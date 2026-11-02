// 執行：npm run test:functions（使用 Deno 內建測試）
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type CollectionWorkRow, type Deps, handle, type ImageRow, type VerifyResult } from "./handler.ts";
import { signToken } from "./token.ts";

const SECRET = "test-secret-test-secret-test-secret-0123456789";
const PASSWORD = "kuma-correct-pw";
const LIFE_PASSWORD = "life-only-pw";
const COL = "22222222-0000-4000-8000-000000000001";
const OTHER_COL = "22222222-0000-4000-8000-000000000002";

function img(id: string, extra: Partial<ImageRow> = {}): ImageRow {
  return {
    id, title: `作品${id.slice(-1)}`, original_path: `${id}/orig.png`, plain_original_path: null, mime_type: "image/png",
    file_size: 1000, sort_order: Number(id.slice(-1)), is_published: true, is_downloadable: true, is_monthly: false, ...extra,
  };
}

const W1 = "11111111-0000-4000-8000-000000000001";
const W2 = "11111111-0000-4000-8000-000000000002";
const W3 = "11111111-0000-4000-8000-000000000003";
const W4 = "11111111-0000-4000-8000-000000000004";
const W5 = "11111111-0000-4000-8000-000000000005";

function work(id: string, no: number, extra: Partial<CollectionWorkRow> = {}): CollectionWorkRow {
  return {
    id, collection_id: COL, work_number: no, nickname: `稱號${no}`, title: `作品${no}`, original_path: `life/${id}/orig.jpg`, mime_type: "image/jpeg",
    file_size: 2000, sort_order: no * 10, is_published: true, is_downloadable: true, collection_public: true, ...extra,
  };
}

const ID1 = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";
const ID3 = "00000000-0000-4000-8000-000000000003";
const ID4 = "00000000-0000-4000-8000-000000000004";

