-- =====================================================================
-- 權限與安全測試（本機 PostgreSQL + local_mock_supabase.sql）
-- 執行：npm run test:db
-- 每個 check 失敗時會 raise exception，整個腳本以非 0 結束。
-- =====================================================================
\set ON_ERROR_STOP on
set client_min_messages = warning;

create schema t;

-- 以指定角色／使用者執行一段 SQL，取回單一結果；執行後一律回滾（不影響後續測試）
create function t.try_as(p_role text, p_uid uuid, p_sql text) returns text language plpgsql as $$
declare r text;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
    perform set_config('role', p_role, true);
    execute p_sql into r;
    raise exception 'RESULT:%', coalesce(r, '<null>');
  exception when others then
    if sqlerrm like 'RESULT:%' then return substr(sqlerrm, 8); end if;
    return 'ERROR:' || sqlstate;
  end;
end $$;

-- 以指定角色執行並保留結果（用於需要延續狀態的步驟）
create function t.do_as(p_role text, p_uid uuid, p_sql text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  perform set_config('role', p_role, true);
  begin
    execute p_sql into r;
  exception when others then
    perform set_config('role', 'none', true);
    return 'ERROR:' || sqlstate;
  end;
  perform set_config('role', 'none', true);
  return coalesce(r, '<null>');
end $$;

create function t.check(p_name text, p_actual text, p_expected text) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL: % → 實際 [%]，預期 [%]', p_name, p_actual, p_expected;
  end if;
  raise notice 'PASS: %', p_name;
end $$;

create function t.check_like(p_name text, p_actual text, p_pattern text) returns void language plpgsql as $$
begin
  if p_actual is null or p_actual not like p_pattern then
    raise exception 'FAIL: % → 實際 [%]，預期符合 [%]', p_name, p_actual, p_pattern;
  end if;
  raise notice 'PASS: %', p_name;
end $$;

set client_min_messages = notice;

-- 測試帳號：A、B 為管理員；C 為已登入但未授權；D 為想成為第三位管理員者
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.test'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@example.test'),
  ('cccccccc-0000-0000-0000-000000000003', 'c@example.test'),
  ('dddddddd-0000-0000-0000-000000000004', 'd@example.test');

insert into public.admins (user_id, display_name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '管理員 A'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '管理員 B');

\set A '''aaaaaaaa-0000-0000-0000-000000000001'''
\set B '''bbbbbbbb-0000-0000-0000-000000000002'''
\set C '''cccccccc-0000-0000-0000-000000000003'''
\set D '''dddddddd-0000-0000-0000-000000000004'''

-- 測試資料：一張已發布、一張草稿
insert into public.images (id, title, preview_path, original_path, mime_type, file_size, width, height, is_published)
values
  ('11111111-0000-0000-0000-000000000001', '測試已發布', 'p/1.webp', 'o/1.png', 'image/png', 100, 10, 10, true),
  ('11111111-0000-0000-0000-000000000002', '測試草稿', 'p/2.webp', 'o/2.png', 'image/png', 100, 10, 10, false);

do $$ begin raise notice '--- 1. 管理員身分判斷 ---'; end $$;
select t.check('A 是管理員', t.try_as('authenticated', :A, 'select public.is_admin()::text'), 'true');
select t.check('B 是管理員', t.try_as('authenticated', :B, 'select public.is_admin()::text'), 'true');
select t.check('C（已登入未授權）不是管理員', t.try_as('authenticated', :C, 'select public.is_admin()::text'), 'false');
select t.check('訪客不是管理員', t.try_as('anon', null, 'select public.is_admin()::text'), 'false');

do $$ begin raise notice '--- 2. 訪客權限 ---'; end $$;
select t.check('訪客只看到已發布作品', t.try_as('anon', null, 'select count(*)::text from public.images'), '1');
select t.check('訪客不能讀取私有原圖路徑', t.try_as('anon', null, 'select original_path from public.images limit 1'), 'ERROR:42501');
select t.check('訪客不能讀取無字版原圖路徑', t.try_as('anon', null, 'select plain_original_path from public.images limit 1'), 'ERROR:42501');
select t.check('訪客可讀取無字版預覽圖路徑', t.try_as('anon', null, 'select coalesce(plain_preview_path, ''none'') from public.images limit 1'), 'none');
select t.check('訪客可讀取公開欄位', t.try_as('anon', null, 'select title from public.images limit 1'), '測試已發布');
select t.check('訪客不能新增作品', t.try_as('anon', null,
  $q$insert into public.images (title, preview_path, original_path, mime_type, file_size, width, height) values ('x','x','x','image/png',1,1,1) returning id::text$q$), 'ERROR:42501');
