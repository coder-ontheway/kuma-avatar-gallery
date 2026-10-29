-- =====================================================================
-- 新增「無字版」：同一張作品可另外上傳一張沒有文字的版本，
-- 粉絲在編輯器可切換「有字／無字」，再加上自己的文字。
--   plain_preview_path ：無字版公開預覽圖（previews bucket，訪客可讀路徑）
--   plain_original_path：無字版原圖（originals bucket，私有；訪客讀不到路徑，下載同樣需要密碼）
-- 已建立的專案請在 SQL Editor 執行本檔一次（可重複執行）。
-- =====================================================================
alter table public.images
  add column if not exists plain_preview_path  text,
  add column if not exists plain_original_path text;

-- 兩個欄位必須同時有值或同時為空
alter table public.images drop constraint if exists images_plain_pair;
alter table public.images
  add constraint images_plain_pair
  check ((plain_preview_path is null) = (plain_original_path is null));

-- 訪客只多開放「無字版預覽圖路徑」；無字版原圖路徑維持不可讀
grant select (plain_preview_path) on table public.images to anon;
