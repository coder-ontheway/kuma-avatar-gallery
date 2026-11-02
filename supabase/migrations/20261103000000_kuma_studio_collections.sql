-- =====================================================================
-- KUMA STUDIO｜多系列原創收藏管理平台（增量 migration，不刪除、不重建既有資料）
--
-- 以「系列」(collections) 為最上層單位，每個系列底下有任意數量的作品 (collection_works)。
-- 本檔在既有的 collections／collection_works／private.collection_download_secret 上擴充：
--
--   1. 系列狀態：草稿 draft／公開 published／下架 archived（與舊欄位 is_published 自動同步）
--   2. 系列封面、主視覺、身份證與收藏卡開關、收藏卡主題、身份證標題與宣言標籤（全部由管理員編輯）
--   3. 系列下載開關 download_enabled（只影響該系列）
--   4. 系列專屬下載密碼：啟用／停用、重新產生（伺服器端產生、只顯示一次）、立即撤銷
--      ─ 密碼一律只存 bcrypt 雜湊；撤銷或停用時版本 +1，先前發出的下載授權立即失效
--   5. 管理紀錄 admin_audit_log（系列、作品、密碼的新增／修改／刪除；不記錄密碼內容）
--   6. 下載驗證紀錄加上系列 id，後臺可看各系列近 48 小時驗證成功／失敗次數
--   7. 安全刪除系列：可選「把作品移到其他系列」或「連同作品一起刪除」，並需輸入系列名稱確認
--
-- 既有資料：
--   * 已公開的系列 → status = 'published'，未公開 → 'draft'
--   * 「熊兔生命共同體」原有的專屬密碼雜湊、版本完全保留（粉絲手上的密碼繼續有效）
--   * 原本收藏館（images 表）的下載密碼不變，仍只用於原本收藏館
--
-- 已部署的專案：在 SQL Editor 執行本檔一次（可重複執行）。
-- 需先執行 20261101000000_life_collection.sql 與 20261102000000_collection_download_password.sql。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 系列新欄位
-- ---------------------------------------------------------------------
alter table public.collections
  add column if not exists status           text    not null default 'draft',
  add column if not exists download_enabled boolean not null default true,
  add column if not exists cover_path       text,
  add column if not exists hero_path        text,
  add column if not exists id_card_enabled  boolean not null default true,
  add column if not exists card_enabled     boolean not null default true,
  add column if not exists card_theme       text    not null default 'forest',
  add column if not exists id_card_title    text    not null default '熊兔合體身份證',
  add column if not exists manifesto_label  text    not null default '專屬宣言';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'collections_status_check') then
    alter table public.collections add constraint collections_status_check check (status in ('draft', 'published', 'archived'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'collections_card_theme_check') then
    alter table public.collections add constraint collections_card_theme_check
      check (card_theme in ('forest', 'sweet', 'sunny', 'sky', 'night', 'classic'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'collections_labels_check') then
    alter table public.collections add constraint collections_labels_check check (
      char_length(btrim(id_card_title)) between 1 and 20 and char_length(btrim(manifesto_label)) between 1 and 12
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'collections_paths_check') then
    alter table public.collections add constraint collections_paths_check check (
      (cover_path is null or char_length(cover_path) between 1 and 300) and (hero_path is null or char_length(hero_path) between 1 and 300)
    );
  end if;
end $$;

-- 既有系列：依原本的公開狀態設定 status（只在第一次執行時有作用）
update public.collections set status = 'published' where is_published and status = 'draft';

-- 第一系列沿用原本的身份證與宣言名稱
update public.collections
   set id_card_title = '熊兔生命共同體身份證', manifesto_label = '專屬愛心宣言'
 where slug = 'one-heart-one-life' and id_card_title = '熊兔合體身份證' and manifesto_label = '專屬宣言';

-- status 與 is_published 自動同步（舊版程式只改 is_published 時也能正確運作）
create or replace function private.collections_status_sync()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.is_published and new.status = 'draft' then
      new.status := 'published';
    end if;
  elsif new.status is distinct from old.status then
    null; -- 以 status 為準
  elsif new.is_published is distinct from old.is_published then
    new.status := case when new.is_published then 'published' when old.status = 'published' then 'archived' else old.status end;
  end if;
  new.is_published := (new.status = 'published');
  return new;
end;
$$;

drop trigger if exists collections_status_sync on public.collections;
create trigger collections_status_sync
  before insert or update on public.collections
  for each row execute function private.collections_status_sync();

create index if not exists collections_order on public.collections (sort_order, created_at);

-- ---------------------------------------------------------------------
-- 2. 管理紀錄（只有管理員看得到；任何人都不能直接寫入或修改）
-- ---------------------------------------------------------------------
create table if not exists public.admin_audit_log (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  actor         uuid,                     -- 操作的管理員（Auth 使用者 id）
  actor_name    text,                     -- 當時的顯示名稱
  action        text not null,            -- 例：collection.create、work.update、password.change
  collection_id uuid,                     -- 不設外鍵：系列刪除後紀錄仍保留
  target        text not null default '', -- 例：系列名稱、No.001 稱號
  detail        jsonb not null default '{}'::jsonb
);

create index if not exists admin_audit_log_time on public.admin_audit_log (created_at desc);
create index if not exists admin_audit_log_collection on public.admin_audit_log (collection_id, created_at desc);

alter table public.admin_audit_log enable row level security;

drop policy if exists "管理員可查看管理紀錄" on public.admin_audit_log;
create policy "管理員可查看管理紀錄"
  on public.admin_audit_log for select
  to authenticated
  using ((select public.is_admin()));

revoke all on table public.admin_audit_log from public, anon, authenticated;
grant select on table public.admin_audit_log to authenticated;

create or replace function private.audit(p_action text, p_collection uuid, p_target text, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  begin
    v_uid := auth.uid();
  exception when others then
    v_uid := null; -- SQL Editor 等沒有登入身分的操作
  end;
  insert into public.admin_audit_log (actor, actor_name, action, collection_id, target, detail)
  values (
    v_uid,
    (select a.display_name from public.admins a where a.user_id = v_uid),
    p_action,
    p_collection,
    left(coalesce(p_target, ''), 120),
    coalesce(p_detail, '{}'::jsonb)
  );
end;
$$;

revoke all on function private.audit(text, uuid, text, jsonb) from public, anon, authenticated;

-- 記錄有哪些欄位被修改（只記欄位名稱與公開狀態等少量資訊，不記錄內容全文）
create or replace function private.changed_columns(p_old jsonb, p_new jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(k order by k), '{}')
    from jsonb_object_keys(p_new) k
   where k not in ('updated_at', 'published_at', 'is_published')
     and p_old -> k is distinct from p_new -> k;
$$;

create or replace function private.audit_collections()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('kuma.audit_quiet', true), '') = '1' then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform private.audit('collection.create', new.id, new.name, jsonb_build_object('status', new.status));
  elsif tg_op = 'UPDATE' then
    if private.changed_columns(to_jsonb(old), to_jsonb(new)) <> '{}' then
      perform private.audit('collection.update', new.id, new.name, jsonb_build_object(
        'fields', private.changed_columns(to_jsonb(old), to_jsonb(new)),
        'status', new.status
      ));
    end if;
  else
    perform private.audit('collection.delete', old.id, old.name, '{}'::jsonb);
  end if;
  return null;
end;
$$;

drop trigger if exists collections_audit on public.collections;
create trigger collections_audit
  after insert or update or delete on public.collections
  for each row execute function private.audit_collections();

create or replace function private.audit_collection_works()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.collection_works;
begin
  if coalesce(current_setting('kuma.audit_quiet', true), '') = '1' then
    return null;
  end if;
  r := case when tg_op = 'DELETE' then old else new end;
  if tg_op = 'INSERT' then
    perform private.audit('work.create', r.collection_id, 'No.' || lpad(r.work_number::text, 3, '0') || ' ' || r.nickname, '{}'::jsonb);
  elsif tg_op = 'UPDATE' then
    if private.changed_columns(to_jsonb(old), to_jsonb(new)) <> '{}' or old.is_published is distinct from new.is_published then
      perform private.audit('work.update', r.collection_id, 'No.' || lpad(r.work_number::text, 3, '0') || ' ' || r.nickname, jsonb_build_object(
        'fields', private.changed_columns(to_jsonb(old), to_jsonb(new)),
        'published', new.is_published
      ));
    end if;
  else
    perform private.audit('work.delete', r.collection_id, 'No.' || lpad(r.work_number::text, 3, '0') || ' ' || r.nickname, '{}'::jsonb);
  end if;
  return null;
end;
$$;

drop trigger if exists collection_works_audit on public.collection_works;
create trigger collection_works_audit
  after insert or update or delete on public.collection_works
  for each row execute function private.audit_collection_works();

-- ---------------------------------------------------------------------
-- 3. 系列專屬下載密碼：啟用狀態、撤銷
--    password_hash 為空 = 已撤銷／未設定（版本號保留且只會增加，舊授權永遠不會因重設而復活）
-- ---------------------------------------------------------------------
alter table private.collection_download_secret
  add column if not exists is_enabled boolean not null default true,
  add column if not exists revoked_at timestamptz;
alter table private.collection_download_secret alter column password_hash drop not null;

-- 下載驗證紀錄加上系列 id（統計用；原本收藏館的紀錄為空）
alter table private.download_attempts add column if not exists collection_id uuid;

-- 驗證系列專屬下載密碼（只有 Edge Function 的 service_role 能呼叫）
--   只比對「這個系列」的雜湊，其他系列或原本收藏館的密碼一律不通過
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
  v_enabled       boolean;
  v_status        text;
  v_dl_enabled    boolean;
  v_client_fails  integer;
  v_global_fails  integer;
  v_unlock_at     timestamptz;
  v_ok            boolean;
begin
  if p_client is null or char_length(p_client) < 16 or char_length(p_client) > 128 then
    raise exception 'invalid client id';
  end if;

  -- 與原本的密碼驗證共用同一把鎖與錯誤紀錄，避免換一個系列或換一種密碼繞過次數限制
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

  select c.status, c.download_enabled into v_status, v_dl_enabled
    from public.collections c where c.id = p_collection_id;
  if v_status is distinct from 'published' then
    return jsonb_build_object('ok', false, 'reason', 'not_available');
  end if;

  select s.password_hash, s.version, s.is_enabled into v_hash, v_version, v_enabled
    from private.collection_download_secret s
   where s.collection_id = p_collection_id;
  if v_hash is null then
    return jsonb_build_object('ok', false, 'reason', 'not_configured');
  end if;
  if not v_dl_enabled or not v_enabled then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;

  v_ok := p_password is not null
          and char_length(p_password) between 1 and 128
          and extensions.crypt(p_password, v_hash) = v_hash;

  if v_ok then
    delete from private.download_attempts where client_hash = p_client and not success;
  end if;
  insert into private.download_attempts (client_hash, success, collection_id) values (p_client, v_ok, p_collection_id);

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

-- Edge Function 每次發出下載網址前確認：版本、是否已設定、是否開放下載
create or replace function public.collection_download_state(p_collection_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'version', coalesce(s.version, 0),
    'configured', coalesce(s.password_hash is not null, false),
    'enabled', coalesce(s.password_hash is not null and s.is_enabled and c.download_enabled and c.status = 'published', false)
  )
  from (select p_collection_id as id) x
  left join public.collections c on c.id = x.id
  left join private.collection_download_secret s on s.collection_id = x.id;
$$;

revoke all on function public.collection_download_state(uuid) from public;
revoke all on function public.collection_download_state(uuid) from anon, authenticated;
grant execute on function public.collection_download_state(uuid) to service_role;

-- 內部：寫入新密碼雜湊（版本 +1）
create or replace function private.store_collection_password(p_collection_id uuid, p_password text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version integer;
begin
  insert into private.collection_download_secret as s (collection_id, password_hash, version, updated_at, updated_by, is_enabled, revoked_at)
  values (p_collection_id, extensions.crypt(p_password, extensions.gen_salt('bf', 10)), 1, now(), auth.uid(), true, null)
  on conflict (collection_id) do update
     set password_hash = excluded.password_hash,
         version       = s.version + 1,
         updated_at    = now(),
         updated_by    = auth.uid(),
         revoked_at    = null
  returning s.version into v_version;
  return v_version;
end;
$$;

revoke all on function private.store_collection_password(uuid, text) from public, anon, authenticated;

create or replace function private.require_admin_collection(p_collection_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  if not public.is_admin() then
    raise exception '沒有管理權限' using errcode = '42501';
  end if;
  select c.name into v_name from public.collections c where c.id = p_collection_id;
  if v_name is null then
    raise exception '找不到系列' using errcode = '22023';
  end if;
  return v_name;
end;
$$;

revoke all on function private.require_admin_collection(uuid) from public, anon, authenticated;

-- 管理員設定／修改系列專屬下載密碼（兩位管理員權限相同）
create or replace function public.set_collection_download_password(p_collection_id uuid, p_new_password text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name    text;
  v_version integer;
begin
  if not public.is_admin() then
    raise exception '沒有管理權限' using errcode = '42501';
  end if;
  if p_new_password is null or char_length(p_new_password) < 6 or char_length(p_new_password) > 64 then
    raise exception '下載密碼長度須為 6 到 64 個字元' using errcode = '22023';
  end if;
  v_name := private.require_admin_collection(p_collection_id);
  v_version := private.store_collection_password(p_collection_id, p_new_password);
  perform private.audit('password.set', p_collection_id, v_name, jsonb_build_object('version', v_version));
  return jsonb_build_object('ok', true, 'version', v_version);
end;
$$;

revoke all on function public.set_collection_download_password(uuid, text) from public;
revoke all on function public.set_collection_download_password(uuid, text) from anon;
grant execute on function public.set_collection_download_password(uuid, text) to authenticated;

-- 重新產生下載密碼：由伺服器產生 12 碼隨機密碼，只在這次回傳給管理員（資料庫只存雜湊）
create or replace function public.regenerate_collection_download_password(p_collection_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_chars   constant text := 'abcdefghjkmnpqrstuvwxyz23456789'; -- 去掉容易混淆的 i l o 0 1
  v_name    text;
  v_bytes   bytea;
  v_pw      text := '';
  v_version integer;
begin
  v_name := private.require_admin_collection(p_collection_id);
  v_bytes := extensions.gen_random_bytes(12);
  for i in 0..11 loop
    v_pw := v_pw || substr(c_chars, 1 + (get_byte(v_bytes, i) % char_length(c_chars)), 1);
    if i in (3, 7) then v_pw := v_pw || '-'; end if;
  end loop;
  v_version := private.store_collection_password(p_collection_id, v_pw);
  perform private.audit('password.regenerate', p_collection_id, v_name, jsonb_build_object('version', v_version));
  return jsonb_build_object('ok', true, 'version', v_version, 'password', v_pw);
end;
$$;

revoke all on function public.regenerate_collection_download_password(uuid) from public;
revoke all on function public.regenerate_collection_download_password(uuid) from anon;
grant execute on function public.regenerate_collection_download_password(uuid) to authenticated;

-- 停用／重新啟用系列專屬密碼（停用時版本 +1：已發出的下載授權立即失效，重新啟用也不會復活）
create or replace function public.set_collection_download_password_enabled(p_collection_id uuid, p_enabled boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name    text;
  v_version integer;
begin
  v_name := private.require_admin_collection(p_collection_id);
  if p_enabled is null then
    raise exception '狀態不可為空' using errcode = '22023';
  end if;
  update private.collection_download_secret s
     set is_enabled = p_enabled,
         version    = case when p_enabled then s.version else s.version + 1 end,
         updated_at = now(),
         updated_by = auth.uid()
   where s.collection_id = p_collection_id and s.password_hash is not null
  returning s.version into v_version;
  if v_version is null then
    raise exception '這個系列尚未設定下載密碼' using errcode = '22023';
  end if;
  perform private.audit(case when p_enabled then 'password.enable' else 'password.disable' end, p_collection_id, v_name, jsonb_build_object('version', v_version));
  return jsonb_build_object('ok', true, 'version', v_version, 'is_enabled', p_enabled);
end;
$$;

revoke all on function public.set_collection_download_password_enabled(uuid, boolean) from public;
revoke all on function public.set_collection_download_password_enabled(uuid, boolean) from anon;
grant execute on function public.set_collection_download_password_enabled(uuid, boolean) to authenticated;

-- 立即撤銷：清除密碼雜湊並讓所有授權失效；之後需要設定新密碼才能再下載
create or replace function public.revoke_collection_download_password(p_collection_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name    text;
  v_version integer;
begin
  v_name := private.require_admin_collection(p_collection_id);
  update private.collection_download_secret s
     set password_hash = null,
         version       = s.version + 1,
         revoked_at    = now(),
         updated_at    = now(),
         updated_by    = auth.uid()
   where s.collection_id = p_collection_id
  returning s.version into v_version;
  perform private.audit('password.revoke', p_collection_id, v_name, jsonb_build_object('version', v_version));
  return jsonb_build_object('ok', true, 'version', coalesce(v_version, 0));
end;
$$;

revoke all on function public.revoke_collection_download_password(uuid) from public;
revoke all on function public.revoke_collection_download_password(uuid) from anon;
grant execute on function public.revoke_collection_download_password(uuid) to authenticated;

-- 管理員查看單一系列的密碼狀態（不回傳密碼或雜湊）
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
           'configured', coalesce(s.password_hash is not null, false),
           'is_enabled', coalesce(s.is_enabled, false),
           'version', coalesce(s.version, 0),
           'updated_at', s.updated_at,
           'revoked_at', s.revoked_at,
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

-- ---------------------------------------------------------------------
-- 4. 後臺「系列管理中心」總覽：作品數、公開數、密碼狀態、近 48 小時下載驗證次數
-- ---------------------------------------------------------------------
create or replace function public.admin_collection_overview()
returns table (
  collection_id    uuid,
  work_count       integer,
  photo_count      integer,
  published_count  integer,
  password_configured boolean,
  password_enabled boolean,
  verify_ok_48h    integer,
  verify_fail_48h  integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception '沒有管理權限' using errcode = '42501';
  end if;
  return query
  select c.id,
         (select count(*)::integer from public.collection_works w where w.collection_id = c.id),
         (select count(*)::integer from public.collection_works w where w.collection_id = c.id and w.original_path is not null),
         (select count(*)::integer from public.collection_works w where w.collection_id = c.id and w.is_published),
         coalesce(s.password_hash is not null, false),
         coalesce(s.password_hash is not null and s.is_enabled, false),
         (select count(*)::integer from private.download_attempts d where d.collection_id = c.id and d.success and d.created_at > now() - interval '48 hours'),
         (select count(*)::integer from private.download_attempts d where d.collection_id = c.id and not d.success and d.created_at > now() - interval '48 hours')
    from public.collections c
    left join private.collection_download_secret s on s.collection_id = c.id;
end;
$$;

revoke all on function public.admin_collection_overview() from public;
revoke all on function public.admin_collection_overview() from anon;
grant execute on function public.admin_collection_overview() to authenticated;

-- ---------------------------------------------------------------------
-- 5. 安全刪除系列
--    p_mode = 'move'   ：作品移到 p_target 系列（編號衝突時接在目標系列最大編號之後；移過去一律先設為草稿）
--    p_mode = 'delete' ：作品連同系列一起刪除
--    p_confirm_name 必須與系列名稱完全相同，避免誤刪。
--    回傳需要從 Storage 刪除的檔案路徑（由管理員的瀏覽器刪除，Storage 政策同樣只允許管理員）。
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
    v_previews := v_previews || v_work_previews;
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

-- ---------------------------------------------------------------------
-- 6. 作品的「大頭貼版」照片（選用）
--    有些系列每個場景同時提供完整照片與另外構圖的方形大頭貼（例：熊大寵妻系列）。
--    兩張都是獨立的原始檔，不合成、不修改：完整照片用於身份證與收藏卡，大頭貼版用於製作大頭貼。
--    大頭貼版原圖同樣放在私有 originals bucket，下載同樣需要該系列的密碼。
-- ---------------------------------------------------------------------
alter table public.collection_works
  add column if not exists avatar_preview_path  text,
  add column if not exists avatar_original_path text,
  add column if not exists avatar_mime_type     text,
  add column if not exists avatar_file_size     bigint,
  add column if not exists avatar_width         integer,
  add column if not exists avatar_height        integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'collection_works_avatar_complete') then
    alter table public.collection_works add constraint collection_works_avatar_complete check (
      (avatar_preview_path is null and avatar_original_path is null and avatar_mime_type is null and avatar_file_size is null and avatar_width is null and avatar_height is null)
      or
      (avatar_preview_path is not null and avatar_original_path is not null and avatar_mime_type in ('image/png', 'image/jpeg', 'image/webp')
       and avatar_file_size > 0 and avatar_width > 0 and avatar_height > 0)
    );
  end if;
end $$;

-- 訪客：可讀大頭貼版的公開預覽圖與尺寸，看不到私有原圖路徑
grant select (avatar_preview_path, avatar_mime_type, avatar_file_size, avatar_width, avatar_height)
  on table public.collection_works to anon;

-- 第一次執行時記錄這次升級（方便日後查詢）
insert into public.admin_audit_log (action, target, detail)
select 'system.migrate', 'KUMA STUDIO 多系列平台', jsonb_build_object('migration', '20261103000000_kuma_studio_collections')
 where not exists (select 1 from public.admin_audit_log where action = 'system.migrate' and detail->>'migration' = '20261103000000_kuma_studio_collections');
