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

do $$ begin raise notice '--- 11. 熊兔生命共同體（獨立系列） ---'; end $$;
update public.admins set is_active = true where user_id = 'bbbbbbbb-0000-0000-0000-000000000002';
select t.check('B 恢復為管理員', t.try_as('authenticated', :B, 'select public.is_admin()::text'), 'true');
select t.check('系列初始資料：1 個系列', (select count(*)::text from public.collections where slug = 'one-heart-one-life'), '1');
select t.check('系列初始資料：10 款作品、10 個不同編號', (select count(distinct work_number)::text from public.collection_works), '10');
select t.check('系列初始資料：10 個不同稱號', (select count(distinct nickname)::text from public.collection_works), '10');
select t.check('No.001 稱號', (select nickname from public.collection_works where work_number = 1), '熊兔共生體');
select t.check('No.010 稱號', (select nickname from public.collection_works where work_number = 10), '永恆愛心體');
select t.check('初始作品都是待上傳（沒有照片、未公開）', (select count(*)::text from public.collection_works where original_path is null and not is_published), '10');
select t.check('預設宣言 10 句', (select cardinality(manifestos)::text from public.collections where slug = 'one-heart-one-life'), '10');
select t.check('待上傳作品不能公開', t.try_as('authenticated', :A, 'update public.collection_works set is_published = true where work_number = 1 returning 1'), 'ERROR:23514');
select t.check('照片欄位必須完整', t.try_as('authenticated', :A, $q$update public.collection_works set preview_path = 'x' where work_number = 1 returning 1$q$), 'ERROR:23514');
select t.check('作品編號不能重複', t.try_as('authenticated', :A, 'update public.collection_works set work_number = 2 where work_number = 1 returning 1'), 'ERROR:23505');
select t.check('宣言長度限制', t.try_as('authenticated', :A, $q$update public.collections set manifestos = array[repeat('長', 41)] where true returning 1$q$), 'ERROR:23514');
-- A 上傳 No.001、No.002 的照片並公開 No.001；B 上傳 No.003（兩位管理員權限相同）
select t.do_as('authenticated', :A, $q$update public.collection_works set preview_path = 'life/1/p.webp', original_path = 'life/1/o.jpg', mime_type = 'image/jpeg', file_size = 100, width = 1280, height = 1280 where work_number in (1, 2) returning 'ok'$q$);
select t.do_as('authenticated', :A, $q$update public.collection_works set is_published = true where work_number = 1 returning 'ok'$q$);
select t.check('B 可以上傳並公開 No.003', t.try_as('authenticated', :B, $q$with u as (update public.collection_works set preview_path = 'life/3/p.webp', original_path = 'life/3/o.jpg', mime_type = 'image/jpeg', file_size = 100, width = 1280, height = 1280, is_published = true where work_number = 3 returning 1) select count(*)::text from u$q$), '1');
select t.check('B 可以修改稱號與介紹', t.try_as('authenticated', :B, $q$with u as (update public.collection_works set nickname = '改名', description = '新介紹' where work_number = 2 returning 1) select count(*)::text from u$q$), '1');
select t.check('B 可以新增 No.011', t.try_as('authenticated', :B, $q$insert into public.collection_works (collection_id, work_number, nickname) select id, 11, '新作品' from public.collections where slug = 'one-heart-one-life' returning work_number::text$q$), '11');
select t.check('B 可以修改系列設定', t.try_as('authenticated', :B, $q$with u as (update public.collections set tagline = '新主題' where slug = 'one-heart-one-life' returning 1) select count(*)::text from u$q$), '1');
select t.check('發布時自動記錄時間', (select (published_at is not null)::text from public.collection_works where work_number = 1), 'true');
select t.check('訪客只看到已公開的系列作品', t.try_as('anon', null, 'select count(*)::text from public.collection_works'), '1');
select t.check('訪客不能讀取系列原圖路徑', t.try_as('anon', null, 'select original_path from public.collection_works limit 1'), 'ERROR:42501');
select t.check('訪客可讀取稱號與保護區域', t.try_as('anon', null, 'select nickname || jsonb_array_length(protect_zones) from public.collection_works'), '熊兔共生體2');
select t.check('訪客不能修改系列作品', t.try_as('anon', null, 'update public.collection_works set nickname = ''壞'' where true returning 1'), 'ERROR:42501');
select t.check('訪客不能新增系列', t.try_as('anon', null, $q$insert into public.collections (slug, name) values ('hack', 'x') returning 1$q$), 'ERROR:42501');
select t.check('C 看不到草稿與待上傳作品', t.try_as('authenticated', :C, 'select count(*)::text from public.collection_works'), '1');
select t.check('C 修改系列作品影響 0 列', t.try_as('authenticated', :C, 'with u as (update public.collection_works set nickname = ''壞'' where true returning 1) select count(*)::text from u'), '0');
select t.check('C 刪除系列作品影響 0 列', t.try_as('authenticated', :C, 'with d as (delete from public.collection_works where true returning 1) select count(*)::text from d'), '0');
select t.check('C 不能新增系列作品', t.try_as('authenticated', :C, $q$insert into public.collection_works (collection_id, work_number, nickname) select id, 50, 'x' from public.collections returning 1$q$), 'ERROR:42501');
select t.check('管理員 A 看得到全部系列作品（含待上傳）', t.try_as('authenticated', :A, 'select count(*)::text from public.collection_works'), '10');
-- 上面 B 新增 No.011 已回滾；以下確認系列下架後訪客看不到任何作品
update public.collections set is_published = false where slug = 'one-heart-one-life';
select t.check('系列下架後訪客看不到系列', t.try_as('anon', null, 'select count(*)::text from public.collections'), '0');
select t.check('系列下架後訪客看不到作品', t.try_as('anon', null, 'select count(*)::text from public.collection_works'), '0');
select t.check('系列下架後管理員仍看得到', t.try_as('authenticated', :A, 'select count(*)::text from public.collections'), '1');
update public.collections set is_published = true where slug = 'one-heart-one-life';
select t.check('系列資料不影響原收藏館作品數', t.try_as('anon', null, 'select count(*)::text from public.images'), '1');
select t.check('A 可刪除系列作品', t.try_as('authenticated', :A, 'with d as (delete from public.collection_works where work_number = 10 returning 1) select count(*)::text from d'), '1');

