// =====================================================================
// 端到端驗收測試：新增「熊大工作日常表情包」12 款獨立系列
// 執行：npm run test:e2e:work
// 需求：本機 PostgreSQL、Playwright Chromium。
// 作品照片：tests/e2e/private-artworks/work-daily/ 內放 No.001～No.012 正式照片（不提交到 GitHub）；
//           沒有放時，改用瀏覽器畫出的「測試圖」（只用來驗證功能，不是作品）。
// 其他系列（熊兔生命共同體、熊大寵妻系列）與原本收藏館使用純色測試圖，用來確認新系列不影響它們。
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
const OUT = path.join(ROOT, "tests/e2e/output-work");
const ART = path.join(ROOT, "tests/e2e/private-artworks/work-daily");
const DB = "kuma_e2e_work";
const API_PORT = 54351;
const WEB_PORT = 4203;
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
const PW_WIFE = "test-wife-pw-2222";
const PW_WORK = "test-work-pw-3333";
const PW_WORK_2 = "test-work-pw-3334";

// 熊大工作日常表情包：RR 指定的 12 款編號、台詞與畫面情境
const SLUG = "bear-work-daily";
const SERIES = "熊大工作日常表情包";
const WORK = [
  { no: 1, title: "出門上班熊大", line: "上班啦！", scene: "熊大背著工作包，精神滿滿準備上班", manifesto: "今天也是元氣滿滿的一天！" },
  { no: 2, title: "準備開工熊大", line: "開工囉！", scene: "熊大坐在辦公桌前，打開筆電準備工作", manifesto: "打開筆電，認真開工。" },
  { no: 3, title: "忙碌打字熊大", line: "忙碌中…", scene: "熊大快速打字，桌上堆滿文件", manifesto: "再忙也要記得喘口氣。" },
  { no: 4, title: "喝水休息熊大", line: "先喝口水", scene: "熊大拿起水杯喝水，稍作休息", manifesto: "多喝水，工作才有精神。" },
  { no: 5, title: "認真開會熊大", line: "會議中", scene: "熊大坐在會議桌前，認真聽取簡報", manifesto: "認真聽，用心記。" },
  { no: 6, title: "收到訊息熊大", line: "收到，馬上辦！", scene: "熊大看著電腦訊息，舉手表示收到", manifesto: "使命必達，交給熊大！" },
  { no: 7, title: "完成報告熊大", line: "報告完成！", scene: "熊大開心舉起完成的報告，露出成就感", manifesto: "完成的感覺最棒了！" },
  { no: 8, title: "替自己加油熊大", line: "再撐一下！", scene: "熊大努力工作，握拳替自己加油", manifesto: "快完成了，加油！" },
  { no: 9, title: "腦袋當機熊大", line: "腦袋當機中…", scene: "熊大眼神放空，頭上出現當機、轉圈的可愛效果", manifesto: "重新開機中，請稍候。" },
  { no: 10, title: "準時下班熊大", line: "今天準時下班！", scene: "熊大開心收拾公事包，準備離開辦公室", manifesto: "準時下班，是對自己最好的獎勵。" },
  { no: 11, title: "溫暖鼓勵熊大", line: "辛苦了！", scene: "熊大溫暖微笑，雙手比出鼓勵手勢", manifesto: "你今天也很努力喔！" },
  { no: 12, title: "伸懶腰休息熊大", line: "明天再努力～", scene: "熊大關上筆電，伸懶腰準備休息", manifesto: "好好休息，明天再出發。" },
];
const WORK_MANIFESTOS = ["今天也要認真工作！", "辛苦了，你最棒！", "準時下班萬歲！", "工作再忙也要照顧自己。", "熊大陪你一起努力。"];
const no3 = (n) => `No.${String(n).padStart(3, "0")}`;

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

