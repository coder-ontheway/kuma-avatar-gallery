# KUMA 熊兔大頭貼收藏館

KUMA 工作室的熊大、兔兔原創照片大頭貼網站。粉絲可以公開瀏覽作品，挑選 Facebook／Instagram／LINE 用途、調整裁切、加上自己的文字，輸入下載密碼後下載個人化 PNG；兩位授權管理員可在後臺上傳、排序、發布作品與管理下載密碼。

- 前端：Vite＋React＋TypeScript，部署在 **GitHub Pages**
- 後端：**Supabase**（Auth、Database＋RLS、Storage、Edge Functions），全部使用免費方案可用的功能
- 不需要自架伺服器、不需要付費 API、粉絲不需要註冊

> 相關文件：[每月更新操作手冊](docs/每月更新手冊.md)｜[部署與驗收清單](docs/部署與驗收清單.md)｜[最新測試報告](docs/測試報告.md)

---

## 目錄

1. [功能總覽](#功能總覽)
2. [安全設計](#安全設計)
3. [Supabase 免費方案評估](#supabase-免費方案評估)
4. [專案結構](#專案結構)
5. [部署步驟（第一次）](#部署步驟第一次)
6. [兩位管理員的帳號設定](#兩位管理員的帳號設定)
7. [本機開發與測試](#本機開發與測試)
8. [常見問題](#常見問題)

---

## 功能總覽

### 粉絲前臺

| 功能 | 說明 |
| --- | --- |
| 首頁 | 品牌名稱、網站公告、最新更新日期、本月大頭貼、分類篩選、Facebook 粉專連結、瀏覽與下載說明 |
| 作品卡片 | 預覽圖、作品名稱、分類、標籤、作品日期、Facebook／Instagram／LINE 選擇、下載按鈕 |
| 大頭貼編輯器 | 三種平台預覽切換；拖曳移動、雙指捏合／滑鼠滾輪／滑桿縮放、置中、顯示完整圖片、重設裁切 |
| 平台預覽 | Facebook：圓形遮罩；Instagram：圓形遮罩＋虛線建議安全範圍；LINE：方形＋圓形參考縮圖 |
| 文字編輯器 | 多個文字區塊、多行、中英數與表情符號、黑體／明體、大小、顏色、拖曳位置、靠左／置中／靠右、粗體、描邊、陰影、文字背景色與透明度、背景圓角、刪除、撤銷、重設設計 |
| 圓形安全提醒 | 文字超出圓形範圍時提示，一鍵「移入安全範圍」；文字一律不會被拖出畫布 |
| 背景 | 預設保留透明 PNG；可選白色、奶油、粉紅、天空或自訂顏色 |
| 下載 | 輸入下載密碼後，以 **原圖解析度** 在瀏覽器重新合成（不是螢幕截圖），檔名如 `KUMA_FB_作品名稱.png`、`KUMA_IG_…`、`KUMA_LINE_…` |
| 下載原圖／全部 ZIP | 下載單張原始檔，或「下載全部大頭貼」打包 ZIP（`KUMA_01_作品名稱.png`…，自動避免重名；超過 150MB 自動分成多個 ZIP） |

粉絲的文字、排版、裁切全部在瀏覽器中處理，**不會上傳、不會儲存、不會傳給任何第三方 AI 服務**，也沒有公開作品牆。關閉編輯視窗後不會保留設計。

> 平台預覽是「通用的大頭貼裁切示意」，不代表各平台官方的精確顯示方式；程式中沒有硬編任何官方尺寸規定。下載的一律是方形圖片，邊長沿用原圖實際裁切的像素（最大 2048px；加上文字時至少 1024px，讓文字清晰）。

### 管理後臺（`網站網址/#/admin`）

- 兩位管理員以各自的 Supabase Auth 帳號登入，權限相同
- 作品：多張上傳（存成草稿）→ 編輯名稱／分類／描述／標籤／日期 → 上下調整排序 → 勾選後一鍵「發布」（可同時更新最新更新日期）
- 替換圖片、刪除作品（含 Storage 檔案）、公開／取消公開、開放／停止下載、設為本月作品、清除本月標記
- 顯示檔案大小、格式、尺寸；點縮圖可預覽底圖在三種平台的裁切效果
- 分類：新增、改名、排序、刪除（作品變為未分類，不會被刪）
- 網站設定：網站名稱、品牌、公告、Facebook 粉專網址、最新更新日期、本月作品是否公開、全站下載開關
- 下載密碼：更換後舊密碼與已發出的下載授權立即失效；顯示由哪位管理員、何時更新
- 管理員名單（唯讀）、變更自己的登入密碼、忘記密碼信

每月更新只需要在後臺操作，**不需要修改程式碼、重新建置或編輯 JSON**。

---

## 安全設計

```
粉絲瀏覽器 ──(公開)──▶ previews bucket（公開預覽圖，最長邊 1200px）
     │
     ├─ 輸入下載密碼 ──▶ Edge Function「download」──▶ 資料庫 bcrypt 比對＋錯誤次數限制
     │                         └─ 成功：回傳 15 分鐘有效的下載憑證（HMAC 簽章）
     │
     └─ 憑證＋作品 ID ──▶ Edge Function ──▶ originals bucket（私有）建立 120 秒有效的簽署網址
                                                  └─ 瀏覽器下載原圖 → 裁切＋文字 → 輸出 PNG／ZIP
```

| 項目 | 實作 |
| --- | --- |
| 下載密碼 | 只存 **bcrypt 雜湊**（`private` schema，不對 API 公開）；比對在資料庫函式內進行，只有 Edge Function 的伺服器金鑰能呼叫。前端完全不比對密碼 |
| 防暴力猜測 | 同一來源 15 分鐘內錯 5 次即鎖定；全站 15 分鐘內錯 200 次暫停驗證。來源 IP 以 HMAC 處理後才存，不保存原始 IP；同一來源的請求在資料庫內序列化，避免並行繞過 |
| 下載授權 | 驗證成功才發 15 分鐘憑證；每次下載再換 **120 秒** 的簽署網址，不會產生永久公開連結。更換密碼後憑證立即失效 |
| 日誌 | Edge Function 只記錄錯誤類型，不記錄請求內容或密碼 |
| 私有原圖 | `originals` bucket 為私有，沒有任何訪客政策：不能列出、不能用公開網址或 API 直接下載 |
| ZIP | 由 Edge Function 先驗證憑證再發簽署網址，瀏覽器端打包；未驗證無法取得任何原圖 |
| 管理員授權 | `public.admins` 以 **Auth 使用者 UUID** 為依據；`is_admin()` 每次請求即時查表，停用後立即失去權限。不依賴 email、前端變數或 localStorage |
| 不能新增第三位 | 管理員表沒有任何寫入權限給登入使用者；另有資料庫觸發器限制「有效管理員最多 2 位」（即使在 SQL Editor 也一樣） |
| RLS | 所有表格啟用 RLS：訪客只能讀已發布作品（欄位層級授權，看不到原圖路徑）、分類、公開設定；寫入一律要求 `is_admin()` |
| Storage 政策 | 只有授權管理員能在 previews／originals 新增、修改、刪除、讀取管理用檔案 |
| 金鑰 | 前端只用 anon／publishable key（公開值）。Service Role／Secret Key 只存在 Supabase Edge Function 環境；GitHub Actions 會在建置前掃描私密金鑰 |
| 註冊 | 關閉公開註冊（`supabase/config.toml` 與 Dashboard 設定），網站沒有註冊頁面 |

公開預覽圖是「讓粉絲在瀏覽器完成裁切預覽」所必需，任何人都能看到（最長邊 1200px）；真正的原圖只能經由密碼流程取得。

---

## Supabase 免費方案評估

以下為撰寫時（2026 年 10 月）查到的免費方案主要額度，**實際額度請以 [Supabase Pricing](https://supabase.com/pricing) 為準**：

| 項目 | 免費額度 | 本網站預估用量 | 結論 |
| --- | --- | --- | --- |
| 資料庫 | 500MB | 作品資料＋設定，遠低於 1MB | 足夠 |
| Storage | 1GB | 每月約 20 張；以每張原圖 5MB＋預覽 0.3MB 估算，一年約 1.3GB | **一年左右可能接近上限**，見下方建議 |
| 流量（Egress） | 5GB／月 | 每位粉絲瀏覽約 5–10MB 預覽圖；下載全部 ZIP 約 20–100MB | 一般粉絲量足夠；若大量粉絲下載 ZIP 需留意 |
| Edge Function 呼叫 | 50 萬次／月 | 每次下載約 2 次 | 足夠 |
| Auth 使用者 | 5 萬 MAU | 2 位管理員 | 足夠 |
| 專案暫停 | 7 天無活動會暫停 | — | 已附 `keepalive.yml` 每 3 天讀取一次公開資料 |
| 備份 | 免費方案無自動備份 | — | 請自行保留原始照片檔案 |

建議：
1. 上傳前把原圖控制在合理大小（例如 2000–3000px、PNG 用工具壓縮），每月 20 張約 30–60MB，可撐數年。
2. Storage 接近 1GB 時，可刪除舊作品、改用 WebP 原圖，或升級 Pro 方案（付費，請自行評估）。
3. 熱門時段流量偏高時，可在後臺暫時關閉「開放粉絲下載」或移除部分舊作品。

---

## 專案結構

```
├─ src/                         前端（React＋TypeScript）
│  ├─ pages/Home.tsx            粉絲首頁
│  ├─ components/AvatarEditor   大頭貼＋文字編輯器
│  ├─ components/DownloadAuth   下載密碼視窗
│  ├─ pages/admin/              管理後臺（登入、作品、分類、設定、設定密碼）
│  └─ lib/                      裁切、文字排版、下載、ZIP、Supabase 存取
├─ supabase/
│  ├─ migrations/…_init_kuma.sql   資料表、RLS、Storage bucket 與政策、密碼函式
│  ├─ admin-setup.sql              登記／撤銷兩位管理員（需填入 UUID）
│  ├─ functions/download/          Edge Function（密碼驗證、下載授權）＋測試
│  ├─ tests/                       資料庫權限測試（本機 PostgreSQL）
│  └─ config.toml                  關閉註冊、Function 設定
├─ tests/e2e/                   端到端測試（瀏覽器實際操作）
├─ .github/workflows/           deploy（GitHub Pages）、test、keepalive
├─ docs/                        每月更新手冊、部署與驗收清單、測試報告
├─ .env.example                 前端環境變數範例
└─ supabase/functions/.env.example  Edge Function 密鑰範例
```

---

## 部署步驟（第一次）

> 預估 30–45 分鐘。需要：GitHub 帳號、Supabase 帳號（免費）。完整勾選清單見 [部署與驗收清單](docs/部署與驗收清單.md)。

### 1. 建立 Supabase 專案

1. 到 <https://supabase.com/dashboard> → **New project**，選擇離台灣近的區域（例如 Northeast Asia (Tokyo)），設定資料庫密碼並妥善保存。
2. 建立完成後到 **Project Settings → API**（或 **API Keys**），記下：
   - **Project URL**（`https://xxxx.supabase.co`）
   - **anon public key** 或 **Publishable key**（`sb_publishable_` 開頭）→ 這兩個是公開值，會放進網站
   - ⚠️ `service_role` / `Secret key` **不要**複製到任何地方

### 2. 建立資料表、權限與 Storage

1. **SQL Editor → New query**，貼上 `supabase/migrations/20261029000000_init_kuma.sql` 全部內容 → **Run**。
2. 應看到 `Success. No rows returned`。
3. 檢查：
   - **Table Editor** 出現 `admins`、`categories`（7 個預設分類）、`images`、`site_settings`
   - **Storage** 出現 `previews`（Public）與 `originals`（**不是** Public）

### 3. 關閉公開註冊

**Authentication → Sign In / Providers**（舊版介面在 Authentication → Providers／Settings）：
- 關閉 **Allow new users to sign up**
- Email provider 保持啟用（管理員用 email＋密碼登入）

### 4. 建立兩位管理員

依下方「[兩位管理員的帳號設定](#兩位管理員的帳號設定)」操作。

### 5. 部署 Edge Function

**方法 A：用 GitHub Actions（手機／iPad 也能做，推薦）**

1. Supabase：右上角頭像 → **Account preferences** → **Access Tokens** → **Generate new token**，名稱填 `github-deploy`，複製產生的權杖（只會顯示一次）。
2. GitHub 儲存庫 → **Settings → Secrets and variables → Actions**：
   - **Secrets** 分頁 → New repository secret：`SUPABASE_ACCESS_TOKEN` = 上一步的權杖
   - **Variables** 分頁 → New repository variable：`SUPABASE_PROJECT_REF` = 專案代碼（Project URL `https://<這段>.supabase.co` 中間那段）
3. **Actions → 部署下載功能（Edge Function）→ Run workflow**。
   第一次執行會自動產生 `DOWNLOAD_TOKEN_SECRET`（只存在 Supabase，GitHub 與執行紀錄都看不到），並把 `ALLOWED_ORIGINS` 設為 `https://<你的帳號>.github.io`。之後修改 `supabase/functions/` 推到 main 時會自動重新部署。

> 存取權杖可以管理你整個 Supabase 帳號，只放在 GitHub **Secrets**（加密、不會顯示），不要貼到任何其他地方。不再需要時可到 Access Tokens 頁面撤銷。
> 使用自訂網域時，另加 Variable `ALLOWED_ORIGINS` = `https://你的網域`。

**方法 B：在電腦上用指令**（需安裝 Node.js 22）：

```bash
git clone https://github.com/<你的帳號>/<儲存庫名稱>.git
cd <儲存庫名稱>
npm install
npx supabase login                       # 瀏覽器登入 Supabase
npx supabase link --project-ref <專案代碼>   # 專案代碼是 URL 中 https://<這段>.supabase.co
# 產生隨機密鑰（只放在 Supabase，不要存進 GitHub）
npx supabase secrets set DOWNLOAD_TOKEN_SECRET="$(openssl rand -base64 48)"
npx supabase secrets set ALLOWED_ORIGINS="https://<你的帳號>.github.io"
npx supabase functions deploy download --no-verify-jwt
```

（Windows 沒有 openssl 時，可到 Supabase Dashboard → Edge Functions → Secrets 手動新增 `DOWNLOAD_TOKEN_SECRET`，值用密碼管理器產生至少 48 字元的隨機字串。）

完成後 Supabase 的 **Edge Functions** 頁面會出現 `download`。

> 為什麼 `--no-verify-jwt`：粉絲沒有帳號，函式改用「下載密碼 → 自簽短效憑證」自行驗證每一次請求。

### 6. 設定 GitHub Pages

1. 儲存庫需為 Public（GitHub 免費方案的私人儲存庫不能使用 Pages）。
2. **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
3. **Settings → Secrets and variables → Actions → Variables** 分頁 → **New repository variable**：
   - `VITE_SUPABASE_URL` = Project URL
   - `VITE_SUPABASE_ANON_KEY` = anon 或 publishable key
   - （使用自訂網域時另加 `VITE_BASE_PATH` = `/`）
4. **Actions → 部署到 GitHub Pages → Run workflow**（之後每次推送到 main 會自動部署）。
5. 完成後網址為 `https://<你的帳號>.github.io/<儲存庫名稱>/`。

### 7. 設定登入信的回跳網址

**Authentication → URL Configuration**：
- **Site URL**：`https://<你的帳號>.github.io/<儲存庫名稱>/`
- **Redirect URLs** 加入同一個網址

### 8. 第一次登入與發布

1. 開 `https://<你的帳號>.github.io/<儲存庫名稱>/#/admin` 登入。
2. **網站設定** → 設定粉絲下載密碼、Facebook 粉專網址、公告。
3. **作品管理** → 上傳第一批照片 → 確認 → **發布**。
4. 用手機開首頁，實際試一次下載（輸入下載密碼）。

---

## 兩位管理員的帳號設定

管理權限以 **Supabase Auth 使用者 UUID** 判斷，只能由網站擁有者在 Supabase Dashboard 設定，網站上沒有任何註冊或新增管理員的功能。

1. **Authentication → Users → Add user → Create new user**
   - 輸入你的 email，設定一個臨時密碼，勾選 **Auto Confirm User** → Create
   - 對先生的 email 重複一次
   - （也可以選 **Send invitation**，對方收信點連結後會進入網站的「設定我的登入密碼」頁面）
2. 在使用者列表點開每個帳號，複製 **User UID**。
3. **SQL Editor**：打開 `supabase/admin-setup.sql`，把 `<管理員A的UUID>`、`<管理員B的UUID>` 換成剛剛的 UID，修改顯示名稱，執行。最後的查詢應顯示 2 列、`is_active = true`。
4. 兩人各自登入網站 `#/admin`，到 **網站設定 → 變更我的登入密碼** 改成只有自己知道的密碼（至少 10 字元）。兩人的密碼互不影響。

**撤銷權限**（例如帳號外洩）：SQL Editor 執行
```sql
update public.admins set is_active = false where user_id = '<UUID>';
```
立即生效，即使對方目前登入中也無法再做任何管理操作。建議同時在 Authentication → Users 封鎖（Ban）或刪除該帳號。

**限制**：有效管理員最多 2 位；要換人需先停用其中一位。任何一位管理員都無法從網站或 API 新增第三位管理員。

---

## 本機開發與測試

```bash
npm install
cp .env.example .env.local     # 填入 Supabase URL 與 anon／publishable key
npm run dev                    # http://localhost:5173
```

| 指令 | 內容 | 需求 |
| --- | --- | --- |
| `npm test` | 裁切數學、檔名、ZIP 分批單元測試 | — |
| `npm run typecheck` | TypeScript 型別檢查 | — |
| `npm run test:db` | 在本機 PostgreSQL 套用 migration，測試 RLS、Storage 政策、雙管理員、撤銷、密碼雜湊與鎖定（87 項） | PostgreSQL 15+ |
| `npm run test:functions` | Edge Function 測試（16 項） | 安裝時自動下載 Deno |
| `npm run test:e2e` | 瀏覽器端到端驗收（80 項，含截圖） | PostgreSQL、Playwright Chromium，作品放在 `tests/e2e/private-artworks/`（不提交） |
| `npm run check:secrets` | 掃描是否有私密金鑰要被提交 | git |

端到端測試使用 `tests/e2e/mock-supabase.mjs`：一個「Supabase 相容測試伺服器」，把請求轉成在本機 PostgreSQL 以 anon／authenticated／service_role 身分執行的 SQL（正式 migration 的 RLS 實際生效），並直接執行正式的 Edge Function 程式。它不是真正的 Supabase，因此正式環境仍需依 [部署與驗收清單](docs/部署與驗收清單.md) 實測一次。

---

## 常見問題

**粉絲說輸入正確密碼還是不能下載？**
同一網路 15 分鐘內錯 5 次會暫時鎖定，請等提示的時間後再試。也請確認後臺「開放粉絲下載」已勾選、作品沒有被設為「停止下載」。

**忘記下載密碼？**
密碼只存雜湊，無法查看。到後臺直接設定新密碼即可。

**忘記管理員登入密碼？**
登入頁按「忘記密碼」收信重設；或由專案擁有者在 Supabase Dashboard → Authentication → Users 對該帳號 **Send password recovery**。

**網站打不開／顯示「尚未連接 Supabase」？**
檢查 GitHub Variables 的 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`，重新執行部署。若 Supabase 專案被暫停，到 Dashboard 按 **Restore**。

**可以換網址或自訂網域嗎？**
可以。自訂網域時設定 `VITE_BASE_PATH=/`，並更新 Supabase 的 Site URL、Redirect URLs 與 Edge Function 的 `ALLOWED_ORIGINS`。
