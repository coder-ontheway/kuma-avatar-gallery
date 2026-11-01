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

/** 主題系列（例：KUMA 熊兔生命共同體） */
export interface Collection {
  id: string;
  slug: string;
  name: string;
  name_en: string;
  tagline: string;
  description: string;
  /** 粉絲可選用的預設宣言 */
  manifestos: string[];
  sort_order: number;
  is_published: boolean;
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
}

export interface AdminCollectionWork extends CollectionWork {
  original_path: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}
