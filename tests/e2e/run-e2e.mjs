// =====================================================================
// 端到端驗收測試（本機）：建置網站 → 啟動 Supabase 相容測試伺服器 → 以真實瀏覽器操作
// 執行：npm run test:e2e
// 需求：本機 PostgreSQL（以目前系統使用者連線）、Playwright Chromium、
//       tests/e2e/private-artworks/ 內放管理員提供的作品（此資料夾不提交到 GitHub）。
// =====================================================================
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { PNG } from "pngjs";
import { unzipSync } from "fflate";
import { createMockSupabase } from "./mock-supabase.mjs";

// 使用環境中已安裝的 Playwright（CI 可用 npx playwright install chromium 安裝）
const { chromium } = createRequire(import.meta.url)("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "tests/e2e/output");
const ART = path.join(ROOT, "tests/e2e/private-artworks");
const DB = "kuma_e2e";
const API_PORT = 54321;
const WEB_PORT = 4173;
const BASE = "/kuma-avatar-gallery/";
const SITE = `http://127.0.0.1:${WEB_PORT}${BASE}`;
const API = `http://127.0.0.1:${API_PORT}`;

const USERS = [
  { id: "aaaaaaaa-1111-4111-8111-000000000001", email: "admin-a@example.test", password: "Admin-A-pass-123", name: "管理員 A（我）" },
  { id: "bbbbbbbb-2222-4222-8222-000000000002", email: "admin-b@example.test", password: "Admin-B-pass-456", name: "管理員 B（先生）" },
  { id: "cccccccc-3333-4333-8333-000000000003", email: "stranger@example.test", password: "Stranger-pass-789" },
];
const [A, B, C] = USERS;
const DL_PASS_1 = "kuma-fans-2026";
const DL_PASS_2 = "kuma-fans-new-11";

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const debugPages = {};
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `：${detail}` : ""}`);
}
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, String(e?.message ?? e).split("\n")[0]);
    for (const [label, p] of Object.entries(debugPages)) {
      await p.screenshot({ path: path.join(OUT, `fail-${name}-${label}.png`) }).catch(() => {});
      const html = await p.locator("body").innerText().catch(() => "");
      fs.writeFileSync(path.join(OUT, `fail-${name}-${label}.txt`), html.slice(0, 4000));
    }
  }
}

// ---------- 1. 資料庫 ----------
const psql = (args) => execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", ...args], { stdio: ["ignore", "ignore", "inherit"] });
psql(["-d", "postgres", "-c", `drop database if exists ${DB}`, "-c", `create database ${DB}`]);
psql(["-d", DB, "-f", path.join(ROOT, "supabase/tests/local_mock_supabase.sql")]);
for (const f of fs.readdirSync(path.join(ROOT, "supabase/migrations")).sort()) psql(["-d", DB, "-f", path.join(ROOT, "supabase/migrations", f)]);
const usersSql = USERS.map((u) => `('${u.id}','${u.email}')`).join(",");
psql(["-d", DB, "-c", `insert into auth.users (id, email) values ${usersSql}`]);
// 依 README 的「登記兩位管理員」步驟
psql(["-d", DB, "-c", `insert into public.admins (user_id, display_name) values ('${A.id}', '${A.name}'), ('${B.id}', '${B.name}')`]);

// ---------- 2. 測試伺服器與網站 ----------
const mock = createMockSupabase({ database: DB, storageDir: path.join(OUT, "storage"), users: USERS, port: API_PORT });
await mock.listen();

execSync("npx vite build --logLevel warn", {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, VITE_SUPABASE_URL: API, VITE_SUPABASE_ANON_KEY: mock.ANON_KEY, VITE_BASE_PATH: BASE },
});
const DIST = path.join(ROOT, "dist");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const web = http.createServer((req, res) => {
  const u = new URL(req.url, SITE);
  if (!u.pathname.startsWith(BASE)) {
    res.writeHead(404);
    return res.end();
  }
  let p = path.join(DIST, u.pathname.slice(BASE.length));
  if (!p.startsWith(DIST)) return res.end();
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!fs.existsSync(p)) p = path.join(DIST, "404.html");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => web.listen(WEB_PORT, "127.0.0.1", r));

if (process.env.E2E_SERVE_ONLY) {
  fs.writeFileSync(path.join(OUT, "anon-key.txt"), mock.ANON_KEY);
  console.log(`測試網站：${SITE}`);
  await new Promise(() => {});
}
const browser = await chromium.launch({
  // 本機容器沒有設定語系時，Chromium 會把中文下載檔名改成 "download"；真實裝置不受影響
  env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } : undefined,
});
const newContext = async (opts = {}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-TW", acceptDownloads: true, ...opts });
  ctx.setDefaultTimeout(15000);
  return ctx;
};

const consoleErrors = [];
const apiLog = [];
function watch(page, label) {
  page.on("pageerror", (e) => consoleErrors.push(`${label}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && apiLog.push(`${label} console: ${m.text()}`));
  page.on("response", async (r) => {
    if (r.status() >= 400 && r.url().startsWith(API)) apiLog.push(`${label} ${r.request().method()} ${r.url().slice(API.length, API.length + 90)} → ${r.status()} ${(await r.text().catch(() => "")).slice(0, 160)}`);
  });
  page.on("dialog", (d) => d.accept());
}

