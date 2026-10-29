// 粉絲自製大頭貼的文字圖層。
// 所有位置與尺寸都以「畫布邊長 = 1」的比例表示，
// 預覽（螢幕大小）與下載（原圖解析度）共用同一套版面計算，因此位置一致。

export type TextAlign = "left" | "center" | "right";
export type FontKey = "sans" | "serif";

export interface TextLayer {
  id: string;
  text: string;
  x: number; // 文字框中心（0~1）
  y: number;
  size: number; // 字級：畫布邊長的比例
  color: string;
  align: TextAlign;
  bold: boolean;
  font: FontKey;
  strokeWidth: number; // 描邊寬度：字級的比例（0 = 無）
  strokeColor: string;
  shadow: boolean;
  bgColor: string;
  bgOpacity: number; // 0 = 無背景
  bgRadius: number; // 圓角：字級的比例
}

export const FONT_LABEL: Record<FontKey, string> = {
  sans: "黑體",
  serif: "明體",
};

// 中文字優先使用 Noto 思源字體（index.html 由 Google Fonts 載入），並以各平台系統字體與表情符號字體備援
const FONT_STACK: Record<FontKey, string> = {
  sans: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Heiti TC", sans-serif',
  serif: '"Noto Serif TC", "Songti TC", "PMingLiU", serif',
};
const EMOJI_STACK = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';

export const LINE_HEIGHT = 1.25;
export const PADDING = 0.3; // 文字背景內距：字級的比例
export const MAX_TEXT_LENGTH = 80;
export const MAX_LAYERS = 8;
export const SAFE_RADIUS = 0.4; // 圓形大頭貼的建議安全範圍（半徑，畫布邊長比例）

export function fontString(layer: Pick<TextLayer, "bold" | "font">, px: number): string {
  // 字型清單把表情符號字體放在中文字體之後，避免數字、英文被表情字體取代
  return `${layer.bold ? 700 : 500} ${px}px ${FONT_STACK[layer.font].replace(/, (sans-serif|serif)$/, "")}, ${EMOJI_STACK}, ${
    layer.font === "serif" ? "serif" : "sans-serif"
  }`;
}

let nextId = 1;
export function newLayer(partial: Partial<TextLayer> = {}): TextLayer {
  return {
    id: `t${Date.now().toString(36)}${nextId++}`,
    text: "輸入文字",
    x: 0.5,
    y: 0.78,
    size: 0.1,
    color: "#ffffff",
    align: "center",
    bold: true,
    font: "sans",
    strokeWidth: 0.14,
    strokeColor: "#8a5a3b",
    shadow: true,
    bgColor: "#ffffff",
    bgOpacity: 0,
    bgRadius: 0.4,
    ...partial,
  };
}

export function lines(text: string): string[] {
  const ls = text.replace(/\r\n?/g, "\n").split("\n");
  return ls.length ? ls : [""];
}

interface Measurer {
  font: string;
  measureText(t: string): { width: number };
}

const REF = 1000; // 以 1000px 畫布作為版面計算基準
let refCtx: Measurer | null = null;
function measurer(): Measurer {
  if (!refCtx) {
    const c = document.createElement("canvas");
    refCtx = c.getContext("2d") as unknown as Measurer;
  }
  return refCtx;
}

export interface Layout {
  w: number; // 文字框寬（比例）
  h: number;
  lineWidths: number[]; // 每行寬（比例）
}

/** 計算文字框大小（以畫布邊長 = 1 表示） */
export function layoutLayer(layer: TextLayer, m: Measurer = measurer()): Layout {
  const px = layer.size * REF;
  m.font = fontString(layer, px);
  const ls = lines(layer.text);
  const widths = ls.map((l) => m.measureText(l).width / REF);
  const pad = layer.size * PADDING;
  const extra = layer.size * layer.strokeWidth; // 描邊會往外長
  const w = Math.max(layer.size * 0.5, ...widths) + 2 * pad + extra;
  const h = ls.length * layer.size * LINE_HEIGHT + 2 * pad + extra;
  return { w, h, lineWidths: widths };
}

/** 讓文字框完全留在畫布內（文字不會被裁到畫布外） */
export function clampLayer(layer: TextLayer, layout = layoutLayer(layer)): TextLayer {
  const hw = Math.min(0.5, layout.w / 2);
  const hh = Math.min(0.5, layout.h / 2);
  return {
    ...layer,
    x: Math.min(1 - hw, Math.max(hw, layer.x)),
    y: Math.min(1 - hh, Math.max(hh, layer.y)),
  };
}