-- =====================================================================
-- 12. 生命共同體專屬下載密碼（與原本收藏館的密碼分開）
-- =====================================================================
\set CLIENT9 '''client-hash-0000000000000009'''
select id::text as life_id from public.collections where slug = 'one-heart-one-life' \gset
select t.check('訪客看不到專屬密碼資料表', t.try_as('anon', null, 'select count(*)::text from private.collection_download_secret'), 'ERROR:42501');
select t.check('訪客不能設定專屬密碼', t.try_as('anon', null, format('select public.set_collection_download_password(%L, %L)::text', :'life_id', 'hacked123')), 'ERROR:42501');
select t.check('訪客不能呼叫專屬密碼驗證', t.try_as('anon', null, format('select public.verify_collection_download_password(%L, %L, %L)::text', :'life_id', 'x', repeat('a', 32))), 'ERROR:42501');
select t.check('訪客不能呼叫系列下載狀態', t.try_as('anon', null, format('select public.collection_download_state(%L)::text', :'life_id')), 'ERROR:42501');
select t.check('C 不能設定專屬密碼', t.try_as('authenticated', :C, format('select public.set_collection_download_password(%L, %L)::text', :'life_id', 'hacked123')), 'ERROR:42501');
select t.check('C 不能查看專屬密碼狀態', t.try_as('authenticated', :C, format('select public.collection_download_password_status(%L)::text', :'life_id')), 'ERROR:42501');
select t.check('C 不能呼叫專屬密碼驗證', t.try_as('authenticated', :C, format('select public.verify_collection_download_password(%L, %L, %L)::text', :'life_id', 'x', repeat('a', 32))), 'ERROR:42501');
select t.check('尚未設定專屬密碼：狀態為未設定', t.try_as('authenticated', :A, format('select public.collection_download_password_status(%L)->>%L', :'life_id', 'configured')), 'false');
select t.check('尚未設定專屬密碼：驗證回報 not_configured', t.try_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'life_id', 'kuma-test-pass-2', :CLIENT9, 'reason')), 'not_configured');
select t.check('尚未設定專屬密碼：下載狀態 configured=false', t.try_as('service_role', null, format('select public.collection_download_state(%L)->>%L', :'life_id', 'configured')), 'false');
select t.check('專屬密碼太短會被拒絕', t.try_as('authenticated', :A, format('select public.set_collection_download_password(%L, %L)::text', :'life_id', '123')), 'ERROR:22023');
select t.check('不存在的系列不能設定', t.try_as('authenticated', :A, format('select public.set_collection_download_password(%L, %L)::text', 'eeeeeeee-0000-0000-0000-000000000000', 'life-pass-1')), 'ERROR:22023');
select t.check('A 可設定專屬密碼（第 1 版）', t.do_as('authenticated', :A, format('select public.set_collection_download_password(%L, %L)->>%L', :'life_id', 'life-pass-1', 'version')), '1');
select t.check('專屬密碼以 bcrypt 雜湊存放', (select (password_hash like '$2%' and password_hash <> 'life-pass-1')::text from private.collection_download_secret), 'true');
select t.check('A 可看到專屬密碼狀態與更新者', t.try_as('authenticated', :A, format('select (s->>%L) || (s->>%L) || (s->>%L) from public.collection_download_password_status(%L) s', 'configured', 'version', 'updated_by_name', :'life_id')), 'true1管理員 A');
select t.check('專屬密碼狀態不回傳雜湊', t.try_as('authenticated', :A, format('select (public.collection_download_password_status(%L) ? %L)::text', :'life_id', 'password_hash')), 'false');
select t.check('專屬密碼驗證成功', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'life_id', 'life-pass-1', :CLIENT9, 'version')), '1');
select t.check('原本收藏館的密碼不能通過專屬密碼驗證', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'life_id', 'kuma-test-pass-2', :CLIENT9, 'reason')), 'wrong');
select t.check('專屬密碼不能通過原本收藏館的驗證', t.do_as('service_role', null, format('select public.verify_download_password(%L, %L)->>%L', 'life-pass-1', :CLIENT9, 'reason')), 'wrong');
select t.check('原本收藏館的密碼仍然有效', t.do_as('service_role', null, format('select public.verify_download_password(%L, %L)->>%L', 'kuma-test-pass-2', :CLIENT9, 'ok')), 'true');
select t.check('B 可更換專屬密碼（第 2 版）', t.do_as('authenticated', :B, format('select public.set_collection_download_password(%L, %L)->>%L', :'life_id', 'life-pass-2', 'version')), '2');
select t.check('更換後下載狀態版本為 2', t.try_as('service_role', null, format('select public.collection_download_state(%L)->>%L', :'life_id', 'version')), '2');
select t.check('更換後舊專屬密碼失效', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'life_id', 'life-pass-1', :CLIENT9, 'reason')), 'wrong');
select t.check('更換專屬密碼不影響原本收藏館的密碼版本', t.try_as('service_role', null, 'select public.download_state()->>''version'''), '2');
select t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)::text', :'life_id', 'bad', :CLIENT9));
select t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)::text', :'life_id', 'bad', :CLIENT9));
select t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)::text', :'life_id', 'bad', :CLIENT9));
select t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)::text', :'life_id', 'bad', :CLIENT9));
select t.check('專屬密碼連續錯誤 5 次後鎖定', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'life_id', 'life-pass-2', :CLIENT9, 'reason')), 'locked');
select t.check('鎖定也適用於原本的密碼（不能換一種密碼繞過）', t.do_as('service_role', null, format('select public.verify_download_password(%L, %L)->>%L', 'kuma-test-pass-2', :CLIENT9, 'reason')), 'locked');
select t.check('系列刪除時專屬密碼一併刪除', (select confdeltype::text from pg_constraint where conrelid = 'private.collection_download_secret'::regclass and contype = 'f' and confrelid = 'public.collections'::regclass), 'c');


