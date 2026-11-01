// 熊兔生命共同體：保護區域（臉、耳朵、胸口愛心）的幾何運算。
//
// 保護區域以「原圖比例 0~1」的矩形儲存，運算時視為內切橢圓並略為放大（ZONE_PAD），
// 用於兩件事：
//   1. 裁切：各平台的裁切框必須完整包含保護區域（耳朵、愛心不會被切掉）。
//   2. 文字：粉絲的文字框不能與保護區域重疊（文字不會遮住臉、耳朵與愛心）。
// 預覽與下載都使用同一份 CropState 與文字圖層，因此只要在編輯時維持限制，下載結果就一定符合。

import { clampState, cropRect, MAX_ZOOM, type CropState, type Platform } from "./crop";
import { clampLayer, layoutLayer, type Layout, type TextLayer } from "./textLayers";

export interface ProtectZone {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 橢圓水平放大倍率：讓頭部兩側的熊耳朵也被涵蓋（垂直方向以量測值為準，耳朵尖端已在矩形頂端） */
export const ZONE_PAD = 1.12;

/** 各平台「保護區域必須在內」的可視範圍 */
export const PLATFORM_VISIBLE: Record<Platform, { shape: "circle" | "square"; radius: number; margin: number }> = {
  facebook: { shape: "circle", radius: 0.5, margin: 0 }, // 圓形大頭貼
  instagram: { shape: "circle", radius: 0.49, margin: 0 }, // 圓形且顯示較小，再留一點邊
  line: { shape: "square", radius: 0.5, margin: 0 }, // 方形（下載的就是完整方形）
};

/** 各平台預設構圖：保護區域頂端位置與佔畫面高度的比例（不同平台構圖不同，不是同一張圖換名字） */
const FRAMING: Record<Platform, { top: number; fill: number }> = {
  facebook: { top: 0.1, fill: 0.62 },
  instagram: { top: 0.13, fill: 0.56 },
  line: { top: 0.06, fill: 0.68 },
};

export interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export function isValidZone(z: unknown): z is ProtectZone {
  if (!z || typeof z !== "object") return false;
  const o = z as Record<string, unknown>;
  return ["x", "y", "w", "h"].every((k) => typeof o[k] === "number" && Number.isFinite(o[k] as number)) &&
    (o.w as number) > 0 && (o.h as number) > 0;
}

export function sanitizeZones(raw: unknown): ProtectZone[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidZone).map((z) => ({
    label: typeof z.label === "string" ? z.label.slice(0, 20) : "",
    x: clamp01(z.x),
    y: clamp01(z.y),
    w: Math.min(1, Math.max(0.01, z.w)),
    h: Math.min(1, Math.max(0.01, z.h)),
  }));
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

/** 保護區域在「裁切後畫布」（邊長 = 1）上的橢圓 */
export function zoneOnCanvas(z: ProtectZone, w: number, h: number, s: CropState): Ellipse {
  const r = cropRect(w, h, s);
  return {
    cx: ((z.x + z.w / 2) * w - r.x) / r.size,
    cy: ((z.y + z.h / 2) * h - r.y) / r.size,
    rx: ((z.w * w) / 2 / r.size) * ZONE_PAD,
    ry: (z.h * h) / 2 / r.size,
  };
}

const SAMPLES = 36;

/** 橢圓是否完整在該平台可視範圍內 */
export function ellipseVisible(e: Ellipse, platform: Platform): boolean {
  const v = PLATFORM_VISIBLE[platform];
  for (let i = 0; i < SAMPLES; i++) {
    const a = (i / SAMPLES) * Math.PI * 2;
    const px = e.cx + e.rx * Math.cos(a);
    const py = e.cy + e.ry * Math.sin(a);
    if (v.shape === "circle") {
      if (Math.hypot(px - 0.5, py - 0.5) > v.radius + 1e-6) return false;
    } else if (px < v.margin - 1e-6 || px > 1 - v.margin + 1e-6 || py < v.margin - 1e-6 || py > 1 - v.margin + 1e-6) {
      return false;
    }
  }
  return true;
}

/** 這個裁切是否讓所有保護區域完整可見 */
export function cropKeepsZones(w: number, h: number, s: CropState, zones: ProtectZone[], platform: Platform): boolean {
  return zones.every((z) => ellipseVisible(zoneOnCanvas(z, w, h, s), platform));
}

function lerpState(a: CropState, b: CropState, t: number): CropState {
  return { cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t, zoom: a.zoom + (b.zoom - a.zoom) * t };
}

/**
 * 粉絲拖曳／縮放時的限制：若新的裁切會切掉保護區域，
 * 就停在「從上一個合格狀態往新狀態移動、仍然合格」的最遠位置。
 */
export function constrainCrop(
  w: number,
  h: number,
  prev: CropState,
  next: CropState,
  zones: ProtectZone[],
  platform: Platform,
): CropState {
  const cand = clampState(w, h, next);
  if (zones.length === 0 || cropKeepsZones(w, h, cand, zones, platform)) return cand;
  const base = clampState(w, h, prev);
  if (!cropKeepsZones(w, h, base, zones, platform)) return cand; // 起點本身不合格（資料異常）時不阻擋
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const t = (lo + hi) / 2;
    if (cropKeepsZones(w, h, clampState(w, h, lerpState(base, next, t)), zones, platform)) lo = t;
    else hi = t;
  }
  return clampState(w, h, lerpState(base, next, lo));
}

