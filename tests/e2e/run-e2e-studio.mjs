// =====================================================================
// 端到端驗收測試：KUMA STUDIO 多系列收藏管理平台
// 執行：npm run test:e2e:studio
// 需求：本機 PostgreSQL、Playwright Chromium、
//       tests/e2e/private-artworks/wife/ 內放「熊大寵妻系列」原始照片（劇情照＋配套大頭貼，不提交到 GitHub）。
// 另外兩個系列（熊兔生命共同體、熊兔甜蜜日常）使用程式產生的純色「測試圖」，只用來驗證功能，不是作品。
// 所有密碼都是測試用密碼，不是正式粉絲密碼。
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

const { chromium, devices } = createRequire(import.meta.url)("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "tests/e2e/output-studio");
const ART = path.join(ROOT, "tests/e2e/private-artworks/wife");
const DB = "kuma_e2e_studio";
const API_PORT = 54341;
const WEB_PORT = 4193;
const BASE = "/kuma-avatar-gallery/";
const SITE = `http://127.0.0.1:${WEB_PORT}${BASE}`;
const API = `http://127.0.0.1:${API_PORT}`;
const DIST = path.join(OUT, "dist");

const USERS = [
  { id: "aaaaaaaa-1111-4111-8111-000000000001", email: "admin-a@example.test", password: "Admin-A-pass-123", name: "管理員 A（我）" },
  { id: "bbbbbbbb-2222-4222-8222-000000000002", email: "admin-b@example.test", password: "Admin-B-pass-456", name: "管理員 B（先生）" },
];
const [A, B] = USERS;
// 測試用密碼（只存在測試資料庫）
const PW_SITE = "test-site-pw-0000";
const PW_LIFE = "test-life-pw-1111";
const PW_LIFE_2 = "test-life-pw-1112";
const PW_WIFE = "test-wife-pw-2222";
let PW_DAILY = ""; // 由「重新產生密碼」產生

// 熊大寵妻系列：RR 提供的五組故事（劇情照＋配套大頭貼）
const WIFE = [
  { no: 1, key: "bedtime", title: "睡前貼心照顧", story: "熊大替兔兔蓋被子。", avatar: "睡前熊兔大頭貼" },
  { no: 2, key: "tea", title: "暖心奉茶", story: "熊大送上熱茶與點心。", avatar: "熱茶熊兔大頭貼" },
  { no: 3, key: "umbrella", title: "雨中共撐一把傘", story: "熊大替兔兔撐傘。", avatar: "雨傘熊兔大頭貼" },
  { no: 4, key: "breakfast", title: "溫馨早餐", story: "熊大準備早餐送到床邊。", avatar: "早餐熊兔大頭貼" },
  { no: 5, key: "garden", title: "花園小驚喜", story: "熊大為兔兔戴上花冠。", avatar: "花園熊兔大頭貼" },
];
const WIFE_MANIFESTOS = ["熊大專屬寵妻員。", "兔兔最大，熊大負責執行。", "寵兔兔是熊大的終身任務。", "你負責可愛，我負責寵你。", "今天也要把兔兔寵上天。"];

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

/** 純色測試圖（不是作品，只用來驗證上傳與下載流程） */
function testImage(w, h, rgb) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const ring = ((x - w / 2) ** 2 + (y - h / 2) ** 2) < (Math.min(w, h) * 0.3) ** 2;
      png.data[i] = ring ? 255 - rgb[0] : rgb[0];
      png.data[i + 1] = ring ? 255 - rgb[1] : rgb[1];
      png.data[i + 2] = ring ? 255 - rgb[2] : rgb[2];
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}

// ---------- 資料庫 ----------
const psql = (args) => execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", ...args], { stdio: ["ignore", "ignore", "inherit"] });
psql(["-d", "postgres", "-c", `drop database if exists ${DB}`, "-c", `create database ${DB}`]);
psql(["-d", DB, "-f", path.join(ROOT, "supabase/tests/local_mock_supabase.sql")]);
for (const f of fs.readdirSync(path.join(ROOT, "supabase/migrations")).sort()) psql(["-d", DB, "-f", path.join(ROOT, "supabase/migrations", f)]);
psql(["-d", DB, "-c", `insert into auth.users (id, email) values ${USERS.map((u) => `('${u.id}','${u.email}')`).join(",")}`]);
psql(["-d", DB, "-c", `insert into public.admins (user_id, display_name) values ('${A.id}', '${A.name}'), ('${B.id}', '${B.name}')`]);
psql(["-d", DB, "-c", `update private.download_secret set password_hash = extensions.crypt('${PW_SITE}', extensions.gen_salt('bf', 6)), version = 1 where id = 1`]);

// 原本收藏館：一張測試作品（檔案直接放進測試 Storage）
const STORAGE = path.join(OUT, "storage");
const OLD_ID = "11111111-0000-4000-8000-000000000001";
const oldOriginal = testImage(600, 600, [200, 120, 60]);
fs.mkdirSync(path.join(STORAGE, "originals/old"), { recursive: true });
fs.mkdirSync(path.join(STORAGE, "previews/old"), { recursive: true });
fs.writeFileSync(path.join(STORAGE, "originals/old/o.png"), oldOriginal);
fs.writeFileSync(path.join(STORAGE, "previews/old/p.png"), oldOriginal);
psql(["-d", DB, "-c", `insert into public.images (id, title, preview_path, original_path, mime_type, file_size, width, height, is_published) values ('${OLD_ID}', '原本作品', 'old/p.png', 'old/o.png', 'image/png', ${oldOriginal.length}, 600, 600, true)`]);

