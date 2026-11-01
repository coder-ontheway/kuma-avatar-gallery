// =====================================================================
// 端到端驗收測試：KUMA 熊兔生命共同體限定收藏館
// 執行：npm run test:e2e:life
// 需求：本機 PostgreSQL、Playwright Chromium、
//       tests/e2e/private-artworks/life/ 內放管理員提供的十張原始照片（此資料夾不提交到 GitHub），
//       檔名依序排列即可（例如 IMG_4755.jpeg ～ IMG_4764.jpeg 對應 No.001 ～ No.010）。
// =====================================================================
import { execFileSync, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { PNG } from "pngjs";
import { unzipSync } from "fflate";
import { createMockSupabase } from "./mock-supabase.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "tests/e2e/output-life");
const ART = path.join(ROOT, "tests/e2e/private-artworks/life");
const DB = "kuma_e2e_life";
const API_PORT = 54331;
const WEB_PORT = 4183;
const BASE = "/kuma-avatar-gallery/";
const SITE = `http://127.0.0.1:${WEB_PORT}${BASE}`;
const API = `http://127.0.0.1:${API_PORT}`;
const DIST = path.join(OUT, "dist");

const USERS = [
  { id: "aaaaaaaa-1111-4111-8111-000000000001", email: "admin-a@example.test", password: "Admin-A-pass-123", name: "管理員 A（我）" },
  { id: "bbbbbbbb-2222-4222-8222-000000000002", email: "admin-b@example.test", password: "Admin-B-pass-456", name: "管理員 B（先生）" },
];
const [A, B] = USERS;
const DL_PASS = "kuma-life-2026"; // 原本收藏館的下載密碼
const LIFE_PASS = "one-heart-0711"; // 生命共同體專屬下載密碼（由管理員在後臺設定）

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
    }
  }
}
const sql = (q) => execFileSync("psql", ["-q", "-d", DB, "-tAc", q], { encoding: "utf8" }).trim();
const md5 = (buf) => crypto.createHash("md5").update(buf).digest("hex");

function jpegSize(buf) {
  for (let i = 2; i < buf.length; ) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

// ---------- 資料庫 ----------
const psql = (args) => execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", ...args], { stdio: ["ignore", "ignore", "inherit"] });
psql(["-d", "postgres", "-c", `drop database if exists ${DB}`, "-c", `create database ${DB}`]);
psql(["-d", DB, "-f", path.join(ROOT, "supabase/tests/local_mock_supabase.sql")]);
for (const f of fs.readdirSync(path.join(ROOT, "supabase/migrations")).sort()) psql(["-d", DB, "-f", path.join(ROOT, "supabase/migrations", f)]);
psql(["-d", DB, "-c", `insert into auth.users (id, email) values ${USERS.map((u) => `('${u.id}','${u.email}')`).join(",")}`]);
psql(["-d", DB, "-c", `insert into public.admins (user_id, display_name) values ('${A.id}', '${A.name}'), ('${B.id}', '${B.name}')`]);
// 下載密碼：與正式流程相同，以 bcrypt 雜湊存在 private schema
psql(["-d", DB, "-c", `update private.download_secret set password_hash = extensions.crypt('${DL_PASS}', extensions.gen_salt('bf', 6)), version = 1 where id = 1`]);
// 原本收藏館放一張作品，用來確認兩邊互不干擾
psql(["-d", DB, "-c", `insert into public.images (id, title, preview_path, original_path, mime_type, file_size, width, height, is_published) values ('11111111-0000-4000-8000-000000000001', '原本作品', 'old/p.png', 'old/o.png', 'image/png', 100, 10, 10, true)`]);

const mock = createMockSupabase({ database: DB, storageDir: path.join(OUT, "storage"), users: USERS, port: API_PORT });
await mock.listen();

execSync(`npx vite build --logLevel warn --outDir ${JSON.stringify(DIST)} --emptyOutDir`, {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, VITE_SUPABASE_URL: API, VITE_SUPABASE_ANON_KEY: mock.ANON_KEY, VITE_BASE_PATH: BASE },
});
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
  console.log(`測試網站：${SITE}`);
  await new Promise(() => {});
}

