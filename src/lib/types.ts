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
