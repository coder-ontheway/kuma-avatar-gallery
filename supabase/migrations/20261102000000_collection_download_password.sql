-- =====================================================================
-- 主題系列（熊兔生命共同體）專屬粉絲下載密碼
--
-- 每個系列可設定自己的下載密碼，與原本收藏館的下載密碼完全分開：
--   * 系列作品（大頭貼、收藏卡、ZIP）只接受該系列的專屬密碼；
--   * 原本收藏館的作品只接受原本的下載密碼；
--   * 兩種密碼發出的下載授權互相不通用。
-- 密碼只以 bcrypt 雜湊存放在 private schema，任何人（包含管理員）都無法讀取。
-- 尚未設定專屬密碼時，系列作品無法下載（後臺會提示）。
-- 錯誤次數限制與原本相同（同一來源 15 分鐘內錯 5 次暫停），兩種密碼的錯誤次數合併計算。
--
-- 已建立的專案請在 SQL Editor 執行本檔一次（可重複執行）。
-- 需先執行 20261101000000_life_collection.sql。
-- =====================================================================

create table if not exists private.collection_download_secret (
  collection_id uuid primary key references public.collections (id) on delete cascade,
  password_hash text not null,                -- bcrypt
  version       integer not null default 1,   -- 每次更換 +1，舊下載授權立即失效
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users (id) on delete set null
);

alter table private.collection_download_secret enable row level security;
revoke all on table private.collection_download_secret from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 驗證系列專屬下載密碼（只有 Edge Function 的 service_role 能呼叫）
-- ---------------------------------------------------------------------
create or replace function public.verify_collection_download_password(p_collection_id uuid, p_password text, p_client text)
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
  v_hash          text;
  v_version       integer;
  v_client_fails  integer;
  v_global_fails  integer;
  v_unlock_at     timestamptz;
  v_ok            boolean;
begin
  if p_client is null or char_length(p_client) < 16 or char_length(p_client) > 128 then
    raise exception 'invalid client id';
  end if;

  -- 與原本的密碼驗證共用同一把鎖與錯誤紀錄，避免換一種密碼繞過次數限制
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

  select s.password_hash, s.version into v_hash, v_version
    from private.collection_download_secret s
   where s.collection_id = p_collection_id;
  if v_hash is null then
    return jsonb_build_object('ok', false, 'reason', 'not_configured');
  end if;

  v_ok := p_password is not null
          and char_length(p_password) between 1 and 128
          and extensions.crypt(p_password, v_hash) = v_hash;

  if v_ok then
    delete from private.download_attempts where client_hash = p_client and not success;
  end if;
  insert into private.download_attempts (client_hash, success) values (p_client, v_ok);

  if v_ok then
    return jsonb_build_object('ok', true, 'version', v_version);
  end if;
  return jsonb_build_object(
    'ok', false, 'reason', 'wrong',
    'remaining', greatest(0, c_client_limit - v_client_fails - 1)
  );
end;
$$;

revoke all on function public.verify_collection_download_password(uuid, text, text) from public;
revoke all on function public.verify_collection_download_password(uuid, text, text) from anon, authenticated;
grant execute on function public.verify_collection_download_password(uuid, text, text) to service_role;

-- 供 Edge Function 確認系列下載授權是否仍有效（密碼版本）
create or replace function public.collection_download_state(p_collection_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'version', coalesce((select s.version from private.collection_download_secret s where s.collection_id = p_collection_id), 0),
    'configured', exists (select 1 from private.collection_download_secret s where s.collection_id = p_collection_id)
  );
$$;

revoke all on function public.collection_download_state(uuid) from public;
revoke all on function public.collection_download_state(uuid) from anon, authenticated;
grant execute on function public.collection_download_state(uuid) to service_role;

-- ---------------------------------------------------------------------
-- 管理員設定／更換系列專屬下載密碼（兩位管理員權限相同）
-- ---------------------------------------------------------------------
create or replace function public.set_collection_download_password(p_collection_id uuid, p_new_password text)
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
  if not exists (select 1 from public.collections c where c.id = p_collection_id) then
    raise exception '找不到系列' using errcode = '22023';
  end if;

  insert into private.collection_download_secret as s (collection_id, password_hash, version, updated_at, updated_by)
  values (p_collection_id, extensions.crypt(p_new_password, extensions.gen_salt('bf', 10)), 1, now(), auth.uid())
  on conflict (collection_id) do update
     set password_hash = excluded.password_hash,
         version       = s.version + 1,
         updated_at    = now(),
         updated_by    = auth.uid()
  returning s.version into v_version;

  return jsonb_build_object('ok', true, 'version', v_version);
end;
$$;

revoke all on function public.set_collection_download_password(uuid, text) from public;
revoke all on function public.set_collection_download_password(uuid, text) from anon;
grant execute on function public.set_collection_download_password(uuid, text) to authenticated;

-- 管理員查看系列專屬密碼狀態（不回傳雜湊）
create or replace function public.collection_download_password_status(p_collection_id uuid)
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
           'configured', s.collection_id is not null,
           'version', coalesce(s.version, 0),
           'updated_at', s.updated_at,
           'updated_by_name', a.display_name
         )
    into v_result
    from (select p_collection_id as id) c
    left join private.collection_download_secret s on s.collection_id = c.id
    left join public.admins a on a.user_id = s.updated_by;
  return v_result;
end;
$$;

revoke all on function public.collection_download_password_status(uuid) from public;
revoke all on function public.collection_download_password_status(uuid) from anon;
grant execute on function public.collection_download_password_status(uuid) to authenticated;