const mock = createMockSupabase({ database: DB, storageDir: STORAGE, users: USERS, port: API_PORT });
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
async function login(page, user) {
  await page.goto(`${SITE}#/admin/login`);
  await page.getByLabel("電子郵件").fill(user.email);
  await page.getByLabel("密碼", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "登入" }).click();
  await page.getByRole("heading", { name: "系列管理中心" }).waitFor();
}
async function scrollAll(page) {
  const h = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < h; y += 500) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}
async function openCollectionAdmin(page, name) {
  await page.goto(`${SITE}#/admin`);
  await page.getByTestId("collection-item").filter({ hasText: name }).getByTestId("manage-collection").click();
  await page.getByRole("heading", { name, level: 1 }).waitFor();
}
async function createSeries(page, f) {
  await page.goto(`${SITE}#/admin`);
  await page.getByTestId("new-collection").click();
  const d = page.getByTestId("create-collection");
  await d.getByTestId("cc-name").fill(f.name);
  await d.getByTestId("cc-name-en").fill(f.name_en);
  await d.getByTestId("cc-slug").fill(f.slug);
  await d.getByLabel("身份證標題").fill(f.id_card_title);
  await d.getByLabel("宣言名稱").fill(f.manifesto_label);
  await d.getByTestId("cc-theme").selectOption(f.theme);
  await d.getByTestId("cc-submit").click();
  await page.getByRole("heading", { name: f.name, level: 1 }).waitFor();
}
async function saveSeriesForm(page, patch) {
  const form = page.getByTestId("collection-form");
  if (patch.manifestos) await form.getByTestId("life-manifestos").fill(patch.manifestos.join("\n"));
  if (patch.tagline !== undefined) await form.getByLabel("系列主題標語").fill(patch.tagline);
  if (patch.description !== undefined) await form.getByLabel("系列介紹").fill(patch.description);
  if (patch.status) await form.getByTestId("cf-status").selectOption(patch.status);
  if (patch.download !== undefined) await form.getByTestId("cf-download").setChecked(patch.download);
  await form.getByTestId("cf-save").click();
  await page.getByText("系列設定已儲存。").waitFor();
}
async function setPassword(page, pw) {
  const form = page.getByTestId("collection-password-form");
  await form.getByTestId("collection-pw").fill(pw);
  await form.getByTestId("collection-pw2").fill(pw);
  await form.getByTestId("collection-pw-save").click();
  await form.getByText(/的下載密碼已更新/).waitFor();
}
async function batchUpload(page, files) {
  await page.getByTestId("life-batch-input").setInputFiles(files);
  await page.getByTestId("life-plan").locator("li").first().waitFor();
  await page.getByTestId("life-batch-start").click();
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid=life-plan] li.up-done, [data-testid=life-plan] li.up-error").length >= n, files.length, { timeout: 180000 });
  return page.locator("[data-testid=life-plan] li.up-error").count();
}
async function publishAll(page) {
  await page.getByRole("button", { name: "公開所有已上傳的草稿" }).click();
  await page.getByText(/已公開 \d+ 款作品/).waitFor();
}

// 直接呼叫正式的下載 Edge Function（模擬粉絲或攻擊者的請求）
let ipSeq = 10;
async function fn(body, ip) {
  const r = await fetch(`${API}/functions/v1/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip ?? `198.51.100.${ipSeq++}` },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await r.json();
  } catch {
    /* */
  }
  return { status: r.status, data };
}
const colId = (slug) => sql(`select id from public.collections where slug = '${slug}'`);
const workIds = (slug) => sql(`select string_agg(w.id::text, ',' order by work_number) from public.collection_works w join public.collections c on c.id = w.collection_id where c.slug = '${slug}' and w.is_published`).split(",").filter(Boolean);
async function tokenFor(slug, password) {
  const r = await fn({ action: "verify", password, collection: colId(slug) });
  return r.status === 200 ? r.data.token : null;
}

const wifeFiles = fs.existsSync(ART) ? fs.readdirSync(ART).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort() : [];

// ===================================================================
// 管理員 A：熊兔生命共同體（既有系列）＋ 新增熊大寵妻系列
// ===================================================================
const ctxA = await newContext({ viewport: { width: 1366, height: 900 } });
const pageA = await ctxA.newPage();
watch(pageA, "管理員A");
debugPages.A = pageA;

await step("後臺以系列管理為主要入口", async () => {
  await login(pageA, A);
  const items = pageA.getByTestId("collection-item");
  await items.first().waitFor();
  check("登入後進入系列管理中心，看到既有的熊兔生命共同體", (await items.count()) === 1 && (await items.first().innerText()).includes("熊兔生命共同體"));
  check("既有系列升級後顯示「公開」", (await items.first().getByTestId("collection-status").innerText()) === "公開");
  check("既有系列顯示 10 款待上傳作品", (await items.first().getByTestId("collection-counts").innerText()).includes("作品 10 款"));
  check("系列旁顯示密碼未設定", (await items.first().getByTestId("collection-password").innerText()) === "未設定密碼");
  // 舊網址仍可用
  await pageA.goto(`${SITE}#/admin/life`);
  await pageA.getByRole("heading", { name: "KUMA 熊兔生命共同體", level: 1 }).waitFor();
  check("舊的 #/admin/life 網址導向第一系列管理頁", true);
});