function makeDeps(over: Partial<Deps> & { version?: number; enabled?: boolean; monthly?: boolean; colVersion?: number; colConfigured?: boolean } = {}) {
  const calls = { verify: [] as string[], verifyCol: [] as string[], signed: [] as string[], recorded: [] as string[] };
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
    verifyCollectionPassword(collectionId, password, clientHash): Promise<VerifyResult> {
      calls.verifyCol.push(`${collectionId}:${clientHash}`);
      if (collectionId !== COL || over.colConfigured === false) return Promise.resolve({ ok: false, reason: "not_configured" });
      if (password === LIFE_PASSWORD) return Promise.resolve({ ok: true, version: over.colVersion ?? 1 });
      return Promise.resolve({ ok: false, reason: "wrong", remaining: 4 });
    },
    collectionDownloadState: (collectionId) =>
      Promise.resolve(
        collectionId === COL && over.colConfigured !== false
          ? { version: over.colVersion ?? 1, configured: true }
          : { version: 0, configured: false },
      ),
    downloadState: () => Promise.resolve({ version: over.version ?? 3, configured: true, downloads_enabled: over.enabled ?? true }),
    monthlyPublic: () => Promise.resolve(over.monthly ?? true),
    listImages: (ids) => {
      const all = [img(ID2), img(ID1, { plain_original_path: `${ID1}/plain.png` }), img(ID3, { is_published: false }), img(ID4, { is_monthly: true })];
      return Promise.resolve(ids ? all.filter((r) => ids.includes(r.id)) : all);
    },
    signUrls: (paths, exp) => {
      calls.signed.push(...paths);
      return Promise.resolve(paths.map((p) => `https://example.test/sign/${p}?exp=${exp}`));
    },
    listCollectionWorks: (ids) => {
      const all = [
        work(W1, 1),
        work(W2, 2),
        work(W3, 3, { is_published: false }),
        work(W4, 4, { original_path: null, mime_type: null, file_size: null }),
        work(W5, 5, { collection_public: false }),
      ];
      return Promise.resolve(ids ? all.filter((r) => ids.includes(r.id)) : all);
    },
    recordDownloads: (ids, kind) => {
      calls.recorded.push(`${kind}:${ids.join(",")}`);
      return Promise.resolve();
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

async function getLifeToken(deps: Deps, collection = COL) {
  const res = await handle(post({ action: "verify", password: LIFE_PASSWORD, collection }), deps);
  assertEquals(res.status, 200);
  return (await res.json()).token as string;
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

Deno.test("無字版：簽署無字版原圖，沒有無字版的作品不回傳", async () => {
  const { deps, calls } = makeDeps();
  const token = await getToken(deps);
  const one = await handle(post({ action: "sign", token, ids: [ID1], variant: "plain" }), deps);
  assertEquals(one.status, 200);
  assertEquals(calls.signed, [`${ID1}/plain.png`]);
  const none = await handle(post({ action: "sign", token, ids: [ID2], variant: "plain" }), deps);
  assertEquals(none.status, 404);
  const all = await handle(post({ action: "sign", token, all: true, variant: "plain" }), deps);
  assertEquals((await all.json()).items.map((i: { id: string }) => i.id), [ID1]);
  const bad = await handle(post({ action: "sign", token, ids: [ID1], variant: "x" }), deps);
  assertEquals(bad.status, 400);
});

Deno.test("無字版同樣需要有效憑證", async () => {
  const { deps, calls } = makeDeps();
  const res = await handle(post({ action: "sign", token: "forged.token", ids: [ID1], variant: "plain" }), deps);
  assertEquals(res.status, 401);
  assertEquals(calls.signed.length, 0);
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

Deno.test("下載次數：依用途記錄，ZIP 全部下載每張各記一次", async () => {
  const { deps, calls } = makeDeps();
  const token = await getToken(deps);
  assertEquals((await handle(post({ action: "sign", token, ids: [ID1], purpose: "avatar" }), deps)).status, 200);
  assertEquals((await handle(post({ action: "sign", token, ids: [ID2] }), deps)).status, 200);
  assertEquals((await handle(post({ action: "sign", token, ids: [ID1], variant: "plain", purpose: "original" }), deps)).status, 200);
  assertEquals((await handle(post({ action: "sign", token, all: true }), deps)).status, 200);
  assertEquals(calls.recorded, [`avatar:${ID1}`, `original:${ID2}`, `original:${ID1}`, `zip:${ID1},${ID2},${ID4}`]);
});

Deno.test("下載次數：未知用途回 400 且不記錄；被拒絕的下載不記錄", async () => {
  const { deps, calls } = makeDeps();
  const token = await getToken(deps);
  assertEquals((await handle(post({ action: "sign", token, ids: [ID1], purpose: "hack" }), deps)).status, 400);
  assertEquals((await handle(post({ action: "sign", token, ids: [ID3] }), deps)).status, 404);
  assertEquals((await handle(post({ action: "sign", token: "bad", ids: [ID1] }), deps)).status, 401);
  assertEquals(calls.recorded, []);
});

Deno.test("下載次數：統計失敗不影響下載", async () => {
  const { deps } = makeDeps({ recordDownloads: () => Promise.reject(new Error("db down")) });
  const token = await getToken(deps);
  const res = await handle(post({ action: "sign", token, ids: [ID1], purpose: "avatar" }), deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).items.length, 1);
});

Deno.test("生命共同體：沒有下載憑證不能取得系列原圖", async () => {
  const { deps, calls } = makeDeps();
  const res = await handle(post({ action: "sign", token: "bad", source: "collection", ids: [W1] }), deps);
  assertEquals(res.status, 401);
  assertEquals(calls.signed.length, 0);
});

Deno.test("生命共同體：通過密碼後可取得單張系列原圖，且不會查到原收藏館", async () => {
  const { deps, calls } = makeDeps();
  const token = await getLifeToken(deps);
  const res = await handle(post({ action: "sign", token, source: "collection", ids: [W2], purpose: "card" }), deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.items.length, 1);
  assertEquals(body.items[0].title, "No.002_稱號2");
  assertEquals(calls.signed, [`life/${W2}/orig.jpg`]);
  assertEquals(calls.recorded.length, 0);
});

Deno.test("生命共同體：全部下載只包含已公開、已上傳、系列公開的作品", async () => {
  const { deps, calls } = makeDeps();
  const token = await getLifeToken(deps);
  const res = await handle(post({ action: "sign", token, source: "collection", all: true }), deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.items.map((i: { id: string }) => i.id), [W1, W2]);
  assert(calls.signed.every((p) => p.startsWith("life/")));
});

Deno.test("生命共同體：草稿、待上傳或系列未公開的作品不能下載", async () => {
  const { deps } = makeDeps();
  const token = await getLifeToken(deps);
  for (const id of [W3, W4, W5]) {
    const res = await handle(post({ action: "sign", token, source: "collection", ids: [id] }), deps);
    assertEquals(res.status, 404);
  }
});

Deno.test("原收藏館的 ZIP 不包含系列作品", async () => {
  const { deps, calls } = makeDeps();
  const token = await getToken(deps);
  const res = await handle(post({ action: "sign", token, all: true }), deps);
  assertEquals(res.status, 200);
  assert(calls.signed.every((p) => !p.startsWith("life/")));
});

Deno.test("未知的作品來源與無字版系列請求會被拒絕", async () => {
  const { deps } = makeDeps();
  const token = await getToken(deps);
  const lifeToken = await getLifeToken(deps);
  assertEquals((await handle(post({ action: "sign", token, source: "x", ids: [W1] }), deps)).status, 400);
  assertEquals((await handle(post({ action: "sign", token: lifeToken, source: "collection", variant: "plain", ids: [W1] }), deps)).status, 400);
  assertEquals((await handle(post({ action: "sign", token, purpose: "card", ids: [ID1] }), deps)).status, 400);
});

Deno.test("專屬密碼：生命共同體密碼以系列 id 驗證，不呼叫原本的密碼驗證", async () => {
  const { deps, calls } = makeDeps();
  const res = await handle(post({ action: "verify", password: LIFE_PASSWORD, collection: COL }), deps);
  assertEquals(res.status, 200);
  assertEquals(calls.verify.length, 0);
  assertEquals(calls.verifyCol.length, 1);
  assert(calls.verifyCol[0].startsWith(`${COL}:`));
  assert(!calls.verifyCol[0].includes("203.0.113.9"));
});

Deno.test("專屬密碼：原本的下載密碼不能通過生命共同體驗證", async () => {
  const { deps } = makeDeps();
  const res = await handle(post({ action: "verify", password: PASSWORD, collection: COL }), deps);
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "wrong_password");
});

Deno.test("專屬密碼：生命共同體密碼不能通過原本收藏館的驗證", async () => {
  const { deps } = makeDeps();
  const res = await handle(post({ action: "verify", password: LIFE_PASSWORD }), deps);
  assertEquals(res.status, 401);
});

Deno.test("專屬密碼：原本密碼的授權不能下載生命共同體作品", async () => {
  const { deps, calls } = makeDeps();
  const token = await getToken(deps);
  for (const body of [{ ids: [W1] }, { all: true }]) {
    const res = await handle(post({ action: "sign", token, source: "collection", ...body }), deps);
    assertEquals(res.status, 401);
    assertEquals((await res.json()).error, "token_invalid");
  }
  assertEquals(calls.signed.length, 0);
});

Deno.test("專屬密碼：生命共同體授權不能下載原本收藏館作品", async () => {
  const { deps, calls } = makeDeps();
  const token = await getLifeToken(deps);
  for (const body of [{ ids: [ID1] }, { all: true }]) {
    const res = await handle(post({ action: "sign", token, ...body }), deps);
    assertEquals(res.status, 401);
  }
  assertEquals(calls.signed.length, 0);
});

Deno.test("專屬密碼：尚未設定時回覆 503 與繁中訊息", async () => {
  const { deps } = makeDeps({ colConfigured: false });
  const res = await handle(post({ action: "verify", password: LIFE_PASSWORD, collection: COL }), deps);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).message, "這個系列尚未設定專屬下載密碼，請聯絡網站管理員。");
});

Deno.test("專屬密碼：更換後舊授權失效；原本密碼的授權不受影響", async () => {
  const { deps } = makeDeps();
  const lifeToken = await getLifeToken(deps);
  const siteToken = await getToken(deps);
  const { deps: after } = makeDeps({ colVersion: 2 });
  assertEquals((await handle(post({ action: "sign", token: lifeToken, source: "collection", ids: [W1] }), after)).status, 401);
  assertEquals((await handle(post({ action: "sign", token: siteToken, ids: [ID1] }), after)).status, 200);
});

Deno.test("專屬密碼：授權只能下載該系列的作品", async () => {
  const { deps } = makeDeps({
    listCollectionWorks: () => Promise.resolve([work(W1, 1), work(W2, 2, { collection_id: OTHER_COL })]),
  });
  const token = await getLifeToken(deps);
  const res = await handle(post({ action: "sign", token, source: "collection", all: true }), deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).items.map((i: { id: string }) => i.id), [W1]);
});

