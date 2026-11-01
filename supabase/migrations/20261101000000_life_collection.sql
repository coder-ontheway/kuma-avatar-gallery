-- =====================================================================
-- KUMA 熊兔生命共同體｜ONE HEART, ONE LIFE 限定收藏館
--
-- 與原本的收藏館（images 表）完全分開：
--   collections       ：主題系列（名稱、英文名、主題句、介紹、預設宣言清單、是否公開、排序）
--   collection_works  ：系列中的每一款作品（每款一筆，各自有自己的原圖、編號、稱號、宣言）
--
-- 原圖仍放在私有的 originals bucket（路徑 life/<作品 id>/...），公開預覽圖放在 previews bucket。
-- 尚未上傳照片的作品是「待上傳」狀態（原圖欄位為空），不能設為公開。
-- 收藏卡與粉絲大頭貼都在瀏覽器以原圖即時合成，不另外儲存，避免重複存放相同圖片。
--
-- 已建立的專案請在 SQL Editor 執行本檔一次（可重複執行的部分以 if not exists 處理）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 主題系列
-- ---------------------------------------------------------------------
create table if not exists public.collections (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name         text not null check (char_length(btrim(name)) between 1 and 40),
  name_en      text not null default '' check (char_length(name_en) <= 60),
  tagline      text not null default '' check (char_length(tagline) <= 80),
  description  text not null default '' check (char_length(description) <= 1000),
  -- 粉絲可選用的預設宣言（管理員可修改；最多 30 句、每句 40 字）
  manifestos   text[] not null default '{}'
               check (cardinality(manifestos) <= 30),
  sort_order   integer not null default 0,
  is_published boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create or replace function private.check_manifestos()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from unnest(new.manifestos) m where char_length(btrim(m)) not between 1 and 40) then
    raise exception '每句預設宣言須為 1 到 40 個字' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists collections_manifestos on public.collections;
create trigger collections_manifestos
  before insert or update on public.collections
  for each row execute function private.check_manifestos();

drop trigger if exists collections_touch on public.collections;
create trigger collections_touch
  before update on public.collections
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 2. 系列作品（每一款獨立一筆）
-- ---------------------------------------------------------------------
create table if not exists public.collection_works (
  id              uuid primary key default gen_random_uuid(),
  collection_id   uuid not null references public.collections (id) on delete cascade,
  work_number     integer not null check (work_number between 1 and 999),  -- 顯示為 No.001
  title           text not null default '' check (char_length(title) <= 60),        -- 作品名稱
  nickname        text not null check (char_length(btrim(nickname)) between 1 and 30), -- 專屬稱號
  theme           text not null default '' check (char_length(theme) <= 100),       -- 主題概念
  description     text not null default '' check (char_length(description) <= 500), -- 生命共同體介紹
  manifesto       text not null default '' check (char_length(manifesto) <= 60),    -- 專屬愛心宣言
  -- 不可被文字遮住、也不可被裁切掉的部位（臉、耳朵、胸口愛心…），以原圖比例 0~1 表示
  -- 例：[{"label":"臉與耳朵","x":0.26,"y":0.02,"w":0.48,"h":0.46}]
  protect_zones   jsonb not null default '[]'::jsonb
                  check (jsonb_typeof(protect_zones) = 'array' and jsonb_array_length(protect_zones) <= 6),
  preview_path    text,          -- previews bucket（公開）；待上傳時為空
  original_path   text,          -- originals bucket（私有）；待上傳時為空
  mime_type       text check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  file_size       bigint check (file_size > 0),
  width           integer check (width > 0),
  height          integer check (height > 0),
  sort_order      integer not null default 0,
  is_published    boolean not null default false,
  is_downloadable boolean not null default true,
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint collection_works_number_unique unique (collection_id, work_number),
  -- 圖片欄位必須同時有值（已上傳）或同時為空（待上傳）
  constraint collection_works_file_complete check (
    (preview_path is null and original_path is null and mime_type is null and file_size is null and width is null and height is null)
    or
    (preview_path is not null and original_path is not null and mime_type is not null and file_size is not null and width is not null and height is not null)
  ),
  -- 待上傳的作品不能公開
  constraint collection_works_publish_needs_photo check (not is_published or original_path is not null)
);