// ---------- 12 款作品檔案（正式照片優先，沒有時用測試圖） ----------
async function makeTestArt(n, line) {
  const p = await browser.newPage();
  const dataUrl = await p.evaluate(({ n, line }) => {
    const c = document.createElement("canvas");
    c.width = c.height = 1080;
    const g = c.getContext("2d");
    g.fillStyle = `hsl(${n * 30}, 45%, 88%)`;
    g.fillRect(0, 0, 1080, 1080);
    g.fillStyle = "#8a5a35";
    g.beginPath(); g.arc(540, 640, 300, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(310, 390, 95, 0, Math.PI * 2); g.arc(770, 390, 95, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#e9cfa8"; g.beginPath(); g.ellipse(540, 730, 120, 95, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#111"; [440, 640].forEach((x) => { g.beginPath(); g.arc(x, 600, 22, 0, Math.PI * 2); g.fill(); });
    g.beginPath(); g.ellipse(540, 700, 34, 24, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#5a3a26"; g.font = "bold 110px sans-serif"; g.textAlign = "center";
    g.fillText(line, 540, 190);
    g.font = "bold 44px sans-serif"; g.fillText(`測試圖 No.${String(n).padStart(3, "0")}`, 540, 1040);
    return c.toDataURL("image/png");
  }, { n, line });
  await p.close();
  return Buffer.from(dataUrl.split(",")[1], "base64");
}
const realFiles = fs.existsSync(ART) ? fs.readdirSync(ART).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)) : [];
const usingReal = realFiles.length >= 12;
const workFiles = [];
for (const w of WORK) {
  if (usingReal) {
    const f = realFiles.find((x) => new RegExp(`(^|[^0-9])0*${w.no}([^0-9]|$)`).test(x.replace(/\.[a-z]+$/i, "")));
    if (!f) throw new Error(`找不到 ${no3(w.no)} 的正式照片`);
    const ext = path.extname(f).toLowerCase();
    workFiles.push({ no: w.no, name: `${no3(w.no)}${ext}`, mimeType: ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg", buffer: fs.readFileSync(path.join(ART, f)) });
  } else {
    workFiles.push({ no: w.no, name: `${no3(w.no)}.png`, mimeType: "image/png", buffer: await makeTestArt(w.no, w.line) });
  }
}
console.log(usingReal ? "使用正式照片 No.001～No.012" : "未放正式照片：使用測試圖驗證功能");

// 其他系列與原本收藏館的資料快照（用來確認新增系列後完全沒有變動）
function snapshotOthers() {
  return sql(`select md5(coalesce(string_agg(x, '|' order by x), '')) from (
    select row_to_json(c)::text x from public.collections c where slug <> '${SLUG}'
    union all select row_to_json(w)::text from public.collection_works w join public.collections c on c.id = w.collection_id where c.slug <> '${SLUG}'
    union all select row_to_json(s)::text from private.collection_download_secret s join public.collections c on c.id = s.collection_id where c.slug <> '${SLUG}'
    union all select row_to_json(i)::text from public.images i
    union all select row_to_json(d)::text from private.download_secret d
  ) t`);
}

// ===================================================================
// 既有系列（熊兔生命共同體、熊大寵妻系列）先準備好
// ===================================================================
const ctxA = await newContext({ viewport: { width: 1366, height: 900 } });
const pageA = await ctxA.newPage();
watch(pageA, "管理員A");
debugPages.A = pageA;

await step("準備既有系列：熊兔生命共同體、熊大寵妻系列", async () => {
  await login(pageA, A);
  await openCollectionAdmin(pageA, "KUMA 熊兔生命共同體");
  check("生命共同體 3 張測試圖上傳成功", (await batchUpload(pageA, [1, 2, 3].map((n) => ({ name: `test_life_${n}.png`, mimeType: "image/png", buffer: testImage(900, 900, [60 + n * 40, 140, 90]) })))) === 0);
  await publishAll(pageA);
  await setPassword(pageA, PW_LIFE);
  await createSeries(pageA, { name: "熊大寵妻系列", name_en: "PAMPER MY BUNNY", slug: "pamper-wife", id_card_title: "熊大寵妻身份證", manifesto_label: "寵妻宣言", theme: "sweet" });
  check("寵妻系列 2 張測試圖上傳成功", (await batchUpload(pageA, [1, 2].map((n) => ({ name: `wife_${n}.png`, mimeType: "image/png", buffer: testImage(900, 900, [230, 150 + n * 20, 170]) })))) === 0);
  await saveSeriesForm(pageA, { manifestos: ["兔兔最大，熊大負責執行。"], status: "published" });
  await publishAll(pageA);
  await setPassword(pageA, PW_WIFE);
});

const before = snapshotOthers();
let tokLife0 = await tokenFor("one-heart-one-life", PW_LIFE);
let tokWife0 = await tokenFor("pamper-wife", PW_WIFE);
check("既有系列各自的授權可用（新增前）", Boolean(tokLife0 && tokWife0));

// ===================================================================
// 新增「熊大工作日常表情包」
// ===================================================================
await step("新增系列「熊大工作日常表情包」（草稿）", async () => {
  await createSeries(pageA, { name: SERIES, name_en: "BEAR WORK DAILY", slug: SLUG, id_card_title: "熊大工作證", manifesto_label: "工作宣言", theme: "classic" });
  check("新系列預設為草稿，粉絲看不到", sql(`select status from public.collections where slug = '${SLUG}'`) === "draft");
  const anon = await (await fetch(`${API}/rest/v1/collections?select=slug&slug=eq.${SLUG}`, { headers: { apikey: mock.ANON_KEY } })).json();
  check("草稿系列訪客 API 讀不到", anon.length === 0);
});

await step("批次上傳 12 張獨立照片，依檔名對應 No.001～No.012", async () => {
  // 故意打亂順序上傳，確認是依檔名編號對應而不是依上傳順序
  const shuffled = [...workFiles].sort((a, b) => ((a.no * 7) % 12) - ((b.no * 7) % 12));
  await pageA.getByTestId("life-batch-input").setInputFiles(shuffled.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })), { timeout: 120000 });
  await pageA.getByTestId("life-plan").locator("li").nth(11).waitFor();
  const plan = await pageA.getByTestId("life-plan").locator("li").evaluateAll((els) => els.map((li) => `${li.querySelector("select")?.value}:${li.textContent.match(/No\.\d{3}\.\w+/)?.[0]}`));
  check("12 個檔案都依檔名對應到正確編號", plan.length === 12 && plan.every((p) => { const [v, n] = p.split(":"); return n && Number(n.slice(3, 6)) === Number(v); }), plan.join(" / "));
  await pageA.getByTestId("life-batch-start").click();
  await pageA.waitForFunction(() => document.querySelectorAll("[data-testid=life-plan] li.up-done, [data-testid=life-plan] li.up-error").length >= 12, null, { timeout: 180000 });
  check("12 張全部上傳成功", (await pageA.locator("[data-testid=life-plan] li.up-error").count()) === 0);
  const id = colId(SLUG);
  check("建立 12 筆獨立作品（沒有合併成拼貼）", sql(`select count(*) from public.collection_works where collection_id = '${id}'`) === "12");
  check("編號正好是 No.001～No.012", sql(`select string_agg(work_number::text, ',' order by work_number) from public.collection_works where collection_id = '${id}'`) === WORK.map((w) => w.no).join(","));
  const rows = sql(`select string_agg(work_number || '|' || original_path || '|' || width || 'x' || height, ',' order by work_number) from public.collection_works where collection_id = '${id}'`).split(",");
  let same = rows.length === 12, square = true;
  for (const r of rows) {
    const [no, p, wh] = r.split("|");
    const src = workFiles.find((f) => f.no === Number(no)).buffer;
    same &&= md5(fs.readFileSync(path.join(STORAGE, "originals", p))) === md5(src) && p.startsWith(`collections/${id}/`);
    const [ww, hh] = wh.split("x");
    square &&= ww === hh;
  }
  check("每款原圖與上傳檔案位元組完全相同（沒有被修改或合成）", same);
  check("12 張都是 1:1 正方形", square, rows.map((r) => r.split("|")[2]).join(" "));
  check("12 張照片內容各不相同", new Set(workFiles.map((f) => md5(f.buffer))).size === 12);
});

