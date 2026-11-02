// 管理後臺：KUMA STUDIO 多系列（collections）資料操作。
// 寫入都受資料庫 RLS、RPC 與 Storage 政策保護，只有兩位授權管理員能成功。
import { supabase } from "./supabase";
import { fail, removeFiles, uploadPair } from "./admin";
import { COLLECTION_COLUMNS, LIFE_SLUG } from "./api";
import { prepareImage } from "./imageProcessing";
import { sanitizeZones } from "./protect";
import type { AdminCollectionWork, AuditEntry, Collection, CollectionOverview } from "./types";

function lifeFail(prefix: string, error: { message?: string; code?: string } | null): never {
  if (error?.code === "23505" && /slug/.test(error.message ?? "")) throw new Error(`${prefix}：網址代稱已被其他系列使用，請換一個。`);
  if (error?.code === "23505") throw new Error(`${prefix}：作品編號重複，請換一個編號。`);
  if (error?.code === "23514" && /slug/.test(error.message ?? "")) throw new Error(`${prefix}：網址代稱只能用小寫英文、數字與「-」，2～41 字。`);
  if (error?.code === "23514" && /publish_needs_photo/.test(error.message ?? "")) {
    throw new Error(`${prefix}：這款作品還沒上傳照片，不能公開。`);
  }
  fail(prefix, error);
}

function normalize(w: AdminCollectionWork): AdminCollectionWork {
  return { ...w, protect_zones: sanitizeZones(w.protect_zones) };
}

// ---------------- 系列 ----------------
export async function listCollections(): Promise<Collection[]> {
  const { data, error } = await supabase.from("collections").select(COLLECTION_COLUMNS).order("sort_order").order("created_at");
  if (error) {
    if (/status|card_theme|download_enabled/.test(error.message ?? "")) {
      throw new Error("讀取系列失敗：請先在 Supabase SQL Editor 執行 supabase/migrations/20261103000000_kuma_studio_collections.sql。");
    }
    lifeFail("讀取系列失敗", error);
  }
  return data as Collection[];
}

export async function getCollection(id: string): Promise<Collection | null> {
  const { data, error } = await supabase.from("collections").select(COLLECTION_COLUMNS).eq("id", id).maybeSingle();
  if (error) lifeFail("讀取系列失敗", error);
  return (data as Collection) ?? null;
}

export async function getLifeCollection(): Promise<Collection | null> {
  const { data, error } = await supabase.from("collections").select(COLLECTION_COLUMNS).eq("slug", LIFE_SLUG).maybeSingle();
  if (error) lifeFail("讀取系列失敗", error);
  return (data as Collection) ?? null;
}

/** 由英文名稱產生網址代稱；沒有英文時用 series-時間碼 */
export function slugify(nameEn: string): string {
  const s = nameEn
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s.length >= 2 ? s : `series-${Date.now().toString(36)}`;
}

export type NewCollection = Pick<Collection, "name" | "slug"> & Partial<Collection>;

export async function createCollection(fields: NewCollection): Promise<Collection> {
  const { data, error } = await supabase
    .from("collections")
    .insert({ status: "draft", ...fields })
    .select(COLLECTION_COLUMNS)
    .single();
  if (error) lifeFail("新增系列失敗", error);
  return data as Collection;
}

/** 系列管理中心的統計：作品數、公開數、密碼狀態、近 48 小時下載驗證 */
export async function getOverview(): Promise<Map<string, CollectionOverview>> {
  const { data, error } = await supabase.rpc("admin_collection_overview");
  if (error) lifeFail("讀取系列統計失敗", error);
  return new Map((data as CollectionOverview[]).map((o) => [o.collection_id, o]));
}

/** 上傳系列封面或主視覺（只存公開預覽尺寸，最長邊 1200px） */
export async function setCollectionImage(collection: Collection, kind: "cover" | "hero", file: File): Promise<Collection> {
  const prepared = await prepareImage(file);
  const path = `collections/${collection.id}/${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${prepared.previewExt}`;
  const up = await supabase.storage.from("previews").upload(path, prepared.preview, { contentType: prepared.preview.type, upsert: false, cacheControl: "31536000" });
  if (up.error) fail("圖片上傳失敗", { message: up.error.message });
  const column = kind === "cover" ? "cover_path" : "hero_path";
  const { data, error } = await supabase.from("collections").update({ [column]: path }).eq("id", collection.id).select(COLLECTION_COLUMNS).single();
  if (error || !data) {
    await supabase.storage.from("previews").remove([path]);
    lifeFail("圖片儲存失敗", error);
  }
  const old = collection[column];
  if (old) await supabase.storage.from("previews").remove([old]);
  return data as Collection;
}