/** 文字框四角是否都在圓形範圍內 */
export function insideCircle(layer: TextLayer, radius = 0.5, layout = layoutLayer(layer)): boolean {
  const hw = layout.w / 2;
  const hh = layout.h / 2;
  const corners = [
    [layer.x - hw, layer.y - hh],
    [layer.x + hw, layer.y - hh],
    [layer.x - hw, layer.y + hh],
    [layer.x + hw, layer.y + hh],
  ];
  return corners.every(([cx, cy]) => Math.hypot(cx - 0.5, cy - 0.5) <= radius + 1e-6);
}

/** 把文字往中心移動（必要時縮小字級），直到完全進入圓形安全範圍 */
export function fitIntoCircle(layer: TextLayer, radius = SAFE_RADIUS): TextLayer {
  let l = clampLayer(layer);
  for (let attempt = 0; attempt < 30; attempt++) {
    const layout = layoutLayer(l);
    if (insideCircle(l, radius, layout)) return l;
    // 文字框比圓還大：縮小字級
    if (Math.hypot(layout.w / 2, layout.h / 2) > radius) {
      l = { ...l, size: l.size * 0.9 };
      continue;
    }
    // 往中心移動
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 20; i++) {
      const t = (lo + hi) / 2;
      const cand = { ...l, x: 0.5 + (l.x - 0.5) * t, y: 0.5 + (l.y - 0.5) * t };
      if (insideCircle(cand, radius, layout)) lo = t;
      else hi = t;
    }
    return { ...l, x: 0.5 + (l.x - 0.5) * lo, y: 0.5 + (l.y - 0.5) * lo };
  }
  return l;
}

/** 依目前所在圓形判斷是否點到文字框（用於拖曳選取） */
export function hitTest(layers: TextLayer[], fx: number, fy: number): TextLayer | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    const { w, h } = layoutLayer(l);
    if (Math.abs(fx - l.x) <= w / 2 && Math.abs(fy - l.y) <= h / 2) return l;
  }
  return null;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(255,255,255,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** 在 S×S 畫布上繪製文字圖層（預覽與下載共用） */
export function drawTextLayers(ctx: Ctx2D, layers: TextLayer[], S: number) {
  for (const raw of layers) {
    if (!raw.text.trim()) continue;
    const layout = layoutLayer(raw);
    const layer = clampLayer(raw, layout);
    const px = layer.size * S;
    const pad = layer.size * PADDING * S;
    const extra = (layer.size * layer.strokeWidth * S) / 2;
    const boxW = layout.w * S;
    const boxH = layout.h * S;
    const left = layer.x * S - boxW / 2;
    const top = layer.y * S - boxH / 2;

    ctx.save();
    if (layer.bgOpacity > 0) {
      ctx.fillStyle = hexToRgba(layer.bgColor, layer.bgOpacity);
      const r = Math.min(boxW / 2, boxH / 2, layer.bgRadius * px);
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(left, top, boxW, boxH, r);
      else ctx.rect(left, top, boxW, boxH);
      ctx.fill();
    }

    ctx.font = fontString(layer, px);
    ctx.textBaseline = "middle";
    ctx.textAlign = layer.align;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    const ls = lines(layer.text);
    const innerLeft = left + pad + extra;
    const innerRight = left + boxW - pad - extra;
    const ax = layer.align === "left" ? innerLeft : layer.align === "right" ? innerRight : layer.x * S;
    const lh = px * LINE_HEIGHT;
    const firstY = top + pad + extra + lh / 2;

    ls.forEach((line, i) => {
      const y = firstY + i * lh;
      if (layer.shadow) {
        ctx.shadowColor = "rgba(0,0,0,0.35)";
        ctx.shadowBlur = px * 0.18;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = px * 0.06;
      }
      if (layer.strokeWidth > 0) {
        ctx.strokeStyle = layer.strokeColor;
        ctx.lineWidth = layer.strokeWidth * px;
        ctx.strokeText(line, ax, y);
        ctx.shadowColor = "transparent";
      }
      ctx.fillStyle = layer.color;
      ctx.fillText(line, ax, y);
      ctx.shadowColor = "transparent";
    });
    ctx.restore();
  }
}

/** 確保字型載入完成後再繪製／匯出，避免中文字在下載檔中掉字 */
export async function ensureFonts(layers: TextLayer[]): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  await Promise.all(
    layers
      .filter((l) => l.text.trim())
      .map((l) => document.fonts.load(fontString(l, 48), l.text).catch(() => undefined)),
  );
}
