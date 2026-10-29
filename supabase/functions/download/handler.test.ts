// 執行：npm run test:functions（使用 Deno 內建測試）
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Deps, handle, type ImageRow, type VerifyResult } from "./handler.ts";
import { signToken } from "./token.ts";

const SECRET = "test-secret-test-secret-test-secret-0123456789";
const PASSWORD = "kuma-correct-pw";

function img(id: string, extra: Partial<ImageRow> = {}): ImageRow {
  return {
    id, title: `作品${id.slice(-1)}`, original_path: `${id}/orig.png`, mime_type: "image/png",
    file_size: 1000, sort_order: Number(id.slice(-1)), is_published: true, is_downloadable: true, is_monthly: false, ...extra,
  };
}

const ID1 = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";
const ID3 = "00000000-0000-4000-8000-000000000003";
const ID4 = "00000000-0000-4000-8000-000000000004";

function makeDeps(over: Partial<Deps> & { version?: number; enabled?: boolean; monthly?: boolean } = {}) {
  const calls = { verify: [] as string[], signed: [] as string[] };
  let fails = 0;
  const deps: Deps = {
    tokenSecret: SECRET,
    allowedOrigins: [],
    verifyPassword(password, clientHash): Promise<VerifyResult> {
      calls.verify.push(clientHash);
      if (fails >= 5) return Promise.resolve({ ok: false, reason: "locked", retry_after: 600 });
      if (password === PASSWORD) return Promise.resolve({ ok: true, version: over.version ?? 3 });
      fails++;
      return Promise.resolve({ ok: false, reason: "wrong", remaining: 5 - fails });
    },
    downloadState: () => Promise.resolve({ version: over.version ?? 3, configured: true, downloads_enabled: over.enabled ?? true }),
    monthlyPublic: () => Promise.resolve(over.monthly ?? true),
    listImages: (ids) => {
      const all = [img(ID2), img(ID1), img(ID3, { is_published: false }), img(ID4, { is_monthly: true })];
      return Promise.resolve(ids ? all.filter((r) => ids.includes(r.id)) : all);
    },
    signUrls: (paths, exp) => {
      calls.signed.push(...paths);
      return Promise.resolve(paths.map((p) => `https://example.test/sign/${p}?exp=${exp}`));
    },
    ...over,
  };
  return { deps, calls };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://fn.test/download", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9, 10.0.0.1", ...headers },
    body: JSON.stringify(body),
  });
}

async function getToken(deps: Deps) {
  const res = await handle(post({ action: "verify", password: PASSWORD }), deps);
  assertEquals(res.status, 200);
  return (await res.json()).token as string;
}

Deno.test("CORS 預檢請求", async () => {
  const { deps } = makeDeps();
  const res = await handle(new Request("https://fn.test", { method: "OPTIONS" }), deps);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
});

Deno.test("未設定 DOWNLOAD_TOKEN_SECRET 時拒絕服務", async () => {
  const { deps } = makeDeps({ tokenSecret: "" });
  const res = await handle(post({ action: "verify", password: PASSWORD }), deps);
  assertEquals(res.status, 500);
});

Deno.test("未輸入密碼", async () => {
  const { deps } = makeDeps();
  const res = await handle(post({ action: "verify", password: "" }), deps);
  assertEquals(res.status, 400);
  assertEquals((await res.json()).message, "請輸入下載密碼。");
});

Deno.test("錯誤密碼：401、繁中訊息、不發憑證、來源以雜湊傳入資料庫", async () => {
  const { deps, calls } = makeDeps();
  const res = await handle(post({ action: "verify", password: "wrong" }), deps);
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.token, undefined);
  assertEquals(body.message, "下載密碼不正確，請再試一次（還可嘗試 4 次）。");
  assert(!calls.verify[0].includes("203.0.113.9"), "不可把原始 IP 傳入資料庫");
  assert(calls.verify[0].length >= 32);
});

Deno.test("錯誤 5 次後鎖定（429）", async () => {
  const { deps } = makeDeps();
  for (let i = 0; i < 5; i++) await handle(post({ action: "verify", password: "wrong" + i }), deps);
  const res = await handle(post({ action: "verify", password: PASSWORD }), deps);
  assertEquals(res.status, 429);
  assertEquals((await res.json()).message, "密碼錯誤次數過多，請約 10 分鐘後再試。");
});

Deno.test("正確密碼取得憑證，可換取單張簽署網址", async () => {
  const { deps, calls } = makeDeps();
  const token = await getToken(deps);
  const res = await handle(post({ action: "sign", token, ids: [ID1] }), deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.items.length, 1);
  assertEquals(body.items[0].id, ID1);
  assertEquals(body.expires_in, 120);
  assertEquals(calls.signed, [`${ID1}/orig.png`]);
  assertEquals(body.items[0].original_path, undefined);
});