await step("第一系列：上傳 3 張測試圖、設定密碼、公開", async () => {
  const files = [1, 2, 3].map((n) => ({ name: `test_life_${n}.png`, mimeType: "image/png", buffer: testImage(900, 900, [60 + n * 40, 140, 90]) }));
  const errs = await batchUpload(pageA, files);
  check("第一系列 3 張測試圖上傳成功", errs === 0);
  await publishAll(pageA);
  await setPassword(pageA, PW_LIFE);
  check("第一系列密碼以 bcrypt 雜湊存放", sql(`select (password_hash like '$2%' and password_hash <> '${PW_LIFE}')::text from private.collection_download_secret where collection_id = '${colId("one-heart-one-life")}'`) === "true");
});

await step("新增「熊大寵妻系列」並批次上傳 RR 提供的照片", async () => {
  check("找到熊大寵妻系列 10 個檔案（5 張劇情照＋5 張配套大頭貼）", wifeFiles.length === 10, `${wifeFiles.length} 個`);
  await createSeries(pageA, { name: "熊大寵妻系列", name_en: "PAMPER MY BUNNY", slug: "pamper-wife", id_card_title: "熊大寵妻身份證", manifesto_label: "寵妻宣言", theme: "sweet" });
  check("新系列預設為草稿", sql("select status from public.collections where slug = 'pamper-wife'") === "draft");
  // 檔名為英數字，直接以路徑上傳（10 個檔案約 50MB，用路徑比傳送內容快）
  await pageA.getByTestId("life-batch-input").setInputFiles(wifeFiles.map((f) => path.join(ART, f)), { timeout: 120000 });
  await pageA.getByTestId("life-plan").locator("li").first().waitFor();
  const plan = await pageA.getByTestId("life-plan").locator("li").evaluateAll((els) =>
    els.map((li) => `${li.querySelector(".badge")?.textContent}:${li.querySelector("select")?.value}:${li.textContent.match(/bear_loves_rabbit_\S+?\.png/)?.[0]}`),
  );
  const okPlan = plan.every((p) => {
    const [kind, no, name] = p.split(":");
    return name.includes(`_0${no}_`) && (kind === "大頭貼版") === name.includes("avatar");
  });
  check("10 個檔案依檔名對應 No.001～No.005（劇情照與大頭貼版分開）", okPlan && plan.length === 10, plan.join(" / "));
  await pageA.getByTestId("life-batch-start").click();
  await pageA.waitForFunction(() => document.querySelectorAll("[data-testid=life-plan] li.up-done, [data-testid=life-plan] li.up-error").length >= 10, null, { timeout: 180000 });
  check("10 個檔案全部上傳成功", (await pageA.locator("[data-testid=life-plan] li.up-error").count()) === 0);
  const id = colId("pamper-wife");
  check("建立 5 筆獨立作品（不是 10 筆、也沒有合成）", sql(`select count(*) from public.collection_works where collection_id = '${id}'`) === "5");
  const rows = sql(`select string_agg(work_number || '=' || file_size || '/' || avatar_file_size, ',' order by work_number) from public.collection_works where collection_id = '${id}'`);
  const expected = WIFE.map((w) => {
    const photo = wifeFiles.find((f) => f.includes(`_0${w.no}_`) && !f.includes("avatar"));
    const av = wifeFiles.find((f) => f.includes(`_0${w.no}_`) && f.includes("avatar"));
    return `${w.no}=${fs.statSync(path.join(ART, photo)).size}/${fs.statSync(path.join(ART, av)).size}`;
  }).join(",");
  check("每款作品的劇情照與大頭貼版都對應正確", rows === expected, rows);
  const paths = sql(`select string_agg(original_path || '|' || avatar_original_path, ',' order by work_number) from public.collection_works where collection_id = '${id}'`).split(",");
  const untouched = paths.every((pp, i) => {
    const [o, a] = pp.split("|");
    const photo = wifeFiles.find((f) => f.includes(`_0${i + 1}_`) && !f.includes("avatar"));
    const av = wifeFiles.find((f) => f.includes(`_0${i + 1}_`) && f.includes("avatar"));
    return md5(fs.readFileSync(path.join(STORAGE, "originals", o))) === md5(fs.readFileSync(path.join(ART, photo))) &&
      md5(fs.readFileSync(path.join(STORAGE, "originals", a))) === md5(fs.readFileSync(path.join(ART, av)));
  });
  check("原始照片未經修改（位元組與上傳檔案完全相同）", untouched);
  check("原圖放在私有 originals 的系列資料夾", paths.every((pp) => pp.split("|").every((x) => x.startsWith(`collections/${id}/`))));
});

