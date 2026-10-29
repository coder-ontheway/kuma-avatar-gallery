import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** 前端只使用公開的 anon / publishable key；所有權限由資料庫 RLS 與 Edge Function 把關 */
export const isConfigured = Boolean(url && key && !url.includes("你的專案") && !key.startsWith("請貼上"));

// 邀請／重設密碼信件的連結會把資訊放在網址 # 之後；在 Supabase 處理前先記下類型
const initialHash = typeof window !== "undefined" ? window.location.hash : "";
export const authLinkType: "invite" | "recovery" | null = /type=invite/.test(initialHash)
  ? "invite"
  : /type=recovery/.test(initialHash)
    ? "recovery"
    : null;

export const supabase: SupabaseClient = createClient(url || "https://not-configured.invalid", key || "not-configured", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
});

export const functionsUrl = `${(url || "").replace(/\/+$/, "")}/functions/v1`;
export const anonKey = key || "";
