// 粉絲下載流程的核心邏輯（與 Supabase 用戶端分離，方便測試）
//   action "verify"：驗證下載密碼 → 回傳 15 分鐘有效的下載憑證
//   action "sign"  ：以下載憑證換取私有原圖的限時簽署網址（120 秒）
//                    variant "plain" 代表下載「無字版」原圖（只回傳有無字版的作品）
//                    purpose "avatar"／"original" 用於下載次數統計（ZIP 全部下載自動記為 "zip"）
//                    source "collection" 代表「熊兔生命共同體」等主題系列作品（collection_works 表），
//                    與原本收藏館（images 表）分開查詢，互不影響
//   每個系列有自己的下載密碼：verify 時帶 collection（系列 id）就只以「該系列」的密碼驗證，
//   發出的授權只能下載該系列（憑證內含系列 id，sign 時只回傳該系列的作品）；
//   其他系列或原本收藏館的授權一律不能使用。一次下載多個系列時，必須分別驗證每個系列的密碼。
import { hashClient, signToken, verifyToken } from "./token.ts";

export const TOKEN_TTL_SECONDS = 15 * 60;
export const SIGNED_URL_TTL_SECONDS = 120;
const MAX_IDS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VerifyResult {
  ok: boolean;
  reason?: "wrong" | "locked" | "busy" | "not_configured" | "disabled" | "not_available";
  version?: number;
  remaining?: number;
  retry_after?: number;
}

export interface DownloadState {
  version: number;
  configured: boolean;
  downloads_enabled: boolean;
}

export interface ImageRow {
  id: string;
  title: string;
  original_path: string;
  plain_original_path: string | null;
  mime_type: string;
  file_size: number;
  sort_order: number;
  is_published: boolean;
  is_downloadable: boolean;
  is_monthly: boolean;
}

export type DownloadKind = "avatar" | "original" | "zip";

/** 主題系列作品（collection_works）；待上傳的作品沒有原圖路徑 */
export interface CollectionWorkRow {
  id: string;
  collection_id: string;
  work_number: number;
  nickname: string;
  title: string;
  original_path: string | null;
  mime_type: string | null;
  file_size: number | null;
  /** 大頭貼版原圖（選用；有些系列每個場景另外提供方形大頭貼） */
  avatar_original_path?: string | null;
  avatar_mime_type?: string | null;
  avatar_file_size?: number | null;
  sort_order: number;
  is_published: boolean;
  is_downloadable: boolean;
  collection_public: boolean;
}

export interface Deps {
  tokenSecret: string;
  allowedOrigins: string[]; // 空陣列代表不限制來源
  verifyPassword(password: string, clientHash: string): Promise<VerifyResult>;
  downloadState(): Promise<DownloadState>;
  monthlyPublic(): Promise<boolean>;
  listImages(ids: string[] | null): Promise<ImageRow[]>;
  listCollectionWorks?(ids: string[] | null): Promise<CollectionWorkRow[]>;
  verifyCollectionPassword?(collectionId: string, password: string, clientHash: string): Promise<VerifyResult>;
  /** enabled：系列已公開、系列開放下載、專屬密碼已設定且啟用（舊版資料庫沒有此欄位時視為 true） */
  collectionDownloadState?(collectionId: string): Promise<{ version: number; configured: boolean; enabled?: boolean }>;
  signUrls(paths: string[], expiresIn: number): Promise<(string | null)[]>;
  recordDownloads?(ids: string[], kind: DownloadKind): Promise<void>;
  now?: () => number;
}

function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const allowOrigin = allowed.length === 0 ? "*" : (origin && allowed.includes(origin) ? origin : allowed[0]);
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? "unknown";
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin, deps.allowedOrigins);
  const now = deps.now ?? Date.now;

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed", message: "不支援的請求方式。" }, cors);
  if (deps.allowedOrigins.length > 0 && origin && !deps.allowedOrigins.includes(origin)) {
    return json(403, { error: "forbidden_origin", message: "此網站來源未被允許下載。" }, cors);
  }
  if (!deps.tokenSecret || deps.tokenSecret.length < 32) {
    return json(500, { error: "server_not_configured", message: "下載服務尚未完成設定，請聯絡網站管理員。" }, cors);
  }

  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 16_384) return json(413, { error: "too_large", message: "請求內容過大。" }, cors);
    body = JSON.parse(text);
    if (!body || typeof body !== "object") throw new Error();
  } catch {
    return json(400, { error: "bad_request", message: "請求格式錯誤。" }, cors);
  }

  try {
    if (body.action === "verify") return await verify(req, body, deps, cors, now);
    if (body.action === "sign") return await sign(body, deps, cors, now);
    return json(400, { error: "bad_request", message: "未知的操作。" }, cors);
  } catch (err) {
    // 只記錄錯誤類型，絕不記錄請求內容（可能含密碼）
    console.error("download function error:", err instanceof Error ? err.name + ": " + err.message : "unknown");
    return json(500, { error: "server_error", message: "伺服器暫時無法處理，請稍後再試。" }, cors);
  }
}