Deno.test("下載全部：排除未發布作品並依排序", async () => {
  const { deps } = makeDeps();
  const token = await getToken(deps);
  const res = await handle(post({ action: "sign", token, all: true }), deps);
  const body = await res.json();
  assertEquals(body.items.map((i: { id: string }) => i.id), [ID1, ID2, ID4]);
});

Deno.test("本月作品不公開時不能下載", async () => {
  const { deps } = makeDeps({ monthly: false });
  const token = await getToken(deps);
  const body = await (await handle(post({ action: "sign", token, all: true }), deps)).json();
  assertEquals(body.items.map((i: { id: string }) => i.id), [ID1, ID2]);
});

Deno.test("未發布作品無法以 ID 直接取得", async () => {
  const { deps, calls } = makeDeps();
  const token = await getToken(deps);
  const res = await handle(post({ action: "sign", token, ids: [ID3] }), deps);
  assertEquals(res.status, 404);
  assertEquals(calls.signed.length, 0);
});

Deno.test("沒有憑證、偽造憑證都不能取得簽署網址（含 ZIP）", async () => {
  const { deps, calls } = makeDeps();
  for (const token of [undefined, "", "abc.def", "x".repeat(600)]) {
    const res = await handle(post({ action: "sign", token, all: true }), deps);
    assertEquals(res.status, 401);
  }
  const forged = await signToken("another-secret-another-secret-another-secret", 3, 900);
  assertEquals((await handle(post({ action: "sign", token: forged.token, all: true }), deps)).status, 401);
  const real = await getToken(deps);
  const [body, sig] = real.split(".");
  const tamperedBody = btoa(JSON.stringify({ v: 3, exp: 9999999999, jti: "x" })).replace(/=+$/, "");
  assertEquals((await handle(post({ action: "sign", token: `${tamperedBody}.${sig}`, all: true }), deps)).status, 401);
  assert(body.length > 0);
  assertEquals(calls.signed.length, 0);
});

Deno.test("憑證過期後不能使用", async () => {
  const { deps } = makeDeps();
  const old = await signToken(SECRET, 3, 900, Date.now() - 901_000);
  const res = await handle(post({ action: "sign", token: old.token, all: true }), deps);
  assertEquals(res.status, 401);
  assertEquals((await res.json()).message, "下載授權已過期，請重新輸入下載密碼。");
});

Deno.test("更換下載密碼後（版本改變）舊憑證失效", async () => {
  const { deps } = makeDeps({ version: 3 });
  const token = await getToken(deps);
  const { deps: after } = makeDeps({ version: 4 });
  const res = await handle(post({ action: "sign", token, all: true }), after);
  assertEquals(res.status, 401);
  assertEquals((await res.json()).message, "下載密碼已更新，請重新輸入下載密碼。");
});

Deno.test("全站暫停下載時拒絕", async () => {
  const { deps } = makeDeps({ enabled: false });
  const res = await handle(post({ action: "verify", password: PASSWORD }), deps);
  assertEquals(res.status, 403);
});

Deno.test("限制來源：未允許的網站來源被拒絕", async () => {
  const { deps } = makeDeps({ allowedOrigins: ["https://kuma.github.io"] });
  const bad = await handle(post({ action: "verify", password: PASSWORD }, { origin: "https://evil.example" }), deps);
  assertEquals(bad.status, 403);
  const good = await handle(post({ action: "verify", password: PASSWORD }, { origin: "https://kuma.github.io" }), deps);
  assertEquals(good.status, 200);
  assertEquals(good.headers.get("access-control-allow-origin"), "https://kuma.github.io");
});

Deno.test("ID 格式驗證與數量上限", async () => {
  const { deps } = makeDeps();
  const token = await getToken(deps);
  assertEquals((await handle(post({ action: "sign", token, ids: ["../../etc"] }), deps)).status, 400);
  assertEquals((await handle(post({ action: "sign", token, ids: Array(201).fill(ID1) }), deps)).status, 400);
});

Deno.test("伺服器錯誤時不在日誌中洩漏密碼", async () => {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => logged.push(a.map(String).join(" "));
  try {
    const { deps } = makeDeps({ verifyPassword: () => Promise.reject(new Error("db down")) });
    const res = await handle(post({ action: "verify", password: "secret-pw-should-not-leak" }), deps);
    assertEquals(res.status, 500);
    assert(!(await res.text()).includes("secret-pw-should-not-leak"));
  } finally {
    console.error = orig;
  }
  assert(logged.length > 0);
  assert(logged.every((l) => !l.includes("secret-pw-should-not-leak")));
});
