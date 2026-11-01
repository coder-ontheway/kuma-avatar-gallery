// 熊兔生命共同體：收藏卡下載（單張、多選、全部 ZIP）。
// 一律先通過下載密碼（Edge Function 驗證）取得私有原圖的限時網址，再在瀏覽器合成收藏卡。
import { zip } from "fflate";
import { renderCardBlob, formatNo, type CardInfo } from "./card";
import { DownloadError, fetchSigned, saveBlob, signCollection } from "./download";
import { safeName } from "./filename";
import type { Collection, CollectionWork } from "./types";

export function cardInfo(collection: Collection, work: CollectionWork, manifesto?: string): CardInfo {
  return {
    workNumber: work.work_number,
    nickname: work.nickname,
    title: work.title,
    description: work.description,
    manifesto: manifesto ?? work.manifesto,
    collectionName: collection.name,
    collectionNameEn: collection.name_en,
  };
}

export function cardFileName(work: Pick<CollectionWork, "work_number" | "nickname">): string {
  return `KUMA_生命共同體_${formatNo(work.work_number)}_${safeName(work.nickname, 20)}_收藏卡.jpg`;
}

export function lifeAvatarTitle(work: Pick<CollectionWork, "work_number" | "nickname">): string {
  return `生命共同體_${formatNo(work.work_number)}_${work.nickname}`;
}

export function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new DownloadError("原圖讀取失敗，請稍後再試。", "decode_failed", 0));
    };
    img.src = url;
  });
}

async function renderFromOriginal(blob: Blob, info: CardInfo, work: CollectionWork): Promise<Blob> {
  const img = await loadImageFromBlob(blob);
  return renderCardBlob(img, img.naturalWidth, img.naturalHeight, info, work.protect_zones);
}

/** 單張收藏卡（可帶粉絲自己的宣言） */
export async function downloadCard(collection: Collection, work: CollectionWork, manifesto?: string): Promise<void> {
  const [item] = await signCollection([work.id], "card");
  if (!item) throw new DownloadError("找不到可下載的作品。", "not_found", 404);
  const blob = await fetchSigned(item);
  const out = await renderFromOriginal(blob, cardInfo(collection, work, manifesto), work);
  saveBlob(out, cardFileName(work));
}

export interface CardZipProgress {
  done: number;
  total: number;
}

/** 多張收藏卡打包成一個 ZIP；ids 為 "all" 時包含全部已公開作品 */
export async function downloadCardsZip(
  collection: Collection,
  works: CollectionWork[],
  ids: string[] | "all",
  onProgress: (p: CardZipProgress) => void,
): Promise<{ files: number; failed: string[] }> {
  const items = await signCollection(ids === "all" ? "all" : ids, "card");
  const byId = new Map(works.map((w) => [w.id, w]));
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  const failed: string[] = [];
  let done = 0;
  onProgress({ done, total: items.length });
  for (const it of items) {
    const work = byId.get(it.id);
    if (!work) {
      done++;
      continue;
    }
    try {
      const blob = await fetchSigned(it);
      const card = await renderFromOriginal(blob, cardInfo(collection, work), work);
      entries[cardFileName(work)] = [new Uint8Array(await card.arrayBuffer()), { level: 0 }];
    } catch {
      failed.push(`${formatNo(work.work_number)} ${work.nickname}`);
    }
    done++;
    onProgress({ done, total: items.length });
  }
  const files = Object.keys(entries).length;
  if (files === 0) throw new DownloadError("收藏卡製作失敗，請檢查網路後再試。", "fetch_failed", 0);
  const data = await new Promise<Uint8Array>((resolve, reject) => zip(entries, (err, out) => (err ? reject(err) : resolve(out))));
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const label = ids === "all" ? "完整收藏卡" : `收藏卡${files}張`;
  saveBlob(new Blob([data as BlobPart], { type: "application/zip" }), `KUMA_熊兔生命共同體_${label}_${stamp}.zip`);
  return { files, failed };
}

// ---- 粉絲的「我的收藏」（只存在這台裝置的瀏覽器，不需要帳號）----
const FAV_KEY = "kuma_life_favorites";

export function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveFavorites(s: Set<string>) {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...s]));
  } catch {
    /* 無痕模式等無法儲存時忽略 */
  }
}