await step("編輯熊大寵妻五款作品的稱號、名稱、介紹與宣言", async () => {
  for (const w of WIFE) {
    await pageA.getByTestId("life-admin-item").filter({ hasText: `No.00${w.no}` }).getByRole("button", { name: "編輯資料" }).click();
    const dlg = pageA.locator(".modal");
    await dlg.getByLabel("專屬稱號").fill(w.title);
    await dlg.getByLabel("作品名稱").fill(w.avatar);
    await dlg.getByLabel("作品介紹（顯示在身份證與收藏卡）").fill(w.story);
    await dlg.getByLabel(/主題宣言/).fill(WIFE_MANIFESTOS[w.no - 1]);
    await dlg.getByRole("button", { name: "儲存" }).click();
    await pageA.getByText("作品資料已儲存。").waitFor();
  }
  const names = sql(`select string_agg(nickname, ',' order by work_number) from public.collection_works where collection_id = '${colId("pamper-wife")}'`);
  check("五款稱號都由管理員填寫（沒有寫死在程式）", names === WIFE.map((w) => w.title).join(","), names);
  await saveSeriesForm(pageA, {
    manifestos: WIFE_MANIFESTOS,
    tagline: "兔兔最大，熊大負責寵。",
    description: "熊大用每一個日常小動作，把兔兔寵上天。",
  });
  check("寵妻系列有自己的 5 句預設宣言", sql("select cardinality(manifestos) from public.collections where slug = 'pamper-wife'") === "5");
  await pageA.getByTestId("cover-input").setInputFiles(path.join(ART, wifeFiles.find((f) => f.includes("avatar_02"))), { timeout: 60000 });
  await pageA.getByText("系列封面已更新。").waitFor();
  check("寵妻系列設定自己的封面", sql("select cover_path like 'collections/%' from public.collections where slug = 'pamper-wife'") === "t");
  await publishAll(pageA);
});

// ===================================================================
// 管理員 B：新增熊兔甜蜜日常、設定寵妻密碼
// ===================================================================
const ctxB = await newContext({ viewport: { width: 1280, height: 900 } });
const pageB = await ctxB.newPage();
watch(pageB, "管理員B");
debugPages.B = pageB;

await step("管理員 B 新增「熊兔甜蜜日常」並設定封面與兩張測試圖", async () => {
  await login(pageB, B);
  check("管理員 B 看得到 A 建立的系列", (await pageB.getByTestId("collection-item").count()) === 2);
  await createSeries(pageB, { name: "熊兔甜蜜日常", name_en: "SWEET DAILY", slug: "sweet-daily", id_card_title: "甜蜜日常身份證", manifesto_label: "甜蜜宣言", theme: "sunny" });
  const files = [1, 2].map((n) => ({ name: `daily_${n}.png`, mimeType: "image/png", buffer: testImage(800, 1000, [230, 180 + n * 20, 90]) }));
  check("甜蜜日常兩張測試圖上傳成功", (await batchUpload(pageB, files)) === 0);
  await pageB.getByTestId("cover-input").setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: testImage(800, 600, [250, 210, 120]) });
  await pageB.getByText("系列封面已更新。").waitFor();
  await saveSeriesForm(pageB, { manifestos: ["今天也很甜。", "早安，我的兔兔。"], tagline: "每天都是甜蜜日常" });
  await publishAll(pageB);
  await pageB.getByTestId("collection-password-form").getByTestId("collection-pw-regenerate").click();
  await pageB.getByTestId("generated-password").waitFor();
  PW_DAILY = (await pageB.getByTestId("generated-password").innerText()).trim();
  check("「重新產生密碼」由伺服器產生並只顯示一次", /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/.test(PW_DAILY), PW_DAILY.replace(/./g, "*"));
  await pageB.reload();
  await pageB.getByTestId("password-state").getByText("已設定・啟用中").waitFor();
  check("重新整理後不會再顯示密碼明文", (await pageB.getByTestId("generated-password").count()) === 0 && !(await pageB.content()).includes(PW_DAILY));
  await saveSeriesForm(pageB, { status: "published" });
  check("甜蜜日常公開", sql("select status from public.collections where slug = 'sweet-daily'") === "published");
});

await step("管理員 B 設定寵妻系列密碼，管理員 A 公開寵妻系列", async () => {
  await openCollectionAdmin(pageB, "熊大寵妻系列");
  await setPassword(pageB, PW_WIFE);
  await pageB.screenshot({ path: path.join(OUT, "admin-series-password.png"), fullPage: false });
  await openCollectionAdmin(pageA, "熊大寵妻系列");
  await saveSeriesForm(pageA, { status: "published" });
  const hashes = sql("select count(distinct password_hash) from private.collection_download_secret where password_hash is not null");
  check("三個系列各自一組不同的密碼雜湊", hashes === "3", hashes);
  await pageA.goto(`${SITE}#/admin`);
  await pageA.getByTestId("collection-item").nth(2).waitFor();
  const list = await pageA.getByTestId("collection-item").allInnerTexts();
  check("系列管理中心列出 3 個系列與各自作品數", list.length === 3 && list.some((t) => t.includes("熊大寵妻系列") && t.includes("作品 5 款")) && list.some((t) => t.includes("熊兔甜蜜日常") && t.includes("作品 2 款")));
  check("三個系列都顯示「密碼已設定」與「可下載」", (await pageA.getByTestId("collection-password").allInnerTexts()).every((t) => t === "密碼已設定") && (await pageA.getByTestId("collection-download").allInnerTexts()).every((t) => t === "可下載"));
  await pageA.screenshot({ path: path.join(OUT, "admin-series-list.png"), fullPage: true });
});

// ===================================================================
// 粉絲（手機）
// ===================================================================
const ctxFan = await newContext({ ...devices["iPhone 13"] });
const fan = await ctxFan.newPage();
watch(fan, "粉絲手機");
debugPages.fan = fan;
const signedPaths = [];
fan.on("request", (r) => {
  const m = /\/object\/sign\/originals\/([^?]+)/.exec(r.url());
  if (m) signedPaths.push(decodeURIComponent(m[1]));
});

