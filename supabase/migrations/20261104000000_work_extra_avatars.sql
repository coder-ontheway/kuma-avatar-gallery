-- =====================================================================
-- KUMA STUDIO：作品的額外大頭貼（每款作品可以有多張大頭貼供粉絲挑選）
-- 前提：已執行 20261103000000_kuma_studio_collections.sql
-- 增量 migration：只新增資料表與更新刪除系列函式，不刪除、不修改既有資料；可重複執行。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 額外大頭貼（每款作品可以有多張大頭貼供粉絲挑選）
--    作品本身的「大頭貼版」是第 1 張；這張表存第 2 張以後。每張都是獨立原始檔，不合成、不修改。
--    原圖同樣放在私有 originals bucket，下載需要該系列的密碼（由 Edge Function 檢查屬於同一款作品）。
-- ---------------------------------------------------------------------
create table if not exists public.collection_work_avatars (
  id           uuid primary key default gen_random_uuid(),
  work_id      uuid not null references public.collection_works(id) on delete cascade,
  sort_order   integer not null default 0,
  preview_path text not null,
  original_path text not null,
  mime_type    text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  file_size    bigint not null check (file_size > 0),
  width        integer not null check (width > 0),
  height       integer not null check (height > 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists collection_work_avatars_work_idx on public.collection_work_avatars (work_id, sort_order);

drop trigger if exists collection_work_avatars_updated_at on public.collection_work_avatars;
create trigger collection_work_avatars_updated_at
  before update on public.collection_work_avatars
  for each row execute function private.touch_updated_at();

alter table public.collection_work_avatars enable row level security;

drop policy if exists "訪客只能看到已公開作品的額外大頭貼" on public.collection_work_avatars;
create policy "訪客只能看到已公開作品的額外大頭貼"
  on public.collection_work_avatars for select
  to anon, authenticated
  using (exists (
    select 1 from public.collection_works w
     where w.id = work_id and w.is_published and (select public.collection_is_public(w.collection_id))
  ));

drop policy if exists "管理員可管理額外大頭貼" on public.collection_work_avatars;
create policy "管理員可管理額外大頭貼"
  on public.collection_work_avatars for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on table public.collection_work_avatars from anon, authenticated;
-- 訪客：欄位層級授權，看不到私有原圖路徑
grant select (id, work_id, sort_order, preview_path, mime_type, file_size, width, height, created_at, updated_at)
  on table public.collection_work_avatars to anon;
grant select, insert, update, delete on table public.collection_work_avatars to authenticated;
grant select on table public.collection_work_avatars to service_role;

create or replace function private.audit_collection_work_avatars()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  w public.collection_works;
begin
  if coalesce(current_setting('kuma.audit_quiet', true), '') = '1' or tg_op = 'UPDATE' then
    return null;
  end if;
  select * into w from public.collection_works x where x.id = case when tg_op = 'DELETE' then old.work_id else new.work_id end;
  if not found then
    return null; -- 作品一起刪除時，已由作品的紀錄涵蓋
  end if;
  perform private.audit(case when tg_op = 'INSERT' then 'work.avatar_add' else 'work.avatar_remove' end,
                        w.collection_id, 'No.' || lpad(w.work_number::text, 3, '0') || ' ' || w.nickname, '{}'::jsonb);
  return null;
end;
$$;

drop trigger if exists collection_work_avatars_audit on public.collection_work_avatars;
create trigger collection_work_avatars_audit
  after insert or update or delete on public.collection_work_avatars
  for each row execute function private.audit_collection_work_avatars();

-- ---------------------------------------------------------------------
-- 2. 刪除系列時一併回傳額外大頭貼的檔案路徑（讓後臺清除 Storage 檔案）
-- ---------------------------------------------------------------------
create or replace function public.delete_collection(p_collection_id uuid, p_mode text, p_target uuid, p_confirm_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name     text;
  v_cover    text;
  v_hero     text;
  v_previews text[] := '{}';
  v_originals text[] := '{}';
  v_work_previews text[] := '{}';
  v_moved    integer := 0;
  v_deleted  integer := 0;
  v_next_no  integer;
  v_next_sort integer;
  w record;
begin
  v_name := private.require_admin_collection(p_collection_id);
  if p_confirm_name is distinct from v_name then
    raise exception '確認名稱不符，系列沒有刪除' using errcode = '22023';
  end if;
  if p_mode not in ('move', 'delete') then
    raise exception '請選擇作品的處理方式' using errcode = '22023';
  end if;

  select c.cover_path, c.hero_path into v_cover, v_hero from public.collections c where c.id = p_collection_id;
  if v_cover is not null then v_previews := v_previews || v_cover; end if;
  if v_hero is not null then v_previews := v_previews || v_hero; end if;

  perform set_config('kuma.audit_quiet', '1', true);

  if p_mode = 'move' then
    if p_target is null or p_target = p_collection_id or not exists (select 1 from public.collections c where c.id = p_target) then
      raise exception '請選擇另一個要移入的系列' using errcode = '22023';
    end if;
    select coalesce(max(x.work_number), 0), coalesce(max(x.sort_order), 0)
      into v_next_no, v_next_sort
      from public.collection_works x where x.collection_id = p_target;
    for w in select * from public.collection_works x where x.collection_id = p_collection_id order by x.sort_order, x.work_number loop
      v_next_sort := v_next_sort + 10;
      if exists (select 1 from public.collection_works x where x.collection_id = p_target and x.work_number = w.work_number) then
        v_next_no := least(v_next_no + 1, 999);
        update public.collection_works set collection_id = p_target, work_number = v_next_no, sort_order = v_next_sort, is_published = false where id = w.id;
      else
        update public.collection_works set collection_id = p_target, sort_order = v_next_sort, is_published = false where id = w.id;
        v_next_no := greatest(v_next_no, w.work_number);
      end if;
      v_moved := v_moved + 1;
    end loop;
  else
    select coalesce(array_agg(p) filter (where p is not null), '{}') into v_work_previews
      from public.collection_works x, unnest(array[x.preview_path, x.avatar_preview_path]) p
     where x.collection_id = p_collection_id;
    select coalesce(array_agg(o) filter (where o is not null), '{}') into v_originals
      from public.collection_works x, unnest(array[x.original_path, x.avatar_original_path]) o
     where x.collection_id = p_collection_id;
    v_previews := v_previews || v_work_previews
      || coalesce((select array_agg(e.preview_path) from public.collection_work_avatars e
                     join public.collection_works x on x.id = e.work_id where x.collection_id = p_collection_id), '{}');
    v_originals := v_originals
      || coalesce((select array_agg(e.original_path) from public.collection_work_avatars e
                     join public.collection_works x on x.id = e.work_id where x.collection_id = p_collection_id), '{}');
    v_deleted := (select count(*) from public.collection_works x where x.collection_id = p_collection_id);
    delete from public.collection_works x where x.collection_id = p_collection_id;
  end if;

  delete from public.collections c where c.id = p_collection_id;
  perform set_config('kuma.audit_quiet', '', true);

  perform private.audit('collection.delete', p_collection_id, v_name, jsonb_build_object(
    'mode', p_mode, 'moved', v_moved, 'deleted_works', v_deleted, 'target', p_target
  ));
  return jsonb_build_object('ok', true, 'moved', v_moved, 'deleted_works', v_deleted,
                            'previews', to_jsonb(v_previews), 'originals', to_jsonb(v_originals));
end;
$$;

revoke all on function public.delete_collection(uuid, text, uuid, text) from public;
revoke all on function public.delete_collection(uuid, text, uuid, text) from anon;
grant execute on function public.delete_collection(uuid, text, uuid, text) to authenticated;

insert into public.admin_audit_log (action, target, detail)
select 'system.migrate', '作品額外大頭貼', jsonb_build_object('migration', '20261104000000_work_extra_avatars')
 where not exists (select 1 from public.admin_audit_log where action = 'system.migrate' and detail->>'migration' = '20261104000000_work_extra_avatars');
