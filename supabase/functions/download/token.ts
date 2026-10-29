// 短效下載憑證：HMAC-SHA256 簽章，內容只有到期時間、密碼版本與隨機 ID。
// 憑證不含密碼；更換下載密碼後版本變更，舊憑證即失效。

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export interface TokenPayload {
  v: number; // 下載密碼版本
  exp: number; // 到期時間（秒）
  jti: string;
}

export async function signToken(secret: string, version: number, ttlSeconds: number, now = Date.now()): Promise<{ token: string; exp: number }> {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const payload: TokenPayload = { v: version, exp, jti: crypto.randomUUID() };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return { token: `${body}.${b64url(sig)}`, exp };
}

export async function verifyToken(secret: string, token: unknown, now = Date.now()): Promise<TokenPayload | null> {
  if (typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(parts[1]), enc.encode(parts[0]));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]))) as TokenPayload;
    if (typeof payload.v !== "number" || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

// 將來源 IP 以 HMAC 處理後再存入資料庫，不保存原始 IP
export async function hashClient(secret: string, ip: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`client:${ip}`)));
  return b64url(sig);
}
