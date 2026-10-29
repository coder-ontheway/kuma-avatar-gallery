-- =====================================================================
-- 登記兩位授權管理員（請在 Supabase Dashboard → SQL Editor 執行）
--
-- 先在 Authentication → Users 建立兩個帳號，複製各自的 User UID（UUID），
-- 取代下方的 <管理員A的UUID>、<管理員B的UUID> 後再執行。
-- 本檔案不含任何密碼；管理員密碼只存在 Supabase Auth。
-- =====================================================================

insert into public.admins (user_id, display_name) values
  ('<管理員A的UUID>', '管理員 A'),
  ('<管理員B的UUID>', '管理員 B');

-- 確認結果（應看到 2 列，is_active = true）
select a.display_name, a.is_active, u.email
  from public.admins a join auth.users u on u.id = a.user_id;


-- ---------------------------------------------------------------------
-- 【需要時才執行】撤銷某位管理員的權限（立即生效，不必等對方登出）
-- ---------------------------------------------------------------------
-- update public.admins set is_active = false where user_id = '<要撤銷的UUID>';
--
-- 重新啟用：
-- update public.admins set is_active = true where user_id = '<UUID>';
--
-- 更換管理員（例如換一個新帳號）：先停用舊的，再新增新的（資料庫限制最多 2 位有效管理員）
-- update public.admins set is_active = false where user_id = '<舊UUID>';
-- insert into public.admins (user_id, display_name) values ('<新UUID>', '新管理員');