await step("首頁顯示三個公開系列", async () => {
  await fan.goto(SITE);
  await fan.getByTestId("series-card").nth(2).waitFor();
  const cards = await fan.getByTestId("series-card").evaluateAll((els) => els.map((e) => `${e.dataset.slug}:${e.querySelector("small")?.textContent}`));
  check("首頁依排序列出 3 個系列與作品數量", JSON.stringify(cards) === JSON.stringify(["one-heart-one-life:3 款作品", "pamper-wife:5 款作品", "sweet-daily:2 款作品"]), cards.join(" / "));
  check("寵妻系列卡片顯示系列封面與標語", (await fan.locator('[data-slug="pamper-wife"] img').getAttribute("src")).includes("collections/") && (await fan.locator('[data-slug="pamper-wife"]').innerText()).includes("兔兔最大，熊大負責寵。"));
  await fan.getByTestId("art-card").first().waitFor();
  check("原本的大頭貼收藏館作品仍然顯示", (await fan.getByTestId("art-card").count()) === 1);
  await scrollAll(fan);
  await fan.screenshot({ path: path.join(OUT, "home-iphone.png"), fullPage: true });
});

await step("寵妻系列頁只顯示自己的作品與主題", async () => {
  await fan.locator('[data-testid=series-card][data-slug="pamper-wife"]').click();
  await fan.getByRole("heading", { name: "熊大寵妻系列", level: 1 }).waitFor();
  await fan.getByTestId("life-card").first().waitFor();
  const nicks = await fan.locator(".life-nick").allInnerTexts();
  check("系列頁只顯示寵妻系列 5 款作品", JSON.stringify(nicks) === JSON.stringify(WIFE.map((w) => w.title)), nicks.join("、"));
  check("系列頁套用甜蜜主題", (await fan.getByTestId("collection-page").getAttribute("class")).includes("theme-sweet"));
  await scrollAll(fan);
  await fan.waitForFunction(() => [...document.querySelectorAll("[data-testid=life-card] img")].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 });
  await fan.screenshot({ path: path.join(OUT, "wife-series-iphone.png"), fullPage: true });
});

await step("寵妻身份證使用系列自己的標題與宣言名稱", async () => {
  await fan.goto(`${SITE}#/c/pamper-wife/3`);
  const card = fan.getByTestId("id-card");
  await card.waitFor();
  const t = await card.innerText();
  check("身份證標題為「熊大寵妻身份證」", t.includes("熊大寵妻身份證"));
  check("身份證顯示系列名稱、No.003、稱號、介紹與寵妻宣言", t.includes("熊大寵妻系列") && t.includes("No.003") && t.includes("雨中共撐一把傘") && t.includes("熊大替兔兔撐傘") && t.includes("寵妻宣言") && t.includes(WIFE_MANIFESTOS[2]));
  check("身份證顯示 KUMA STUDIO 品牌", t.includes("KUMA STUDIO"));
  await fan.waitForTimeout(500);
  await fan.screenshot({ path: path.join(OUT, "wife-id-card-iphone.png"), fullPage: true });
});

await step("寵妻大頭貼：系列宣言、密碼隔離、使用配套大頭貼原圖", async () => {
  await fan.getByTestId("make-avatar").click();
  await fan.getByRole("button", { name: "下載我的專屬大頭貼" }).waitFor();
  await fan.waitForTimeout(800);
  const body = await fan.locator(".modal").innerText();
  check("大頭貼編輯器提供寵妻系列的預設宣言", WIFE_MANIFESTOS.every((m) => body.includes(m)));
  check("不會出現其他系列的宣言", !body.includes("熊兔合體，誰也拆不開") && !body.includes("今天也很甜"));
  await fan.screenshot({ path: path.join(OUT, "wife-editor-iphone.png") });
  await fan.getByRole("button", { name: "下載我的專屬大頭貼" }).click();
  await fan.getByRole("heading", { name: "輸入「熊大寵妻系列」下載密碼" }).waitFor();
  await fan.getByLabel("下載密碼", { exact: true }).fill(PW_LIFE);
  await fan.getByRole("button", { name: "確認" }).click();
  await fan.getByText(/下載密碼不正確/).waitFor();
  check("生命共同體的密碼不能下載寵妻系列", true);
  await fan.getByLabel("下載密碼", { exact: true }).fill(PW_SITE);
  await fan.getByRole("button", { name: "確認" }).click();
  await fan.getByText(/下載密碼不正確/).waitFor();
  check("原本收藏館的密碼不能下載寵妻系列", true);
  await fan.getByLabel("下載密碼", { exact: true }).fill(PW_WIFE);
  const before = signedPaths.length;
  const [d] = await Promise.all([fan.waitForEvent("download"), fan.getByRole("button", { name: "確認" }).click()]);
  const file = path.join(OUT, d.suggestedFilename());
  await d.saveAs(file);
  const png = PNG.sync.read(fs.readFileSync(file));
  check("輸入寵妻密碼後下載大頭貼（正方形高解析 PNG）", png.width === png.height && png.width >= 1080, `${d.suggestedFilename()} ${png.width}×${png.height}`);
  check("大頭貼檔名含系列、編號與稱號", d.suggestedFilename().includes("熊大寵妻系列") && d.suggestedFilename().includes("No.003"), d.suggestedFilename());
  const used = signedPaths.slice(before);
  check("大頭貼使用配套「大頭貼版」原圖（不是劇情照）", used.length === 1 && /-avatar\./.test(used[0]), used.join(","));
  await fan.getByRole("button", { name: "關閉" }).click();
});