create index if not exists collection_works_order on public.collection_works (collection_id, sort_order, work_number);

create or replace function private.collection_works_before_write()
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

drop trigger if exists collection_works_before_write on public.collection_works;
create trigger collection_works_before_write
  before insert or update on public.collection_works
  for each row execute function private.collection_works_before_write();

-- 系列是否公開（給作品的 RLS 使用）
create or replace function public.collection_is_public(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select c.is_published from public.collections c where c.id = p_id), false);
$$;

revoke all on function public.collection_is_public(uuid) from public;
grant execute on function public.collection_is_public(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. RLS：訪客只看得到「已公開系列」中「已公開作品」；兩位管理員權限相同
-- ---------------------------------------------------------------------
alter table public.collections enable row level security;
alter table public.collection_works enable row level security;

drop policy if exists "訪客只能看到已公開系列" on public.collections;
create policy "訪客只能看到已公開系列"
  on public.collections for select
  to anon, authenticated
  using (is_published);

drop policy if exists "管理員可看到全部系列" on public.collections;
create policy "管理員可看到全部系列"
  on public.collections for select
  to authenticated
  using ((select public.is_admin()));

drop policy if exists "管理員可新增系列" on public.collections;
create policy "管理員可新增系列"
  on public.collections for insert
  to authenticated
  with check ((select public.is_admin()));

drop policy if exists "管理員可修改系列" on public.collections;
create policy "管理員可修改系列"
  on public.collections for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "管理員可刪除系列" on public.collections;
create policy "管理員可刪除系列"
  on public.collections for delete
  to authenticated
  using ((select public.is_admin()));

drop policy if exists "訪客只能看到已公開作品" on public.collection_works;
create policy "訪客只能看到已公開作品"
  on public.collection_works for select
  to anon, authenticated
  using (is_published and (select public.collection_is_public(collection_id)));

drop policy if exists "管理員可看到全部系列作品" on public.collection_works;
create policy "管理員可看到全部系列作品"
  on public.collection_works for select
  to authenticated
  using ((select public.is_admin()));

drop policy if exists "管理員可新增系列作品" on public.collection_works;
create policy "管理員可新增系列作品"
  on public.collection_works for insert
  to authenticated
  with check ((select public.is_admin()));

drop policy if exists "管理員可修改系列作品" on public.collection_works;
create policy "管理員可修改系列作品"
  on public.collection_works for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "管理員可刪除系列作品" on public.collection_works;
create policy "管理員可刪除系列作品"
  on public.collection_works for delete
  to authenticated
  using ((select public.is_admin()));

revoke all on table public.collections from anon, authenticated;
grant select on table public.collections to anon;
grant select, insert, update, delete on table public.collections to authenticated;
grant select on table public.collections to service_role;

revoke all on table public.collection_works from anon, authenticated;
-- 訪客：欄位層級授權，看不到私有原圖路徑
grant select (id, collection_id, work_number, title, nickname, theme, description, manifesto, protect_zones,
              preview_path, mime_type, file_size, width, height, sort_order, is_published, is_downloadable,
              published_at, created_at, updated_at)
  on table public.collection_works to anon;
grant select, insert, update, delete on table public.collection_works to authenticated;
-- 下載用 Edge Function（service_role）
grant select on table public.collection_works to service_role;

-- ---------------------------------------------------------------------
-- 4. 初始資料：生命共同體系列與十款「待上傳」作品
--    稱號、主題概念、宣言皆依需求表建立；作品名稱 No.001 為「心在一起」，其餘先沿用主題概念，管理員可在後臺修改。
--    介紹只放需求表上的主題概念，不自動描述照片內容。
--    protect_zones 是依十張原始照片（IMG_4755～IMG_4764）量測的臉、耳朵與胸口位置，
--    若上傳的照片不同，請在後臺「保護區域」調整。
-- ---------------------------------------------------------------------
insert into public.collections (slug, name, name_en, tagline, description, manifestos, sort_order, is_published)
values (
  'one-heart-one-life',
  'KUMA 熊兔生命共同體',
  'ONE HEART, ONE LIFE',
  '一顆心，兩個靈魂；十種模樣，一個共同的生命。',
  '熊大與兔兔不是兩個分開的角色，而是融合成一個完整的生命共同體。兩個角色，共同的生命；一顆心，兩個靈魂。',
  array[
    '我的生命共同體 ❤',
    '熊兔合體，誰也拆不開！',
    '你負責可愛，我負責愛你。',
    '一個身體，兩顆愛心。',
    '一顆心，兩個靈魂。',
    '永遠在一起。',
    '有你就是完整。',
    '我們是一體的。',
    '愛讓我們成為彼此。',
    '這輩子不拆夥！'
  ],
  10,
  true
)
on conflict (slug) do nothing;

insert into public.collection_works (collection_id, work_number, title, nickname, theme, description, manifesto, protect_zones, sort_order)
select c.id, v.no, v.title, v.nickname, v.theme, v.theme || '。', v.manifesto, v.zones::jsonb, v.no * 10
  from public.collections c
  cross join (values
    (1,  '心在一起',     '熊兔共生體',   '熊兔合而為一',       '我的生命共同體 ❤',
         '[{"label":"臉與耳朵","x":0.26,"y":0.015,"w":0.49,"h":0.465},{"label":"胸口愛心","x":0.43,"y":0.51,"w":0.14,"h":0.13}]'),
    (2,  '兩顆心產生共鳴', '心動共鳴體',   '兩顆心產生共鳴',     '熊兔合體，誰也拆不開！',
         '[{"label":"臉與耳朵","x":0.23,"y":0.21,"w":0.41,"h":0.35},{"label":"胸口愛心","x":0.40,"y":0.56,"w":0.12,"h":0.12}]'),
    (3,  '在星空中守護彼此', '星空守護體',   '在星空中守護彼此',   '你負責可愛，我負責愛你。',
         '[{"label":"臉與耳朵","x":0.27,"y":0.15,"w":0.48,"h":0.36},{"label":"胸口","x":0.40,"y":0.52,"w":0.22,"h":0.12}]'),
    (4,  '形影不離的陪伴', '永遠黏在一起', '形影不離的陪伴',     '一個身體，兩顆愛心。',
         '[{"label":"臉與耳朵","x":0.26,"y":0.10,"w":0.47,"h":0.41},{"label":"胸口","x":0.40,"y":0.52,"w":0.20,"h":0.12}]'),
    (5,  '在森林裡一起成長', '森林療癒體',   '在森林裡一起成長',   '一顆心，兩個靈魂。',
         '[{"label":"臉與耳朵","x":0.28,"y":0.12,"w":0.40,"h":0.36},{"label":"胸口","x":0.36,"y":0.48,"w":0.20,"h":0.12}]'),
    (6,  '傳遞幸福與溫暖', '幸福能量體',   '傳遞幸福與溫暖',     '永遠在一起。',
         '[{"label":"臉與耳朵","x":0.28,"y":0.12,"w":0.40,"h":0.41},{"label":"胸口","x":0.38,"y":0.52,"w":0.20,"h":0.12}]'),
    (7,  '一起實現夢想', '浪漫夢想體',   '一起實現夢想',       '有你就是完整。',
         '[{"label":"臉與耳朵","x":0.28,"y":0.06,"w":0.38,"h":0.39},{"label":"胸口","x":0.49,"y":0.44,"w":0.12,"h":0.12}]'),
    (8,  '永遠守護彼此', '愛的守護體',   '永遠守護彼此',       '我們是一體的。',
         '[{"label":"臉與耳朵","x":0.29,"y":0.06,"w":0.37,"h":0.39},{"label":"胸口","x":0.44,"y":0.45,"w":0.12,"h":0.12}]'),
    (9,  '一起探索世界', '奇幻冒險體',   '一起探索世界',       '愛讓我們成為彼此。',
         '[{"label":"臉與耳朵","x":0.32,"y":0.09,"w":0.35,"h":0.37},{"label":"胸口","x":0.40,"y":0.47,"w":0.16,"h":0.12}]'),
    (10, '愛永遠不會消失', '永恆愛心體',   '愛永遠不會消失',     '這輩子不拆夥！',
         '[{"label":"臉與耳朵","x":0.31,"y":0.13,"w":0.41,"h":0.38},{"label":"胸口","x":0.40,"y":0.53,"w":0.22,"h":0.12}]')
  ) as v(no, title, nickname, theme, manifesto, zones)
 where c.slug = 'one-heart-one-life'
on conflict (collection_id, work_number) do nothing;