const browser = await chromium.launch({
  env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } : undefined,
});
const newContext = async (opts = {}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: "zh-TW", acceptDownloads: true, ...opts });
  ctx.setDefaultTimeout(20000);
  return ctx;
};
const consoleErrors = [];
function watch(page, label) {
  page.on("pageerror", (e) => consoleErrors.push(`${label}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
}
async function setRange(locator, value) {
  await locator.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}
async function login(page, user) {
  await page.goto(`${SITE}#/admin/login`);
  await page.getByLabel("電子郵件").fill(user.email);
  await page.getByLabel("密碼", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "登入" }).click();
  await page.getByRole("heading", { name: "作品管理" }).waitFor();
}
async function scrollAll(page) {
  const h = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < h; y += 500) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

const photos = fs.existsSync(ART) ? fs.readdirSync(ART).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort() : [];
const payload = (f) => ({ name: f, mimeType: /\.png$/i.test(f) ? "image/png" : "image/jpeg", buffer: fs.readFileSync(path.join(ART, f)) });

// ===================================================================
// 管理員：十款作品
// ===================================================================
const ctxA = await newContext({ viewport: { width: 1366, height: 900 } });
const pageA = await ctxA.newPage();
watch(pageA, "管理員A");
debugPages.A = pageA;

await step("初始待上傳狀態", async () => {
  check("找到十張原始照片", photos.length === 10, `${photos.length} 張`);
  await login(pageA, A);
  await pageA.getByRole("link", { name: "生命共同體" }).click();
  await pageA.getByRole("heading", { name: "熊兔生命共同體" }).waitFor();
  const items = pageA.getByTestId("life-admin-item");
  await items.first().waitFor();
  check("後臺有十款作品位置", (await items.count()) === 10, `${await items.count()} 筆`);
  check("尚未上傳時顯示「待上傳」，沒有放入虛構照片", (await pageA.locator(".pending-thumb").count()) === 10);
  const anon = await (await fetch(`${API}/rest/v1/collection_works?select=id`, { headers: { apikey: mock.ANON_KEY } })).json();
  check("待上傳作品粉絲看不到", anon.length === 0, `訪客可見 ${anon.length} 筆`);
  const publishBtn = items.first().getByRole("button", { name: "公開" });
  check("待上傳作品不能公開", await publishBtn.isDisabled());
});

await step("批次上傳十張", async () => {
  await pageA.getByTestId("life-batch-input").setInputFiles(photos.map(payload));
  const rows = pageA.getByTestId("life-plan").locator("li");
  await rows.first().waitFor();
  const selects = await pageA.getByTestId("life-plan").locator("select").evaluateAll((els) => els.map((e) => Number(e.value)));
  check("十張照片自動對應 No.001～No.010（依檔名順序）", JSON.stringify(selects) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), selects.join(","));
  await pageA.getByTestId("life-batch-start").click();
  await pageA.waitForFunction(() => document.querySelectorAll("[data-testid=life-plan] li.up-done, [data-testid=life-plan] li.up-error").length >= 10, null, { timeout: 120000 });
  check("十張全部上傳成功", (await pageA.locator("[data-testid=life-plan] li.up-error").count()) === 0);
  const rowsDb = sql("select count(*) || '/' || count(distinct original_path) || '/' || count(distinct work_number) || '/' || count(distinct nickname) from public.collection_works where original_path is not null");
  check("十張照片分別建立十筆資料（不同原圖、編號、稱號）", rowsDb === "10/10/10/10", rowsDb);
  const mapping = sql("select string_agg(work_number || '=' || file_size, ',' order by work_number) from public.collection_works");
  const expected = photos.map((f, i) => `${i + 1}=${fs.statSync(path.join(ART, f)).size}`).join(",");
  check("每一款使用自己的原始照片（No.001～No.010 對應正確）", mapping === expected);
  // 原圖原封不動存在私有空間
  const paths = sql("select string_agg(original_path, ',' order by work_number) from public.collection_works").split(",");
  const same = paths.every((p, i) => md5(fs.readFileSync(path.join(OUT, "storage", "originals", p))) === md5(fs.readFileSync(path.join(ART, photos[i]))));
  check("原圖未經修改（位元組與上傳檔案完全相同）", same);
  check("原圖存放於私有 originals 的 life/ 路徑", paths.every((p) => p.startsWith("life/")));
  check("上傳後先是草稿", sql("select count(*) from public.collection_works where is_published") === "0");
  await pageA.screenshot({ path: path.join(OUT, "admin-life-uploaded.png"), fullPage: true });
});