await step("寵妻收藏卡：單張與整套 ZIP", async () => {
  await fan.getByTestId("open-card").click();
  await fan.getByTestId("card-canvas").waitFor();
  await fan.waitForTimeout(800);
  const t = await fan.locator(".modal").innerText();
  check("收藏卡使用系列自己的宣言名稱", t.includes("官方寵妻宣言"));
  await fan.screenshot({ path: path.join(OUT, "wife-card-iphone.png") });
  const [d] = await Promise.all([fan.waitForEvent("download"), fan.getByRole("button", { name: "下載這張收藏卡" }).click()]);
  const f = path.join(OUT, d.suggestedFilename());
  await d.saveAs(f);
  const size = jpegSize(fs.readFileSync(f));
  check("單張收藏卡 1200×1800（15 分鐘內同系列不需再輸入密碼）", size?.w === 1200 && size?.h === 1800, d.suggestedFilename());
  await fan.getByRole("button", { name: "關閉" }).click();
  await fan.goto(`${SITE}#/c/pamper-wife`);
  await fan.getByRole("button", { name: /下載完整 5 張收藏卡/ }).waitFor();
  const [z] = await Promise.all([fan.waitForEvent("download", { timeout: 120000 }), fan.getByRole("button", { name: /下載完整 5 張收藏卡/ }).click()]);
  const zf = path.join(OUT, z.suggestedFilename());
  await z.saveAs(zf);
  const names = Object.keys(unzipSync(fs.readFileSync(zf))).sort();
  check("整套 ZIP 含 5 張寵妻收藏卡（不含其他系列）", names.length === 5 && names.every((n) => n.startsWith("KUMA_熊大寵妻系列_No.00")), names.join("、"));
});

await step("換到甜蜜日常：必須另外輸入甜蜜日常的密碼", async () => {
  await fan.goto(`${SITE}#/c/sweet-daily`);
  await fan.getByRole("button", { name: /下載完整 2 張收藏卡/ }).click();
  await fan.getByRole("heading", { name: "輸入「熊兔甜蜜日常」下載密碼" }).waitFor();
  check("已通過寵妻密碼，進入甜蜜日常仍要求甜蜜日常密碼", true);
  await fan.getByLabel("下載密碼", { exact: true }).fill(PW_WIFE);
  await fan.getByRole("button", { name: "確認" }).click();
  await fan.getByText(/下載密碼不正確/).waitFor();
  check("寵妻密碼（B）不能下載甜蜜日常（C）", true);
  await fan.getByLabel("下載密碼", { exact: true }).fill(PW_DAILY);
  const [z] = await Promise.all([fan.waitForEvent("download", { timeout: 120000 }), fan.getByRole("button", { name: "確認" }).click()]);
  const zf = path.join(OUT, z.suggestedFilename());
  await z.saveAs(zf);
  const names = Object.keys(unzipSync(fs.readFileSync(zf)));
  check("甜蜜日常 ZIP 含 2 張收藏卡", names.length === 2 && names.every((n) => n.includes("熊兔甜蜜日常")), names.join("、"));
  check("甜蜜日常頁套用暖陽主題", (await fan.getByTestId("collection-page").getAttribute("class")).includes("theme-sunny"));
  await fan.screenshot({ path: path.join(OUT, "daily-series-iphone.png"), fullPage: true });
});

// ===================================================================
// 後端安全：直接呼叫 API（不經過網頁）
// ===================================================================
let tokLife, tokWife, tokDaily;
await step("後端授權：每個系列的授權只能下載該系列", async () => {
  tokLife = await tokenFor("one-heart-one-life", PW_LIFE);
  tokWife = await tokenFor("pamper-wife", PW_WIFE);
  tokDaily = await tokenFor("sweet-daily", PW_DAILY);
  check("三個系列各自用自己的密碼取得授權", Boolean(tokLife && tokWife && tokDaily));
  check("A 系列密碼不能取得 B 系列授權（API）", (await tokenFor("pamper-wife", PW_LIFE)) === null);
  check("B 系列密碼不能取得 C 系列授權（API）", (await tokenFor("sweet-daily", PW_WIFE)) === null);
  check("C 系列密碼不能取得 A 系列授權（API）", (await tokenFor("one-heart-one-life", PW_DAILY)) === null);
  const cross = await fn({ action: "sign", token: tokLife, source: "collection", ids: workIds("pamper-wife") });
  check("A 系列授權指定 B 系列作品 id 也拿不到原圖", cross.status === 404, `HTTP ${cross.status}`);
  const mixed = await fn({ action: "sign", token: tokWife, source: "collection", ids: [...workIds("pamper-wife"), ...workIds("sweet-daily")], purpose: "card" });
  check("混合多個系列的請求只回傳授權系列的作品", mixed.status === 200 && mixed.data.items.length === 5, `${mixed.data.items?.length} 筆`);
  const zipB = await fn({ action: "sign", token: tokWife, source: "collection", all: true });
  check("ZIP（全部）只回傳該系列作品", zipB.status === 200 && zipB.data.items.length === 5 && zipB.data.items.every((i) => workIds("pamper-wife").includes(i.id)));
  const toImages = await fn({ action: "sign", token: tokWife, ids: [OLD_ID] });
  check("系列授權不能下載原本收藏館作品", toImages.status === 401, `HTTP ${toImages.status}`);
  const noTok = await fn({ action: "sign", source: "collection", all: true });
  check("沒有授權不能取得任何原圖網址", noTok.status === 401);
  const json = JSON.stringify(zipB.data);
  check("API 回應不含密碼", !json.includes(PW_WIFE));
  check("簽署網址 120 秒後失效（非永久連結）", zipB.data.expires_in === 120);
});