/** 所有保護區域的外框（原圖比例），已含 ZONE_PAD */
export function zonesBounds(zones: ProtectZone[]) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const z of zones) {
    const cx = z.x + z.w / 2;
    const cy = z.y + z.h / 2;
    const hw = (z.w / 2) * ZONE_PAD;
    const hh = z.h / 2;
    x0 = Math.min(x0, cx - hw);
    y0 = Math.min(y0, cy - hh);
    x1 = Math.max(x1, cx + hw);
    y1 = Math.max(y1, cy + hh);
  }
  return { x0, y0, x1, y1 };
}

/**
 * 各平台的預設構圖：讓臉、耳朵與愛心落在畫面上方，下方保留放宣言的空間，
 * 且整個保護區域在該平台的可視範圍內。不會縮小到比原圖還小（不產生空白邊）。
 */
export function defaultCrop(w: number, h: number, zones: ProtectZone[], platform: Platform): CropState {
  const full = clampState(w, h, { cx: 0.5, cy: 0.5, zoom: 1 });
  if (zones.length === 0) return full;
  const b = zonesBounds(zones);
  const short = Math.min(w, h);
  const f = FRAMING[platform];
  const bw = (b.x1 - b.x0) * w;
  const bh = (b.y1 - b.y0) * h;
  let size = Math.max(bh / f.fill, bw / 0.78);
  size = Math.min(short, size);
  const zoom = Math.min(MAX_ZOOM, Math.max(1, short / size));
  const realSize = short / zoom;
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 * h - f.top * realSize + realSize / 2) / h;
  let target = clampState(w, h, { cx, cy, zoom });
  // 若預設構圖仍會切到保護區域，就往「完整原圖」的方向退，直到合格
  if (!cropKeepsZones(w, h, target, zones, platform) && cropKeepsZones(w, h, full, zones, platform)) {
    target = constrainCrop(w, h, full, target, zones, platform);
  }
  return target;
}

// ---------------------------------------------------------------------
// 文字與保護區域
// ---------------------------------------------------------------------

/** 文字框（畫布比例）是否與橢圓重疊：把空間縮放成單位圓後做「圓與矩形」相交判斷 */
export function rectHitsEllipse(x0: number, y0: number, x1: number, y1: number, e: Ellipse): boolean {
  const ux0 = (x0 - e.cx) / e.rx;
  const ux1 = (x1 - e.cx) / e.rx;
  const uy0 = (y0 - e.cy) / e.ry;
  const uy1 = (y1 - e.cy) / e.ry;
  const nx = Math.min(Math.max(0, ux0), ux1);
  const ny = Math.min(Math.max(0, uy0), uy1);
  return nx * nx + ny * ny < 1;
}

export function layerHitsZones(layer: TextLayer, ellipses: Ellipse[], layout: Layout = layoutLayer(layer)): boolean {
  if (!layer.text.trim()) return false;
  const hw = layout.w / 2;
  const hh = layout.h / 2;
  return ellipses.some((e) => rectHitsEllipse(layer.x - hw, layer.y - hh, layer.x + hw, layer.y + hh, e));
}

function insideRadius(layer: TextLayer, layout: Layout, radius: number) {
  const hw = layout.w / 2;
  const hh = layout.h / 2;
  return [
    [layer.x - hw, layer.y - hh],
    [layer.x + hw, layer.y - hh],
    [layer.x - hw, layer.y + hh],
    [layer.x + hw, layer.y + hh],
  ].every(([x, y]) => Math.hypot(x - 0.5, y - 0.5) <= radius + 1e-6);
}

/**
 * 讓文字避開保護區域：若重疊，移到離原位置最近、不重疊的位置；
 * 圓形平台優先找完全在圓內的位置。真的放不下時逐步縮小字級。
 */
export function avoidZones(layer: TextLayer, ellipses: Ellipse[], circleRadius: number | null): TextLayer {
  let l = clampLayer(layer);
  if (!l.text.trim() || ellipses.length === 0) return l;
  for (let shrink = 0; shrink < 8; shrink++) {
    const layout = layoutLayer(l);
    const fits = (c: TextLayer, needCircle: boolean) =>
      !layerHitsZones(c, ellipses, layout) && (!needCircle || circleRadius === null || insideRadius(c, layout, circleRadius));
    if (fits(l, false)) return l;
    for (const needCircle of circleRadius === null ? [false] : [true, false]) {
      for (let d = 0.01; d <= 1.0; d += 0.01) {
        let best: TextLayer | null = null;
        let bestScore = Infinity;
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * Math.PI * 2;
          const c = clampLayer({ ...l, x: l.x + d * Math.cos(a), y: l.y + d * Math.sin(a) }, layout);
          if (!fits(c, needCircle)) continue;
          const score = Math.hypot(c.x - l.x, c.y - l.y);
          if (score < bestScore) {
            best = c;
            bestScore = score;
          }
        }
        if (best) return best;
      }
    }
    l = clampLayer({ ...l, size: Math.max(0.03, l.size * 0.88) });
  }
  return l;
}