await step("單張上傳（替換 No.005）", async () => {
  const item = pageA.getByTestId("life-admin-item").filter({ hasText: "No.005" });
  const oldPath = sql("select original_path from public.collection_works where work_number = 5");
  const chooser = pageA.waitForEvent("filechooser");
  await item.getByRole("button", { name: "替換照片" }).click();
  await (await chooser).setFiles(payload(photos[4]));
  await pageA.getByText("已上傳 No.005 的照片").waitFor();
  const newPath = sql("select original_path from public.collection_works where work_number = 5");
  check("可以單獨上傳／替換某一款的照片", newPath !== oldPath && newPath.startsWith("life/"));
  check("替換後舊檔案已刪除（不重複儲存）", !fs.existsSync(path.join(OUT, "storage", "originals", oldPath)));
  check("其他作品不受影響", sql("select count(distinct original_path) from public.collection_works") === "10");
});

const ctxB = await newContext({ viewport: { width: 1180, height: 820 } });
const pageB = await ctxB.newPage();
watch(pageB, "管理員B");
debugPages.B = pageB;

await step("管理員 B 管理作品", async () => {
  await login(pageB, B);
  await pageB.getByRole("link", { name: "生命共同體" }).click();
  await pageB.getByTestId("life-admin-item").first().waitFor();
  check("管理員 B 看得到相同的十款作品", (await pageB.getByTestId("life-admin-item").count()) === 10);
  const item = pageB.getByTestId("life-admin-item").filter({ hasText: "No.002" });
  await item.getByRole("button", { name: "編輯資料" }).click();
  await pageB.getByLabel("專屬稱號").fill("心動共鳴體");
  await pageB.getByLabel("作品名稱").fill("星空下的心動");
  await pageB.getByLabel("生命共同體介紹（顯示在身份證與收藏卡）").fill("兩顆心在星空下產生共鳴。");
  await pageB.getByLabel("專屬愛心宣言（收藏卡與大頭貼預設文字）").fill("熊兔合體，誰也拆不開！💞");
  await pageB.getByRole("button", { name: "儲存", exact: true }).click();
  await pageB.getByText("作品資料已儲存。").waitFor();
  check("管理員 B 可以修改名稱、介紹與宣言", sql("select title || '|' || manifesto from public.collection_works where work_number = 2") === "星空下的心動|熊兔合體，誰也拆不開！💞");
  // 排序
  const before = await pageB.locator("[data-testid=life-admin-item] strong").allTextContents();
  await pageB.getByTestId("life-admin-item").nth(1).getByRole("button", { name: "上移" }).click();
  await pageB.waitForTimeout(800);
  const after = await pageB.locator("[data-testid=life-admin-item] strong").allTextContents();
  check("管理員 B 可以調整排序", after[0] === before[1] && after[1] === before[0]);
  await pageB.getByTestId("life-admin-item").nth(1).getByRole("button", { name: "上移" }).click();
  await pageB.waitForTimeout(800);
  // 新增、刪除
  await pageB.getByRole("button", { name: "＋ 新增一款" }).click();
  await pageB.getByRole("button", { name: "取消" }).click();
  check("可以新增 No.011（待上傳）", sql("select count(*) from public.collection_works where work_number = 11 and original_path is null") === "1");
  await pageB.getByTestId("life-admin-item").filter({ hasText: "No.011" }).getByRole("button", { name: "刪除" }).click();
  await pageB.getByText("已刪除 No.011").waitFor();
  check("可以刪除作品", sql("select count(*) from public.collection_works") === "10");
  // 系列設定（預設宣言）
  await pageB.getByLabel("系列主題句").fill("一顆心，兩個靈魂；十種模樣，一個共同的生命。");
  await pageB.getByRole("button", { name: "儲存系列設定" }).click();
  await pageB.getByText("系列設定已儲存。").waitFor();
  check("管理員 B 可以修改系列設定", true);
  // 保護區域
  await pageB.getByTestId("life-admin-item").filter({ hasText: "No.003" }).getByRole("button", { name: "保護區域" }).click();
  await pageB.locator(".zone-stage img").waitFor();
  await pageB.screenshot({ path: path.join(OUT, "admin-zones.png") });
  await pageB.getByRole("button", { name: "儲存保護區域" }).click();
  await pageB.getByText("保護區域已儲存。").waitFor();
  check("管理員可以檢視並儲存保護區域", sql("select jsonb_array_length(protect_zones) from public.collection_works where work_number = 3") === "2");
});