select t.check('訪客不能修改作品', t.try_as('anon', null, 'update public.images set title = ''壞'' returning id::text'), 'ERROR:42501');
select t.check('訪客不能刪除作品', t.try_as('anon', null, 'delete from public.images returning id::text'), 'ERROR:42501');
select t.check('訪客可讀取分類', t.try_as('anon', null, 'select count(*)::text from public.categories'), '7');
select t.check('訪客不能新增分類', t.try_as('anon', null, 'insert into public.categories (name) values (''駭客'') returning id::text'), 'ERROR:42501');
select t.check('訪客可讀取網站設定', t.try_as('anon', null, 'select site_name from public.site_settings'), 'KUMA 熊兔大頭貼收藏館');
select t.check('訪客不能修改網站設定', t.try_as('anon', null, 'update public.site_settings set announcement = ''x'' returning id::text'), 'ERROR:42501');
select t.check('訪客不能讀取管理員名單', t.try_as('anon', null, 'select count(*)::text from public.admins'), 'ERROR:42501');
select t.check('訪客不能讀取 private schema', t.try_as('anon', null, 'select count(*)::text from private.download_secret'), 'ERROR:42501');
select t.check('訪客不能直接呼叫密碼驗證函式', t.try_as('anon', null, 'select public.verify_download_password(''x'', repeat(''a'',32))::text'), 'ERROR:42501');
select t.check('訪客不能呼叫 download_state', t.try_as('anon', null, 'select public.download_state()::text'), 'ERROR:42501');
select t.check('訪客不能更換下載密碼', t.try_as('anon', null, 'select public.set_download_password(''hacked123'')::text'), 'ERROR:42501');
select t.check('訪客不能把自己加入管理員', t.try_as('anon', null, $q$insert into public.admins (user_id, display_name) values ('dddddddd-0000-0000-0000-000000000004','x') returning 1$q$), 'ERROR:42501');

do $$ begin raise notice '--- 3. 已登入但未授權的使用者（C） ---'; end $$;
select t.check('C 看不到草稿', t.try_as('authenticated', :C, 'select count(*)::text from public.images'), '1');
select t.check('C 不能新增作品（RLS）', t.try_as('authenticated', :C,
  $q$insert into public.images (title, preview_path, original_path, mime_type, file_size, width, height) values ('x','x','x','image/png',1,1,1) returning id::text$q$), 'ERROR:42501');
select t.check('C 更新作品影響 0 列', t.try_as('authenticated', :C, 'with u as (update public.images set title = ''壞'' returning 1) select count(*)::text from u'), '0');
select t.check('C 刪除作品影響 0 列', t.try_as('authenticated', :C, 'with d as (delete from public.images returning 1) select count(*)::text from d'), '0');
select t.check('C 修改網站設定影響 0 列', t.try_as('authenticated', :C, 'with u as (update public.site_settings set announcement = ''x'' returning 1) select count(*)::text from u'), '0');
select t.check('C 不能新增分類', t.try_as('authenticated', :C, 'insert into public.categories (name) values (''駭客'') returning id::text'), 'ERROR:42501');
select t.check('C 不能更換下載密碼', t.try_as('authenticated', :C, 'select public.set_download_password(''hacked123'')::text'), 'ERROR:42501');
select t.check('C 不能查看密碼狀態', t.try_as('authenticated', :C, 'select public.download_password_status()::text'), 'ERROR:42501');
select t.check('C 看不到管理員名單', t.try_as('authenticated', :C, 'select count(*)::text from public.admins'), '0');
select t.check('C 不能把自己加入管理員', t.try_as('authenticated', :C, $q$insert into public.admins (user_id, display_name) values ('cccccccc-0000-0000-0000-000000000003','x') returning 1$q$), 'ERROR:42501');
select t.check('C 不能呼叫密碼驗證函式', t.try_as('authenticated', :C, 'select public.verify_download_password(''x'', repeat(''a'',32))::text'), 'ERROR:42501');
select t.check('C 不能上傳 Storage 原圖', t.try_as('authenticated', :C, $q$insert into storage.objects (bucket_id, name) values ('originals','x.png') returning 1$q$), 'ERROR:42501');
select t.check('C 不能上傳 Storage 預覽圖', t.try_as('authenticated', :C, $q$insert into storage.objects (bucket_id, name) values ('previews','x.png') returning 1$q$), 'ERROR:42501');

