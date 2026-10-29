// Supabase Edge Function：download
// 部署：npx supabase functions deploy download --no-verify-jwt
// 必要 Secret：DOWNLOAD_TOKEN_SECRET（至少 32 字元的隨機字串）
// 選用 Secret：ALLOWED_ORIGINS（逗號分隔，例如 https://你的帳號.github.io）
import { createClient } from "npm:@supabase/supabase-js@2";
import { handle, type ImageRow } from "./handler.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
// 伺服器端金鑰由 Supabase 自動注入 Edge Function（不在前端、不在 GitHub）：
// 新版為 SUPABASE_SECRET_KEYS（JSON），舊版為 SUPABASE_SERVICE_ROLE_KEY，兩者皆支援
function serverKey(): string {
  const json = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (json) {
    try {
      const keys = JSON.parse(json) as Record<string, string>;
      if (keys.default) return keys.default;
      const first = Object.values(keys)[0];
      if (first) return first;
    } catch {
      /* 改用舊版金鑰 */
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const serviceKey = serverKey();
const admin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

Deno.serve((req) =>
  handle(req, {
    tokenSecret: Deno.env.get("DOWNLOAD_TOKEN_SECRET") ?? "",
    allowedOrigins,
    async verifyPassword(password, clientHash) {
      const { data, error } = await admin.rpc("verify_download_password", {
        p_password: password,
        p_client: clientHash,
      });
      if (error) throw new Error(`verify rpc failed (${error.code})`);
      return data;
    },
    async downloadState() {
      const { data, error } = await admin.rpc("download_state");
      if (error) throw new Error(`state rpc failed (${error.code})`);
      return data;
    },
    async monthlyPublic() {
      const { data, error } = await admin.from("site_settings").select("monthly_public").eq("id", 1).single();
      if (error) throw new Error(`settings query failed (${error.code})`);
      return data.monthly_public;
    },
    async listImages(ids) {
      let q = admin
        .from("images")
        .select("id,title,original_path,plain_original_path,mime_type,file_size,sort_order,is_published,is_downloadable,is_monthly")
        .eq("is_published", true)
        .eq("is_downloadable", true);
      if (ids) q = q.in("id", ids);
      const { data, error } = await q;
      if (error) throw new Error(`images query failed (${error.code})`);
      return data as ImageRow[];
    },
    async signUrls(paths, expiresIn) {
      const { data, error } = await admin.storage.from("originals").createSignedUrls(paths, expiresIn);
      if (error) throw new Error(`sign failed (${error.name})`);
      const byPath = new Map(data.map((d) => [d.path, d.error ? null : d.signedUrl]));
      return paths.map((p) => byPath.get(p) ?? null);
    },
  })
);