await step("生命共同體專屬下載密碼", async () => {
  const form = pageB.getByTestId("life-password-form");
  await form.getByText(/尚未設定/).waitFor();
  check("後臺顯示專屬密碼尚未設定", true);
  await form.getByLabel("新的專屬下載密碼（6～64 字元）").fill(LIFE_PASS);
  await form.getByLabel("再輸入一次").fill("different-1");
  await form.getByRole("button", { name: "設定專屬下載密碼" }).click();
  await form.getByText("兩次輸入的密碼不一致。").waitFor();
  check("兩次輸入不一致時不會儲存", sql("select count(*) from private.collection_download_secret") === "0");
  await form.getByLabel("再輸入一次").fill(LIFE_PASS);
  await form.getByRole("button", { name: "設定專屬下載密碼" }).click();
  await form.getByText(/專屬下載密碼已更新/).waitFor();
  await form.getByText(/已設定（第 1 版/).waitFor();
  check("管理員 B 可以設定生命共同體專屬下載密碼", sql("select version from private.collection_download_secret") === "1");
  check("專屬密碼以雜湊存放（不是明文）", sql(`select (password_hash <> '${LIFE_PASS}' and password_hash like '$2%')::text from private.collection_download_secret`) === "true");
  check("設定專屬密碼不影響原本收藏館的密碼", sql("select version from private.download_secret") === "1");
  await pageB.screenshot({ path: path.join(OUT, "admin-life-password.png") });
});

await step("公開與預覽", async () => {
  await pageA.reload();
  await pageA.getByTestId("life-admin-item").first().waitFor();
  await pageA.getByRole("button", { name: "公開所有已上傳的草稿" }).click();
  await pageA.getByText("已公開 10 款作品").waitFor();
  const anon = await (await fetch(`${API}/rest/v1/collection_works?select=id`, { headers: { apikey: mock.ANON_KEY } })).json();
  check("公開後粉絲看得到十款", anon.length === 10, `${anon.length} 筆`);
  const priv = await fetch(`${API}/rest/v1/collection_works?select=original_path`, { headers: { apikey: mock.ANON_KEY } });
  check("粉絲查不到系列原圖路徑", priv.status === 403, `HTTP ${priv.status}`);
  const p = sql("select original_path from public.collection_works where work_number = 1");
  const direct = await fetch(`${API}/storage/v1/object/public/originals/${p}`);
  check("私有原圖不能用公開網址取得", direct.status >= 400, `HTTP ${direct.status}`);
  // 下架一款 → 預覽模式看得到、粉絲看不到
  await pageA.getByTestId("life-admin-item").filter({ hasText: "No.010" }).getByRole("button", { name: "下架" }).click();
  await pageA.getByText("已下架 No.010").waitFor();
  const prev = await ctxA.newPage();
  await prev.goto(`${SITE}#/life?preview=1`);
  await prev.getByTestId("life-card").first().waitFor();
  check("管理員預覽頁面可看到草稿", (await prev.getByTestId("life-card").count()) === 10 && (await prev.getByText("管理員預覽模式").isVisible()));
  await prev.goto(`${SITE}#/life`);
  await prev.reload();
  await prev.getByTestId("life-card").first().waitFor();
  await prev.waitForTimeout(500);
  check("管理員看「粉絲實際頁面」時不顯示草稿", (await prev.getByTestId("life-card").count()) === 9, `${await prev.getByTestId("life-card").count()} 款`);
  await prev.close();
  await pageA.getByTestId("life-admin-item").filter({ hasText: "No.010" }).getByRole("button", { name: "公開" }).click();
  await pageA.getByText("已公開 No.010").waitFor();
});

// ===================================================================
// 粉絲
// ===================================================================
const ctxFan = await newContext({ viewport: { width: 1280, height: 860 } });
const fan = await ctxFan.newPage();
watch(fan, "粉絲");
debugPages.fan = fan;