async function verify(req: Request, body: Record<string, unknown>, deps: Deps, cors: Record<string, string>, now: () => number) {
  const password = body.password;
  if (typeof password !== "string" || password.length === 0) {
    return json(400, { error: "password_required", message: "請輸入下載密碼。" }, cors);
  }
  if (password.length > 128) {
    return json(401, { error: "wrong_password", message: "下載密碼不正確，請再試一次。" }, cors);
  }

  const collectionId = body.collection;
  if (collectionId !== undefined && (typeof collectionId !== "string" || !UUID_RE.test(collectionId) || !deps.verifyCollectionPassword)) {
    return json(400, { error: "bad_request", message: "未知的作品系列。" }, cors);
  }

  const state = await deps.downloadState();
  if (!state.downloads_enabled) {
    return json(403, { error: "downloads_disabled", message: "目前暫停開放下載，請留意粉專公告。" }, cors);
  }

  const clientHash = await hashClient(deps.tokenSecret, clientIp(req));
  const result = collectionId
    ? await deps.verifyCollectionPassword!(collectionId as string, password, clientHash)
    : await deps.verifyPassword(password, clientHash);

  if (result.ok && typeof result.version === "number") {
    const { token, exp } = await signToken(deps.tokenSecret, result.version, TOKEN_TTL_SECONDS, now(), collectionId as string | undefined);
    return json(200, { token, expires_at: exp }, cors);
  }

  switch (result.reason) {
    case "locked": {
      const minutes = Math.max(1, Math.ceil((result.retry_after ?? 900) / 60));
      return json(429, {
        error: "too_many_attempts",
        retry_after: result.retry_after ?? 900,
        message: `密碼錯誤次數過多，請約 ${minutes} 分鐘後再試。`,
      }, cors);
    }
    case "disabled":
      return json(403, { error: "collection_download_disabled", message: "這個系列目前暫停下載，請留意粉專公告。" }, cors);
    case "not_available":
      return json(404, { error: "collection_not_available", message: "找不到這個系列，可能已下架。" }, cors);
    case "busy":
      return json(429, { error: "busy", retry_after: result.retry_after ?? 900, message: "目前嘗試次數過多，請稍後再試。" }, cors);
    case "not_configured":
      return json(503, {
        error: "password_not_set",
        message: collectionId ? "這個系列尚未設定專屬下載密碼，請聯絡網站管理員。" : "網站尚未設定下載密碼，請聯絡網站管理員。",
      }, cors);
    default: {
      const remaining = result.remaining ?? 0;
      return json(401, {
        error: "wrong_password",
        remaining,
        message: remaining > 0
          ? `下載密碼不正確，請再試一次（還可嘗試 ${remaining} 次）。`
          : "下載密碼不正確，嘗試次數已達上限，請稍後再試。",
      }, cors);
    }
  }
}