await step("逐款填寫台詞（稱號）、作品名稱、情境介紹與工作宣言", async () => {
  for (const w of WORK) {
    await pageA.getByTestId("life-admin-item").filter({ hasText: `${no3(w.no)}｜` }).getByRole("button", { name: "編輯資料" }).click();
    const dlg = pageA.locator(".modal");
    await dlg.getByLabel("專屬稱號").fill(w.line);
    await dlg.getByLabel("作品名稱").fill(w.title);
    await dlg.getByLabel("作品介紹（顯示在身份證與收藏卡）").fill(w.scene);
    await dlg.getByLabel(/主題宣言/).fill(w.manifesto);
    await dlg.getByRole("button", { name: "儲存" }).click();
    await pageA.getByText("作品資料已儲存。").waitFor();
  }
  const got = sql(`select string_agg(work_number || '=' || nickname || '=' || description, '|' order by work_number) from public.collection_works where collection_id = '${colId(SLUG)}'`);
  check("12 款台詞與情境逐字正確", got === WORK.map((w) => `${w.no}=${w.line}=${w.scene}`).join("|"), got);
  await saveSeriesForm(pageA, {
    manifestos: WORK_MANIFESTOS,
    tagline: "上班族熊大的 12 個工作瞬間",
    description: "從上班、開會、忙碌到準時下班，熊大陪你度過每一個工作日。12 款獨立大頭貼，每款都能加上自己的文字、製作收藏卡。",
  });
  await pageA.getByTestId("cover-input").setInputFiles({ name: "cover.png", mimeType: workFiles[0].mimeType, buffer: workFiles[0].buffer });
  await pageA.getByText("系列封面已更新。").waitFor();
  check("系列封面使用 No.001", sql(`select cover_path like 'collections/%' from public.collections where slug = '${SLUG}'`) === "t");
  await publishAll(pageA);
  check("12 款全部公開", sql(`select count(*) from public.collection_works where collection_id = '${colId(SLUG)}' and is_published`) === "12");
});