await step("原本收藏館與入口", async () => {
  await fan.goto(SITE);
  await fan.getByRole("heading", { name: "KUMA 熊兔大頭貼收藏館", level: 1 }).waitFor();
  await fan.getByTestId("art-card").first().waitFor();
  check("原本收藏館正常顯示原本作品", (await fan.getByTestId("art-card").count()) >= 1);
  await fan.getByTestId("life-entry").waitFor();
  check("首頁有「熊兔生命共同體限定收藏館」入口", await fan.getByTestId("life-entry").getByText("熊兔生命共同體限定收藏館").isVisible());
  await fan.screenshot({ path: path.join(OUT, "home-entry.png") });
  await fan.getByTestId("life-entry").click();
  await fan.getByRole("heading", { name: "KUMA 熊兔生命共同體", level: 1 }).waitFor();
  await fan.getByTestId("life-card").first().waitFor();
  await scrollAll(fan);
  await fan.waitForFunction(() => [...document.querySelectorAll("[data-testid=life-card] img")].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 });
  const nos = await fan.locator(".life-no").allTextContents();
  const nicks = await fan.locator(".life-nick").allTextContents();
  check("收藏館顯示十款作品", nos.length === 10, nos.join(","));
  check("十個不同編號", new Set(nos).size === 10);
  check("十個不同專屬稱號", new Set(nicks).size === 10, nicks.join("、"));
  check("顯示 ONE HEART, ONE LIFE 與主題句", (await fan.getByText("ONE HEART, ONE LIFE").first().isVisible()) && (await fan.getByText(/十種模樣/).first().isVisible()));
  const srcs = await fan.locator("[data-testid=life-card] img").evaluateAll((els) => els.map((e) => e.src));
  check("十款各自使用不同的預覽圖", new Set(srcs).size === 10);
  await fan.screenshot({ path: path.join(OUT, "life-desktop.png"), fullPage: true });
});

await step("身份證", async () => {
  for (const n of [1, 6, 10]) {
    await fan.goto(`${SITE}#/life/${n}`);
    await fan.getByTestId("id-card").waitFor();
    const no = await fan.locator(".id-no").textContent();
    const nick = await fan.locator(".id-nick").textContent();
    const expected = sql(`select nickname from public.collection_works where work_number = ${n}`);
    check(`No.${String(n).padStart(3, "0")} 身份證顯示正確編號與稱號`, no === `No.${String(n).padStart(3, "0")}` && nick === expected, `${no} ${nick}`);
  }
  await fan.goto(`${SITE}#/life/2`);
  await fan.getByTestId("id-card").waitFor();
  check("身份證顯示管理員修改後的介紹與宣言", (await fan.getByText("兩顆心在星空下產生共鳴。").isVisible()) && (await fan.getByText(/誰也拆不開！💞/).isVisible()));
  await fan.screenshot({ path: path.join(OUT, "id-card-desktop.png") });
  // 收藏
  await fan.getByRole("button", { name: "♡ 加入我的收藏" }).click();
  await fan.goto(`${SITE}#/life`);
  await fan.getByRole("button", { name: /我的收藏（1）/ }).click();
  check("粉絲可以收藏喜歡的作品", (await fan.getByTestId("life-card").count()) === 1);
  await fan.getByRole("button", { name: /我的收藏（1）/ }).click();
});

function ellipsesInside(page, platform) {
  return page.evaluate((p) => {
    const es = [...document.querySelectorAll(".stage-overlay ellipse.protect")].map((e) => ({
      cx: +e.getAttribute("cx"), cy: +e.getAttribute("cy"), rx: +e.getAttribute("rx"), ry: +e.getAttribute("ry"),
    }));
    if (es.length === 0) return { ok: false, n: 0 };
    const r = p === "Instagram" ? 49 : 50;
    const ok = es.every((e) => {
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2;
        const x = e.cx + e.rx * Math.cos(a);
        const y = e.cy + e.ry * Math.sin(a);
        if (p === "LINE" ? x < -0.01 || x > 100.01 || y < -0.01 || y > 100.01 : Math.hypot(x - 50, y - 50) > r + 0.01) return false;
      }
      return true;
    });
    return { ok, n: es.length };
  }, platform);
}

function textHitsZones(page) {
  return page.evaluate(() => {
    const sel = document.querySelector(".stage-overlay rect.sel");
    if (!sel) return null;
    const x0 = +sel.getAttribute("x"), y0 = +sel.getAttribute("y");
    const x1 = x0 + +sel.getAttribute("width"), y1 = y0 + +sel.getAttribute("height");
    return [...document.querySelectorAll(".stage-overlay ellipse.protect")].some((e) => {
      const cx = +e.getAttribute("cx"), cy = +e.getAttribute("cy"), rx = +e.getAttribute("rx"), ry = +e.getAttribute("ry");
      const nx = Math.min(Math.max(0, (x0 - cx) / rx), (x1 - cx) / rx);
      const ny = Math.min(Math.max(0, (y0 - cy) / ry), (y1 - cy) / ry);
      return nx * nx + ny * ny < 0.999;
    });
  });
}

