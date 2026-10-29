// 粉絲下載：密碼驗證、短效憑證、限時簽署網址、ZIP 打包
import { zip } from "fflate";
import { anonKey, functionsUrl } from "./supabase";
import { splitIntoParts, uniqueZipNames } from "./filename";

const TOKEN_KEY = "kuma_download_token";

export class DownloadError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message);
  }
}

interface StoredToken {
  token: string;
  exp: number;
}

export function getToken(): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as StoredToken;
    if (t.exp * 1000 - Date.now() < 15_000) {
      sessionStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return t.token;
  } catch {
    return null;
  }
}

export function clearToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
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

/** 以下載密碼換取 15 分鐘有效的下載憑證（密碼只送到 Edge Function，前端不比對） */
export async function verifyPassword(password: string): Promise<void> {
  const data = await call({ action: "verify", password });
  const token = data.token as string;
  const exp = data.expires_at as number;
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, exp }));
  } catch {
    memoryToken = { token, exp };
  }
}

let memoryToken: StoredToken | null = null;

function currentToken(): string | null {
  const t = getToken();
  if (t) return t;
  if (memoryToken && memoryToken.exp * 1000 - Date.now() > 15_000) return memoryToken.token;
  return null;
}

export function hasValidToken(): boolean {
  return currentToken() !== null;
}

export interface SignedItem {
  id: string;
  title: string;
  mime_type: string;
  file_size: number;
  url: string;
}

async function sign(body: { ids?: string[]; all?: boolean }): Promise<SignedItem[]> {
  const token = currentToken();
  if (!token) throw new DownloadError("請先輸入下載密碼。", "token_invalid", 401);
  try {
    const data = await call({ action: "sign", token, ...body });
    return data.items as SignedItem[];
  } catch (e) {
    if (e instanceof DownloadError && e.code === "token_invalid") {
      clearToken();
      memoryToken = null;
    }
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

/** 取得單張原圖（僅在通過密碼驗證後） */
export async function fetchOriginal(id: string): Promise<{ blob: Blob; item: SignedItem }> {
  const [item] = await sign({ ids: [id] });
  if (!item) throw new DownloadError("找不到可下載的作品。", "not_found", 404);
  try {
    return { blob: await fetchBlob(item.url), item };
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