do $$ begin raise notice '--- 12. KUMA STUDIO 多系列：三個系列、各自獨立密碼 ---'; end $$;
-- 既有系列在升級後的狀態
select t.check('既有公開系列升級為 status=published', (select status from public.collections where slug = 'one-heart-one-life'), 'published');
select t.check('第一系列沿用原本的身份證名稱', (select id_card_title from public.collections where slug = 'one-heart-one-life'), '熊兔生命共同體身份證');
select t.check('第一系列原有密碼雜湊保留（升級不影響粉絲密碼）', (select (password_hash is not null)::text from private.collection_download_secret s join public.collections c on c.id = s.collection_id where c.slug = 'one-heart-one-life'), 'true');

-- 兩位管理員各自建立系列
select t.check('A 可新增「熊大寵妻系列」（草稿）', t.do_as('authenticated', :A, $q$insert into public.collections (slug, name, name_en, card_theme, id_card_title, manifesto_label, manifestos, sort_order)
  values ('pamper-wife', '熊大寵妻系列', 'PAMPER MY BUNNY', 'sweet', '熊大寵妻身份證', '寵妻宣言', array['熊大專屬寵妻員。', '兔兔最大，熊大負責執行。'], 20) returning status$q$), 'draft');
select t.check('B 可新增「熊兔甜蜜日常」', t.do_as('authenticated', :B, $q$insert into public.collections (slug, name, name_en, status, card_theme, manifestos, sort_order)
  values ('sweet-daily', '熊兔甜蜜日常', 'SWEET DAILY', 'published', 'sunny', array['今天也很甜。'], 30) returning is_published::text$q$), 'true');