await step("宣言大頭貼製作器", async () => {
  await fan.goto(`${SITE}#/life/3`);
  await fan.getByTestId("make-avatar").click();
  await fan.getByTestId("crop-canvas").waitFor();
  await fan.waitForTimeout(800);
  const input = fan.getByTestId("text-input");
  if (!(await input.isVisible())) await fan.locator(".text-panel .chip").first().click();
  const def = await fan.getByTestId("text-input").inputValue();
  check("預設帶入該款的專屬宣言", def === sql("select manifesto from public.collection_works where work_number = 3"), def);
  const presets = await fan.getByTestId("manifesto-presets").locator("button").allTextContents();
  check("提供預設宣言（含十句系列宣言）", presets.length >= 10 && presets.includes("這輩子不拆夥！"), `${presets.length} 句`);
  await fan.getByTestId("manifesto-presets").getByRole("button", { name: "這輩子不拆夥！" }).click();
  check("可以選擇預設宣言", (await fan.getByTestId("text-input").inputValue()) === "這輩子不拆夥！");
  const before = await fan.getByTestId("crop-canvas").evaluate((c) => c.toDataURL());
  await fan.getByTestId("text-input").fill("我們是一體的 🐻🐰❤️");
  await fan.waitForTimeout(400);
  const after = await fan.getByTestId("crop-canvas").evaluate((c) => c.toDataURL());
  check("自訂宣言（繁中＋Emoji）即時預覽", before !== after);
  await setRange(fan.getByTestId("text-size"), 0.12);
  await fan.getByRole("button", { name: "文字顏色 #e85d75" }).click();
  check("可以調整文字大小與顏色", true);
  check("文字沒有遮住臉、耳朵與愛心", (await textHitsZones(fan)) === false);
  // 把文字拖到臉上
  const stage = fan.getByTestId("crop-stage");
  const box = await stage.boundingBox();
  const sel = await fan.locator(".stage-overlay rect.sel").boundingBox();
  const face = await fan.locator(".stage-overlay ellipse.protect").first().boundingBox();
  await fan.mouse.move(sel.x + sel.width / 2, sel.y + sel.height / 2);
  await fan.mouse.down();
  await fan.mouse.move(face.x + face.width / 2, face.y + face.height / 2, { steps: 10 });
  await fan.mouse.up();
  await fan.waitForTimeout(300);
  check("把文字拖到臉上時會自動避開（不遮住角色）", (await textHitsZones(fan)) === false);
  void box;

  // 三個平台：各自的裁切、都保留耳朵與愛心
  const minis = {};
  for (const p of ["Facebook", "Instagram", "LINE"]) {
    await fan.getByRole("tab", { name: p, exact: true }).click();
    await fan.waitForTimeout(300);
    const r = await ellipsesInside(fan, p);
    check(`${p} 預覽：耳朵、臉與胸口完整在可視範圍內`, r.ok, `${r.n} 個保護區域`);
    minis[p] = await fan.getByTestId(`mini-${p === "Facebook" ? "facebook" : p === "Instagram" ? "instagram" : "line"}`).evaluate((c) => c.toDataURL());
  }
  check("三個平台的預覽各自不同（不是同一張圖換名字）", new Set(Object.values(minis)).size === 3);
  // 放大到最大也不會切掉耳朵
  await fan.getByRole("tab", { name: "Facebook", exact: true }).click();
  await fan.getByRole("tab", { name: "圖片與背景" }).click();
  await setRange(fan.getByLabel("縮放", { exact: true }), 5);
  await fan.getByRole("tab", { name: /文字/ }).click();
  await fan.waitForTimeout(300);
  const z = await ellipsesInside(fan, "Facebook");
  check("放大裁切時不會切掉耳朵或愛心", z.ok);
  await fan.screenshot({ path: path.join(OUT, "life-editor-desktop.png") });
});