export async function removeCollectionImage(collection: Collection, kind: "cover" | "hero"): Promise<Collection> {
  const column = kind === "cover" ? "cover_path" : "hero_path";
  const { data, error } = await supabase.from("collections").update({ [column]: null }).eq("id", collection.id).select(COLLECTION_COLUMNS).single();
  if (error) lifeFail("移除圖片失敗", error);
  const old = collection[column];
  if (old) await supabase.storage.from("previews").remove([old]);
  return data as Collection;
}

/**
 * 刪除系列：mode "move" 把作品移到另一個系列（移過去都先設為草稿），"delete" 連同作品與照片一起刪除。
 * confirmName 必須與系列名稱完全相同（資料庫端再檢查一次）。
 */
export async function deleteCollection(collection: Collection, mode: "move" | "delete", targetId: string | null, confirmName: string) {
  const { data, error } = await supabase.rpc("delete_collection", {
    p_collection_id: collection.id,
    p_mode: mode,
    p_target: targetId,
    p_confirm_name: confirmName,
  });
  if (error) lifeFail("刪除系列失敗", error);
  const r = data as { moved: number; deleted_works: number; previews: string[]; originals: string[] };
  if (r.previews.length) await supabase.storage.from("previews").remove(r.previews);
  if (r.originals.length) await supabase.storage.from("originals").remove(r.originals);
  return r;
}

export async function listAuditLog(limit = 100, collectionId?: string): Promise<AuditEntry[]> {
  let q = supabase.from("admin_audit_log").select("id,created_at,actor_name,action,collection_id,target,detail").order("created_at", { ascending: false });
  if (collectionId) q = q.eq("collection_id", collectionId);
  const { data, error } = await q.limit(limit);
  if (error) lifeFail("讀取管理紀錄失敗", error);
  return data as AuditEntry[];
}

export async function updateCollection(id: string, patch: Partial<Collection>): Promise<Collection> {
  const { data, error } = await supabase.from("collections").update(patch).eq("id", id).select(COLLECTION_COLUMNS).single();
  if (error) lifeFail("儲存系列失敗", error);
  return data as Collection;
}

export async function listWorks(collectionId: string): Promise<AdminCollectionWork[]> {
  const { data, error } = await supabase
    .from("collection_works")
    .select("*")
    .eq("collection_id", collectionId)
    .order("sort_order")
    .order("work_number");
  if (error) lifeFail("讀取系列作品失敗", error);
  return (data as AdminCollectionWork[]).map(normalize);
}

export async function createWork(
  collectionId: string,
  fields: Pick<AdminCollectionWork, "work_number" | "nickname"> & Partial<AdminCollectionWork>,
): Promise<AdminCollectionWork> {
  const { data, error } = await supabase
    .from("collection_works")
    .insert({ collection_id: collectionId, is_published: false, ...fields })
    .select("*")
    .single();
  if (error) lifeFail("新增作品失敗", error);
  return normalize(data as AdminCollectionWork);
}

export async function updateWork(id: string, patch: Partial<AdminCollectionWork>): Promise<AdminCollectionWork> {
  const { data, error } = await supabase.from("collection_works").update(patch).eq("id", id).select("*").single();
  if (error) lifeFail("儲存失敗", error);
  if (!data) throw new Error("儲存失敗：沒有管理權限。");
  return normalize(data as AdminCollectionWork);
}

/** 上傳或替換某一款的照片：原圖原封不動存到私有空間，另存公開預覽圖；舊檔案在資料更新成功後才刪除 */
export async function setWorkPhoto(work: AdminCollectionWork, file: File): Promise<AdminCollectionWork> {
  // 新上傳的照片放在 collections/<系列 id>/<作品 id>/；舊路徑（life/...）的照片不受影響
  const { prepared, originalPath, previewPath } = await uploadPair(work.id, file, "original", `collections/${work.collection_id}/`);
  const { data, error } = await supabase
    .from("collection_works")
    .update({
      preview_path: previewPath,
      original_path: originalPath,
      mime_type: file.type,
      file_size: file.size,
      width: prepared.width,
      height: prepared.height,
    })
    .eq("id", work.id)
    .select("*")
    .single();
  if (error || !data) {
    await removeFiles(previewPath, originalPath);
    lifeFail("照片上傳失敗", error);
  }
  if (work.preview_path && work.original_path) await removeFiles(work.preview_path, work.original_path);
  return normalize(data as AdminCollectionWork);
}

