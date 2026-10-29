// 大頭貼裁切的共用數學與繪製邏輯。
// 預覽與下載使用「同一份」CropState 與同一個 drawCrop()，
// 座標以原圖比例（0~1）表示，因此無論用預覽圖或原圖繪製，裁切位置都一致。

import { drawTextLayers, ensureFonts, type TextLayer } from "./textLayers";

export type Platform = "facebook" | "instagram" | "line";

export interface CropState {
  cx: number; // 裁切框中心點，以圖片寬度為 1 的比例
  cy: number; // 裁切框中心點，以圖片高度為 1 的比例
  zoom: number; // 1 = 剛好填滿正方形（短邊貼齊）；小於 1 會出現留白
}

export const MAX_ZOOM = 5;
export const MIN_OUTPUT = 256;
export const MAX_OUTPUT = 2048;

export const PLATFORM_LABEL: Record<Platform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  line: "LINE",
};

export const PLATFORM_CODE: Record<Platform, string> = {
  facebook: "FB",
  instagram: "IG",
  line: "LINE",
};

/** 縮到最小時整張圖完整放進正方形（長邊貼齊） */
export function minZoom(w: number, h: number): number {
  return Math.min(w, h) / Math.max(w, h);
}

export function initialState(): CropState {
  return { cx: 0.5, cy: 0.5, zoom: 1 };
}

/** 正方形裁切框在圖片像素座標中的位置 */
export function cropRect(w: number, h: number, s: CropState) {
  const size = Math.min(w, h) / s.zoom;
  return { x: s.cx * w - size / 2, y: s.cy * h - size / 2, size };
}

/** 限制縮放範圍；放大時不讓裁切框跑出圖片外，縮小到比圖片大時自動置中該方向 */
export function clampState(w: number, h: number, s: CropState): CropState {
  const zoom = Math.min(MAX_ZOOM, Math.max(minZoom(w, h), s.zoom));
  const size = Math.min(w, h) / zoom;
  const clampAxis = (c: number, len: number) => {
    if (size >= len) return 0.5;
    const half = size / 2 / len;
    return Math.min(1 - half, Math.max(half, c));
  };
  return { zoom, cx: clampAxis(s.cx, w), cy: clampAxis(s.cy, h) };
}

/** 依使用者在畫面上拖曳的距離（以預覽框邊長為單位）移動裁切中心 */
export function panBy(w: number, h: number, s: CropState, dxView: number, dyView: number): CropState {
  const size = Math.min(w, h) / s.zoom;
  return clampState(w, h, { ...s, cx: s.cx - (dxView * size) / w, cy: s.cy - (dyView * size) / h });
}

/** 以預覽框中某一點（0~1）為中心縮放，讓手指／游標下的位置不跑掉 */
export function zoomAt(w: number, h: number, s: CropState, newZoom: number, fx = 0.5, fy = 0.5): CropState {
  const before = cropRect(w, h, s);
  const px = before.x + fx * before.size;
  const py = before.y + fy * before.size;
  const z = Math.min(MAX_ZOOM, Math.max(minZoom(w, h), newZoom));
  const size = Math.min(w, h) / z;
  const x = px - fx * size;
  const y = py - fy * size;
  return clampState(w, h, { zoom: z, cx: (x + size / 2) / w, cy: (y + size / 2) / h });
}

export const MIN_OUTPUT_WITH_TEXT = 1024;

/**
 * 下載尺寸：沿用原圖實際裁切像素，避免不必要放大或縮小；上限 2048、下限 256。
 * 有文字時至少 1024px，讓文字邊緣清晰（文字是向量繪製，不受底圖解析度影響）。
 */
export function outputSize(origW: number, origH: number, s: CropState, hasText = false): number {
  const { size } = cropRect(origW, origH, clampState(origW, origH, s));
  const min = hasText ? MIN_OUTPUT_WITH_TEXT : MIN_OUTPUT;
  return Math.round(Math.min(MAX_OUTPUT, Math.max(min, size)));
}

export interface DrawOptions {
  background: string | null; // null = 保留透明
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** 把裁切結果畫到 outSize × outSize 的畫布上（預覽與下載共用） */
export function drawCrop(
  ctx: Ctx2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  s: CropState,
  outSize: number,
  opts: DrawOptions,
) {
  const st = clampState(srcW, srcH, s);
  const r = cropRect(srcW, srcH, st);
  const k = outSize / r.size;
  ctx.save();
  ctx.clearRect(0, 0, outSize, outSize);
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, outSize, outSize);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, -r.x * k, -r.y * k, srcW * k, srcH * k);
  ctx.restore();
}

/** 用原圖產生正方形 PNG（保留透明，除非選了背景色）；文字圖層在同一張畫布上以高解析度重新繪製 */
export async function renderAvatarBlob(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  s: CropState,
  opts: DrawOptions,
  layers: TextLayer[] = [],
): Promise<Blob> {
  const visible = layers.filter((l) => l.text.trim());
  await ensureFonts(visible);
  const size = outputSize(srcW, srcH, s, visible.length > 0);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("瀏覽器不支援圖片處理");
  drawCrop(ctx, source, srcW, srcH, s, size, opts);
  drawTextLayers(ctx, visible, size);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("無法產生圖片"))), "image/png"),
  );
}