await step("下載密碼與大頭貼下載", async () => {
  await fan.getByRole("button", { name: "下載我的專屬大頭貼" }).click();
  await fan.getByRole("heading", { name: "輸入生命共同體下載密碼" }).waitFor();
  check("密碼視窗說明這是生命共同體專屬密碼", await fan.getByText(/有自己的專屬下載密碼/).isVisible());
  await fan.getByLabel("下載密碼", { exact: true }).fill("wrong-password");
  await fan.getByRole("button", { name: "確認" }).click();
  await fan.getByText(/下載密碼不正確/).waitFor();
  check("密碼錯誤時不能下載", true);
  await fan.getByLabel("下載密碼", { exact: true }).fill(DL_PASS);
  await fan.getByRole("button", { name: "確認" }).click();
  await fan.getByText(/下載密碼不正確/).waitFor();
  check("原本收藏館的密碼不能下載生命共同體", true);
  await fan.getByLabel("下載密碼", { exact: true }).fill(LIFE_PASS);
  const [d] = await Promise.all([fan.waitForEvent("download"), fan.getByRole("button", { name: "確認" }).click()]);
  const file = path.join(OUT, d.suggestedFilename());
  await d.saveAs(file);
  const png = PNG.sync.read(fs.readFileSync(file));
  check("密碼正確後下載 Facebook 大頭貼（正方形 PNG）", png.width === png.height && png.width >= 1080, `${d.suggestedFilename()} ${png.width}×${png.height}`);
  for (const [tab, size] of [["Instagram", 1080], ["LINE", null]]) {
    await fan.getByRole("tab", { name: tab, exact: true }).click();
    const [d2] = await Promise.all([fan.waitForEvent("download"), fan.getByRole("button", { name: "下載我的專屬大頭貼" }).click()]);
    const f2 = path.join(OUT, d2.suggestedFilename());
    await d2.saveAs(f2);
    const p2 = PNG.sync.read(fs.readFileSync(f2));
    check(`${tab} 大頭貼下載（正方形、高解析度）`, p2.width === p2.height && (size ? p2.width === size : p2.width >= 1080), `${d2.suggestedFilename()} ${p2.width}×${p2.height}`);
  }
  await fan.getByRole("button", { name: "關閉" }).click();
});

await step("收藏卡", async () => {
  await fan.getByTestId("open-card").click();
  await fan.getByTestId("card-canvas").waitFor();
  await fan.waitForTimeout(800);
  await fan.getByRole("button", { name: "我的宣言版本" }).click();
  await fan.getByTestId("card-manifesto").fill("愛讓我們成為彼此 ✨");
  await fan.waitForTimeout(400);
  await fan.screenshot({ path: path.join(OUT, "card-modal.png") });
  const [d] = await Promise.all([fan.waitForEvent("download"), fan.getByRole("button", { name: "下載這張收藏卡" }).click()]);
  const file = path.join(OUT, d.suggestedFilename());
  await d.saveAs(file);
  const size = jpegSize(fs.readFileSync(file));
  check("單張收藏卡下載為獨立圖片檔（1200×1800 JPG）", size?.w === 1200 && size?.h === 1800, `${d.suggestedFilename()} ${size?.w}×${size?.h}`);
  check("收藏卡檔名含編號與稱號", d.suggestedFilename() === "KUMA_生命共同體_No.003_星空守護體_收藏卡.jpg", d.suggestedFilename());
  await fan.getByRole("button", { name: "關閉" }).click();

  await fan.goto(`${SITE}#/life`);
  await fan.getByTestId("mini-card").first().waitFor();
  await fan.getByRole("button", { name: "選擇多張" }).click();
  const cards = fan.getByTestId("mini-card");
  await cards.nth(0).click();
  await cards.nth(4).click();
  await cards.nth(9).click();
  const [z1] = await Promise.all([fan.waitForEvent("download", { timeout: 60000 }), fan.getByRole("button", { name: /下載已選收藏卡（3 張/ }).click()]);
  const zf1 = path.join(OUT, z1.suggestedFilename());
  await z1.saveAs(zf1);
  const n1 = Object.keys(unzipSync(fs.readFileSync(zf1)));
  check("可以下載自己選擇的多張收藏卡（ZIP）", n1.length === 3, n1.join("、"));
  const [z2] = await Promise.all([fan.waitForEvent("download", { timeout: 120000 }), fan.getByRole("button", { name: /下載完整 10 張收藏卡/ }).click()]);
  const zf2 = path.join(OUT, z2.suggestedFilename());
  await z2.saveAs(zf2);
  const files = unzipSync(fs.readFileSync(zf2));
  const names = Object.keys(files);
  const sizes = names.map((n) => jpegSize(Buffer.from(files[n])));
  check("可以一次下載十張完整收藏卡 ZIP", names.length === 10 && sizes.every((s) => s?.w === 1200 && s?.h === 1800), names.join("、"));
  check("十張收藏卡內容各不相同", new Set(names.map((n) => md5(Buffer.from(files[n])))).size === 10);
  fs.writeFileSync(path.join(OUT, "card-No.001.jpg"), Buffer.from(files[names.find((n) => n.includes("No.001"))]));
});