Deno.test("專屬密碼：系列 id 格式錯誤會被拒絕", async () => {
  const { deps, calls } = makeDeps();
  const res = await handle(post({ action: "verify", password: LIFE_PASSWORD, collection: "x" }), deps);
  assertEquals(res.status, 400);
  assertEquals(calls.verifyCol.length + calls.verify.length, 0);
});

Deno.test("專屬密碼：偽造系列 id 的授權（簽章不符）會被拒絕", async () => {
  const { deps } = makeDeps();
  const { token } = await signToken("another-secret-another-secret-another-secret", 1, 900, Date.now(), COL);
  assertEquals((await handle(post({ action: "sign", token, source: "collection", ids: [W1] }), deps)).status, 401);
});

// ---------------- KUMA STUDIO 多系列：每個系列獨立密碼 ----------------
const COL_A = "33333333-0000-4000-8000-00000000000a";
const COL_B = "33333333-0000-4000-8000-00000000000b";
const COL_C = "33333333-0000-4000-8000-00000000000c";
const PW: Record<string, string> = { [COL_A]: "test-a-pw", [COL_B]: "test-b-pw", [COL_C]: "test-c-pw" };
const WA = "44444444-0000-4000-8000-00000000000a";
const WB = "44444444-0000-4000-8000-00000000000b";
const WC = "44444444-0000-4000-8000-00000000000c";