await step("未經授權無法用直接網址取得原圖", async () => {
  const p = sql(`select avatar_original_path from public.collection_works w join public.collections c on c.id = w.collection_id where c.slug = 'pamper-wife' and work_number = 1`);
  const pub = await fetch(`${API}/storage/v1/object/public/originals/${p}`);
  check("原圖不能用公開網址下載", pub.status >= 400, `HTTP ${pub.status}`);
  const direct = await fetch(`${API}/storage/v1/object/originals/${p}`, { headers: { apikey: mock.ANON_KEY, Authorization: `Bearer ${mock.ANON_KEY}` } });
  check("原圖不能以訪客身分直接下載", direct.status >= 400, `HTTP ${direct.status}`);
  const forged = await fetch(`${API}/storage/v1/object/sign/originals/${p}?token=forged.sig`);
  check("偽造簽署網址無效", forged.status >= 400, `HTTP ${forged.status}`);
  const cols = await fetch(`${API}/rest/v1/collection_works?select=original_path`, { headers: { apikey: mock.ANON_KEY } });
  check("訪客 API 讀不到原圖路徑", cols.status >= 400, `HTTP ${cols.status}`);
  const av = await fetch(`${API}/rest/v1/collection_works?select=avatar_original_path`, { headers: { apikey: mock.ANON_KEY } });
  check("訪客 API 讀不到大頭貼版原圖路徑", av.status >= 400, `HTTP ${av.status}`);
  const html = await (await fetch(SITE)).text();
  const js = fs.readdirSync(path.join(DIST, "assets")).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(DIST, "assets", f), "utf8")).join("");
  check("網頁原始碼與前端程式不含任何測試密碼", ![PW_LIFE, PW_WIFE, PW_DAILY, PW_SITE].some((pw) => html.includes(pw) || js.includes(pw)));
  check("前端程式不含 service role 金鑰", !js.includes("service_role") || !/eyJ[^"]{20,}\.eyJ[^"]*c2VydmljZV9yb2xl/.test(js));
});

await step("修改 A 系列密碼：A 舊授權失效，B、C 不受影響", async () => {
  await openCollectionAdmin(pageA, "KUMA 熊兔生命共同體");
  await setPassword(pageA, PW_LIFE_2);
  const a = await fn({ action: "sign", token: tokLife, source: "collection", all: true });
  check("A 系列舊授權立即失效", a.status === 401, `HTTP ${a.status}`);
  check("A 系列舊密碼不能再使用", (await tokenFor("one-heart-one-life", PW_LIFE)) === null);
  check("A 系列新密碼可以使用", Boolean(await tokenFor("one-heart-one-life", PW_LIFE_2)));
  check("B 系列授權不受影響", (await fn({ action: "sign", token: tokWife, source: "collection", all: true })).status === 200);
  check("C 系列授權不受影響", (await fn({ action: "sign", token: tokDaily, source: "collection", all: true })).status === 200);
});

await step("停用 B 系列密碼：B 立即不能下載，A、C 不受影響", async () => {
  await openCollectionAdmin(pageB, "熊大寵妻系列");
  await pageB.getByTestId("collection-pw-disable").click();
  await pageB.getByTestId("password-state").getByText("已設定・已停用").waitFor();
  const b = await fn({ action: "sign", token: tokWife, source: "collection", all: true });
  check("B 系列已發出的授權立即失效", b.status === 401 || b.status === 403, `HTTP ${b.status}`);
  const v = await fn({ action: "verify", password: PW_WIFE, collection: colId("pamper-wife") });
  check("B 系列停用時正確密碼也無法驗證", v.status === 403 && v.data.error === "collection_download_disabled", `HTTP ${v.status}`);
  check("C 系列不受影響", (await fn({ action: "sign", token: tokDaily, source: "collection", all: true })).status === 200);
  check("A 系列不受影響", Boolean(await tokenFor("one-heart-one-life", PW_LIFE_2)));
  // 粉絲在網頁上也無法繞過
  await fan.goto(`${SITE}#/c/pamper-wife`);
  await fan.getByRole("button", { name: /下載完整 5 張收藏卡/ }).click();
  // 先前的授權已失效，網頁會要求重新輸入密碼；即使輸入正確密碼也會被拒絕
  await fan.getByRole("heading", { name: "輸入「熊大寵妻系列」下載密碼" }).waitFor();
  await fan.getByLabel("下載密碼", { exact: true }).fill(PW_WIFE);
  await fan.getByRole("button", { name: "確認" }).click();
  await fan.getByText(/這個系列目前暫停下載/).waitFor();
  check("粉絲網頁上也無法下載停用中的系列（已通過的授權失效、正確密碼也被拒絕）", true);
  await fan.getByRole("button", { name: "取消" }).click();
  await pageB.getByTestId("collection-pw-enable").click();
  await pageB.getByTestId("password-state").getByText("已設定・啟用中").waitFor();
  tokWife = await tokenFor("pamper-wife", PW_WIFE);
  check("重新啟用後同一組密碼恢復可用", Boolean(tokWife));
});

await step("關閉 C 系列下載開關：只影響 C", async () => {
  await openCollectionAdmin(pageB, "熊兔甜蜜日常");
  await saveSeriesForm(pageB, { download: false });
  const c = await fn({ action: "sign", token: tokDaily, source: "collection", all: true });
  check("C 系列關閉下載後後端拒絕", c.status === 403, `HTTP ${c.status}`);
  check("B 系列不受影響", (await fn({ action: "sign", token: tokWife, source: "collection", all: true })).status === 200);
  await saveSeriesForm(pageB, { download: true });
  check("C 系列重新開放下載", (await fn({ action: "sign", token: tokDaily, source: "collection", all: true })).status === 200);
});

