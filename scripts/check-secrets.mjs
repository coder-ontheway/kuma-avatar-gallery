// 掃描要提交的檔案，避免把 Service Role Key、Secret Key、密碼等私密資訊提交到 GitHub
import { execSync } from "node:child_process";
import fs from "node:fs";

let files;
try {
  files = execSync("git ls-files --cached --others --exclude-standard", { encoding: "utf8" }).split("\n").filter(Boolean);
} catch {
  console.error("找不到 git，略過檢查");
  process.exit(0);
}

const patterns = [
  [/sb_secret_[A-Za-z0-9_-]{10,}/, "Supabase Secret Key"],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*cm9sZSI6InNlcnZpY2Vfcm9sZS[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/, "Supabase service_role JWT"],
  [/SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S{20,}/, "Service Role Key 設定值"],
  [/DOWNLOAD_TOKEN_SECRET\s*=\s*(?!請貼上)\S{20,}/, "DOWNLOAD_TOKEN_SECRET 設定值"],
  [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, "私鑰"],
];
const problems = [];
for (const f of files) {
  if (!fs.existsSync(f) || fs.statSync(f).size > 2_000_000) continue;
  if (/\.(png|jpe?g|webp|zip|ico)$/i.test(f)) {
    if (f.startsWith("tests/e2e/private-artworks/")) problems.push(`${f}：私有原圖不應提交`);
    continue;
  }
  const text = fs.readFileSync(f, "utf8");
  for (const [re, label] of patterns) if (re.test(text)) problems.push(`${f}：疑似包含 ${label}`);
  if (/^\.env(\.|$)/.test(f.split("/").pop()) && !f.endsWith(".env.example")) problems.push(`${f}：.env 檔不應提交`);
}
if (problems.length) {
  console.error("❌ 發現可能的私密資訊：\n" + problems.join("\n"));
  process.exit(1);
}
console.log(`✅ 已檢查 ${files.length} 個檔案，沒有發現私密金鑰`);
