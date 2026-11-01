import { supabase } from "./supabase";
import type { Category, Collection, CollectionWork, PublicImage, SiteSettings } from "./types";
import { sanitizeZones } from "./protect";

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

// ---- 熊兔生命共同體（主題系列）----
export const LIFE_SLUG = "one-heart-one-life";

export const PUBLIC_WORK_COLUMNS =
  "id,collection_id,work_number,title,nickname,theme,description,manifesto,protect_zones,preview_path,mime_type,file_size,width,height,sort_order,is_published,is_downloadable";

const COLLECTION_COLUMNS = "id,slug,name,name_en,tagline,description,manifestos,sort_order,is_published";

/**
 * 讀取系列與作品。訪客只會拿到已公開的資料（RLS）；
 * 管理員登入時資料庫會回傳全部，因此前端再過濾一次，讓「粉絲看到的畫面」保持一致（preview=true 時顯示草稿）。
 */
export async function fetchCollection(slug: string, preview = false): Promise<{ collection: Collection | null; works: CollectionWork[] }> {
  const { data: c, error } = await supabase.from("collections").select(COLLECTION_COLUMNS).eq("slug", slug).maybeSingle();
  if (error) throw new Error("讀取系列失敗");
  if (!c || (!preview && !c.is_published)) return { collection: null, works: [] };
  const { data: w, error: e2 } = await supabase
    .from("collection_works")
    .select(PUBLIC_WORK_COLUMNS)
    .eq("collection_id", c.id)
    .order("sort_order")
    .order("work_number");
  if (e2) throw new Error("讀取系列作品失敗");
  const works = (w as CollectionWork[])
    .map((x) => ({ ...x, protect_zones: sanitizeZones(x.protect_zones) }))
    .filter((x) => x.preview_path && (preview || x.is_published));
  return { collection: c as Collection, works };
}

/** 首頁入口用：系列是否公開、有幾款已公開作品 */
export async function fetchCollectionTeaser(slug: string): Promise<{ collection: Collection; count: number; cover: string | null } | null> {
  try {
    const { collection, works } = await fetchCollection(slug);
    if (!collection || works.length === 0) return null;
    return { collection, count: works.length, cover: works[0].preview_path };
  } catch {
    return null;
  }
}
