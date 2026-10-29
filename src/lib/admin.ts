// 管理後臺資料操作：所有寫入都直接受資料庫 RLS 與 Storage 政策保護（非管理員會被伺服器拒絕）
import { supabase } from "./supabase";
import { extFromMime } from "./filename";
import { prepareImage } from "./imageProcessing";
import type { AdminImage, AdminUser, Category, SiteSettings } from "./types";
import { SETTINGS_COLUMNS } from "./api";

function fail(prefix: string, error: { message?: string; code?: string } | null): never {
  const code = error?.code;
  if (code === "42501" || /row-level security|permission denied|Unauthorized/i.test(error?.message ?? "")) {
    throw new Error(`${prefix}：沒有管理權限。`);
  }
  if (code === "23505") throw new Error(`${prefix}：名稱重複。`);
  throw new Error(`${prefix}：${error?.message ?? "未知錯誤"}`);
}

export async function checkIsAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_admin");
  if (error) return false;
  return data === true;
}

export async function listAdminImages(): Promise<AdminImage[]> {
  const { data, error } = await supabase
    .from("images")
    .select("*")
    .order("sort_order")
    .order("created_at", { ascending: false });
  if (error) fail("讀取作品失敗", error);
  return data as AdminImage[];
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function uploadPair(id: string, file: File) {
  const prepared = await prepareImage(file);
  const s = stamp();
  const originalPath = `${id}/${s}-original.${extFromMime(file.type)}`;
  const previewPath = `${id}/${s}-preview.${prepared.previewExt}`;
  const up1 = await supabase.storage.from("originals").upload(originalPath, file, { contentType: file.type, upsert: false });
  if (up1.error) fail("原圖上傳失敗", { message: up1.error.message });
  const up2 = await supabase.storage
    .from("previews")
    .upload(previewPath, prepared.preview, { contentType: prepared.preview.type, upsert: false, cacheControl: "31536000" });
  if (up2.error) {
    await supabase.storage.from("originals").remove([originalPath]);
    fail("預覽圖上傳失敗", { message: up2.error.message });
  }
  return { prepared, originalPath, previewPath };
}

export async function uploadNewImage(
  file: File,
  meta: { title: string; category_id: string | null; sort_order: number; is_monthly: boolean },
): Promise<AdminImage> {
  const id = crypto.randomUUID();
  const { prepared, originalPath, previewPath } = await uploadPair(id, file);
  const { data, error } = await supabase
    .from("images")
    .insert({
      id,
      title: meta.title,
      category_id: meta.category_id,
      sort_order: meta.sort_order,
      is_monthly: meta.is_monthly,
      preview_path: previewPath,
      original_path: originalPath,
      mime_type: file.type,
      file_size: file.size,
      width: prepared.width,
      height: prepared.height,
      is_published: false,
    })
    .select("*")
    .single();
  if (error) {
    await removeFiles(previewPath, originalPath);
    fail("建立作品資料失敗", error);
  }
  return data as AdminImage;
}

export async function replaceImageFile(image: AdminImage, file: File): Promise<AdminImage> {
  const { prepared, originalPath, previewPath } = await uploadPair(image.id, file);
  const { data, error } = await supabase
    .from("images")
    .update({
      preview_path: previewPath,
      original_path: originalPath,
      mime_type: file.type,
      file_size: file.size,
      width: prepared.width,
      height: prepared.height,
    })
    .eq("id", image.id)
    .select("*")
    .single();
  if (error) {
    await removeFiles(previewPath, originalPath);
    fail("替換失敗", error);
  }
  await removeFiles(image.preview_path, image.original_path);
  return data as AdminImage;
}

async function removeFiles(previewPath: string, originalPath: string) {
  await Promise.all([
    supabase.storage.from("previews").remove([previewPath]),
    supabase.storage.from("originals").remove([originalPath]),
  ]);
}

export async function deleteImage(image: AdminImage) {
  const { error } = await supabase.from("images").delete().eq("id", image.id);
  if (error) fail("刪除失敗", error);
  await removeFiles(image.preview_path, image.original_path);
}

export async function updateImage(id: string, patch: Partial<AdminImage>): Promise<AdminImage> {
  const { data, error } = await supabase.from("images").update(patch).eq("id", id).select("*").single();
  if (error) fail("儲存失敗", error);
  if (!data) throw new Error("儲存失敗：沒有管理權限。");
  return data as AdminImage;
}

export async function saveOrder(items: { id: string; sort_order: number }[]) {
  for (const it of items) {
    const { error } = await supabase.from("images").update({ sort_order: it.sort_order }).eq("id", it.id);
    if (error) fail("排序儲存失敗", error);
  }
}

export function adminPreviewUrl(path: string) {
  return supabase.storage.from("previews").getPublicUrl(path).data.publicUrl;
}

// ---- 分類 ----
export async function listCategories(): Promise<Category[]> {
  const { data, error } = await supabase.from("categories").select("id,name,sort_order").order("sort_order").order("name");
  if (error) fail("讀取分類失敗", error);
  return data as Category[];
}

export async function createCategory(name: string, sort_order: number) {
  const { error } = await supabase.from("categories").insert({ name: name.trim(), sort_order });
  if (error) fail("新增分類失敗", error);
}

export async function updateCategory(id: string, patch: Partial<Category>) {
  const { data, error } = await supabase.from("categories").update(patch).eq("id", id).select("id");
  if (error) fail("修改分類失敗", error);
  if (!data?.length) throw new Error("修改分類失敗：沒有管理權限。");
}

export async function deleteCategory(id: string) {
  const { data, error } = await supabase.from("categories").delete().eq("id", id).select("id");
  if (error) fail("刪除分類失敗", error);
  if (!data?.length) throw new Error("刪除分類失敗：沒有管理權限。");
}

// ---- 網站設定 ----
export async function getSettings(): Promise<SiteSettings> {
  const { data, error } = await supabase.from("site_settings").select(SETTINGS_COLUMNS).eq("id", 1).single();
  if (error) fail("讀取設定失敗", error);
  return data as SiteSettings;
}

export async function saveSettings(patch: Partial<SiteSettings>) {
  const { data: u } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("site_settings")
    .update({ ...patch, updated_by: u.user?.id ?? null })
    .eq("id", 1)
    .select("site_name");
  if (error) fail("儲存設定失敗", error);
  if (!data?.length) throw new Error("儲存設定失敗：沒有管理權限。");
}

export async function setDownloadPassword(pw: string) {
  const { error } = await supabase.rpc("set_download_password", { p_new_password: pw });
  if (error) fail("更換下載密碼失敗", error);
}

export interface PasswordStatus {
  configured: boolean;
  version: number;
  updated_at: string | null;
  updated_by_name: string | null;
}

export async function getPasswordStatus(): Promise<PasswordStatus> {
  const { data, error } = await supabase.rpc("download_password_status");
  if (error) fail("讀取密碼狀態失敗", error);
  return data as PasswordStatus;
}

export async function listAdmins(): Promise<AdminUser[]> {
  const { data, error } = await supabase.from("admins").select("*").order("created_at");
  if (error) fail("讀取管理員名單失敗", error);
  return data as AdminUser[];
}

/** 發布：把選取的草稿設為公開，並可同時更新網站「最新更新日期」 */
export async function publishImages(ids: string[], updateDate: boolean) {
  if (ids.length > 0) {
    const { error } = await supabase.from("images").update({ is_published: true }).in("id", ids);
    if (error) fail("發布失敗", error);
  }
  if (updateDate) {
    const today = new Date();
    const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    await saveSettings({ latest_update_date: d });
  }
}
