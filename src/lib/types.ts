export interface SiteSettings {
  site_name: string;
  brand_name: string;
  announcement: string;
  facebook_url: string;
  latest_update_date: string | null;
  monthly_title: string;
  monthly_public: boolean;
  downloads_enabled: boolean;
}

export interface Category {
  id: string;
  name: string;
  sort_order: number;
}

export interface PublicImage {
  id: string;
  title: string;
  description: string;
  category_id: string | null;
  tags: string[];
  preview_path: string;
  /** 無字版公開預覽圖（沒有無字版時為 null） */
  plain_preview_path: string | null;
  mime_type: string;
  file_size: number;
  width: number;
  height: number;
  sort_order: number;
  is_downloadable: boolean;
  is_monthly: boolean;
  work_date: string;
}

export interface AdminImage extends PublicImage {
  original_path: string;
  plain_original_path: string | null;
  is_published: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminUser {
  user_id: string;
  display_name: string;
  is_active: boolean;
  created_at: string;
  revoked_at: string | null;
}

/** 每件作品的下載次數（只有管理員看得到） */
export interface DownloadStats {
  image_id: string;
  avatar_count: number;
  original_count: number;
  zip_count: number;
  last_downloaded_at: string | null;
}

export type CollectionStatus = "draft" | "published" | "archived";

/** 收藏卡主題（視覺可依系列變化，但都維持 KUMA STUDIO 品牌） */
export type CardTheme = "forest" | "sweet" | "sunny" | "sky" | "night" | "classic";

/** 系列（KUMA STUDIO 的最上層管理單位，例：熊兔生命共同體、熊大寵妻系列） */
export interface Collection {
  id: string;
  slug: string;
  name: string;
  /** 英文名稱 */
  name_en: string;
  /** 主題標語 */
  tagline: string;
  description: string;
  /** 粉絲可選用的預設宣言（每個系列各自一份） */
  manifestos: string[];
  sort_order: number;
  /** 與 status 同步：status = published 時為 true */
  is_published: boolean;
  status: CollectionStatus;
  /** 系列下載開關（只影響這個系列） */
  download_enabled: boolean;
  /** 系列封面（previews bucket，公開） */
  cover_path: string | null;
  /** 系列主視覺（previews bucket，公開） */
  hero_path: string | null;
  id_card_enabled: boolean;
  card_enabled: boolean;
  card_theme: CardTheme;
  /** 身份證標題，例：熊兔合體身份證 */
  id_card_title: string;
  /** 宣言名稱，例：專屬愛心宣言、寵妻宣言 */
  manifesto_label: string;
  created_at?: string;
  updated_at?: string;
}

/** 首頁系列卡片 */
export interface CollectionSummary {
  collection: Collection;
  count: number;
  /** 封面：系列封面，沒有時用第一款作品 */
  cover: string | null;
}

/** 系列中的單一作品；preview_path 為空代表「待上傳」 */
export interface CollectionWork {
  id: string;
  collection_id: string;
  work_number: number;
  title: string;
  nickname: string;
  theme: string;
  description: string;
  manifesto: string;
  protect_zones: import("./protect").ProtectZone[];
  preview_path: string | null;
  mime_type: string | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  sort_order: number;
  is_published: boolean;
  is_downloadable: boolean;
  /** 大頭貼版（選用）：同一個場景另外構圖的方形大頭貼，粉絲製作大頭貼時優先使用 */
  avatar_preview_path: string | null;
  avatar_mime_type: string | null;
  avatar_file_size: number | null;
  avatar_width: number | null;
  avatar_height: number | null;
  /** 額外大頭貼（第 2 張以後，粉絲可在大頭貼編輯器切換） */
  extra_avatars?: WorkAvatar[];
}

/** 作品的額外大頭貼（collection_work_avatars）；原圖路徑只有管理員看得到 */
export interface WorkAvatar {
  id: string;
  work_id: string;
  sort_order: number;
  preview_path: string;
  mime_type: string;
  file_size: number;
  width: number;
  height: number;
  original_path?: string;
}

export interface AdminCollectionWork extends CollectionWork {
  original_path: string | null;
  avatar_original_path: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 後臺系列管理中心：每個系列的統計與密碼狀態 */
export interface CollectionOverview {
  collection_id: string;
  work_count: number;
  photo_count: number;
  published_count: number;
  password_configured: boolean;
  password_enabled: boolean;
  verify_ok_48h: number;
  verify_fail_48h: number;
}

export interface AuditEntry {
  id: number;
  created_at: string;
  actor_name: string | null;
  action: string;
  collection_id: string | null;
  target: string;
  detail: Record<string, unknown>;
}
