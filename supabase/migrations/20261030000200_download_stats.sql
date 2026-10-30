-- =====================================================================
-- 下載次數統計（只有管理員看得到）
--   每次粉絲成功取得原圖下載網址就記一次：
--     avatar_count   ：下載大頭貼（FB／IG／LINE，含加了文字的版本）
--     original_count ：下載原始圖片
--     zip_count      ：「下載全部大頭貼（ZIP）」時，ZIP 裡的每一張各記一次
--   無字版併入同一件作品計算。只記次數與最後下載時間，不記錄任何粉絲資料。
--   只有 Edge Function（service_role）能寫入；管理員只能讀取。
-- =====================================================================
create table if not exists public.image_download_stats (
  image_id           uuid primary key references public.images (id) on delete cascade,
  avatar_count       integer not null default 0,
  original_count     integer not null default 0,
  zip_count          integer not null default 0,
  last_downloaded_at timestamptz
);

alter table public.image_download_stats enable row level security;

drop policy if exists "管理員可查看下載次數" on public.image_download_stats;
create policy "管理員可查看下載次數"
  on public.image_download_stats for select
  to authenticated
  using ((select public.is_admin()));

revoke all on table public.image_download_stats from public, anon, authenticated;
grant select on table public.image_download_stats to authenticated;
grant select on table public.image_download_stats to service_role;

create or replace function public.record_downloads(p_ids uuid[], p_kind text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_kind not in ('avatar', 'original', 'zip') then
    raise exception 'unknown download kind' using errcode = '22023';
  end if;
  insert into public.image_download_stats as s (image_id, avatar_count, original_count, zip_count, last_downloaded_at)
  select i.id,
         (p_kind = 'avatar')::int,
         (p_kind = 'original')::int,
         (p_kind = 'zip')::int,
         now()
    from public.images i
   where i.id = any (p_ids)
  on conflict (image_id) do update
     set avatar_count       = s.avatar_count + excluded.avatar_count,
         original_count     = s.original_count + excluded.original_count,
         zip_count          = s.zip_count + excluded.zip_count,
         last_downloaded_at = excluded.last_downloaded_at;
end;
$$;

revoke all on function public.record_downloads(uuid[], text) from public;
revoke all on function public.record_downloads(uuid[], text) from anon, authenticated;
grant execute on function public.record_downloads(uuid[], text) to service_role;