do $$ begin raise notice '--- 4. 管理員 A、B 權限 ---'; end $$;
select t.check('A 看得到草稿', t.try_as('authenticated', :A, 'select count(*)::text from public.images'), '2');
select t.check('B 看得到草稿', t.try_as('authenticated', :B, 'select count(*)::text from public.images'), '2');
select t.check('A 可讀取原圖路徑', t.try_as('authenticated', :A, 'select original_path from public.images where id = ''11111111-0000-0000-0000-000000000001'''), 'o/1.png');
select t.check('A 可設定無字版', t.try_as('authenticated', :A,
  $q$update public.images set plain_preview_path = 'p/1-plain.webp', plain_original_path = 'o/1-plain.png' where id = '11111111-0000-0000-0000-000000000001' returning plain_original_path$q$), 'o/1-plain.png');
select t.check('無字版必須同時有預覽與原圖', t.try_as('authenticated', :A,
  $q$update public.images set plain_preview_path = 'p/x.webp' where id = '11111111-0000-0000-0000-000000000001' returning id::text$q$), 'ERROR:23514');
select t.check_like('A 可新增作品', t.try_as('authenticated', :A,
  $q$insert into public.images (title, preview_path, original_path, mime_type, file_size, width, height) values ('新','p','o','image/png',1,1,1) returning id::text$q$), '%-%');
select t.check('B 可修改作品與排序', t.try_as('authenticated', :B, 'with u as (update public.images set title = ''改名'', sort_order = 5 returning 1) select count(*)::text from u'), '2');
select t.check('A 可刪除作品', t.try_as('authenticated', :A, 'with d as (delete from public.images where id = ''11111111-0000-0000-0000-000000000002'' returning 1) select count(*)::text from d'), '1');
select t.check('B 可發布草稿', t.try_as('authenticated', :B, 'update public.images set is_published = true where id = ''11111111-0000-0000-0000-000000000002'' returning (published_at is not null)::text'), 'true');
select t.check_like('A 可新增分類', t.try_as('authenticated', :A, 'insert into public.categories (name, sort_order) values (''新分類'', 70) returning id::text'), '%-%');
select t.check('B 可刪除分類', t.try_as('authenticated', :B, 'with d as (delete from public.categories where name = ''其他'' returning 1) select count(*)::text from d'), '1');
select t.check('A 可修改網站公告', t.try_as('authenticated', :A, 'update public.site_settings set announcement = ''十一月更新'' returning announcement'), '十一月更新');
select t.check('B 可修改最新更新日期', t.try_as('authenticated', :B, 'update public.site_settings set latest_update_date = ''2026-11-01'' returning latest_update_date::text'), '2026-11-01');
select t.check('管理員不能竄改 site_settings.id', t.try_as('authenticated', :A, 'update public.site_settings set id = 2 returning id::text'), 'ERROR:42501');
select t.check('Facebook 網址必須是 https', t.try_as('authenticated', :A, 'update public.site_settings set facebook_url = ''javascript:alert(1)'' returning 1'), 'ERROR:23514');
select t.check('A 可看到 2 位管理員', t.try_as('authenticated', :A, 'select count(*)::text from public.admins'), '2');
select t.check('A 可上傳 Storage 原圖', t.try_as('authenticated', :A, $q$insert into storage.objects (bucket_id, name) values ('originals','x.png') returning 'ok'$q$), 'ok');
select t.check('B 可上傳 Storage 預覽圖', t.try_as('authenticated', :B, $q$insert into storage.objects (bucket_id, name) values ('previews','x.webp') returning 'ok'$q$), 'ok');
select t.check('管理員不能寫入其他 bucket', t.try_as('authenticated', :A, $q$insert into storage.objects (bucket_id, name) values ('other','x') returning 'ok'$q$), 'ERROR:42501');

