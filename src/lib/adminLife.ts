// 管理後臺：熊兔生命共同體（主題系列）資料操作。
// 寫入都受資料庫 RLS 與 Storage 政策保護，只有兩位授權管理員能成功。
import { supabase } from "./supabase";
import { fail, removeFiles, uploadPair } from "./admin";
import { LIFE_SLUG } from "./api";
import { sanitizeZones } from "./protect";
import type { AdminCollectionWork, Collection } from "./types";

function lifeFail(prefix: string, error: { message?: string; code?: string } | null): never {
  if (error?.code === "23505") throw new Error(`${prefix}：作品編號重複，請換一個編號。`);
  if (error?.code === "23514" && /publish_needs_photo/.test(error.message ?? "")) {
    throw new Error(`${prefix}：這款作品還沒上傳照片，不能公開。`);
  }
  fail(prefix, error);
}

function normalize(w: AdminCollectionWork): AdminCollectionWork {
  return { ...w, protect_zones: sanitizeZones(w.protect_zones) };
}

export async function getLifeCollection(): Promise<Collection | null> {
  const { data, error } = await supabase.from("collections").select("*").eq("slug", LIFE_SLUG).maybeSingle();
  if (error) lifeFail("讀取系列失敗", error);
  return (data as Collection) ?? null;
}

export async function updateCollection(id: string, patch: Partial<Collection>): Promise<Collection> {
  const { data, error } = await supabase.from("collections").update(patch).eq("id", id).select("*").single();
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
  const { prepared, originalPath, previewPath } = await uploadPair(work.id, file, "original", "life/");
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

export async function deleteWork(work: AdminCollectionWork) {
  const { data, error } = await supabase.from("collection_works").delete().eq("id", work.id).select("id");
  if (error) lifeFail("刪除失敗", error);
  if (!data?.length) throw new Error("刪除失敗：沒有管理權限。");
  if (work.preview_path && work.original_path) await removeFiles(work.preview_path, work.original_path);
}

export async function saveWorkOrder(items: { id: string; sort_order: number }[]) {
  for (const it of items) {
    const { error } = await supabase.from("collection_works").update({ sort_order: it.sort_order }).eq("id", it.id);
    if (error) lifeFail("排序儲存失敗", error);
  }
}
