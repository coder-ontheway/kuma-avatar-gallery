import { supabase } from "./supabase";
import type { Category, Collection, CollectionSummary, CollectionWork, PublicImage, SiteSettings, WorkAvatar } from "./types";
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

// ---- KUMA STUDIO 系列（collections）----
/** 第一系列「熊兔生命共同體」的網址代稱（舊網址 #/life 會導向 #/c/one-heart-one-life） */
export const LIFE_SLUG = "one-heart-one-life";

export const PUBLIC_WORK_COLUMNS =
  "id,collection_id,work_number,title,nickname,theme,description,manifesto,protect_zones,preview_path,mime_type,file_size,width,height,sort_order,is_published,is_downloadable,avatar_preview_path,avatar_mime_type,avatar_file_size,avatar_width,avatar_height";

export const COLLECTION_COLUMNS =
  "id,slug,name,name_en,tagline,description,manifestos,sort_order,is_published,status,download_enabled,cover_path,hero_path,id_card_enabled,card_enabled,card_theme,id_card_title,manifesto_label,created_at,updated_at";

export function collectionPath(c: Pick<Collection, "slug">): string {
  return `/c/${c.slug}`;
}

/**
 * 讀取單一系列與作品。訪客只會拿到已公開的資料（RLS）；
 * 管理員登入時資料庫會回傳全部，因此前端再過濾一次，讓「粉絲看到的畫面」保持一致（preview=true 時顯示草稿）。
 */
export async function fetchCollection(slug: string, preview = false): Promise<{ collection: Collection | null; works: CollectionWork[] }> {
  const { data: c, error } = await supabase.from("collections").select(COLLECTION_COLUMNS).eq("slug", slug).maybeSingle();
  if (error) throw new Error("讀取系列失敗");
  if (!c || (!preview && c.status !== "published")) return { collection: null, works: [] };
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
  return { collection: c as Collection, works: await attachExtraAvatars(works) };
}

export const PUBLIC_AVATAR_COLUMNS = "id,work_id,sort_order,preview_path,mime_type,file_size,width,height";

/** 附上每款作品的額外大頭貼。資料庫尚未升級（沒有這張表）時視為沒有額外大頭貼。 */
export async function attachExtraAvatars<T extends CollectionWork>(works: T[], columns = PUBLIC_AVATAR_COLUMNS): Promise<T[]> {
  if (works.length === 0) return works;
  const { data, error } = await supabase
    .from("collection_work_avatars")
    .select(columns)
    .in("work_id", works.map((w) => w.id))
    .order("sort_order")
    .order("created_at");
  if (error || !data) return works.map((w) => ({ ...w, extra_avatars: [] }));
  const byWork = new Map<string, WorkAvatar[]>();
  for (const a of data as unknown as WorkAvatar[]) byWork.set(a.work_id, [...(byWork.get(a.work_id) ?? []), a]);
  return works.map((w) => ({ ...w, extra_avatars: byWork.get(w.id) ?? [] }));
}

/** 首頁：所有已公開的系列（依排序），附作品數量與封面。系列數量不寫死，後臺新增後自動出現。 */
export async function fetchPublishedCollections(): Promise<CollectionSummary[]> {
  const { data: cs, error } = await supabase
    .from("collections")
    .select(COLLECTION_COLUMNS)
    .eq("status", "published")
    .order("sort_order")
    .order("created_at");
  if (error) throw new Error("讀取系列失敗");
  const list = (cs as Collection[]).filter((c) => c.status === "published");
  if (list.length === 0) return [];
  const { data: ws, error: e2 } = await supabase
    .from("collection_works")
    .select("collection_id,preview_path,is_published,sort_order,work_number")
    .in("collection_id", list.map((c) => c.id))
    .eq("is_published", true)
    .order("sort_order")
    .order("work_number");
  if (e2) throw new Error("讀取系列作品失敗");
  const works = (ws as { collection_id: string; preview_path: string | null; is_published: boolean }[]).filter((w) => w.is_published && w.preview_path);
  return list
    .map((collection) => {
      const mine = works.filter((w) => w.collection_id === collection.id);
      return { collection, count: mine.length, cover: collection.cover_path ?? mine[0]?.preview_path ?? null };
    })
    .filter((s) => s.count > 0);
}