async function sign(body: Record<string, unknown>, deps: Deps, cors: Record<string, string>, now: () => number) {
  const payload = await verifyToken(deps.tokenSecret, body.token, now());
  if (!payload) {
    return json(401, { error: "token_invalid", message: "下載授權已過期，請重新輸入下載密碼。" }, cors);
  }
  const state = await deps.downloadState();
  if (!state.downloads_enabled) {
    return json(403, { error: "downloads_disabled", message: "目前暫停開放下載，請留意粉專公告。" }, cors);
  }
  const isCollection = body.source === "collection";
  if (isCollection) {
    // 系列作品只接受該系列專屬密碼發出的授權
    if (!payload.c || !deps.collectionDownloadState) {
      return json(401, { error: "token_invalid", message: "請輸入這個系列的專屬下載密碼。" }, cors);
    }
    const cs = await deps.collectionDownloadState(payload.c);
    if (!cs.configured || cs.version !== payload.v) {
      return json(401, { error: "token_invalid", message: "下載密碼已更新，請重新輸入下載密碼。" }, cors);
    }
    // 系列被下架、關閉下載或停用密碼時，已發出的授權也立即不能再換下載網址
    if (cs.enabled === false) {
      return json(403, { error: "collection_download_disabled", message: "這個系列目前暫停下載，請留意粉專公告。" }, cors);
    }
  } else {
    if (payload.c) {
      return json(401, { error: "token_invalid", message: "請輸入下載密碼。" }, cors);
    }
    if (state.version !== payload.v) {
      return json(401, { error: "token_invalid", message: "下載密碼已更新，請重新輸入下載密碼。" }, cors);
    }
  }

  const variant = body.variant ?? "original";
  if (variant !== "original" && variant !== "plain" && !(variant === "avatar" && isCollection)) {
    return json(400, { error: "bad_request", message: "未知的作品版本。" }, cors);
  }

  const purpose = body.purpose ?? "original";
  if (body.all !== true && purpose !== "avatar" && purpose !== "original" && !(purpose === "card" && body.source === "collection")) {
    return json(400, { error: "bad_request", message: "未知的下載用途。" }, cors);
  }
  const kind: DownloadKind = body.all === true ? "zip" : purpose === "card" ? "original" : purpose as DownloadKind;

  let ids: string[] | null = null;
  if (body.all !== true) {
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > MAX_IDS) {
      return json(400, { error: "bad_request", message: "請選擇要下載的作品。" }, cors);
    }
    if (!body.ids.every((id) => typeof id === "string" && UUID_RE.test(id))) {
      return json(400, { error: "bad_request", message: "作品編號格式錯誤。" }, cors);
    }
    ids = [...new Set(body.ids as string[])];
  }

  if (isCollection) return await signCollection(payload.c!, ids, variant, deps, cors);
  if (body.source !== undefined && body.source !== "images") {
    return json(400, { error: "bad_request", message: "未知的作品來源。" }, cors);
  }

  const monthlyPublic = await deps.monthlyPublic();
  const rows = (await deps.listImages(ids))
    .filter((r) => r.is_published && r.is_downloadable && (!r.is_monthly || monthlyPublic))
    .filter((r) => variant === "original" || !!r.plain_original_path)
    .sort((a, b) => a.sort_order - b.sort_order);

  if (rows.length === 0) {
    return json(404, { error: "not_found", message: "找不到可下載的作品。" }, cors);
  }

  const paths = rows.map((r) => (variant === "plain" ? r.plain_original_path! : r.original_path));
  const urls = await deps.signUrls(paths, SIGNED_URL_TTL_SECONDS);
  const items = rows
    .map((r, i) => ({ id: r.id, title: r.title, mime_type: r.mime_type, file_size: r.file_size, url: urls[i] }))
    .filter((r) => typeof r.url === "string");

  // 統計失敗不影響粉絲下載
  if (deps.recordDownloads && items.length > 0) {
    try {
      await deps.recordDownloads(items.map((r) => r.id), kind);
    } catch (err) {
      console.error("record downloads failed:", err instanceof Error ? err.message : "unknown");
    }
  }

  return json(200, { items, expires_in: SIGNED_URL_TTL_SECONDS }, cors);
}

function pad3(n: number) {
  return String(n).padStart(3, "0");
}

/** 主題系列作品：只回傳「已公開系列」中「已公開、可下載、已上傳照片」的作品 */
async function signCollection(
  collectionId: string,
  ids: string[] | null,
  variant: unknown,
  deps: Deps,
  cors: Record<string, string>,
) {
  if ((variant !== "original" && variant !== "avatar") || !deps.listCollectionWorks) {
    return json(400, { error: "bad_request", message: "未知的作品版本。" }, cors);
  }
  const avatar = variant === "avatar";
  const rows = (await deps.listCollectionWorks(ids))
    .filter((r) => r.collection_id === collectionId && r.collection_public && r.is_published && r.is_downloadable && r.original_path && r.mime_type && r.file_size)
    .filter((r) => !avatar || (r.avatar_original_path && r.avatar_mime_type && r.avatar_file_size))
    .sort((a, b) => a.sort_order - b.sort_order || a.work_number - b.work_number);
  if (rows.length === 0) {
    return json(404, { error: "not_found", message: "找不到可下載的作品。" }, cors);
  }
  const urls = await deps.signUrls(rows.map((r) => (avatar ? r.avatar_original_path! : r.original_path!)), SIGNED_URL_TTL_SECONDS);
  const items = rows
    .map((r, i) => ({
      id: r.id,
      title: `No.${pad3(r.work_number)}_${r.nickname}${avatar ? "_大頭貼" : ""}`,
      mime_type: avatar ? r.avatar_mime_type! : r.mime_type!,
      file_size: avatar ? r.avatar_file_size! : r.file_size!,
      url: urls[i],
    }))
    .filter((r) => typeof r.url === "string");
  return json(200, { items, expires_in: SIGNED_URL_TTL_SECONDS }, cors);
}