await step("管理員可以排序、替換照片", async () => {
  const id = colId(SLUG);
  const order = () => sql(`select string_agg(work_number::text, ',' order by sort_order, work_number) from public.collection_works where collection_id = '${id}'`);
  const original = order();
  await pageA.getByTestId("life-admin-item").filter({ hasText: "No.002｜" }).getByRole("button", { name: "下移" }).click();
  await pageA.waitForFunction(() => !document.querySelector(".admin-actions button[disabled]"), null, { timeout: 10000 }).catch(() => {});
  await pageA.waitForTimeout(800);
  check("下移後 No.002 排在 No.003 後面", order().startsWith("1,3,2,4"), order());
  await pageA.getByTestId("life-admin-item").filter({ hasText: "No.002｜" }).getByRole("button", { name: "上移" }).click();
  await pageA.waitForTimeout(800);
  check("上移後恢復 No.001～No.012 順序", order() === original, order());

  const item5 = pageA.getByTestId("life-admin-item").filter({ hasText: "No.005｜" });
  const repl = testImage(1080, 1080, [40, 90, 160]);
  let [chooser] = await Promise.all([pageA.waitForEvent("filechooser"), item5.getByRole("button", { name: "替換照片" }).click()]);
  await chooser.setFiles({ name: "No.005-new.png", mimeType: "image/png", buffer: repl });
  await pageA.getByText("已上傳 No.005 的照片。").waitFor({ timeout: 60000 });
  const p1 = sql(`select original_path from public.collection_works where collection_id = '${id}' and work_number = 5`);
  check("替換照片後 No.005 使用新照片", md5(fs.readFileSync(path.join(STORAGE, "originals", p1))) === md5(repl));
  [chooser] = await Promise.all([pageA.waitForEvent("filechooser"), item5.getByRole("button", { name: "替換照片" }).click()]);
  const f5 = workFiles[4];
  await chooser.setFiles({ name: f5.name, mimeType: f5.mimeType, buffer: f5.buffer });
  await pageA.getByText("已上傳 No.005 的照片。").nth(0).waitFor({ timeout: 60000 });
  await pageA.waitForTimeout(500);
  const p2 = sql(`select original_path from public.collection_works where collection_id = '${id}' and work_number = 5`);
  check("再替換回原本的 No.005（其他款不受影響）", md5(fs.readFileSync(path.join(STORAGE, "originals", p2))) === md5(f5.buffer) && sql(`select count(*) from public.collection_works where collection_id = '${id}'`) === "12");
  check("No.005 舊照片檔案已刪除", !fs.existsSync(path.join(STORAGE, "originals", p1)));
});

await step("保留新增第 13 款以後作品的能力", async () => {
  const id = colId(SLUG);
  await pageA.getByRole("button", { name: "＋ 新增一款" }).click();
  const dlg = pageA.locator(".modal");
  await dlg.getByLabel("專屬稱號").fill("第 13 款測試");
  await dlg.getByRole("button", { name: "儲存" }).click();
  await pageA.getByText("作品資料已儲存。").waitFor();
  check("「＋ 新增一款」自動建立 No.013", sql(`select count(*) from public.collection_works where collection_id = '${id}' and work_number = 13`) === "1");
  const item13 = pageA.getByTestId("life-admin-item").filter({ hasText: "No.013｜" });
  const [chooser] = await Promise.all([pageA.waitForEvent("filechooser"), item13.getByRole("button", { name: "上傳照片" }).click()]);
  await chooser.setFiles({ name: "No.013.png", mimeType: "image/png", buffer: testImage(1080, 1080, [200, 200, 80]) });
  await pageA.getByText("已上傳 No.013 的照片。").waitFor({ timeout: 60000 });
  check("No.013 可以上傳照片", sql(`select preview_path is not null from public.collection_works where collection_id = '${id}' and work_number = 13`) === "t");
  await item13.getByRole("button", { name: "刪除" }).click();
  await pageA.getByText("已刪除 No.013。").waitFor();
  check("測試用 No.013 已刪除，系列維持 12 款", sql(`select count(*) from public.collection_works where collection_id = '${id}'`) === "12");
});

