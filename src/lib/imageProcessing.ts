// 管理後臺：上傳前在瀏覽器產生公開預覽圖（不修改原圖，原圖原封不動上傳到私有 bucket）
import { extFromMime } from "./filename";

export const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024; // 與 originals bucket 上限一致
export const PREVIEW_MAX_SIDE = 1200;

export interface PreparedImage {
  original: File;
  preview: Blob;
  previewExt: string;
  width: number;
  height: number;
}

function loadFromFile(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("無法讀取圖片，請確認檔案沒有損壞。"));
    };
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export function validateFile(file: File): string | null {
  if (!ALLOWED_TYPES.includes(file.type)) return `「${file.name}」格式不支援，請使用 PNG、JPG 或 WebP。`;
  if (file.size > MAX_ORIGINAL_BYTES) return `「${file.name}」超過 20MB，請先壓縮後再上傳。`;
  return null;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const err = validateFile(file);
  if (err) throw new Error(err);
  const img = await loadFromFile(file);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) throw new Error("無法讀取圖片尺寸。");

  // 預覽圖：等比例縮小（最長邊 1200px），保持與原圖相同長寬比，裁切座標才會一致
  const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(width, height));
  const pw = Math.max(1, Math.round(width * scale));
  const ph = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = pw;
  canvas.height = ph;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("瀏覽器不支援圖片處理。");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, pw, ph);

  // 優先 WebP（保留透明）；不支援 WebP 編碼的瀏覽器改用 PNG／JPG
  let preview = await toBlob(canvas, "image/webp", 0.9);
  if (!preview || preview.type !== "image/webp") {
    preview = await toBlob(canvas, file.type === "image/jpeg" ? "image/jpeg" : "image/png", 0.9);
  }
  if (!preview) throw new Error("無法產生預覽圖。");
  return { original: file, preview, previewExt: extFromMime(preview.type), width, height };
}

export function titleFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/^\d+[_\-\s.]*/, "").replace(/[_]+/g, " ").trim().slice(0, 60) || "未命名作品";
}