select t.check('C 不能新增系列', t.try_as('authenticated', :C, $q$insert into public.collections (slug, name) values ('c-hack', 'x') returning 1$q$), 'ERROR:42501');
select id::text as wife_id from public.collections where slug = 'pamper-wife' \gset
select id::text as daily_id from public.collections where slug = 'sweet-daily' \gset

-- 不同系列可有相同作品編號
select t.check('寵妻 No.001 可與生命共同體 No.001 並存', t.do_as('authenticated', :A, format($q$insert into public.collection_works (collection_id, work_number, nickname, preview_path, original_path, mime_type, file_size, width, height)
  values (%L, 1, '專屬寵妻執行者', 'collections/w/p1.webp', 'collections/w/o1.jpg', 'image/jpeg', 100, 800, 800) returning work_number::text$q$, :'wife_id')), '1');
select t.do_as('authenticated', :A, format($q$insert into public.collection_works (collection_id, work_number, nickname, preview_path, original_path, mime_type, file_size, width, height, is_published)
  values (%L, 2, '鞋帶守護者', 'collections/w/p2.webp', 'collections/w/o2.jpg', 'image/jpeg', 100, 800, 800, true) returning 1$q$, :'wife_id'));
select t.do_as('authenticated', :B, format($q$insert into public.collection_works (collection_id, work_number, nickname, preview_path, original_path, mime_type, file_size, width, height, is_published)
  values (%L, 1, '甜蜜早餐員', 'collections/d/p1.webp', 'collections/d/o1.jpg', 'image/jpeg', 100, 800, 800, true) returning 1$q$, :'daily_id'));
select t.check('同一系列內編號仍不可重複', t.try_as('authenticated', :A, format($q$insert into public.collection_works (collection_id, work_number, nickname) values (%L, 1, '重複') returning 1$q$, :'wife_id')), 'ERROR:23505');

-- 草稿系列訪客看不到
select t.check('草稿系列訪客看不到', t.try_as('anon', null, format('select count(*)::text from public.collections where id = %L', :'wife_id')), '0');
select t.check('草稿系列的已公開作品訪客也看不到', t.try_as('anon', null, format('select count(*)::text from public.collection_works where collection_id = %L', :'wife_id')), '0');
select t.check('公開系列訪客看得到', t.try_as('anon', null, format('select count(*)::text from public.collections where id = %L', :'daily_id')), '1');
select t.check('A 可把寵妻系列設為公開', t.do_as('authenticated', :A, format($q$update public.collections set status = 'published' where id = %L returning is_published::text$q$, :'wife_id')), 'true');
select t.check('只改 is_published=false 時狀態變成下架', t.do_as('authenticated', :A, format($q$update public.collections set is_published = false where id = %L returning status$q$, :'wife_id')), 'archived');
select t.check('下架系列訪客看不到', t.try_as('anon', null, format('select count(*)::text from public.collections where id = %L', :'wife_id')), '0');
select t.do_as('authenticated', :A, format($q$update public.collections set status = 'published' where id = %L returning 1$q$, :'wife_id'));
select t.check('不合法的狀態被拒絕', t.try_as('authenticated', :A, format($q$update public.collections set status = 'deleted' where id = %L returning 1$q$, :'wife_id')), 'ERROR:23514');
select t.check('不合法的收藏卡主題被拒絕', t.try_as('authenticated', :A, format($q$update public.collections set card_theme = 'neon' where id = %L returning 1$q$, :'wife_id')), 'ERROR:23514');

