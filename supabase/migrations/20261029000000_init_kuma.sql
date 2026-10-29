-- =====================================================================
-- KUMA 熊兔大頭貼收藏館：初始資料庫結構
-- 內容：兩位授權管理員名單、分類、作品、網站設定、下載密碼（雜湊）、
--       錯誤嘗試紀錄、RLS 政策、Storage bucket 與 Storage 政策。
--
-- 執行方式（擇一）：
--   1. Supabase Dashboard → SQL Editor → 貼上整份檔案 → Run
--   2. 本機：npx supabase link --project-ref <ref> && npx supabase db push
--
-- 重要：本檔案不含任何密碼或金鑰。下載密碼由管理後臺設定，資料庫只存 bcrypt 雜湊。
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- 不對 Data API 公開的內部 schema（下載密碼雜湊、嘗試紀錄都放這裡）
create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

-- ---------------------------------------------------------------------
-- 共用：自動更新 updated_at
-- ---------------------------------------------------------------------
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- =====================================================================
-- 1. 授權管理員名單（以 Supabase Auth 使用者 UUID 為依據）
--    - 只能由專案擁有者在 SQL Editor（postgres 角色）新增／停用
--    - 登入後的管理員只能「讀取」名單，無法新增第三位或修改任何人
-- =====================================================================
create table public.admins (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 30),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);

comment on table public.admins is
  '授權管理員名單。僅能在 SQL Editor 以 postgres 角色維護；最多 2 位有效管理員。';

-- 最多 2 位「有效」管理員：即使在 SQL Editor 誤操作也無法登記第三位
create or replace function private.enforce_admin_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_active integer;
begin
  if new.is_active then
    perform pg_advisory_xact_lock(hashtextextended('kuma_admin_limit', 0));
    select count(*) into v_active
      from public.admins
     where is_active and user_id <> new.user_id;
    if v_active >= 2 then
      raise exception '授權管理員最多 2 位，請先停用其中一位再登記新管理員。'
        using errcode = 'check_violation';
    end if;
    new.revoked_at := null;
  elsif tg_op = 'UPDATE' and old.is_active and not new.is_active then
    new.revoked_at := coalesce(new.revoked_at, now());
  end if;
  return new;
end;
$$;

create trigger admins_limit
  before insert or update on public.admins
  for each row execute function private.enforce_admin_limit();

-- 伺服器端判斷：目前 JWT 的使用者是否為「有效」授權管理員。
-- 每次請求即時查表，因此停用後立刻失去權限（不必等 JWT 過期）。
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.admins a
     where a.user_id = auth.uid()
       and a.is_active
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated, service_role;

alter table public.admins enable row level security;

create policy "管理員可查看管理員名單"
  on public.admins for select
  to authenticated
  using ((select public.is_admin()));

revoke all on table public.admins from anon, authenticated;
grant select on table public.admins to authenticated;

-- =====================================================================
-- 2. 分類
-- =====================================================================
create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (char_length(btrim(name)) between 1 and 30),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger categories_touch
  before update on public.categories
  for each row execute function private.touch_updated_at();

alter table public.categories enable row level security;

create policy "所有人可讀取分類"
  on public.categories for select
  to anon, authenticated
  using (true);

create policy "管理員可新增分類"
  on public.categories for insert
  to authenticated
  with check ((select public.is_admin()));

create policy "管理員可修改分類"
  on public.categories for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "管理員可刪除分類"
  on public.categories for delete
  to authenticated
  using ((select public.is_admin()));

revoke all on table public.categories from anon, authenticated;
grant select on table public.categories to anon;
grant select, insert, update, delete on table public.categories to authenticated;

insert into public.categories (name, sort_order) values
  ('熊大', 10),
  ('兔兔', 20),
  ('熊大兔兔', 30),
  ('甜蜜放閃', 40),
  ('搞笑表情', 50),
  ('節日限定', 60),
  ('其他', 99);

-- =====================================================================
-- 3. 網站設定（單列）
-- =====================================================================
create table public.site_settings (
  id                 smallint primary key default 1 check (id = 1),
  site_name          text not null default 'KUMA 熊兔大頭貼收藏館' check (char_length(site_name) <= 40),
  brand_name         text not null default 'KUMA 工作室' check (char_length(brand_name) <= 40),
  announcement       text not null default '' check (char_length(announcement) <= 1000),
  facebook_url       text not null default ''
                     check (facebook_url = '' or facebook_url ~ '^https://[^[:space:]]+$'),
  latest_update_date date,
  monthly_title      text not null default '本月大頭貼' check (char_length(monthly_title) <= 30),
  monthly_public     boolean not null default true,   -- 本月作品是否公開
  downloads_enabled  boolean not null default true,   -- 全站下載開關
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users (id) on delete set null
);

create trigger site_settings_touch
  before update on public.site_settings
  for each row execute function private.touch_updated_at();

insert into public.site_settings (id) values (1);

alter table public.site_settings enable row level security;

create policy "所有人可讀取公開網站設定"
  on public.site_settings for select
  to anon, authenticated
  using (true);

