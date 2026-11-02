// KUMA STUDIO 系列收藏卡：以 canvas 合成成獨立圖片檔（1200 × 1800，2:3 直式）。
// 每個系列可選不同的主題配色（森林、甜蜜、暖陽、晴空、星夜、經典），版面與 KUMA STUDIO 品牌標示一致。
// 照片在上、文字全部在照片下方，不會有任何文字壓在熊兔身上。
// 網頁預覽用公開預覽圖繪製；下載時以私有原圖（通過下載密碼後取得）重新繪製同一個版面。

import { zonesBounds, type ProtectZone } from "./protect";
import type { CardTheme } from "./types";

export const CARD_W = 1200;
export const CARD_H = 1800;

export interface CardInfo {
  workNumber: number;
  nickname: string;
  title: string;
  description: string;
  manifesto: string;
  collectionName: string;
  collectionNameEn: string;
  theme?: CardTheme;
}

const SERIF = '"Noto Serif TC", "Songti TC", "PMingLiU", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", serif';
const SANS = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

interface Palette {
  paper1: string;
  paper2: string;
  gold: string;
  goldSoft: string;
  brown: string;
  brownSoft: string;
  rose: string;
  ornament: "leaf" | "heart" | "star" | "dot";
}

/** 收藏卡主題配色。所有主題共用同一個版面、同樣的 KUMA STUDIO 標示 */
export const CARD_THEMES: Record<CardTheme, Palette & { label: string; hint: string }> = {
  forest: { label: "森林共生", hint: "森林、愛心、自然", paper1: "#fffaf2", paper2: "#f6e9d6", gold: "#b8893e", goldSoft: "#d9b878", brown: "#5a3a26", brownSoft: "#8a6a52", rose: "#d9647a", ornament: "leaf" },
  sweet: { label: "甜蜜寵愛", hint: "甜蜜、溫暖、可愛", paper1: "#fff6f7", paper2: "#fde3e8", gold: "#d0708a", goldSoft: "#efb3c2", brown: "#6a3a44", brownSoft: "#9a6670", rose: "#e0587a", ornament: "heart" },
  sunny: { label: "暖陽日常", hint: "日常、陽光、輕鬆", paper1: "#fffbef", paper2: "#fbecc5", gold: "#c98a1e", goldSoft: "#ecc76f", brown: "#5c4020", brownSoft: "#8d6b45", rose: "#e07a3f", ornament: "dot" },
  sky: { label: "晴空旅行", hint: "旅行、約會、藍天", paper1: "#f6fbff", paper2: "#dcecf8", gold: "#4f86b8", goldSoft: "#9cc3e3", brown: "#2f4a63", brownSoft: "#5f7d96", rose: "#e06a86", ornament: "dot" },
  night: { label: "星夜守護", hint: "星空、夢想、浪漫", paper1: "#f7f4fb", paper2: "#e3dcf0", gold: "#8a6cc0", goldSoft: "#c2b0e2", brown: "#3a2f55", brownSoft: "#6a5f88", rose: "#d9647a", ornament: "star" },
  classic: { label: "經典奶茶", hint: "簡約、經典", paper1: "#fffdf8", paper2: "#f1ebe1", gold: "#8a6a52", goldSoft: "#c9b39b", brown: "#4a3426", brownSoft: "#7a604e", rose: "#c45a6a", ornament: "leaf" },
};

function palette(theme?: CardTheme): Palette {
  return CARD_THEMES[theme ?? "forest"] ?? CARD_THEMES.forest;
}

export function formatNo(n: number): string {
  return `No.${String(n).padStart(3, "0")}`;
}

type Ctx = CanvasRenderingContext2D;

/** 以字元為單位換行（中文沒有空白），最多 maxLines 行，超出以「…」結尾 */
export function wrapText(ctx: Pick<Ctx, "measureText">, text: string, maxWidth: number, maxLines: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const ch of Array.from(para)) {
      if (ctx.measureText(line + ch).width > maxWidth && line) {
        out.push(line);
        line = ch;
      } else line += ch;
    }
    out.push(line);
  }
  const lines = out.filter((l, i) => l || i < out.length - 1);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && ctx.measureText(last + "…").width > maxWidth) last = Array.from(last).slice(0, -1).join("");
  kept[maxLines - 1] = last + "…";
  return kept;
}

/** 收藏卡照片區是正方形：非正方形照片以保護區域為中心取正方形（不變形、不縮放比例） */
export function photoSquare(pw: number, ph: number, zones: ProtectZone[]) {
  const size = Math.min(pw, ph);
  let cx = pw / 2;
  let cy = ph / 2;
  if (zones.length > 0 && pw !== ph) {
    const b = zonesBounds(zones);
    cx = ((b.x0 + b.x1) / 2) * pw;
    cy = ((b.y0 + b.y1) / 2) * ph;
  }
  const sx = Math.min(pw - size, Math.max(0, cx - size / 2));
  const sy = Math.min(ph - size, Math.max(0, cy - size / 2));
  return { sx, sy, size };
}

function roundRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function heart(ctx: Ctx, cx: number, cy: number, s: number, color: string) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.35);
  ctx.bezierCurveTo(cx - s * 0.9, cy - s * 0.25, cx - s * 0.45, cy - s * 0.95, cx, cy - s * 0.45);
  ctx.bezierCurveTo(cx + s * 0.45, cy - s * 0.95, cx + s * 0.9, cy - s * 0.25, cx, cy + s * 0.35);
  ctx.fill();
  ctx.restore();
}

