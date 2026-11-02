// 粉絲下載：密碼驗證、短效憑證、限時簽署網址、ZIP 打包
import { zip } from "fflate";
import { anonKey, functionsUrl } from "./supabase";
import { splitIntoParts, uniqueZipNames } from "./filename";

const TOKEN_KEY = "kuma_download_token";

/**
 * 下載授權的範圍：null 代表原本收藏館（原本的下載密碼），
 * 字串代表主題系列 id（該系列的專屬下載密碼）。兩者的授權分開存放、互不通用。
 */
export type AuthScope = string | null;

function keyFor(scope: AuthScope) {
  return scope ? `${TOKEN_KEY}:c:${scope}` : TOKEN_KEY;
}

export class DownloadError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message);
  }
}

interface StoredToken {
  token: string;
  exp: number;
}

export function getToken(scope: AuthScope = null): string | null {
  try {
    const raw = sessionStorage.getItem(keyFor(scope));
    if (!raw) return null;
    const t = JSON.parse(raw) as StoredToken;
    if (t.exp * 1000 - Date.now() < 15_000) {
      sessionStorage.removeItem(keyFor(scope));
      return null;
    }
    return t.token;
  } catch {
    return null;
  }
}

export function clearToken(scope: AuthScope = null) {
  memoryTokens.delete(keyFor(scope));
  try {
    sessionStorage.removeItem(keyFor(scope));
  } catch {
    /* 無法使用 sessionStorage 時忽略 */
  }
}

async function call(body: Record<string, unknown>) {
  let res: Response;
  try {
    res = await fetch(`${functionsUrl}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new DownloadError("無法連線到下載服務，請檢查網路後再試。", "network", 0);
  }
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 回應 */
  }
  if (!res.ok) {
    throw new DownloadError(
      typeof data.message === "string" ? data.message : "下載服務暫時無法使用，請稍後再試。",
      typeof data.error === "string" ? data.error : "unknown",
      res.status,
    );
  }
  return data;
}

/**
 * 以下載密碼換取 15 分鐘有效的下載憑證（密碼只送到 Edge Function，前端不比對）。
 * scope 為系列 id 時以該系列的專屬密碼驗證。
 */
export async function verifyPassword(password: string, scope: AuthScope = null): Promise<void> {
  const data = await call(scope ? { action: "verify", password, collection: scope } : { action: "verify", password });
  const token = data.token as string;
  const exp = data.expires_at as number;
  try {
    sessionStorage.setItem(keyFor(scope), JSON.stringify({ token, exp }));
  } catch {
    memoryTokens.set(keyFor(scope), { token, exp });
  }
}

const memoryTokens = new Map<string, StoredToken>();

function currentToken(scope: AuthScope): string | null {
  const t = getToken(scope);
  if (t) return t;
  const m = memoryTokens.get(keyFor(scope));
  if (m && m.exp * 1000 - Date.now() > 15_000) return m.token;
  return null;
}

export function hasValidToken(scope: AuthScope = null): boolean {
  return currentToken(scope) !== null;
}

export interface SignedItem {
  id: string;
  title: string;
  mime_type: string;
  file_size: number;
  url: string;
}

/** original：原圖；plain：原本收藏館的無字版；avatar：系列作品的大頭貼版 */
export type Variant = "original" | "plain" | "avatar";

/** 用途只用於後臺的下載次數統計；"card" 為生命共同體收藏卡 */
export type Purpose = "avatar" | "original" | "card";

/** 作品來源：原本收藏館（images）或主題系列（collection_works） */
export type Source = "images" | "collection";

async function sign(
  body: { ids?: string[]; all?: boolean; variant?: Variant; purpose?: Purpose; source?: Source },
  scope: AuthScope = null,
): Promise<SignedItem[]> {
  const token = currentToken(scope);
  if (!token) throw new DownloadError("請先輸入下載密碼。", "token_invalid", 401);
  try {
    const data = await call({ action: "sign", token, ...body });
    return data.items as SignedItem[];
  } catch (e) {
    if (e instanceof DownloadError && e.code === "token_invalid") clearToken(scope);
    throw e;
  }
}

async function fetchBlob(url: string, retries = 1): Promise<Blob> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      return await res.blob();
    } catch (e) {
      if (i >= retries) throw e;
    }
  }
}

/**
 * 取得單張原圖（僅在通過密碼驗證後）；variant "plain" 取得無字版；purpose 為大頭貼或原圖下載。
 * 系列作品（source "collection"）需傳入系列 id，使用該系列專屬密碼的授權。
 */
export async function fetchOriginal(
  id: string,
  variant: Variant = "original",
  purpose: Purpose = "original",
  source: Source = "images",
  collectionId: AuthScope = null,
): Promise<{ blob: Blob; item: SignedItem }> {
  const [item] = await (source === "collection"
    ? sign({ ids: [id], purpose, source, ...(variant === "avatar" ? { variant } : {}) }, collectionId)
    : sign({ ids: [id], variant, purpose }));
  if (!item) throw new DownloadError("找不到可下載的作品。", "not_found", 404);
  try {
    return { blob: await fetchBlob(item.url), item };
  } catch {
    throw new DownloadError("原圖下載失敗，請檢查網路後再試。", "fetch_failed", 0);
  }
}

/** 主題系列：一次取得多款（或全部）作品原圖的限時網址 */
export async function signCollection(collectionId: string, ids: string[] | "all", purpose: Purpose = "card"): Promise<SignedItem[]> {
  return sign(ids === "all" ? { all: true, source: "collection" } : { ids, purpose, source: "collection" }, collectionId);
}

export async function fetchSigned(item: SignedItem): Promise<Blob> {
  try {
    return await fetchBlob(item.url);
  } catch {
    throw new DownloadError("原圖下載失敗，請檢查網路後再試。", "fetch_failed", 0);
  }
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const ZIP_PART_BYTES = 150 * 1024 * 1024;

export interface ZipProgress {
  done: number;
  total: number;
  part: number;
  parts: number;
}

/** 下載全部：取得限時網址 → 逐張下載 → 在瀏覽器打包 ZIP（超過 150MB 自動分成多個 ZIP） */
export async function downloadAllZip(onProgress: (p: ZipProgress) => void): Promise<{ failed: string[]; files: number }> {
  const items = await sign({ all: true });
  const names = uniqueZipNames(items);
  const named = items.map((it, i) => ({ ...it, name: names[i] }));
  const parts = splitIntoParts(named, ZIP_PART_BYTES);
  const failed: string[] = [];
  let done = 0;
  let files = 0;
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  for (let p = 0; p < parts.length; p++) {
    const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
    for (const it of parts[p]) {
      onProgress({ done, total: named.length, part: p + 1, parts: parts.length });
      try {
        const blob = await fetchBlob(it.url);
        entries[it.name] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
        files++;
      } catch {
        failed.push(it.title);
      }
      done++;
    }
    onProgress({ done, total: named.length, part: p + 1, parts: parts.length });
    if (Object.keys(entries).length === 0) continue;
    const data = await new Promise<Uint8Array>((resolve, reject) =>
      zip(entries, (err, out) => (err ? reject(err) : resolve(out))),
    );
    const suffix = parts.length > 1 ? `_第${p + 1}部分` : "";
    saveBlob(new Blob([data as BlobPart], { type: "application/zip" }), `KUMA_熊兔大頭貼_${stamp}${suffix}.zip`);
  }
  if (files === 0) throw new DownloadError("全部作品下載失敗，請檢查網路後再試。", "fetch_failed", 0);
  return { failed, files };
}