-- 三個系列設定不同密碼（測試用密碼）
\set CLIENT_M '''client-hash-multi-00000000001'''
\set CLIENT_M2 '''client-hash-multi-00000000002'''
select t.do_as('authenticated', :A, format('select public.set_collection_download_password(%L, %L)::text', :'life_id', 'test-life-pw-A'));
select t.check('寵妻系列設定密碼（B 操作）', t.do_as('authenticated', :B, format('select public.set_collection_download_password(%L, %L)->>%L', :'wife_id', 'test-wife-pw-B', 'version')), '1');
select t.check('甜蜜日常設定密碼（A 操作）', t.do_as('authenticated', :A, format('select public.set_collection_download_password(%L, %L)->>%L', :'daily_id', 'test-daily-pw-C', 'version')), '1');
select t.check('A 系列密碼可通過 A 系列', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'life_id', 'test-life-pw-A', :CLIENT_M, 'ok')), 'true');
select t.check('A 系列密碼不能通過 B 系列', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'wife_id', 'test-life-pw-A', :CLIENT_M, 'reason')), 'wrong');
select t.check('B 系列密碼不能通過 C 系列', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'daily_id', 'test-wife-pw-B', :CLIENT_M, 'reason')), 'wrong');
select t.check('C 系列密碼不能通過 A 系列', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'life_id', 'test-daily-pw-C', :CLIENT_M, 'reason')), 'wrong');
select t.check('B 系列密碼通過 B 系列', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'wife_id', 'test-wife-pw-B', :CLIENT_M, 'ok')), 'true');
select t.check('系列密碼不能通過原本收藏館', t.do_as('service_role', null, format('select public.verify_download_password(%L, %L)->>%L', 'test-wife-pw-B', :CLIENT_M2, 'reason')), 'wrong');
select t.check('驗證紀錄記下系列 id', (select count(*)::text from private.download_attempts where collection_id = :'wife_id'::uuid and success), '1');

-- 修改 A 系列密碼不影響 B、C
select (public.collection_download_state(:'wife_id')->>'version') as wife_v0, (public.collection_download_state(:'daily_id')->>'version') as daily_v0 \gset
select t.do_as('authenticated', :B, format('select public.set_collection_download_password(%L, %L)::text', :'life_id', 'test-life-pw-A2'));
select t.check('修改 A 後 B 版本不變', (public.collection_download_state(:'wife_id')->>'version'), :'wife_v0');
select t.check('修改 A 後 C 版本不變', (public.collection_download_state(:'daily_id')->>'version'), :'daily_v0');
select t.check('修改 A 後 B 密碼仍可用', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'wife_id', 'test-wife-pw-B', :CLIENT_M2, 'ok')), 'true');
select t.check('修改 A 後 A 舊密碼失效', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'life_id', 'test-life-pw-A', :CLIENT_M2, 'reason')), 'wrong');

-- 停用 A 系列密碼不影響 B、C
select t.check('C 不能停用系列密碼', t.try_as('authenticated', :C, format('select public.set_collection_download_password_enabled(%L, false)::text', :'life_id')), 'ERROR:42501');
select (public.collection_download_state(:'life_id')->>'version')::int as life_v_before \gset
select t.check('A 可停用 A 系列密碼', t.do_as('authenticated', :A, format('select public.set_collection_download_password_enabled(%L, false)->>%L', :'life_id', 'is_enabled')), 'false');
select t.check('停用時版本 +1（舊授權立即失效）', ((public.collection_download_state(:'life_id')->>'version')::int - :life_v_before)::text, '1');
select t.check('停用後下載狀態 enabled=false', (public.collection_download_state(:'life_id')->>'enabled'), 'false');
select t.check('停用後正確密碼也無法驗證', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'life_id', 'test-life-pw-A2', :CLIENT_M2, 'reason')), 'disabled');
select t.check('停用 A 不影響 B', (public.collection_download_state(:'wife_id')->>'enabled'), 'true');
select t.check('停用 A 不影響 C', (public.collection_download_state(:'daily_id')->>'enabled'), 'true');
select t.check('B 可重新啟用 A 系列密碼', t.do_as('authenticated', :B, format('select public.set_collection_download_password_enabled(%L, true)->>%L', :'life_id', 'is_enabled')), 'true');
select t.check('重新啟用後密碼可用', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'life_id', 'test-life-pw-A2', :CLIENT_M2, 'ok')), 'true');