do $$ begin raise notice '--- 5. 管理員不能新增第三位或修改名單 ---'; end $$;
select t.check('A 不能新增第三位管理員', t.try_as('authenticated', :A, $q$insert into public.admins (user_id, display_name) values ('dddddddd-0000-0000-0000-000000000004','第三位') returning 1$q$), 'ERROR:42501');
select t.check('B 不能停用 A', t.try_as('authenticated', :B, $q$update public.admins set is_active = false where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' returning 1$q$), 'ERROR:42501');
select t.check('A 不能刪除 B', t.try_as('authenticated', :A, $q$delete from public.admins where user_id = 'bbbbbbbb-0000-0000-0000-000000000002' returning 1$q$), 'ERROR:42501');
select t.check('A 不能直接讀取密碼雜湊', t.try_as('authenticated', :A, 'select password_hash from private.download_secret'), 'ERROR:42501');
-- 即使在 SQL Editor（postgres）也無法登記第三位有效管理員
select t.check('資料庫上限：最多 2 位有效管理員', t.try_as('postgres', null, $q$insert into public.admins (user_id, display_name) values ('dddddddd-0000-0000-0000-000000000004','第三位') returning 1$q$), 'ERROR:23514');

do $$ begin raise notice '--- 6. 下載密碼：雜湊、驗證、暴力猜測限制 ---'; end $$;
\set CLIENT1 '''client-hash-0000000000000001'''
\set CLIENT2 '''client-hash-0000000000000002'''
select t.check('尚未設定密碼時驗證回報 not_configured', t.try_as('service_role', null, 'select public.verify_download_password(''whatever'', ' || :'CLIENT1' || ')->>''reason'''), 'not_configured');
select t.check('密碼太短會被拒絕', t.try_as('authenticated', :A, 'select public.set_download_password(''123'')::text'), 'ERROR:22023');
select t.check('A 可設定下載密碼', t.do_as('authenticated', :A, 'select public.set_download_password(''kuma-test-pass-1'')->>''version'''), '1');
select t.check('資料庫沒有明文密碼', (select (password_hash not like '%kuma-test-pass-1%' and password_hash like '$2a$10$%')::text from private.download_secret), 'true');
select t.check('A 可查看密碼狀態（不含雜湊）', t.try_as('authenticated', :A, 'select (public.download_password_status() ? ''password_hash'')::text'), 'false');
select t.check('狀態顯示由管理員 A 更新', t.try_as('authenticated', :B, 'select public.download_password_status()->>''updated_by_name'''), '管理員 A');
select t.check('正確密碼驗證成功', t.do_as('service_role', null, 'select public.verify_download_password(''kuma-test-pass-1'', ' || :'CLIENT1' || ')->>''ok'''), 'true');
select t.check('錯誤密碼驗證失敗', t.do_as('service_role', null, 'select public.verify_download_password(''wrong'', ' || :'CLIENT1' || ')->>''reason'''), 'wrong');
select t.check('第 2 次錯誤剩餘 3 次', t.do_as('service_role', null, 'select public.verify_download_password(''wrong'', ' || :'CLIENT1' || ')->>''remaining'''), '3');
select t.do_as('service_role', null, 'select public.verify_download_password(''wrong'', ' || :'CLIENT1' || ')::text');
select t.do_as('service_role', null, 'select public.verify_download_password(''wrong'', ' || :'CLIENT1' || ')::text');
select t.check('第 5 次錯誤後剩餘 0', t.do_as('service_role', null, 'select public.verify_download_password(''wrong'', ' || :'CLIENT1' || ')->>''remaining'''), '0');
select t.check('鎖定後即使正確密碼也被拒絕', t.do_as('service_role', null, 'select public.verify_download_password(''kuma-test-pass-1'', ' || :'CLIENT1' || ')->>''reason'''), 'locked');
select t.check_like('鎖定時回報等待秒數', t.do_as('service_role', null, 'select public.verify_download_password(''x'', ' || :'CLIENT1' || ')->>''retry_after'''), '%');
select t.check('鎖定時不新增嘗試紀錄', (select count(*)::text from private.download_attempts where client_hash = 'client-hash-0000000000000001' and not success), '5');
select t.check('其他來源不受影響', t.do_as('service_role', null, 'select public.verify_download_password(''kuma-test-pass-1'', ' || :'CLIENT2' || ')->>''ok'''), 'true');
select t.check('download_state 版本為 1', t.try_as('service_role', null, 'select public.download_state()->>''version'''), '1');

do $$ begin raise notice '--- 7. B 更換密碼後舊密碼失效 ---'; end $$;
select t.check('B 可更換下載密碼', t.do_as('authenticated', :B, 'select public.set_download_password(''kuma-test-pass-2'')->>''version'''), '2');
select t.check('換密碼後解除鎖定紀錄', (select count(*)::text from private.download_attempts), '0');
select t.check('舊密碼失效', t.do_as('service_role', null, 'select public.verify_download_password(''kuma-test-pass-1'', ' || :'CLIENT2' || ')->>''reason'''), 'wrong');
select t.check('新密碼有效且版本為 2', t.do_as('service_role', null, 'select public.verify_download_password(''kuma-test-pass-2'', ' || :'CLIENT2' || ')->>''version'''), '2');
select t.check('來源識別太短會被拒絕', t.try_as('service_role', null, 'select public.verify_download_password(''x'', ''short'')::text'), 'ERROR:P0001');

do $$ begin raise notice '--- 8. 本月作品是否公開 ---'; end $$;
update public.images set is_monthly = true where id = '11111111-0000-0000-0000-000000000001';
select t.check('本月作品公開時訪客可見', t.try_as('anon', null, 'select count(*)::text from public.images where is_monthly'), '1');
update public.site_settings set monthly_public = false;
select t.check('本月作品不公開時訪客不可見', t.try_as('anon', null, 'select count(*)::text from public.images where is_monthly'), '0');
select t.check('本月作品不公開時管理員仍可見', t.try_as('authenticated', :A, 'select count(*)::text from public.images where is_monthly'), '1');
update public.site_settings set monthly_public = true;

do $$ begin raise notice '--- 9. 撤銷管理員權限 ---'; end $$;
update public.admins set is_active = false where user_id = 'bbbbbbbb-0000-0000-0000-000000000002';
select t.check('撤銷時自動記錄時間', (select (revoked_at is not null)::text from public.admins where user_id = 'bbbbbbbb-0000-0000-0000-000000000002'), 'true');
select t.check('撤銷後 B 不是管理員', t.try_as('authenticated', :B, 'select public.is_admin()::text'), 'false');
select t.check('撤銷後 B 不能新增作品', t.try_as('authenticated', :B,
  $q$insert into public.images (title, preview_path, original_path, mime_type, file_size, width, height) values ('x','x','x','image/png',1,1,1) returning id::text$q$), 'ERROR:42501');
select t.check('撤銷後 B 修改作品影響 0 列', t.try_as('authenticated', :B, 'with u as (update public.images set title = ''壞'' returning 1) select count(*)::text from u'), '0');
select t.check('撤銷後 B 不能更換密碼', t.try_as('authenticated', :B, 'select public.set_download_password(''hacked123'')::text'), 'ERROR:42501');
select t.check('撤銷後 B 不能上傳 Storage', t.try_as('authenticated', :B, $q$insert into storage.objects (bucket_id, name) values ('originals','y.png') returning 1$q$), 'ERROR:42501');
select t.check('撤銷 B 不影響 A', t.try_as('authenticated', :A, 'select public.is_admin()::text'), 'true');
select t.check('撤銷後可登記新管理員（仍最多 2 位）', t.try_as('postgres', null, $q$insert into public.admins (user_id, display_name) values ('dddddddd-0000-0000-0000-000000000004','新管理員') returning 'ok'$q$), 'ok');
select t.check('重新啟用 B 成功', t.try_as('postgres', null, $q$update public.admins set is_active = true where user_id = 'bbbbbbbb-0000-0000-0000-000000000002' returning (revoked_at is null)::text$q$), 'true');

do $$ begin raise notice '--- 10. 下載次數統計 ---'; end $$;
select t.check('訪客不能記錄下載次數', t.try_as('anon', null, $q$select public.record_downloads(array['11111111-0000-0000-0000-000000000001']::uuid[], 'avatar')::text$q$), 'ERROR:42501');
select t.check('管理員也不能自行灌下載次數', t.try_as('authenticated', :A, $q$select public.record_downloads(array['11111111-0000-0000-0000-000000000001']::uuid[], 'avatar')::text$q$), 'ERROR:42501');
select t.do_as('service_role', null, $q$select public.record_downloads(array['11111111-0000-0000-0000-000000000001']::uuid[], 'avatar')::text$q$);
select t.do_as('service_role', null, $q$select public.record_downloads(array['11111111-0000-0000-0000-000000000001']::uuid[], 'avatar')::text$q$);
select t.do_as('service_role', null, $q$select public.record_downloads(array['11111111-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000009']::uuid[], 'zip')::text$q$);
select t.check('Edge Function 可累計下載次數', t.try_as('authenticated', :A, $q$select avatar_count || '/' || original_count || '/' || zip_count from public.image_download_stats where image_id = '11111111-0000-0000-0000-000000000001'$q$), '2/0/1');
select t.check('不存在的作品不會產生統計', (select count(*)::text from public.image_download_stats where image_id = '99999999-0000-0000-0000-000000000009'), '0');
select t.check('未知的下載類型會被拒絕', t.try_as('service_role', null, $q$select public.record_downloads(array[]::uuid[], 'hack')::text$q$), 'ERROR:22023');
select t.check('訪客看不到下載次數', t.try_as('anon', null, 'select count(*)::text from public.image_download_stats'), 'ERROR:42501');
select t.check('管理員 A 看得到下載次數', t.try_as('authenticated', :A, 'select count(*)::text from public.image_download_stats'), '1');
select t.check('管理員不能修改下載次數', t.try_as('authenticated', :A, 'update public.image_download_stats set avatar_count = 999 where true returning 1'), 'ERROR:42501');

do $$ begin raise notice '=== 全部權限測試通過 ==='; end $$;