function multiDeps(state: Record<string, { version: number; enabled: boolean }> = {}) {
  const st = (c: string) => state[c] ?? { version: 1, enabled: true };
  return makeDeps({
    verifyCollectionPassword(collectionId, password) {
      if (!PW[collectionId]) return Promise.resolve({ ok: false, reason: "not_available" });
      if (!st(collectionId).enabled) return Promise.resolve({ ok: false, reason: "disabled" });
      return Promise.resolve(password === PW[collectionId] ? { ok: true, version: st(collectionId).version } : { ok: false, reason: "wrong", remaining: 4 });
    },
    collectionDownloadState: (c) => Promise.resolve(PW[c] ? { version: st(c).version, configured: true, enabled: st(c).enabled } : { version: 0, configured: false, enabled: false }),
    listCollectionWorks: (ids) => {
      const all = [work(WA, 1, { collection_id: COL_A }), work(WB, 1, { collection_id: COL_B }), work(WC, 1, { collection_id: COL_C })];
      return Promise.resolve(ids ? all.filter((r) => ids.includes(r.id)) : all);
    },
  }).deps;
}

async function tokenFor(deps: Deps, col: string, password = PW[col]) {
  const res = await handle(post({ action: "verify", password, collection: col }), deps);
  return { status: res.status, token: res.ok ? ((await res.json()).token as string) : null };
}