-- 系列下載開關
select t.do_as('authenticated', :A, format('update public.collections set download_enabled = false where id = %L returning 1', :'daily_id'));
select t.check('系列關閉下載後 enabled=false', (public.collection_download_state(:'daily_id')->>'enabled'), 'false');
select t.check('系列關閉下載後無法驗證', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'daily_id', 'test-daily-pw-C', :CLIENT_M2, 'reason')), 'disabled');
select t.check('C 系列關閉下載不影響 B', (public.collection_download_state(:'wife_id')->>'enabled'), 'true');
select t.do_as('authenticated', :A, format('update public.collections set download_enabled = true where id = %L returning 1', :'daily_id'));
-- 草稿／下架系列不能驗證
select t.do_as('authenticated', :A, format($q$update public.collections set status = 'draft' where id = %L returning 1$q$, :'daily_id'));
select t.check('草稿系列無法驗證密碼', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'daily_id', 'test-daily-pw-C', :CLIENT_M2, 'reason')), 'not_available');
select t.check('草稿系列下載狀態 enabled=false', (public.collection_download_state(:'daily_id')->>'enabled'), 'false');
select t.do_as('authenticated', :A, format($q$update public.collections set status = 'published' where id = %L returning 1$q$, :'daily_id'));

-- 重新產生密碼
select t.check('C 不能重新產生密碼', t.try_as('authenticated', :C, format('select public.regenerate_collection_download_password(%L)::text', :'wife_id')), 'ERROR:42501');
select t.check('訪客不能重新產生密碼', t.try_as('anon', null, format('select public.regenerate_collection_download_password(%L)::text', :'wife_id')), 'ERROR:42501');
select public.collection_download_state(:'wife_id')->>'version' as wife_v1 \gset
select t.do_as('authenticated', :A, format('select set_config(%L, public.regenerate_collection_download_password(%L)->>%L, false)', 'kuma.test_pw', :'wife_id', 'password'));
select t.check_like('重新產生的密碼格式 xxxx-xxxx-xxxx', current_setting('kuma.test_pw'), '____-____-____');
select t.check('重新產生後版本 +1', ((public.collection_download_state(:'wife_id')->>'version')::int - :'wife_v1'::int)::text, '1');
select t.check('重新產生的密碼可通過驗證', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'wife_id', current_setting('kuma.test_pw'), :CLIENT_M2, 'ok')), 'true');
select t.check('重新產生後舊密碼失效', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'wife_id', 'test-wife-pw-B', :CLIENT_M2, 'reason')), 'wrong');
select t.check('資料庫不存明文密碼', (select (password_hash like '$2%' and password_hash <> current_setting('kuma.test_pw'))::text from private.collection_download_secret where collection_id = :'wife_id'::uuid), 'true');

-- 立即撤銷
select public.collection_download_state(:'wife_id')->>'version' as wife_v2 \gset
select t.check('C 不能撤銷密碼', t.try_as('authenticated', :C, format('select public.revoke_collection_download_password(%L)::text', :'wife_id')), 'ERROR:42501');
select t.do_as('authenticated', :B, format('select public.revoke_collection_download_password(%L)::text', :'wife_id'));
select t.check('撤銷後狀態為未設定', t.try_as('authenticated', :A, format('select public.collection_download_password_status(%L)->>%L', :'wife_id', 'configured')), 'false');
select t.check('撤銷後版本仍增加（舊授權不會復活）', ((public.collection_download_state(:'wife_id')->>'version')::int - :'wife_v2'::int)::text, '1');
select t.check('撤銷後無法驗證', t.do_as('service_role', null, format('select public.verify_collection_download_password(%L, %L, %L)->>%L', :'wife_id', current_setting('kuma.test_pw'), :CLIENT_M2, 'reason')), 'not_configured');
select t.check('撤銷後不能直接停用（沒有密碼）', t.try_as('authenticated', :A, format('select public.set_collection_download_password_enabled(%L, false)::text', :'wife_id')), 'ERROR:22023');
select t.check('撤銷後重新設定，版本繼續往上', t.do_as('authenticated', :A, format('select (public.set_collection_download_password(%L, %L)->>%L)::int > %s', :'wife_id', 'test-wife-pw-B2', 'version', :'wife_v2')), 'true');