// 以 React 能接收的方式設定滑桿數值
async function setRange(locator, value) {
  await locator.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

// 圖片採 lazy loading，捲動整頁讓所有預覽圖載入
async function scrollAll(page) {
  const h = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < h; y += 500) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(80);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function login(page, user) {
  await page.goto(`${SITE}#/admin/login`);
  await page.getByLabel("電子郵件").fill(user.email);
  await page.getByLabel("密碼", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "登入" }).click();
}

const artworks = fs.existsSync(ART) ? fs.readdirSync(ART).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort() : [];

// ===================================================================
// 管理後臺
// ===================================================================
const ctxA = await newContext({ viewport: { width: 1366, height: 900 } });
const pageA = await ctxA.newPage();
watch(pageA, "管理員A");
debugPages.A = pageA;

await step("未登入不能進入管理後臺", async () => {
  await pageA.goto(`${SITE}#/admin`);
  await pageA.waitForURL(/#\/admin\/login/);
  check("未登入不能進入管理後臺（自動導向登入頁）", true);
});

await step("未授權帳號", async () => {
  const ctx = await newContext();
  const p = await ctx.newPage();
  watch(p, "未授權");
  await login(p, C);
  await p.getByText("此帳號沒有管理權限").waitFor();
  check("已登入但不在授權名單的帳號不能使用管理後臺", true);
  // 直接呼叫 API 嘗試繞過（拿 C 的 JWT 呼叫 REST / Storage / RPC）
  const tok = await (await fetch(`${API}/auth/v1/token?grant_type=password`, { method: "POST", body: JSON.stringify({ email: C.email, password: C.password }) })).json();
  const hdr = { apikey: mock.ANON_KEY, Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json", Prefer: "return=representation" };
  const ins = await fetch(`${API}/rest/v1/images`, { method: "POST", headers: hdr, body: JSON.stringify({ title: "x", preview_path: "x", original_path: "x", mime_type: "image/png", file_size: 1, width: 1, height: 1 }) });
  check("未授權帳號直接呼叫 API 新增作品被拒絕", ins.status === 403, `HTTP ${ins.status}`);
  const pw = await fetch(`${API}/rest/v1/rpc/set_download_password`, { method: "POST", headers: hdr, body: JSON.stringify({ p_new_password: "hacked-123" }) });
  check("未授權帳號直接呼叫 API 更換下載密碼被拒絕", pw.status === 403, `HTTP ${pw.status}`);
  const fd = new FormData();
  fd.append("", new Blob([fs.readFileSync(path.join(ART, artworks[0]))], { type: "image/png" }), "x.png");
  const up = await fetch(`${API}/storage/v1/object/originals/hack/x.png`, { method: "POST", headers: { apikey: mock.ANON_KEY, Authorization: `Bearer ${tok.access_token}` }, body: fd });
  check("未授權帳號直接上傳到私有 Storage 被拒絕", up.status >= 400, `HTTP ${up.status}`);
  const adm = await fetch(`${API}/rest/v1/admins`, { method: "POST", headers: hdr, body: JSON.stringify({ user_id: C.id, display_name: "我也要" }) });
  check("未授權帳號不能把自己加入管理員名單", adm.status === 403, `HTTP ${adm.status}`);
  await ctx.close();
});

await step("管理員 A 登入", async () => {
  await login(pageA, A);
  await pageA.getByRole("heading", { name: "作品管理" }).waitFor();
  check("管理員 A 可以登入管理後臺", true);
});

await step("設定下載密碼", async () => {
  await pageA.getByRole("link", { name: "網站設定" }).click();
  await pageA.getByText("尚未設定，粉絲目前無法下載").waitFor();
  await pageA.getByLabel("新的下載密碼（6～64 字元）").fill(DL_PASS_1);
  await pageA.getByLabel("再輸入一次").fill(DL_PASS_1);
  await pageA.getByRole("button", { name: "更換下載密碼" }).click();
  await pageA.getByText("下載密碼已更新").waitFor();
  await pageA.getByText(/由 管理員 A（我） 更新/).waitFor();
  check("管理員 A 可以設定粉絲下載密碼", true);
  const row = execFileSync("psql", ["-d", DB, "-Atc", "select password_hash from private.download_secret"]).toString().trim();
  check("資料庫中下載密碼只存 bcrypt 雜湊（無明文）", row.startsWith("$2a$10$") && !row.includes(DL_PASS_1));
});

await step("網站設定", async () => {
  await pageA.getByLabel("網站公告（留空則不顯示）").fill("十一月新作上架囉！熊大兔兔陪你過冬 ❄️");
  await pageA.getByLabel("Facebook 粉專網址").fill("https://www.facebook.com/kuma.studio.test");
  await pageA.getByRole("button", { name: "儲存網站設定" }).click();
  await pageA.getByText("網站設定已儲存").waitFor();
  check("管理員可以修改網站公告與 Facebook 粉專連結", true);
  await pageA.screenshot({ path: path.join(OUT, "admin-settings.png"), fullPage: true });
});

await step("分類管理", async () => {
  await pageA.getByRole("link", { name: "分類管理" }).click();
  await pageA.getByLabel("新增分類").fill("生日快樂");
  await pageA.getByRole("button", { name: "新增", exact: true }).click();
  await pageA.getByText("已新增分類「生日快樂」").waitFor();
  check("管理員可以新增分類", await pageA.locator(".cat-list li", { hasText: "生日快樂" }).isVisible());
  const row = pageA.locator(".cat-list li", { hasText: "生日快樂" });
  await row.getByRole("button", { name: "刪除" }).click();
  await pageA.getByText("已刪除分類「生日快樂」").waitFor();
  check("管理員可以刪除分類", (await pageA.locator(".cat-list li", { hasText: "生日快樂" }).count()) === 0);
});

const bunnies = artworks.filter((f) => !f.includes("熊大"));
const bears = artworks.filter((f) => f.includes("熊大"));

// 以檔案內容傳給瀏覽器（此環境的 Playwright 以路徑上傳中文檔名時不會觸發 change 事件）
const filePayload = (f) => ({ name: f, mimeType: "image/png", buffer: fs.readFileSync(path.join(ART, f)) });

async function uploadBatch(page, files, category) {
  await page.getByRole("link", { name: "作品管理" }).click();
  await page.getByLabel("預設分類").selectOption({ label: category });
  await page.getByTestId("upload-input").setInputFiles(files.map(filePayload));
  await page.waitForFunction((n) => document.querySelectorAll(".up-done, .up-error").length >= n, files.length, { timeout: 120000 });
  return page.locator(".up-error").count();
}

await step("上傳作品", async () => {
  check("找到管理員提供的作品", artworks.length === 20, `${artworks.length} 張`);
  const err1 = await uploadBatch(pageA, bunnies, "兔兔");
  const err2 = await uploadBatch(pageA, bears, "熊大");
  check("管理員可以一次上傳多張作品（20 張）", err1 + err2 === 0, `失敗 ${err1 + err2} 張`);
  const n = await pageA.getByTestId("admin-item").count();
  check("上傳後先成為草稿並列在後臺", n === 20, `${n} 筆`);
  const anon = await (await fetch(`${API}/rest/v1/images?select=id`, { headers: { apikey: mock.ANON_KEY } })).json();
  check("發布前粉絲看不到草稿", anon.length === 0, `訪客可見 ${anon.length} 筆`);
  await pageA.screenshot({ path: path.join(OUT, "admin-drafts.png"), fullPage: false });
});

await step("編輯作品名稱", async () => {
  const item = pageA.getByTestId("admin-item").filter({ hasText: "熊大害羞坐姿" });
  await item.getByRole("button", { name: "編輯" }).click();
  await pageA.getByLabel("作品名稱").fill("熊大的害羞時刻");
  await pageA.getByLabel("標籤（以頓號或空白分隔，最多 8 個）").fill("害羞、可愛");
  await pageA.getByRole("button", { name: "儲存", exact: true }).click();
  await pageA.getByText("已儲存。").waitFor();
  check("管理員可以編輯作品名稱與標籤", await pageA.getByText("熊大的害羞時刻").isVisible());
});

await step("發布", async () => {
  await pageA.getByRole("button", { name: /發布選取的草稿（20）/ }).click();
  await pageA.getByText("已發布 20 張作品").waitFor({ timeout: 20000 });
  const anon = await (await fetch(`${API}/rest/v1/images?select=id`, { headers: { apikey: mock.ANON_KEY } })).json();
  check("按「發布」後粉絲即可看到 20 張作品", anon.length === 20, `${anon.length} 筆`);
  const date = execFileSync("psql", ["-d", DB, "-Atc", "select latest_update_date = current_date from public.site_settings"]).toString().trim();
  check("發布時自動更新「最新更新日期」", date === "t");
});

// ---- 管理員 B（獨立帳號） ----
const ctxB = await newContext({ viewport: { width: 1180, height: 820 } });
const pageB = await ctxB.newPage();
watch(pageB, "管理員B");

await step("管理員 B", async () => {
  await login(pageB, B);
  await pageB.getByRole("heading", { name: "作品管理" }).waitFor();
  check("管理員 B 可以用自己的帳號登入", true);
  await pageB.waitForFunction(() => document.querySelectorAll("[data-testid=admin-item]").length >= 20).catch(() => {});
  check("管理員 B 看得到相同的作品清單", (await pageB.getByTestId("admin-item").count()) === 20);

  // 排序：把最後一張（熊大雲朵散步）往上移
  const before = await pageB.locator("[data-testid=admin-item] strong").allTextContents();
  const last = pageB.getByTestId("admin-item").last();
  await last.getByRole("button", { name: "上移" }).click();
  await pageB.waitForTimeout(800);
  const after = await pageB.locator("[data-testid=admin-item] strong").allTextContents();
  check("管理員 B 可以調整排序", after.at(-2) === before.at(-1) && after.at(-1) === before.at(-2), `${before.at(-1)} 上移`);

  // 上傳第 21 張後替換、刪除
  await uploadBatch(pageB, [bunnies[0]], "其他");
  const extra = pageB.getByTestId("admin-item").filter({ hasText: "草稿" });
  check("管理員 B 可以上傳作品", (await extra.count()) === 1);
  const chooser = pageB.waitForEvent("filechooser");
  await extra.getByRole("button", { name: "替換" }).click();
  await (await chooser).setFiles(filePayload(bears[0]));
  await pageB.getByText(/已替換/).waitFor();
  const dims = await extra.locator(".tiny").textContent();
  check("管理員 B 可以替換作品圖片", dims.includes("1920×1920"), dims);
  await extra.getByRole("button", { name: "刪除" }).click();
  await pageB.getByText(/已刪除/).waitFor();
  check("管理員 B 可以刪除作品（含 Storage 檔案）", (await pageB.getByTestId("admin-item").count()) === 20);
  const leftovers = execFileSync("psql", ["-d", DB, "-Atc", "select count(*) from storage.objects"]).toString().trim();
  check("刪除／替換後沒有遺留舊檔案", leftovers === "40", `storage.objects = ${leftovers}（20 原圖 + 20 預覽）`);

  // 管理員預覽平台裁切
  await pageB.getByTestId("admin-item").first().locator(".admin-thumb").click();
  await pageB.getByRole("tab", { name: "Instagram" }).click();
  await pageB.waitForTimeout(500);
  check("管理員可以預覽底圖在不同平台的裁切效果（不顯示下載）", (await pageB.getByRole("dialog").getByRole("button", { name: /下載/ }).count()) === 0);
  await pageB.screenshot({ path: path.join(OUT, "admin-platform-preview.png") });
  await pageB.getByRole("button", { name: "關閉" }).click();
});

await step("管理員 B 更換下載密碼", async () => {
  // 先以舊密碼取得下載憑證，確認更換後失效
  const r = await fetch(`${API}/functions/v1/download`, { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.7" }, body: JSON.stringify({ action: "verify", password: DL_PASS_1 }) });
  const oldToken = (await r.json()).token;
  await pageB.getByRole("link", { name: "網站設定" }).click();
  await pageB.getByLabel("新的下載密碼（6～64 字元）").fill(DL_PASS_2);
  await pageB.getByLabel("再輸入一次").fill(DL_PASS_2);
  await pageB.getByRole("button", { name: "更換下載密碼" }).click();
  await pageB.getByText("下載密碼已更新").waitFor();
  await pageB.getByText(/由 管理員 B（先生） 更新/).waitFor();
  check("管理員 B 也可以更換下載密碼", true);
  const s = await fetch(`${API}/functions/v1/download`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sign", token: oldToken, all: true }) });
  check("更換密碼後，舊的下載授權立即失效", s.status === 401, `HTTP ${s.status}`);
  const old = await fetch(`${API}/functions/v1/download`, { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.8" }, body: JSON.stringify({ action: "verify", password: DL_PASS_1 }) });
  check("更換密碼後舊密碼不能再使用", old.status === 401, `HTTP ${old.status}`);
  // 管理員 A 的登入不受影響
  await pageA.reload();
  await pageA.getByRole("heading", { name: "作品管理" }).waitFor();
  check("兩位管理員的登入互不影響（B 操作後 A 仍在登入狀態）", true);
});

process.env.E2E_ONLY_ADMIN && process.exit(0);
// ===================================================================
// 粉絲前臺
// ===================================================================
const ctxFan = await newContext({ viewport: { width: 1366, height: 900 } });
const fan = await ctxFan.newPage();
watch(fan, "粉絲");
let fontReport = "";

await step("首頁", async () => {
  await fan.goto(SITE);
  await fan.getByRole("heading", { name: "KUMA 熊兔大頭貼收藏館", level: 1 }).waitFor();
  await fan.waitForFunction(() => document.querySelectorAll("[data-testid=art-card] img").length >= 20);
  await scrollAll(fan);
  await fan.waitForFunction(() => [...document.querySelectorAll("[data-testid=art-card] img")].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 });
  check("首頁（GitHub Pages 子路徑）能正常開啟", true);
  const cards = await fan.getByTestId("art-card").count();
  check("全部作品區顯示 20 張作品", (await fan.locator("#all-title").textContent()).includes("20 張"), `${cards} 張卡片（含本月區）`);
  check("顯示最新更新日期", await fan.getByText(/最新更新：/).isVisible());
  check("顯示網站公告", await fan.getByText("十一月新作上架囉").isVisible());
  check("顯示 Facebook 粉專連結", (await fan.getByRole("link", { name: "Facebook 粉專", exact: true }).getAttribute("href")) === "https://www.facebook.com/kuma.studio.test");
  check("顯示本月大頭貼區", await fan.getByRole("heading", { name: "本月大頭貼" }).isVisible());
  await fan.getByRole("tab", { name: "熊大", exact: true }).click();
  const bearsShown = await fan.locator("section[aria-labelledby=all-title] [data-testid=art-card]").count();
  check("分類篩選正常（熊大 4 張）", bearsShown === 4, `${bearsShown} 張`);
  await fan.getByRole("tab", { name: "全部" }).click();
  await fan.screenshot({ path: path.join(OUT, "fan-desktop.png"), fullPage: false });
  await fan.reload();
  await fan.waitForFunction(() => document.querySelectorAll("[data-testid=art-card]").length >= 20);
  check("重新整理後資料仍然存在", true);
});

await step("私有原圖保護", async () => {
  const pathRow = execFileSync("psql", ["-d", DB, "-Atc", "select original_path from public.images limit 1"]).toString().trim();
  const pub = await fetch(`${API}/storage/v1/object/public/originals/${pathRow}`);
  check("私有原圖不能透過公開 Storage 網址取得", pub.status >= 400, `HTTP ${pub.status}`);
  const direct = await fetch(`${API}/storage/v1/object/originals/${pathRow}`, { headers: { apikey: mock.ANON_KEY } });
  check("訪客不能以 API 直接下載私有原圖", direct.status >= 400, `HTTP ${direct.status}`);
  const col = await fetch(`${API}/rest/v1/images?select=original_path`, { headers: { apikey: mock.ANON_KEY } });
  check("訪客查不到私有原圖路徑", col.status === 403, `HTTP ${col.status}`);
  const noTok = await fetch(`${API}/functions/v1/download`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sign", all: true }) });
  check("未輸入密碼時不能取得下載網址（含 ZIP）", noTok.status === 401, `HTTP ${noTok.status}`);
});

async function canvasDataUrl(page) {
  return page.getByTestId("crop-canvas").evaluate((c) => c.toDataURL("image/png"));
}

async function compareImages(page, aUrl, bUrl) {
  return page.evaluate(
    async ([a, b]) => {
      const load = (src) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = src; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const S = 256;
      const px = (img) => {
        const c = document.createElement("canvas");
        c.width = S;
        c.height = S;
        const x = c.getContext("2d");
        x.drawImage(img, 0, 0, S, S);
        return x.getImageData(0, 0, S, S).data;
      };
      const da = px(ia);
      const db = px(ib);
      let sum = 0;
      for (let i = 0; i < da.length; i++) sum += Math.abs(da[i] - db[i]);
      return sum / da.length;
    },
    [aUrl, bUrl],
  );
}

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

async function openEditor(page, title, platform = "Facebook") {
  const card = page.locator("section[aria-labelledby=all-title] [data-testid=art-card]").filter({ hasText: title });
  await card.getByRole("button", { name: platform, exact: true }).click();
  await page.getByTestId("crop-stage").waitFor();
  await page.waitForFunction(() => {
    const c = document.querySelector("[data-testid=crop-canvas]");
    return c && c.width > 0 && !document.querySelector(".stage-msg");
  });
  await page.waitForTimeout(300);
}

await step("三種平台預覽與裁切", async () => {
  await openEditor(fan, "掰掰");
  for (const p of ["Facebook", "Instagram", "LINE"]) {
    await fan.getByRole("tab", { name: p, exact: true }).click();
    await fan.waitForTimeout(200);
    const mask = await fan.locator(".stage-overlay .mask").count();
    const safe = await fan.locator(".stage-overlay .safe").count();
    check(`${p}：預覽切換正常（${p === "LINE" ? "方形" : "圓形遮罩"}${p === "Instagram" ? "＋安全範圍" : ""}）`, p === "LINE" ? mask === 0 : mask === 1 && (p !== "Instagram" || safe === 1));
    await fan.screenshot({ path: path.join(OUT, `editor-${p}.png`) });
  }
});

await step("錯誤密碼與未輸入密碼", async () => {
  await fan.getByRole("button", { name: /下載 LINE 大頭貼/ }).click();
  await fan.getByRole("dialog", { name: "輸入下載密碼" }).waitFor();
  await fan.getByRole("button", { name: "確認" }).click();
  check("未輸入密碼時顯示提示", await fan.getByText("請輸入下載密碼。").isVisible());
  await fan.getByLabel("下載密碼", { exact: true }).fill("wrong-password");
  await fan.getByRole("button", { name: "確認" }).click();
  await fan.getByText(/下載密碼不正確/).waitFor();
  check("錯誤密碼不能取得下載權限，並顯示繁中提示", true, await fan.locator("#pw-error").textContent());
});

await step("正確密碼下載單張（LINE、透明 PNG）", async () => {
  await fan.getByLabel("下載密碼", { exact: true }).fill(DL_PASS_2);
  const [d] = await Promise.all([fan.waitForEvent("download"), fan.getByRole("button", { name: "確認" }).click()]);
  const file = path.join(OUT, d.suggestedFilename());
  await d.saveAs(file);
  check("正確密碼可以下載單張大頭貼", true);
  check("檔名格式 KUMA_LINE_作品名稱.png", d.suggestedFilename() === "KUMA_LINE_掰掰.png", d.suggestedFilename());
  const png = readPng(file);
  check("下載為方形圖片且保留原比例", png.width === png.height, `${png.width}×${png.height}`);
  check("透明背景的 PNG 保留透明（角落 alpha = 0）", png.data[3] === 0, `alpha=${png.data[3]}`);
});

await step("背景色＋裁切一致性（Facebook，兔兔）", async () => {
  await fan.getByRole("tab", { name: "Facebook", exact: true }).click();
  await fan.getByRole("button", { name: "粉紅" }).click();
  const stage = fan.getByTestId("crop-stage");
  const box = await stage.boundingBox();
  await setRange(fan.getByLabel("縮放", { exact: true }), 1.6);
  await fan.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await fan.mouse.down();
  await fan.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 8 });
  await fan.mouse.up();
  await fan.waitForTimeout(300);
  const preview = await canvasDataUrl(fan);
  const [d] = await Promise.all([fan.waitForEvent("download"), fan.getByRole("button", { name: "下載 Facebook 大頭貼" }).click()]);
  const file = path.join(OUT, "fb-bunny.png");
  await d.saveAs(file);
  const png = readPng(file);
  check("15 分鐘內再次下載不需重新輸入密碼", true);
  check("選擇背景色時才填色（角落不透明）", png.data[3] === 255);
  const diff = await compareImages(fan, preview, `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`);
  check("預覽與下載的裁切位置一致（縮放＋拖曳後）", diff < 6, `平均像素差 ${diff.toFixed(2)}／255`);
  await fan.getByRole("button", { name: "關閉" }).click();
});

await step("觸控拖曳（手機）", async () => {
  const ctx = await newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
  const m = await ctx.newPage();
  watch(m, "手機");
  await m.goto(SITE);
  await m.waitForFunction(() => document.querySelectorAll("[data-testid=art-card] img").length >= 20);
  await m.screenshot({ path: path.join(OUT, "fan-iphone.png") });
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("手機版（390px）排版沒有水平捲動", overflow <= 0, `溢出 ${overflow}px`);
  await openEditor(m, "熊大乖乖坐", "Instagram");
  const before = await canvasDataUrl(m);
  const stage = m.getByTestId("crop-stage");
  const box = await stage.boundingBox();
  // 以 CDP 送出真實觸控事件：先放大再拖曳
  const cdp = await ctx.newCDPSession(m);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  await touch("touchStart", [[cx - 30, cy], [cx + 30, cy]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[cx - 30 - i * 8, cy], [cx + 30 + i * 8, cy]]);
  await touch("touchEnd", []);
  await touch("touchStart", [[cx, cy]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[cx + i * 6, cy + i * 4]]);
  await touch("touchEnd", []);
  await m.waitForTimeout(300);
  const zoomLabel = await m.getByText(/縮放（\d+%）/).textContent();
  const after = await canvasDataUrl(m);
  check("手機觸控雙指縮放與拖曳可以調整裁切", before !== after && !zoomLabel.includes("（100%）"), zoomLabel);
  await m.screenshot({ path: path.join(OUT, "editor-iphone.png") });
  await ctx.close();
});

await step("iPad 版面", async () => {
  const ctx = await newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(SITE);
  await p.waitForFunction(() => document.querySelectorAll("[data-testid=art-card] img").length >= 20);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("iPad（820px）排版沒有水平捲動", overflow <= 0, `溢出 ${overflow}px`);
  await p.screenshot({ path: path.join(OUT, "fan-ipad.png") });
  await openEditor(p, "早安");
  await p.screenshot({ path: path.join(OUT, "editor-ipad.png") });
  await ctx.close();
});

// ---------- 粉絲文字編輯器 ----------
await step("文字編輯器", async () => {
  await openEditor(fan, "熊大雲朵散步");
  await fan.getByRole("tab", { name: /^文字/ }).click();
  await fan.getByRole("button", { name: "＋ 新增文字" }).click();
  await fan.getByTestId("text-input").fill("早安呀\n熊大愛你 💕");
  await fan.getByLabel("文字顏色 #e85d75").click();
  await setRange(fan.getByTestId("text-size"), 0.09);
  await fan.getByRole("button", { name: "＋ 新增文字" }).click();
  await fan.getByTestId("text-input").fill("KUMA 2026 ✨");
  await fan.getByRole("button", { name: "靠左" }).click();
  await setRange(fan.getByLabel("文字背景透明度"), 0.7);
  check("可以新增多個文字區塊（中文、英文、數字、表情符號、多行）", (await fan.locator(".text-panel .chip").count()) === 2);

  // 拖曳第二個文字到左上角（超出圓形）
  const stage = fan.getByTestId("crop-stage");
  const box = await stage.boundingBox();
  const sel = await fan.locator(".stage-overlay .sel").boundingBox();
  await fan.mouse.move(sel.x + sel.width / 2, sel.y + sel.height / 2);
  await fan.mouse.down();
  await fan.mouse.move(box.x - 200, box.y - 200, { steps: 10 });
  await fan.mouse.up();
  const sel2 = await fan.locator(".stage-overlay .sel").boundingBox();
  check("文字可以拖曳，且不會被拖出畫布外", sel2.x >= box.x - 1 && sel2.y >= box.y - 1, `框左上 (${Math.round(sel2.x - box.x)}, ${Math.round(sel2.y - box.y)})`);
  check("文字超出圓形範圍時顯示提醒", await fan.getByText(/超出圓形/).isVisible());
  await fan.getByRole("button", { name: "移入安全範圍" }).click();
  await fan.waitForTimeout(200);
  check("「移入安全範圍」後文字完全在圓形內", (await fan.getByText(/超出圓形/).count()) === 0);

  // 撤銷
  await fan.getByRole("button", { name: "↶ 撤銷" }).click();
  await fan.waitForTimeout(200);
  check("撤銷可以回到上一步", await fan.getByText(/超出圓形/).isVisible());
  await fan.getByRole("button", { name: "移入安全範圍" }).click();

  // 字型確認：中文以 Noto Sans TC 繪製
  fontReport = await fan.evaluate(async () => {
    await document.fonts.ready;
    const ok = document.fonts.check('700 48px "Noto Sans TC"', "早安呀熊大愛你");
    return ok ? "Noto Sans TC 已載入" : "Noto Sans TC 未載入（使用系統字體）";
  });
  check("中文字體已載入", fontReport.includes("已載入"), fontReport);

  await fan.waitForTimeout(500);
  const preview = await canvasDataUrl(fan);
  await fan.screenshot({ path: path.join(OUT, "editor-text.png") });
  const [d] = await Promise.all([fan.waitForEvent("download"), fan.getByRole("button", { name: "下載我的專屬大頭貼" }).click()]);
  const file = path.join(OUT, "custom-text.png");
  await d.saveAs(file);
  const png = readPng(file);
  check("正確密碼能下載個人化 PNG", d.suggestedFilename() === "KUMA_FB_熊大雲朵散步.png", d.suggestedFilename());
  check("個人化成品以原圖解析度匯出（非螢幕截圖）", png.width === 1920, `${png.width}×${png.height}`);
  const diff = await compareImages(fan, preview, `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`);
  check("下載成品與畫面預覽一致（含文字位置）", diff < 6, `平均像素差 ${diff.toFixed(2)}／255`);

  // 文字確實存在於下載檔：與不含文字的版本比較文字區域
  const textPixels = await fan.evaluate(async (src) => {
    const i = new Image();
    i.src = src;
    await i.decode();
    const c = document.createElement("canvas");
    c.width = i.width;
    c.height = i.height;
    const x = c.getContext("2d");
    x.drawImage(i, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let pink = 0;
    for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - 0xe8) < 12 && Math.abs(d[k + 1] - 0x5d) < 12 && Math.abs(d[k + 2] - 0x75) < 12) pink++;
    return pink;
  }, `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`);
  check("匯出圖片含有文字（未遺失中文字）", textPixels > 5000, `文字顏色像素 ${textPixels}`);

  // 重設設計
  await fan.getByRole("button", { name: "重設設計" }).click();
  check("可以重設設計", (await fan.locator(".text-panel .chip").count()) === 0);
  await fan.getByRole("button", { name: "關閉" }).click();
});

await step("表情符號字型", async () => {
  const r = await fan.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 80;
    c.height = 80;
    const x = c.getContext("2d");
    x.font = '60px "Noto Sans TC", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    x.textBaseline = "top";
    x.fillStyle = "#000";
    x.fillText("💕", 5, 5);
    const d = x.getImageData(0, 0, 80, 80).data;
    let colored = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (Math.abs(d[i] - d[i + 1]) > 40 || Math.abs(d[i] - d[i + 2]) > 40)) colored++;
    return colored;
  });
  check("表情符號以彩色字型繪製（本機 Chromium＋Noto Color Emoji）", r > 100, `彩色像素 ${r}`);
});

await step("下載全部 ZIP", async () => {
  const [d] = await Promise.all([fan.waitForEvent("download", { timeout: 60000 }), fan.getByRole("button", { name: "下載全部大頭貼（ZIP）" }).click()]);
  const file = path.join(OUT, d.suggestedFilename());
  await d.saveAs(file);
  const entries = unzipSync(fs.readFileSync(file));
  const names = Object.keys(entries);
  check("正確密碼可以下載全部 ZIP", names.length === 20, `${d.suggestedFilename()}，${names.length} 個檔案`);
  check("ZIP 內使用有意義且不重複的檔名", new Set(names).size === 20 && names.every((n) => /^KUMA_\d{2}_.+\.(png|jpg|webp)$/.test(n)), names.slice(0, 3).join("、") + "…");
  const orig = fs.readFileSync(path.join(ART, "16_掰掰.png"));
  const inZip = names.find((n) => n.endsWith("掰掰.png"));
  check("ZIP 內為原始檔案（位元組完全相同）", inZip && Buffer.compare(Buffer.from(entries[inZip]), orig) === 0);
  await fan.getByText(/已完成！共 20 張作品/).waitFor();
});

await step("防暴力猜測", async () => {
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${API}/functions/v1/download`, { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.50" }, body: JSON.stringify({ action: "verify", password: `guess-${i}` }) });
    codes.push(r.status);
  }
  const ok = await fetch(`${API}/functions/v1/download`, { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.50" }, body: JSON.stringify({ action: "verify", password: DL_PASS_2 }) });
  const body = await ok.json();
  check("同一來源錯誤 5 次後鎖定，連正確密碼也暫時拒絕", codes.slice(0, 5).every((c) => c === 401) && codes[5] === 429 && ok.status === 429, `${codes.join(",")} → ${ok.status}「${body.message}」`);
  const other = await fetch(`${API}/functions/v1/download`, { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.51" }, body: JSON.stringify({ action: "verify", password: DL_PASS_2 }) });
  check("其他來源的粉絲不受影響", other.status === 200);
});

await step("撤銷管理員", async () => {
  psql(["-d", DB, "-c", `update public.admins set is_active = false where user_id = '${B.id}'`]);
  await pageB.getByRole("link", { name: "網站設定" }).click();
  await pageB.getByLabel("網站公告（留空則不顯示）").fill("B 被撤銷後的修改");
  await pageB.getByRole("button", { name: "儲存網站設定" }).click();
  await pageB.getByText(/沒有管理權限/).waitFor();
  check("撤銷後，已登入中的 B 也不能再修改資料", true);
  await pageB.reload();
  await pageB.getByText("此帳號（admin-b@example.test）不在授權名單中").waitFor().catch(() => {});
  check("撤銷後 B 重新整理會看到「沒有管理權限」", await pageB.getByRole("heading", { name: "沒有管理權限" }).isVisible());
  const ann = execFileSync("psql", ["-d", DB, "-Atc", "select announcement from public.site_settings"]).toString().trim();
  check("撤銷後的修改沒有寫入資料庫", !ann.includes("B 被撤銷"), ann);
  await pageA.reload();
  await pageA.getByRole("heading", { name: "作品管理" }).waitFor();
  check("撤銷 B 不影響管理員 A", true);
});

check("瀏覽器沒有 JavaScript 錯誤", consoleErrors.length === 0, consoleErrors.slice(0, 3).join("｜"));

await browser.close();
await mock.close();
web.close();

const passed = results.filter((r) => r.ok).length;
const report = [
  "# 端到端測試報告（本機 Chromium＋Supabase 相容測試伺服器）",
  "",
  `執行時間：${new Date().toISOString()}`,
  `結果：${passed}/${results.length} 通過`,
  "",
  "| 結果 | 項目 | 說明 |",
  "| --- | --- | --- |",
  ...results.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.name} | ${r.detail.replace(/\|/g, "／").replace(/\n/g, " ")} |`),
  "",
].join("\n");
fs.writeFileSync(path.join(OUT, "report.md"), report);
fs.writeFileSync(path.join(OUT, "api-errors.log"), apiLog.join("\n"));
console.log(`\n${passed}/${results.length} 通過，報告：tests/e2e/output/report.md`);
process.exit(passed === results.length ? 0 : 1);
