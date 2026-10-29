-- =====================================================================
-- 修正：更換下載密碼時出現「DELETE requires a WHERE clause」
-- Supabase 對 API 角色啟用 pg_safeupdate，不帶 WHERE 的 DELETE 會被拒絕。
-- 已執行過初始 migration 的專案，請在 SQL Editor 執行本檔一次（可重複執行）。
-- =====================================================================

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
  -- （Supabase 啟用 pg_safeupdate，不帶 WHERE 的 DELETE 會被拒絕，因此寫明 where true）
  delete from private.download_attempts where true;

  return jsonb_build_object('ok', true, 'version', v_version);
end;
$$;