-- 總覽與管理紀錄
select t.check('C 不能讀系列總覽', t.try_as('authenticated', :C, 'select count(*)::text from public.admin_collection_overview()'), 'ERROR:42501');
select t.check('A 可讀系列總覽（3 個系列）', t.try_as('authenticated', :A, 'select count(*)::text from public.admin_collection_overview()'), '3');
select t.check('總覽：寵妻系列 2 款作品、1 款公開、密碼已設定', t.try_as('authenticated', :A, format('select work_count || %L || published_count || %L || password_configured from public.admin_collection_overview() where collection_id = %L', '/', '/', :'wife_id')), '2/1/true');
select t.check('管理紀錄：有系列建立紀錄（含操作者名稱）', (select actor_name from public.admin_audit_log where action = 'collection.create' and collection_id = :'wife_id'::uuid), '管理員 A');
select t.check('管理紀錄：密碼變更有紀錄', (select (count(*) >= 3)::text from public.admin_audit_log where action like 'password.%' and collection_id = :'wife_id'::uuid), 'true');
select t.check('管理紀錄不含密碼內容', (select count(*)::text from public.admin_audit_log where detail::text like '%test-wife-pw%' or detail::text like '%' || current_setting('kuma.test_pw') || '%'), '0');
select t.check('訪客看不到管理紀錄', t.try_as('anon', null, 'select count(*)::text from public.admin_audit_log'), 'ERROR:42501');
select t.check('C 看不到管理紀錄', t.try_as('authenticated', :C, 'select count(*)::text from public.admin_audit_log'), '0');
select t.check('管理員不能竄改管理紀錄', t.try_as('authenticated', :A, 'delete from public.admin_audit_log where true returning 1'), 'ERROR:42501');
select t.check('管理員不能偽造管理紀錄', t.try_as('authenticated', :A, $q$insert into public.admin_audit_log (action) values ('fake') returning 1$q$), 'ERROR:42501');

-- 大頭貼版照片
select t.check('作品可加上大頭貼版照片', t.do_as('authenticated', :A, format($q$with u as (update public.collection_works set avatar_preview_path = 'collections/w/a1.webp', avatar_original_path = 'collections/w/a1.png', avatar_mime_type = 'image/png', avatar_file_size = 50, avatar_width = 1920, avatar_height = 1920 where collection_id = %L and work_number = 2 returning 1) select count(*)::text from u$q$, :'wife_id')), '1');
select t.check('大頭貼版欄位必須完整', t.try_as('authenticated', :A, format($q$update public.collection_works set avatar_preview_path = 'x' where collection_id = %L and work_number = 1 returning 1$q$, :'wife_id')), 'ERROR:23514');
select t.check('訪客可讀大頭貼版預覽', t.try_as('anon', null, format('select avatar_preview_path from public.collection_works where collection_id = %L and work_number = 2', :'wife_id')), 'collections/w/a1.webp');
select t.check('訪客不能讀大頭貼版原圖路徑', t.try_as('anon', null, 'select avatar_original_path from public.collection_works limit 1'), 'ERROR:42501');