await step("新舊系列互不干擾", async () => {
  const fn = (body) => fetch(`${API}/functions/v1/download`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const lifeId = sql("select id from public.collections where slug = 'one-heart-one-life'");
  const tok = await (await fn({ action: "verify", password: DL_PASS })).json();
  const lifeTok = await (await fn({ action: "verify", password: LIFE_PASS, collection: lifeId })).json();
  check("專屬密碼不能通過原本收藏館的驗證", (await fn({ action: "verify", password: LIFE_PASS })).status === 401);
  const old = await (await fn({ action: "sign", token: tok.token, all: true })).json();
  check("原本收藏館的 ZIP 只包含原本作品", old.items?.length === 1 && old.items[0].title === "原本作品", `${old.items?.length} 張`);
  const crossOld = await fn({ action: "sign", token: tok.token, all: true, source: "collection" });
  check("原本密碼的授權不能下載生命共同體作品", crossOld.status === 401, `HTTP ${crossOld.status}`);
  const crossLife = await fn({ action: "sign", token: lifeTok.token, all: true });
  check("專屬密碼的授權不能下載原本收藏館作品", crossLife.status === 401, `HTTP ${crossLife.status}`);
  const life = await (await fn({ action: "sign", token: lifeTok.token, all: true, source: "collection" })).json();
  check("生命共同體的下載只包含系列作品", life.items?.length === 10 && life.items.every((i) => i.title.startsWith("No.")));
  const noTok = await fetch(`${API}/functions/v1/download`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sign", all: true, source: "collection" }) });
  check("未輸入密碼不能取得系列原圖", noTok.status === 401, `HTTP ${noTok.status}`);
  const bundle = fs.readdirSync(path.join(DIST, "assets")).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(DIST, "assets", f), "utf8")).join("");
  check("下載密碼沒有出現在前端程式碼", !bundle.includes(DL_PASS) && !bundle.includes(LIFE_PASS));
  check("原本作品資料未被修改", sql("select count(*) || '/' || string_agg(title, '') from public.images") === "1/原本作品");
});

await step("手機版", async () => {
  const ctx = await newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const m = await ctx.newPage();
  watch(m, "手機");
  debugPages.m = m;
  await m.goto(`${SITE}#/life`);
  await m.getByTestId("life-card").first().waitFor();
  await scrollAll(m);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("手機版收藏館沒有左右溢出", overflow <= 1, `溢出 ${overflow}px`);
  await m.screenshot({ path: path.join(OUT, "life-iphone.png") });
  await m.screenshot({ path: path.join(OUT, "life-iphone-full.png"), fullPage: true });
  await m.goto(`${SITE}#/life/1`);
  await m.getByTestId("id-card").waitFor();
  await m.waitForTimeout(500);
  await m.screenshot({ path: path.join(OUT, "id-card-iphone.png"), fullPage: true });
  await m.getByTestId("make-avatar").tap();
  await m.getByTestId("crop-canvas").waitFor();
  await m.waitForTimeout(800);
  const o2 = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("手機版大頭貼編輯器正常顯示", o2 <= 1);
  await m.screenshot({ path: path.join(OUT, "life-editor-iphone.png") });
  await m.getByRole("button", { name: "關閉" }).tap();
  await m.getByTestId("open-card").tap();
  await m.getByTestId("card-canvas").waitFor();
  await m.waitForTimeout(800);
  await m.screenshot({ path: path.join(OUT, "card-iphone.png") });
  check("手機版收藏卡正常顯示", true);
  await ctx.close();
  delete debugPages.m;
});

await step("重新整理後資料仍在", async () => {
  await fan.goto(`${SITE}#/life`);
  await fan.reload();
  await fan.getByTestId("life-card").first().waitFor();
  check("重新整理後十款作品仍然存在", (await fan.getByTestId("life-card").count()) === 10);
});

check("瀏覽器沒有 JavaScript 錯誤", consoleErrors.length === 0, consoleErrors.slice(0, 3).join("｜"));

await browser.close();
await mock.close();
web.close();

const passed = results.filter((r) => r.ok).length;
const report = [
  "# 端到端測試報告：熊兔生命共同體（本機 Chromium＋Supabase 相容測試伺服器）",
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
console.log(`\n${passed}/${results.length} 通過，報告：tests/e2e/output-life/report.md`);
process.exit(passed === results.length ? 0 : 1);