await step("設定本系列專屬下載密碼並公開", async () => {
  await setPassword(pageA, PW_WORK);
  await saveSeriesForm(pageA, { status: "published" });
  check("系列已公開", sql(`select status from public.collections where slug = '${SLUG}'`) === "published");
  check("工作日常密碼以 bcrypt 雜湊存放（不是明文）", sql(`select (password_hash like '$2%' and password_hash <> '${PW_WORK}')::text from private.collection_download_secret where collection_id = '${colId(SLUG)}'`) === "true");
  check("三個系列各自一組不同的密碼雜湊", sql("select count(distinct password_hash) from private.collection_download_secret where password_hash is not null") === "3");
  await pageA.goto(`${SITE}#/admin`);
  await pageA.getByTestId("collection-item").nth(2).waitFor();
  const t = await pageA.getByTestId("collection-item").filter({ hasText: SERIES }).innerText();
  check("系列管理中心顯示工作日常 12 款、密碼已設定、可下載", t.includes("作品 12 款") && t.includes("密碼已設定") && t.includes("可下載"), t.replace(/\n/g, " "));
  await pageA.screenshot({ path: path.join(OUT, "admin-series-list.png"), fullPage: true });
  await openCollectionAdmin(pageA, SERIES);
  await scrollAll(pageA);
  await pageA.screenshot({ path: path.join(OUT, "admin-work-daily.png"), fullPage: true });
});