-- 額外大頭貼（每款作品可有多張）
select t.check('可替已公開作品加上額外大頭貼', t.do_as('authenticated', :A, format($q$insert into public.collection_work_avatars (work_id, sort_order, preview_path, original_path, mime_type, file_size, width, height) select id, 10, 'collections/w/e2.webp', 'collections/w/e2.jpg', 'image/jpeg', 40, 1920, 1920 from public.collection_works where collection_id = %L and work_number = 2 returning 1$q$, :'wife_id')), '1');
select t.check('可替草稿作品加上額外大頭貼', t.do_as('authenticated', :B, format($q$insert into public.collection_work_avatars (work_id, sort_order, preview_path, original_path, mime_type, file_size, width, height) select id, 10, 'collections/w/e1.webp', 'collections/w/e1.jpg', 'image/jpeg', 40, 1920, 1920 from public.collection_works where collection_id = %L and work_number = 1 returning 1$q$, :'wife_id')), '1');
select t.check('額外大頭貼格式受限制', t.try_as('authenticated', :A, format($q$insert into public.collection_work_avatars (work_id, preview_path, original_path, mime_type, file_size, width, height) select id, 'x', 'y', 'image/gif', 1, 1, 1 from public.collection_works where collection_id = %L and work_number = 2 returning 1$q$, :'wife_id')), 'ERROR:23514');
select t.check('C 不能新增額外大頭貼', t.try_as('authenticated', :C, format($q$insert into public.collection_work_avatars (work_id, preview_path, original_path, mime_type, file_size, width, height) select id, 'x', 'y', 'image/png', 1, 1, 1 from public.collection_works where collection_id = %L and work_number = 2 returning 1$q$, :'wife_id')), 'ERROR:42501');
select t.check('訪客可讀已公開作品的額外大頭貼預覽', t.try_as('anon', null, $q$select string_agg(preview_path, ',') from public.collection_work_avatars$q$), 'collections/w/e2.webp');
select t.check('訪客不能讀額外大頭貼原圖路徑', t.try_as('anon', null, 'select original_path from public.collection_work_avatars limit 1'), 'ERROR:42501');
select t.check('訪客不能新增額外大頭貼', t.try_as('anon', null, $q$insert into public.collection_work_avatars (work_id, preview_path, original_path, mime_type, file_size, width, height) select id, 'x', 'y', 'image/png', 1, 1, 1 from public.collection_works limit 1 returning 1$q$), 'ERROR:42501');
select t.check('C 也只看得到已公開作品的額外大頭貼', t.try_as('authenticated', :C, 'select count(*)::text from public.collection_work_avatars'), '1');
select t.check('新增額外大頭貼有管理紀錄', (select count(*)::text from public.admin_audit_log where action = 'work.avatar_add' and collection_id = :'wife_id'::uuid), '2');

-- 安全刪除系列
select t.check('名稱不符時不能刪除', t.try_as('authenticated', :A, format('select public.delete_collection(%L, %L, null, %L)::text', :'daily_id', 'delete', '錯的名字')), 'ERROR:22023');
select t.check('C 不能刪除系列', t.try_as('authenticated', :C, format('select public.delete_collection(%L, %L, null, %L)::text', :'daily_id', 'delete', '熊兔甜蜜日常')), 'ERROR:42501');
select t.check('移動模式必須選目標系列', t.try_as('authenticated', :A, format('select public.delete_collection(%L, %L, null, %L)::text', :'daily_id', 'move', '熊兔甜蜜日常')), 'ERROR:22023');
select t.check('刪除甜蜜日常並把作品移到寵妻系列', t.do_as('authenticated', :A, format('select public.delete_collection(%L, %L, %L, %L)->>%L', :'daily_id', 'move', :'wife_id', '熊兔甜蜜日常', 'moved')), '1');
select t.check('移入的作品編號自動接在後面（不與 No.001 衝突）', (select string_agg(work_number::text || ':' || nickname || ':' || is_published::text, ',' order by work_number) from public.collection_works where collection_id = :'wife_id'::uuid), '1:專屬寵妻執行者:false,2:鞋帶守護者:true,3:甜蜜早餐員:false');
select t.check('被刪除系列的密碼一併刪除', (select count(*)::text from private.collection_download_secret where collection_id = :'daily_id'::uuid), '0');
select t.check('刪除有管理紀錄', (select detail->>'mode' from public.admin_audit_log where action = 'collection.delete' and collection_id = :'daily_id'::uuid), 'move');
select t.check('連同作品刪除會回傳要清除的檔案', t.do_as('authenticated', :B, format('select jsonb_array_length(public.delete_collection(%L, %L, null, %L)->%L)::text', :'wife_id', 'delete', '熊大寵妻系列', 'originals')), '6');
select t.check('作品刪除時額外大頭貼一併刪除', (select count(*)::text from public.collection_work_avatars), '0');
select t.check('連同作品刪除後作品不存在', (select count(*)::text from public.collection_works where collection_id = :'wife_id'::uuid), '0');
select t.check('生命共同體不受影響', (select count(*)::text from public.collections where slug = 'one-heart-one-life'), '1');

do $$ begin raise notice '=== 全部權限測試通過 ==='; end $$;