/** 上傳或替換大頭貼版（同一場景另外構圖的方形大頭貼；原檔原封不動存到私有空間） */
export async function setWorkAvatar(work: AdminCollectionWork, file: File): Promise<AdminCollectionWork> {
  const { prepared, originalPath, previewPath } = await uploadPair(work.id, file, "avatar", `collections/${work.collection_id}/`);
  const { data, error } = await supabase
    .from("collection_works")
    .update({
      avatar_preview_path: previewPath,
      avatar_original_path: originalPath,
      avatar_mime_type: file.type,
      avatar_file_size: file.size,
      avatar_width: prepared.width,
      avatar_height: prepared.height,
    })
    .eq("id", work.id)
    .select("*")
    .single();
  if (error || !data) {
    await removeFiles(previewPath, originalPath);
    lifeFail("大頭貼版上傳失敗", error);
  }
  if (work.avatar_preview_path && work.avatar_original_path) await removeFiles(work.avatar_preview_path, work.avatar_original_path);
  return normalize(data as AdminCollectionWork);
}

export async function removeWorkAvatar(work: AdminCollectionWork): Promise<AdminCollectionWork> {
  const { data, error } = await supabase
    .from("collection_works")
    .update({ avatar_preview_path: null, avatar_original_path: null, avatar_mime_type: null, avatar_file_size: null, avatar_width: null, avatar_height: null })
    .eq("id", work.id)
    .select("*")
    .single();
  if (error) lifeFail("移除大頭貼版失敗", error);
  if (work.avatar_preview_path && work.avatar_original_path) await removeFiles(work.avatar_preview_path, work.avatar_original_path);
  return normalize(data as AdminCollectionWork);
}

export async function deleteWork(work: AdminCollectionWork) {
  const { data, error } = await supabase.from("collection_works").delete().eq("id", work.id).select("id");
  if (error) lifeFail("刪除失敗", error);
  if (!data?.length) throw new Error("刪除失敗：沒有管理權限。");
  if (work.preview_path && work.original_path) await removeFiles(work.preview_path, work.original_path);
  if (work.avatar_preview_path && work.avatar_original_path) await removeFiles(work.avatar_preview_path, work.avatar_original_path);
}

export async function saveWorkOrder(items: { id: string; sort_order: number }[]) {
  for (const it of items) {
    const { error } = await supabase.from("collection_works").update({ sort_order: it.sort_order }).eq("id", it.id);
    if (error) lifeFail("排序儲存失敗", error);
  }
}

export interface CollectionPasswordStatus {
  configured: boolean;
  /** 密碼是否啟用（停用時粉絲無法下載，已發出的授權也立即失效） */
  is_enabled: boolean;
  version: number;
  updated_at: string | null;
  revoked_at: string | null;
  updated_by_name: string | null;
}

/** 系列專屬下載密碼狀態（不回傳密碼或雜湊） */
export async function getCollectionPasswordStatus(collectionId: string): Promise<CollectionPasswordStatus> {
  const { data, error } = await supabase.rpc("collection_download_password_status", { p_collection_id: collectionId });
  if (error) {
    if (error.code === "PGRST202" || /collection_download_password_status/.test(error.message ?? "")) {
      throw new Error("讀取專屬密碼狀態失敗：請先在 Supabase SQL Editor 執行 supabase/migrations/20261102000000_collection_download_password.sql。");
    }
    fail("讀取專屬密碼狀態失敗", error);
  }
  return data as CollectionPasswordStatus;
}

/** 設定或更換系列專屬下載密碼（伺服器端以 bcrypt 雜湊後儲存） */
export async function setCollectionPassword(collectionId: string, pw: string) {
  const { error } = await supabase.rpc("set_collection_download_password", { p_collection_id: collectionId, p_new_password: pw });
  if (error) fail("設定專屬下載密碼失敗", error);
}

/** 重新產生密碼：由伺服器產生隨機密碼，只在這次回傳（請立即複製給粉絲） */
export async function regenerateCollectionPassword(collectionId: string): Promise<string> {
  const { data, error } = await supabase.rpc("regenerate_collection_download_password", { p_collection_id: collectionId });
  if (error) fail("重新產生下載密碼失敗", error);
  return (data as { password: string }).password;
}

/** 停用／重新啟用系列下載密碼 */
export async function setCollectionPasswordEnabled(collectionId: string, enabled: boolean) {
  const { error } = await supabase.rpc("set_collection_download_password_enabled", { p_collection_id: collectionId, p_enabled: enabled });
  if (error) fail(enabled ? "啟用下載密碼失敗" : "停用下載密碼失敗", error);
}

/** 立即撤銷：清除密碼並讓所有已發出的授權失效 */
export async function revokeCollectionPassword(collectionId: string) {
  const { error } = await supabase.rpc("revoke_collection_download_password", { p_collection_id: collectionId });
  if (error) fail("撤銷下載密碼失敗", error);
}
