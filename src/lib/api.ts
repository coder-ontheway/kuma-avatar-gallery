import { supabase } from "./supabase";
import type { Category, PublicImage, SiteSettings } from "./types";

// 訪客只能讀取這些欄位（資料庫以欄位權限限制，看不到私有原圖路徑）
export const PUBLIC_IMAGE_COLUMNS =
  "id,title,description,category_id,tags,preview_path,plain_preview_path,mime_type,file_size,width,height,sort_order,is_downloadable,is_monthly,work_date";

export const SETTINGS_COLUMNS =
  "site_name,brand_name,announcement,facebook_url,latest_update_date,monthly_title,monthly_public,downloads_enabled";

export async function fetchSettings(): Promise<SiteSettings> {
  const { data, error } = await supabase.from("site_settings").select(SETTINGS_COLUMNS).eq("id", 1).single();
  if (error) throw new Error("讀取網站設定失敗");
  return data as SiteSettings;
}

export async function fetchCategories(): Promise<Category[]> {
  const { data, error } = await supabase.from("categories").select("id,name,sort_order").order("sort_order").order("name");
  if (error) throw new Error("讀取分類失敗");
  return data as Category[];
}

export async function fetchPublishedImages(): Promise<PublicImage[]> {
  const { data, error } = await supabase
    .from("images")
    .select(PUBLIC_IMAGE_COLUMNS)
    .eq("is_published", true)
    .order("sort_order")
    .order("created_at", { ascending: false });
  if (error) throw new Error("讀取作品失敗");
  return data as PublicImage[];
}

export function previewUrl(path: string): string {
  return supabase.storage.from("previews").getPublicUrl(path).data.publicUrl;
}

export function formatDate(d: string | null | undefined): string {
  if (!d) return "";
  const [y, m, day] = d.slice(0, 10).split("-");
  return `${y} 年 ${Number(m)} 月 ${Number(day)} 日`;
}