Deno.test("多系列：A 系列密碼不能通過 B、C 系列", async () => {
  const deps = multiDeps();
  assertEquals((await tokenFor(deps, COL_B, PW[COL_A])).status, 401);
  assertEquals((await tokenFor(deps, COL_C, PW[COL_B])).status, 401);
  assertEquals((await tokenFor(deps, COL_A)).status, 200);
});

Deno.test("多系列：A 系列的授權不能下載 B 系列作品（指定 id 或全部 ZIP）", async () => {
  const deps = multiDeps();
  const { token } = await tokenFor(deps, COL_A);
  const one = await handle(post({ action: "sign", token, source: "collection", ids: [WB] }), deps);
  assertEquals(one.status, 404);
  const mixed = await handle(post({ action: "sign", token, source: "collection", ids: [WA, WB, WC] }), deps);
  assertEquals((await mixed.json()).items.map((i: { id: string }) => i.id), [WA]);
  const zip = await handle(post({ action: "sign", token, source: "collection", all: true }), deps);
  assertEquals((await zip.json()).items.map((i: { id: string }) => i.id), [WA]);
});

Deno.test("多系列：修改 A 系列密碼後 A 的授權失效，B、C 不受影響", async () => {
  const before = multiDeps();
  const a = (await tokenFor(before, COL_A)).token;
  const b = (await tokenFor(before, COL_B)).token;
  const after = multiDeps({ [COL_A]: { version: 2, enabled: true } });
  assertEquals((await handle(post({ action: "sign", token: a, source: "collection", ids: [WA] }), after)).status, 401);
  assertEquals((await handle(post({ action: "sign", token: b, source: "collection", ids: [WB] }), after)).status, 200);
});

Deno.test("多系列：停用 A 系列下載後，A 的既有授權與驗證都被擋，B 正常", async () => {
  const before = multiDeps();
  const a = (await tokenFor(before, COL_A)).token;
  const b = (await tokenFor(before, COL_B)).token;
  const after = multiDeps({ [COL_A]: { version: 1, enabled: false } });
  const res = await handle(post({ action: "sign", token: a, source: "collection", ids: [WA] }), after);
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error, "collection_download_disabled");
  assertEquals((await tokenFor(after, COL_A)).status, 403);
  assertEquals((await handle(post({ action: "sign", token: b, source: "collection", ids: [WB] }), after)).status, 200);
});

Deno.test("多系列：不存在或下架的系列回覆 404", async () => {
  const deps = multiDeps();
  assertEquals((await tokenFor(deps, "33333333-0000-4000-8000-0000000000ff", "x")).status, 404);
});

Deno.test("多系列：回應不含密碼或私有路徑以外的資訊", async () => {
  const deps = multiDeps();
  const res = await handle(post({ action: "verify", password: PW[COL_A], collection: COL_A }), deps);
  const text = await res.text();
  assert(!text.includes(PW[COL_A]));
  assert(!text.includes("orig.jpg"));
});

Deno.test("多系列：大頭貼版原圖需要該系列密碼，且只回傳有大頭貼版的作品", async () => {
  const { deps } = makeDeps({
    listCollectionWorks: () =>
      Promise.resolve([
        work(W1, 1, { avatar_original_path: "c/w1/avatar.png", avatar_mime_type: "image/png", avatar_file_size: 500 }),
        work(W2, 2),
      ]),
  });
  const token = await getLifeToken(deps);
  const res = await handle(post({ action: "sign", token, source: "collection", variant: "avatar", ids: [W1, W2], purpose: "avatar" }), deps);
  assertEquals(res.status, 200);
  const items = (await res.json()).items;
  assertEquals(items.map((i: { id: string }) => i.id), [W1]);
  assert(items[0].url.includes("c/w1/avatar.png"));
  assertEquals((await handle(post({ action: "sign", variant: "avatar", ids: [ID1], token: await getToken(deps) }), deps)).status, 400);
});