function star(ctx: Ctx, cx: number, cy: number, r: number, color: string) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 編號兩側的裝飾（依主題） */
function ornament(ctx: Ctx, C: Palette, x: number, y: number, side: -1 | 1) {
  if (C.ornament === "leaf") return leaf(ctx, C, x, y, 60, side < 0 ? Math.PI : 0);
  const cx = x + side * 30;
  if (C.ornament === "heart") return heart(ctx, cx, y + 6, 26, C.goldSoft);
  if (C.ornament === "star") return star(ctx, cx, y, 22, C.goldSoft);
  ctx.save();
  ctx.fillStyle = C.goldSoft;
  for (const [dx, r] of [[0, 10], [side * 26, 6], [side * 44, 4]] as const) {
    ctx.beginPath();
    ctx.arc(cx + dx, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function leaf(ctx: Ctx, C: Palette, x: number, y: number, s: number, angle: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = C.goldSoft;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(s * 0.5, -s * 0.35, s, 0);
  ctx.quadraticCurveTo(s * 0.5, s * 0.35, 0, 0);
  ctx.fill();
  ctx.restore();
}

export async function ensureCardFonts(info: CardInfo): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  const all = Object.values(info).join("");
  await Promise.all([
    document.fonts.load(`700 60px ${SERIF}`, all),
    document.fonts.load(`500 36px ${SERIF}`, all),
    document.fonts.load(`500 32px ${SANS}`, all),
    document.fonts.load(`700 32px ${SANS}`, all),
  ].map((p) => p.catch(() => undefined)));
}

/** 在 1200×1800 畫布上繪製整張收藏卡（預覽與下載共用） */
export function drawCard(ctx: Ctx, photo: CanvasImageSource, pw: number, ph: number, info: CardInfo, zones: ProtectZone[]) {
  const W = CARD_W;
  const H = CARD_H;
  const C = palette(info.theme);
  ctx.save();
  // 紙張底色
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, C.paper1);
  g.addColorStop(1, C.paper2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 外框（在卡片邊緣，不在照片上）
  ctx.strokeStyle = C.goldSoft;
  ctx.lineWidth = 4;
  roundRectPath(ctx, 28, 28, W - 56, H - 56, 36);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, 44, 44, W - 88, H - 88, 28);
  ctx.stroke();

  // 頂部品牌列
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = C.brownSoft;
  ctx.font = `700 26px ${SANS}`;
  if ("letterSpacing" in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = "8px";
  ctx.fillText("KUMA STUDIO", W / 2, 96);
  if ("letterSpacing" in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = "0px";

  // 照片（正方形、圓角）
  const P = 1000;
  const px = (W - P) / 2;
  const py = 140;
  const sq = photoSquare(pw, ph, zones);
  ctx.save();
  ctx.shadowColor = "rgba(90,58,38,0.25)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = "#fff";
  roundRectPath(ctx, px - 10, py - 10, P + 20, P + 20, 34);
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRectPath(ctx, px, py, P, P, 26);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(photo, sq.sx, sq.sy, sq.size, sq.size, px, py, P, P);
  ctx.restore();

  // 編號與稱號
  let y = py + P + 92;
  ornament(ctx, C, W / 2 - 190, y, -1);
  ornament(ctx, C, W / 2 + 190, y, 1);
  ctx.fillStyle = C.gold;
  ctx.font = `700 64px ${SERIF}`;
  ctx.fillText(formatNo(info.workNumber), W / 2, y);

  y += 92;
  ctx.fillStyle = C.brown;
  ctx.font = `700 68px ${SERIF}`;
  const nick = wrapText(ctx, info.nickname, W - 200, 1)[0] ?? "";
  ctx.fillText(nick, W / 2, y);

  if (info.title && info.title !== info.nickname) {
    y += 70;
    ctx.fillStyle = C.brownSoft;
    ctx.font = `500 36px ${SERIF}`;
    ctx.fillText(`「${wrapText(ctx, info.title, W - 260, 1)[0]}」`, W / 2, y);
  }

  // 介紹
  if (info.description.trim()) {
    y += 64;
    ctx.fillStyle = C.brownSoft;
    ctx.font = `500 30px ${SANS}`;
    for (const line of wrapText(ctx, info.description.trim(), W - 240, 2)) {
      ctx.fillText(line, W / 2, y);
      y += 44;
    }
    y -= 44;
  }

  // 宣言
  if (info.manifesto.trim()) {
    y += 82;
    ctx.font = `700 40px ${SERIF}`;
    const m = wrapText(ctx, info.manifesto.trim(), W - 300, 1)[0];
    const mw = ctx.measureText(m).width;
    heart(ctx, W / 2 - mw / 2 - 40, y, 28, C.rose);
    heart(ctx, W / 2 + mw / 2 + 40, y, 28, C.rose);
    ctx.fillStyle = C.rose;
    ctx.fillText(m, W / 2, y);
  }

  // 底部
  ctx.fillStyle = C.gold;
  ctx.font = `700 24px ${SANS}`;
  if ("letterSpacing" in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = "6px";
  ctx.fillText(info.collectionNameEn || "KUMA STUDIO COLLECTION", W / 2, H - 112);
  if ("letterSpacing" in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = "0px";
  ctx.fillStyle = C.brownSoft;
  ctx.font = `500 24px ${SANS}`;
  ctx.fillText(`${info.collectionName}｜KUMA STUDIO`, W / 2, H - 74);
  ctx.restore();
}

/** 產生收藏卡 JPG（高畫質）。照片以原圖解析度繪入 1000×1000 區域。 */
export async function renderCardBlob(photo: CanvasImageSource, pw: number, ph: number, info: CardInfo, zones: ProtectZone[]): Promise<Blob> {
  await ensureCardFonts(info);
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("瀏覽器不支援圖片處理");
  drawCard(ctx, photo, pw, ph, info, zones);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("無法產生收藏卡"))), "image/jpeg", 0.95),
  );
}
