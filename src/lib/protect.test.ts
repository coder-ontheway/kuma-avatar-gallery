import { describe, expect, it, vi } from "vitest";

// layoutLayer 需要 canvas 量字；測試環境以固定字寬模擬（每字 = 字級）
vi.mock("./textLayers", async (orig) => {
  const mod = await orig<typeof import("./textLayers")>();
  const fake = {
    font: "",
    measureText(t: string) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 100);
      return { width: Array.from(t).length * px };
    },
  };
  return {
    ...mod,
    layoutLayer: (l: import("./textLayers").TextLayer) => mod.layoutLayer(l, fake),
    clampLayer: (l: import("./textLayers").TextLayer) => mod.clampLayer(l, mod.layoutLayer(l, fake)),
  };
});

import { avoidZones, constrainCrop, cropKeepsZones, defaultCrop, layerHitsZones, rectHitsEllipse, sanitizeZones, zoneOnCanvas } from "./protect";
import { newLayer } from "./textLayers";
import type { Platform } from "./crop";

// No.001 的保護區域（臉與耳朵、胸口愛心）
const ZONES = [
  { label: "臉與耳朵", x: 0.26, y: 0.015, w: 0.49, h: 0.465 },
  { label: "胸口愛心", x: 0.43, y: 0.51, w: 0.14, h: 0.13 },
];
const PLATFORMS: Platform[] = ["facebook", "instagram", "line"];

describe("保護區域：裁切", () => {
  it("三個平台的預設構圖都完整保留耳朵與愛心", () => {
    for (const p of PLATFORMS) {
      const s = defaultCrop(1280, 1280, ZONES, p);
      expect(cropKeepsZones(1280, 1280, s, ZONES, p)).toBe(true);
    }
  });

  it("三個平台的預設構圖不同（不是同一張圖換名字）", () => {
    const zs = sanitizeZones([{ label: "臉", x: 0.35, y: 0.2, w: 0.3, h: 0.3 }, { label: "心", x: 0.45, y: 0.52, w: 0.1, h: 0.08 }]);
    const [fb, ig, line] = PLATFORMS.map((p) => defaultCrop(1280, 1280, zs, p));
    expect(fb).not.toEqual(ig);
    expect(fb).not.toEqual(line);
    expect(ig.zoom).toBeLessThan(line.zoom);
  });

  it("放大或拖曳到會切掉耳朵時，停在仍完整的位置", () => {
    for (const p of PLATFORMS) {
      const start = defaultCrop(1280, 1280, ZONES, p);
      const tooFar = { cx: 0.5, cy: 0.9, zoom: 4 };
      const s = constrainCrop(1280, 1280, start, tooFar, ZONES, p);
      expect(cropKeepsZones(1280, 1280, s, ZONES, p)).toBe(true);
    }
  });

  it("沒有保護區域時不限制", () => {
    const s = constrainCrop(1000, 1000, { cx: 0.5, cy: 0.5, zoom: 1 }, { cx: 0.8, cy: 0.8, zoom: 3 }, [], "facebook");
    expect(s.zoom).toBe(3);
  });

  it("非正方形照片也能找到合格構圖", () => {
    const zs = [{ label: "臉", x: 0.3, y: 0.05, w: 0.4, h: 0.25 }];
    for (const p of PLATFORMS) {
      const s = defaultCrop(1000, 1600, zs, p);
      expect(cropKeepsZones(1000, 1600, s, zs, p)).toBe(true);
    }
  });

  it("不合法的保護區域資料會被忽略", () => {
    expect(sanitizeZones([{ x: "a" }, null, { x: 0.1, y: 0.1, w: 0, h: 0.2 }, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }])).toHaveLength(1);
    expect(sanitizeZones("x")).toEqual([]);
  });
});

describe("保護區域：文字", () => {
  it("矩形與橢圓相交判斷", () => {
    const e = { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.1 };
    expect(rectHitsEllipse(0.45, 0.45, 0.55, 0.55, e)).toBe(true);
    expect(rectHitsEllipse(0.0, 0.0, 0.3, 0.38, e)).toBe(false); // 角落附近但在橢圓外
    expect(rectHitsEllipse(0.69, 0.49, 0.8, 0.51, e)).toBe(true);
  });

  it("文字放在愛心上會被移開，且不再遮住任何保護區域", () => {
    for (const p of PLATFORMS) {
      const s = defaultCrop(1280, 1280, ZONES, p);
      const ellipses = ZONES.map((z) => zoneOnCanvas(z, 1280, 1280, s));
      const heart = ellipses[1];
      const layer = newLayer({ text: "心在一起 ❤️", x: heart.cx, y: heart.cy, size: 0.07 });
      expect(layerHitsZones(layer, ellipses)).toBe(true);
      const moved = avoidZones(layer, ellipses, p === "line" ? null : 0.5);
      expect(layerHitsZones(moved, ellipses)).toBe(false);
    }
  });

  it("原本就沒有遮住時位置不變", () => {
    const s = defaultCrop(1280, 1280, ZONES, "facebook");
    const ellipses = ZONES.map((z) => zoneOnCanvas(z, 1280, 1280, s));
    const layer = newLayer({ text: "永遠在一起", x: 0.5, y: 0.93, size: 0.05 });
    if (!layerHitsZones(layer, ellipses)) expect(avoidZones(layer, ellipses, 0.5)).toMatchObject({ x: 0.5, y: 0.93 });
  });
});