await step("其他系列與原本收藏館的資料完全沒有變動", async () => {
  check("生命共同體、寵妻系列、原本收藏館的作品、設定與密碼都和新增前相同", snapshotOthers() === before);
  check("既有系列先前發出的授權仍然有效", (await fn({ action: "sign", token: tokLife0, source: "collection", all: true })).status === 200 && (await fn({ action: "sign", token: tokWife0, source: "collection", all: true })).status === 200);
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

await step("首頁顯示新系列，其他系列照常顯示", async () => {
  await fan.goto(SITE);
  await fan.getByTestId("series-card").nth(2).waitFor();
  const cards = await fan.getByTestId("series-card").evaluateAll((els) => els.map((e) => `${e.dataset.slug}:${e.querySelector("small")?.textContent}`));
  check("首頁列出 3 個系列與作品數量", JSON.stringify(cards) === JSON.stringify(["one-heart-one-life:3 款作品", "pamper-wife:2 款作品", `${SLUG}:12 款作品`]), cards.join(" / "));
  await fan.getByTestId("art-card").first().waitFor();
  check("原本的大頭貼收藏館作品仍然顯示", (await fan.getByTestId("art-card").count()) === 1);
  await scrollAll(fan);
  await fan.screenshot({ path: path.join(OUT, "home-iphone.png"), fullPage: true });
});

await step("系列頁瀏覽 12 款，編號與台詞正確", async () => {
  await fan.locator(`[data-testid=series-card][data-slug="${SLUG}"]`).click();
  await fan.getByRole("heading", { name: SERIES, level: 1 }).waitFor();
  await fan.getByTestId("life-card").nth(11).waitFor();
  check("系列頁只顯示本系列 12 款", (await fan.getByTestId("life-card").count()) === 12);
  const nicks = await fan.locator(".life-nick").allInnerTexts();
  check("12 款台詞依序正確", JSON.stringify(nicks) === JSON.stringify(WORK.map((w) => w.line)), nicks.join("、"));
  const nos = await fan.getByTestId("life-card").allInnerTexts();
  check("12 款編號 No.001～No.012 依序顯示", WORK.every((w, i) => nos[i].includes(no3(w.no))));
  await scrollAll(fan);
  await fan.waitForFunction(() => [...document.querySelectorAll("[data-testid=life-card] img")].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 });
  check("12 張預覽圖都載入成功", true);
  await fan.screenshot({ path: path.join(OUT, "work-series-iphone.png"), fullPage: true });
});

await step("工作證（身份證）顯示本系列資料", async () => {
  await fan.goto(`${SITE}#/c/${SLUG}/6`);
  const card = fan.getByTestId("id-card");
  await card.waitFor();
  const t = await card.innerText();
  check("工作證標題、系列名稱、No.006、台詞、情境與工作宣言", t.includes("熊大工作證") && t.includes(SERIES) && t.includes("No.006") && t.includes("收到，馬上辦！") && t.includes(WORK[5].scene) && t.includes("工作宣言") && t.includes(WORK[5].manifesto));
  await fan.waitForTimeout(500);
  await fan.screenshot({ path: path.join(OUT, "work-id-card-iphone.png"), fullPage: true });
});

await step("大頭貼：自行加入／修改文字、三平台預覽、專屬密碼下載", async () => {
  await fan.getByTestId("make-avatar").click();
  await fan.getByTestId("crop-canvas").waitFor();
  await fan.waitForTimeout(800);
  const body = await fan.locator(".modal").innerText();
  check("編輯器提供本系列的工作宣言", WORK_MANIFESTOS.every((m) => body.includes(m)));
  check("不會出現其他系列的宣言", !body.includes("兔兔最大，熊大負責執行。"));
  const input = fan.getByTestId("text-input");
  if (!(await input.isVisible())) await fan.locator(".text-panel .chip").first().click();
  const before = await fan.getByTestId("crop-canvas").evaluate((c) => c.toDataURL());
  await fan.getByTestId("text-input").fill("我今天也很棒 💪");
  await fan.waitForTimeout(400);
  check("粉絲自訂文字（繁中＋Emoji）即時預覽", before !== (await fan.getByTestId("crop-canvas").evaluate((c) => c.toDataURL())));
  const minis = {};
  for (const p of ["Facebook", "Instagram", "LINE"]) {
    await fan.getByRole("tab", { name: p, exact: true }).click();
    await fan.waitForTimeout(300);
    minis[p] = await fan.getByTestId(`mini-${p.toLowerCase()}`).evaluate((c) => c.toDataURL());
    await fan.screenshot({ path: path.join(OUT, `work-editor-${p}.png`) });
  }
  const shapes = await Promise.all(["facebook", "instagram", "line"].map((p) => fan.getByTestId(`mini-${p}`).getAttribute("class")));
  check("Facebook／Instagram／LINE 三種裁切預覽都有畫面（FB、IG 圓形，LINE 方形）", Object.values(minis).every((u) => u.length > 1000) && shapes[0].includes("round") && shapes[1].includes("round") && !shapes[2].includes("round"), shapes.join(" / "));
  await fan.getByRole("tab", { name: "Facebook", exact: true }).click();
  await fan.getByRole("button", { name: "下載我的專屬大頭貼" }).click();
  await fan.getByRole("heading", { name: `輸入「${SERIES}」下載密碼` }).waitFor();
  for (const [label, pw] of [["生命共同體", PW_LIFE], ["寵妻系列", PW_WIFE], ["原本收藏館", PW_SITE]]) {
    await fan.getByLabel("下載密碼", { exact: true }).fill(pw);
    await fan.getByRole("button", { name: "確認" }).click();
    await fan.getByText(/下載密碼不正確/).waitFor();
    check(`${label}的密碼不能下載工作日常`, true);
  }
  await fan.getByLabel("下載密碼", { exact: true }).fill(PW_WORK);
  const n0 = signedPaths.length;
  const [d] = await Promise.all([fan.waitForEvent("download"), fan.getByRole("button", { name: "確認" }).click()]);
  const file = path.join(OUT, d.suggestedFilename());
  await d.saveAs(file);
  const png = PNG.sync.read(fs.readFileSync(file));
  check("輸入本系列密碼後下載大頭貼（正方形高解析 PNG）", png.width === png.height && png.width >= 1080, `${d.suggestedFilename()} ${png.width}×${png.height}`);
  check("檔名含系列名稱與 No.006", d.suggestedFilename().includes(SERIES) && d.suggestedFilename().includes("No.006"), d.suggestedFilename());
  const used = signedPaths.slice(n0);
  check("大頭貼使用本系列 No.006 原圖", used.length === 1 && used[0] === sql(`select original_path from public.collection_works where collection_id = '${colId(SLUG)}' and work_number = 6`), used.join(","));
  await fan.getByRole("button", { name: "關閉" }).click();
});

await step("收藏卡：單張與 12 張 ZIP", async () => {
  await fan.getByTestId("open-card").click();
  await fan.getByTestId("card-canvas").waitFor();
  await fan.waitForTimeout(800);
  check("收藏卡使用本系列的宣言名稱", (await fan.locator(".modal").innerText()).includes("官方工作宣言"));
  await fan.screenshot({ path: path.join(OUT, "work-card-iphone.png") });
  const [d] = await Promise.all([fan.waitForEvent("download"), fan.getByRole("button", { name: "下載這張收藏卡" }).click()]);
  const f = path.join(OUT, d.suggestedFilename());
  await d.saveAs(f);
  const size = jpegSize(fs.readFileSync(f));
  check("單張收藏卡 1200×1800（同系列 15 分鐘內不需再輸入密碼）", size?.w === 1200 && size?.h === 1800, d.suggestedFilename());
  await fan.getByRole("button", { name: "關閉" }).click();
  await fan.goto(`${SITE}#/c/${SLUG}`);
  await fan.getByRole("button", { name: /下載完整 12 張收藏卡/ }).waitFor();
  const [z] = await Promise.all([fan.waitForEvent("download", { timeout: 180000 }), fan.getByRole("button", { name: /下載完整 12 張收藏卡/ }).click()]);
  const zf = path.join(OUT, z.suggestedFilename());
  await z.saveAs(zf);
  const names = Object.keys(unzipSync(fs.readFileSync(zf))).sort();
  check("ZIP 含 12 張本系列收藏卡（不含其他系列）", names.length === 12 && names.every((n) => n.startsWith(`KUMA_${SERIES}_No.0`)), names.join("、"));
});

await step("換到寵妻系列仍要輸入寵妻密碼", async () => {
  await fan.goto(`${SITE}#/c/pamper-wife`);
  await fan.getByRole("button", { name: /下載完整 2 張收藏卡/ }).click();
  await fan.getByRole("heading", { name: "輸入「熊大寵妻系列」下載密碼" }).waitFor();
  await fan.getByLabel("下載密碼", { exact: true }).fill(PW_WORK);
  await fan.getByRole("button", { name: "確認" }).click();
  await fan.getByText(/下載密碼不正確/).waitFor();
  check("工作日常的密碼不能下載寵妻系列", true);
  await fan.getByLabel("下載密碼", { exact: true }).fill(PW_WIFE);
  const [z] = await Promise.all([fan.waitForEvent("download", { timeout: 120000 }), fan.getByRole("button", { name: "確認" }).click()]);
  const names = Object.keys(unzipSync(fs.readFileSync(await z.path())));
  check("寵妻系列用自己的密碼照常下載 2 張", names.length === 2 && names.every((n) => n.includes("熊大寵妻系列")));
});

// ===================================================================
// 後端（直接呼叫 API，不經過網頁）
// ===================================================================
await step("後端授權：工作日常的密碼只對應本系列", async () => {
  const tokWork = await tokenFor(SLUG, PW_WORK);
  const tokLife = await tokenFor("one-heart-one-life", PW_LIFE);
  const tokWife = await tokenFor("pamper-wife", PW_WIFE);
  check("工作日常密碼取得本系列授權", Boolean(tokWork));
  check("工作日常密碼不能取得生命共同體／寵妻授權", (await tokenFor("one-heart-one-life", PW_WORK)) === null && (await tokenFor("pamper-wife", PW_WORK)) === null);
  check("其他系列的密碼不能取得工作日常授權", (await tokenFor(SLUG, PW_LIFE)) === null && (await tokenFor(SLUG, PW_WIFE)) === null && (await tokenFor(SLUG, PW_SITE)) === null);
  check("原本收藏館不接受工作日常密碼", (await fn({ action: "verify", password: PW_WORK })).status !== 200);
  const all = await fn({ action: "sign", token: tokWork, source: "collection", all: true });
  check("工作日常授權下載全部時只拿到本系列 12 款", all.status === 200 && all.data.items.length === 12 && all.data.items.every((i) => workIds(SLUG).includes(i.id)));
  const cross = await fn({ action: "sign", token: tokWork, source: "collection", ids: [...workIds("pamper-wife"), ...workIds("one-heart-one-life")] });
  check("工作日常授權指定其他系列作品也拿不到", cross.status === 404, `HTTP ${cross.status}`);
  const rev = await fn({ action: "sign", token: tokWife, source: "collection", ids: workIds(SLUG) });
  check("寵妻授權指定工作日常作品也拿不到", rev.status === 404, `HTTP ${rev.status}`);
  check("工作日常授權不能下載原本收藏館", (await fn({ action: "sign", token: tokWork, ids: [OLD_ID] })).status === 401);

  await openCollectionAdmin(pageA, SERIES);
  await setPassword(pageA, PW_WORK_2);
  check("修改工作日常密碼後舊授權立即失效", (await fn({ action: "sign", token: tokWork, source: "collection", all: true })).status === 401);
  check("工作日常舊密碼失效、新密碼可用", (await tokenFor(SLUG, PW_WORK)) === null && Boolean(await tokenFor(SLUG, PW_WORK_2)));
  check("修改工作日常密碼不影響生命共同體與寵妻系列", (await fn({ action: "sign", token: tokLife, source: "collection", all: true })).status === 200 && (await fn({ action: "sign", token: tokWife, source: "collection", all: true })).status === 200);
  await pageA.getByTestId("collection-pw-disable").click();
  await pageA.getByTestId("password-state").getByText("已設定・已停用").waitFor();
  check("停用工作日常密碼時本系列不能下載", (await fn({ action: "verify", password: PW_WORK_2, collection: colId(SLUG) })).status === 403);
  check("停用工作日常密碼不影響其他系列", Boolean(await tokenFor("pamper-wife", PW_WIFE)) && Boolean(await tokenFor("one-heart-one-life", PW_LIFE)));
  await pageA.getByTestId("collection-pw-enable").click();
  await pageA.getByTestId("password-state").getByText("已設定・啟用中").waitFor();
  check("重新啟用後恢復可用", Boolean(await tokenFor(SLUG, PW_WORK_2)));
  const t = await fn({ action: "verify", password: PW_SITE });
  const s = await fn({ action: "sign", token: t.data.token, ids: [OLD_ID], purpose: "original" });
  const buf = Buffer.from(await (await fetch(s.data.items[0].url)).arrayBuffer());
  check("原本收藏館用原本的密碼照常下載", md5(buf) === md5(oldOriginal));
});

await step("其他系列粉絲頁面照常運作、桌機畫面", async () => {
  const desk = await (await newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  watch(desk, "粉絲桌機");
  await desk.goto(`${SITE}#/c/one-heart-one-life`);
  await desk.getByTestId("life-card").nth(2).waitFor();
  check("生命共同體頁面仍顯示 3 款", (await desk.getByTestId("life-card").count()) === 3);
  await desk.goto(`${SITE}#/c/pamper-wife`);
  await desk.getByRole("heading", { name: "熊大寵妻系列", level: 1 }).waitFor();
  await desk.getByTestId("life-card").nth(1).waitFor();
  await desk.waitForTimeout(500);
  check("寵妻系列頁面仍顯示 2 款", (await desk.getByTestId("life-card").count()) === 2);
  await desk.goto(`${SITE}#/c/${SLUG}`);
  await desk.getByRole("heading", { name: SERIES, level: 1 }).waitFor();
  await desk.getByTestId("life-card").nth(11).waitFor();
  await scrollAll(desk);
  await desk.waitForFunction(() => [...document.querySelectorAll("[data-testid=life-card] img")].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 });
  await desk.screenshot({ path: path.join(OUT, "work-series-desktop.png"), fullPage: true });
  const logs = sql(`select count(*) from public.admin_audit_log where collection_id = '${colId(SLUG)}'`);
  check("工作日常的操作都有管理紀錄", Number(logs) > 0, `${logs} 筆`);
});

check("瀏覽器沒有 JavaScript 錯誤", consoleErrors.length === 0, consoleErrors.slice(0, 3).join("｜"));

await browser.close();
await mock.close();
web.close();

const passed = results.filter((r) => r.ok).length;
const report = [
  "# 端到端測試報告：熊大工作日常表情包（本機 Chromium＋Supabase 相容測試伺服器）",
  "",
  `執行時間：${new Date().toISOString()}`,
  `作品照片：${usingReal ? "正式照片 No.001～No.012" : "測試圖（正式照片尚未提供）"}`,
  `結果：${passed}/${results.length} 通過`,
  "",
  "| 結果 | 項目 | 說明 |",
  "| --- | --- | --- |",
  ...results.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.name} | ${r.detail.replace(/\|/g, "／").replace(/\n/g, " ")} |`),
  "",
].join("\n");
fs.writeFileSync(path.join(OUT, "report.md"), report);
console.log(`\n${passed}/${results.length} 通過，報告：tests/e2e/output-work/report.md`);
process.exit(passed === results.length ? 0 : 1);