create policy "管理員可修改網站設定"
  on public.site_settings for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on table public.site_settings from anon, authenticated;
grant select on table public.site_settings to anon;
grant select on table public.site_settings to authenticated;
grant update (site_name, brand_name, announcement, facebook_url, latest_update_date,
              monthly_title, monthly_public, downloads_enabled, updated_by)
  on table public.site_settings to authenticated;

-- 「本月作品是否公開」給 RLS 使用
create or replace function public.monthly_is_public()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.monthly_public from public.site_settings s where s.id = 1), true);
$$;

revoke all on function public.monthly_is_public() from public;
grant execute on function public.monthly_is_public() to anon, authenticated, service_role;

-- =====================================================================
-- 4. 作品
-- =====================================================================
create table public.images (
  id              uuid primary key default gen_random_uuid(),
  title           text not null check (char_length(btrim(title)) between 1 and 60),
  description     text not null default '' check (char_length(description) <= 500),
  category_id     uuid references public.categories (id) on delete set null,
  tags            text[] not null default '{}',
  preview_path    text not null,          -- previews bucket（公開）
  original_path   text not null,          -- originals bucket（私有）
  mime_type       text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  file_size       bigint not null check (file_size > 0),
  width           integer not null check (width > 0),
  height          integer not null check (height > 0),
  sort_order      integer not null default 0,
  is_published    boolean not null default false,  -- 草稿 / 已發布
  is_downloadable boolean not null default true,
  is_monthly      boolean not null default false,  -- 本月作品
  work_date       date not null default current_date,
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index images_public_order on public.images (is_published, sort_order, created_at desc);
create index images_category on public.images (category_id);

create or replace function private.images_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_published and (tg_op = 'INSERT' or not old.is_published) then
    new.published_at := now();
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger images_before_write
  before insert or update on public.images
  for each row execute function private.images_before_write();

alter table public.images enable row level security;

create policy "訪客只能看到已發布作品"
  on public.images for select
  to anon, authenticated
  using (is_published and (not is_monthly or (select public.monthly_is_public())));

create policy "管理員可看到全部作品"
  on public.images for select
  to authenticated
  using ((select public.is_admin()));

create policy "管理員可新增作品"
  on public.images for insert
  to authenticated
  with check ((select public.is_admin()));

create policy "管理員可修改作品"
  on public.images for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "管理員可刪除作品"
  on public.images for delete
  to authenticated
  using ((select public.is_admin()));

revoke all on table public.images from anon, authenticated;
-- 訪客：欄位層級授權，看不到私有原圖路徑
grant select (id, title, description, category_id, tags, preview_path, mime_type, file_size,
              width, height, sort_order, is_published, is_downloadable, is_monthly, work_date,
              published_at, created_at, updated_at)
  on table public.images to anon;
grant select, insert, update, delete on table public.images to authenticated;

-- =====================================================================
-- 5. 下載密碼（僅存 bcrypt 雜湊）與防暴力猜測
-- =====================================================================
create table private.download_secret (
  id            smallint primary key default 1 check (id = 1),
  password_hash text,                       -- bcrypt；null 代表尚未設定
  version       integer not null default 0, -- 每次更換 +1，舊下載憑證立即失效
  updated_at    timestamptz,
  updated_by    uuid references auth.users (id) on delete set null
);

insert into private.download_secret (id) values (1);

create table private.download_attempts (
  id          bigint generated always as identity primary key,
  client_hash text not null,      -- 由 Edge Function 以 HMAC 處理過的來源識別，不存原始 IP
  success     boolean not null,
  created_at  timestamptz not null default now()
);

create index download_attempts_client on private.download_attempts (client_hash, created_at desc);
create index download_attempts_time on private.download_attempts (created_at);

alter table private.download_secret enable row level security;
alter table private.download_attempts enable row level security;
revoke all on all tables in schema private from public, anon, authenticated;

-- 驗證下載密碼（只有 Edge Function 的 service_role 能呼叫）
-- 規則：同一來源 15 分鐘內錯誤 5 次即暫停；全站 15 分鐘內錯誤 200 次即暫停驗證。
create or replace function public.verify_download_password(p_password text, p_client text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_window        constant interval := interval '15 minutes';
  c_client_limit  constant integer  := 5;
  c_global_limit  constant integer  := 200;
  v_secret        private.download_secret%rowtype;
  v_client_fails  integer;
  v_global_fails  integer;
  v_unlock_at     timestamptz;
  v_ok            boolean;
begin
  if p_client is null or char_length(p_client) < 16 or char_length(p_client) > 128 then
    raise exception 'invalid client id';
  end if;

  -- 同一來源序列化處理，避免並行請求繞過次數限制
  perform pg_advisory_xact_lock(hashtextextended('kuma_dl:' || p_client, 0));

  delete from private.download_attempts where created_at < now() - interval '2 days';

  select count(*) into v_client_fails
    from private.download_attempts
   where client_hash = p_client and not success and created_at > now() - c_window;

  if v_client_fails >= c_client_limit then
    select a.created_at + c_window into v_unlock_at
      from private.download_attempts a
     where a.client_hash = p_client and not a.success and a.created_at > now() - c_window
     order by a.created_at desc
     offset c_client_limit - 1
     limit 1;
    return jsonb_build_object(
      'ok', false, 'reason', 'locked',
      'retry_after', greatest(1, ceil(extract(epoch from (coalesce(v_unlock_at, now() + c_window) - now())))::integer)
    );
  end if;

  select count(*) into v_global_fails
    from private.download_attempts
   where not success and created_at > now() - c_window;

  if v_global_fails >= c_global_limit then
    return jsonb_build_object('ok', false, 'reason', 'busy', 'retry_after', 900);
  end if;

  select * into v_secret from private.download_secret where id = 1;
  if v_secret.password_hash is null then
    return jsonb_build_object('ok', false, 'reason', 'not_configured');
  end if;

  v_ok := p_password is not null
          and char_length(p_password) between 1 and 128
          and extensions.crypt(p_password, v_secret.password_hash) = v_secret.password_hash;

  if v_ok then
    delete from private.download_attempts where client_hash = p_client and not success;
  end if;
  insert into private.download_attempts (client_hash, success) values (p_client, v_ok);

  if v_ok then
    return jsonb_build_object('ok', true, 'version', v_secret.version);
  end if;
  return jsonb_build_object(
    'ok', false, 'reason', 'wrong',
    'remaining', greatest(0, c_client_limit - v_client_fails - 1)
  );
end;
$$;

revoke all on function public.verify_download_password(text, text) from public;
revoke all on function public.verify_download_password(text, text) from anon, authenticated;
grant execute on function public.verify_download_password(text, text) to service_role;

-- 供 Edge Function 確認下載憑證是否仍有效（密碼版本、全站下載開關）
create or replace function public.download_state()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'version', (select d.version from private.download_secret d where d.id = 1),
    'configured', (select d.password_hash is not null from private.download_secret d where d.id = 1),
    'downloads_enabled', (select s.downloads_enabled from public.site_settings s where s.id = 1)
  );
$$;

revoke all on function public.download_state() from public;
revoke all on function public.download_state() from anon, authenticated;
grant execute on function public.download_state() to service_role;

-- 管理員更換下載密碼（伺服器端以 bcrypt 雜湊後儲存）
create or replace function public.set_download_password(p_new_password text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_version integer;
begin
  if not public.is_admin() then
    raise exception '沒有管理權限' using errcode = '42501';
  end if;
  if p_new_password is null or char_length(p_new_password) < 6 or char_length(p_new_password) > 64 then
    raise exception '下載密碼長度須為 6 到 64 個字元' using errcode = '22023';
  end if;

  update private.download_secret
     set password_hash = extensions.crypt(p_new_password, extensions.gen_salt('bf', 10)),
         version       = version + 1,
         updated_at    = now(),
         updated_by    = auth.uid()
   where id = 1
  returning version into v_version;

  -- 換密碼後清除舊的錯誤紀錄
  delete from private.download_attempts;

  return jsonb_build_object('ok', true, 'version', v_version);
end;
$$;

revoke all on function public.set_download_password(text) from public;
revoke all on function public.set_download_password(text) from anon;
grant execute on function public.set_download_password(text) to authenticated;

-- 管理員查看下載密碼狀態（不回傳雜湊）
create or replace function public.download_password_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception '沒有管理權限' using errcode = '42501';
  end if;
  select jsonb_build_object(
           'configured', d.password_hash is not null,
           'version', d.version,
           'updated_at', d.updated_at,
           'updated_by_name', a.display_name
         )
    into v_result
    from private.download_secret d
    left join public.admins a on a.user_id = d.updated_by
   where d.id = 1;
  return v_result;
end;
$$;

revoke all on function public.download_password_status() from public;
revoke all on function public.download_password_status() from anon;
grant execute on function public.download_password_status() to authenticated;

-- =====================================================================
-- 6. Storage：公開預覽圖 previews、私有原圖 originals
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('previews',  'previews',  true,  5242880,  array['image/png', 'image/jpeg', 'image/webp']),
  ('originals', 'originals', false, 20971520, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 不建立任何 anon 的 storage.objects 政策：
--   - previews 是公開 bucket，訪客只能透過公開網址讀取「已知路徑」的預覽圖，無法列出檔案
--   - originals 是私有 bucket，訪客無法列出或下載；只能經由 download Edge Function 取得限時簽署網址
create policy "KUMA 管理員可讀取圖片檔"
  on storage.objects for select
  to authenticated
  using (bucket_id in ('previews', 'originals') and (select public.is_admin()));

create policy "KUMA 管理員可上傳圖片檔"
  on storage.objects for insert
  to authenticated
  with check (bucket_id in ('previews', 'originals') and (select public.is_admin()));

create policy "KUMA 管理員可更新圖片檔"
  on storage.objects for update
  to authenticated
  using (bucket_id in ('previews', 'originals') and (select public.is_admin()))
  with check (bucket_id in ('previews', 'originals') and (select public.is_admin()));

create policy "KUMA 管理員可刪除圖片檔"
  on storage.objects for delete
  to authenticated
  using (bucket_id in ('previews', 'originals') and (select public.is_admin()));