await step("原本收藏館功能正常（原本的密碼）", async () => {
  const t = await fn({ action: "verify", password: PW_SITE });
  check("原本收藏館密碼可取得授權", t.status === 200);
  const s = await fn({ action: "sign", token: t.data.token, ids: [OLD_ID], purpose: "original" });
  const buf = Buffer.from(await (await fetch(s.data.items[0].url)).arrayBuffer());
  check("原本收藏館原圖可下載且內容正確", md5(buf) === md5(oldOriginal));
  const s2 = await fn({ action: "sign", token: t.data.token, source: "collection", all: true });
  check("原本收藏館的授權不能下載任何系列", s2.status === 401);
});

await step("管理紀錄與安全刪除系列", async () => {
  await pageA.goto(`${SITE}#/admin/logs`);
  await pageA.getByTestId("audit-table").waitFor();
  const t = await pageA.getByTestId("audit-table").innerText();
  check("管理紀錄記下兩位管理員的操作", t.includes("管理員 A（我）") && t.includes("管理員 B（先生）"));
  check("管理紀錄有新增系列、設定密碼、停用密碼", t.includes("新增系列") && t.includes("設定／修改下載密碼") && t.includes("停用下載密碼") && t.includes("重新產生下載密碼"));
  check("管理紀錄不含密碼", ![PW_LIFE, PW_LIFE_2, PW_WIFE, PW_DAILY].some((p) => t.includes(p)));
  await pageA.screenshot({ path: path.join(OUT, "admin-logs.png"), fullPage: true });

  await createSeries(pageA, { name: "刪除測試系列", name_en: "DELETE TEST", slug: "delete-test", id_card_title: "測試身份證", manifesto_label: "測試宣言", theme: "classic" });
  await batchUpload(pageA, [{ name: "x_1.png", mimeType: "image/png", buffer: testImage(400, 400, [90, 90, 90]) }]);
  const anonDraft = await (await fetch(`${API}/rest/v1/collections?select=slug&slug=eq.delete-test`, { headers: { apikey: mock.ANON_KEY } })).json();
  check("草稿系列粉絲看不到", anonDraft.length === 0);
  await pageA.getByTestId("delete-collection").click();
  const dlg = pageA.getByTestId("delete-collection-dialog");
  await dlg.waitFor();
  check("刪除前要求選擇作品處理方式並輸入名稱", await dlg.getByTestId("delete-submit").isDisabled());
  await dlg.getByTestId("delete-mode-delete").check();
  await dlg.getByTestId("delete-confirm").fill("刪除測試系列");
  await dlg.getByTestId("delete-submit").click();
  await pageA.getByRole("heading", { name: "系列管理中心" }).waitFor();
  check("系列與作品已刪除", sql("select count(*) from public.collections where slug = 'delete-test'") === "0" && sql("select count(*) from public.collection_works w left join public.collections c on c.id = w.collection_id where c.id is null") === "0");
  check("其他三個系列不受影響", sql("select count(*) from public.collections") === "3");
});

await step("重新整理與重新登入後資料仍在（桌機）", async () => {
  const ctx = await newContext({ viewport: { width: 1366, height: 900 } });
  const p = await ctx.newPage();
  watch(p, "管理員B重新登入");
  await login(p, B);
  await p.getByTestId("collection-item").nth(2).waitFor();
  check("重新登入後 3 個系列都在", (await p.getByTestId("collection-item").count()) === 3);
  await ctx.close();
  const desk = await (await newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  watch(desk, "粉絲桌機");
  await desk.goto(SITE);
  await desk.getByTestId("series-card").nth(2).waitFor();
  check("桌機首頁顯示 3 個系列", (await desk.getByTestId("series-card").count()) === 3);
  await desk.screenshot({ path: path.join(OUT, "home-desktop.png"), fullPage: true });
  await desk.goto(`${SITE}#/c/pamper-wife`);
  await desk.getByTestId("life-card").nth(4).waitFor();
  await scrollAll(desk);
  await desk.waitForFunction(() => [...document.querySelectorAll("[data-testid=life-card] img")].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 });
  await desk.screenshot({ path: path.join(OUT, "wife-series-desktop.png"), fullPage: true });
  await desk.goto(`${SITE}#/life`);
  await desk.getByRole("heading", { name: "KUMA 熊兔生命共同體", level: 1 }).waitFor();
  check("舊網址 #/life 仍可進入第一系列", desk.url().includes("#/c/one-heart-one-life"));
  await fan.reload();
  await fan.getByTestId("life-card").first().waitFor();
  check("手機重新整理後寵妻系列 5 款仍在", (await fan.getByTestId("life-card").count()) === 5);
});

check("瀏覽器沒有 JavaScript 錯誤", consoleErrors.length === 0, consoleErrors.slice(0, 3).join("｜"));

await browser.close();
await mock.close();
web.close();

const passed = results.filter((r) => r.ok).length;
const report = [
  "# 端到端測試報告：KUMA STUDIO 多系列（本機 Chromium＋Supabase 相容測試伺服器）",
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
console.log(`\n${passed}/${results.length} 通過，報告：tests/e2e/output-studio/report.md`);
process.exit(passed === results.length ? 0 : 1);
