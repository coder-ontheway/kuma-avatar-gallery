import { describe, expect, it } from "vitest";
import { clampState, cropRect, initialState, MAX_ZOOM, minZoom, outputSize, panBy, zoomAt } from "./crop";

describe("裁切數學", () => {
  it("預設：正方形裁切框置中，短邊貼齊", () => {
    const r = cropRect(1200, 800, initialState());
    expect(r).toEqual({ x: 200, y: 0, size: 800 });
  });

  it("預覽圖與原圖使用同一狀態時，裁切位置按比例一致", () => {
    const s = clampState(4000, 3000, { cx: 0.62, cy: 0.41, zoom: 1.7 });
    const big = cropRect(4000, 3000, s);
    const small = cropRect(1200, 900, s);
    const k = 4000 / 1200;
    expect(big.x / k).toBeCloseTo(small.x, 6);
    expect(big.y / k).toBeCloseTo(small.y, 6);
    expect(big.size / k).toBeCloseTo(small.size, 6);
  });

  it("縮放範圍限制在『整張可見』到 5 倍", () => {
    expect(clampState(1000, 500, { cx: 0.5, cy: 0.5, zoom: 0.01 }).zoom).toBe(minZoom(1000, 500));
    expect(clampState(1000, 500, { cx: 0.5, cy: 0.5, zoom: 99 }).zoom).toBe(MAX_ZOOM);
  });

  it("放大後拖曳不會讓裁切框超出圖片", () => {
    const s = panBy(1000, 1000, { cx: 0.5, cy: 0.5, zoom: 2 }, 5, -5);
    const r = cropRect(1000, 1000, s);
    expect(r.x).toBeGreaterThanOrEqual(-1e-9);
    expect(r.y + r.size).toBeLessThanOrEqual(1000 + 1e-9);
  });

  it("縮小到比圖片大時，該方向自動置中", () => {
    const s = clampState(1000, 500, { cx: 0.9, cy: 0.1, zoom: 0.5 });
    expect(s.cx).toBe(0.5);
    expect(s.cy).toBe(0.5);
  });

  it("以指定點縮放時，該點位置不變", () => {
    const s0 = { cx: 0.5, cy: 0.5, zoom: 1.5 };
    const before = cropRect(1000, 1000, s0);
    const s1 = zoomAt(1000, 1000, s0, 2, 0.4, 0.45);
    const after = cropRect(1000, 1000, s1);
    expect(before.x + 0.4 * before.size).toBeCloseTo(after.x + 0.4 * after.size, 6);
    expect(before.y + 0.45 * before.size).toBeCloseTo(after.y + 0.45 * after.size, 6);
  });

  it("下載尺寸沿用原圖裁切像素，上限 2048、下限 256", () => {
    expect(outputSize(1000, 800, initialState())).toBe(800);
    expect(outputSize(5000, 4000, initialState())).toBe(2048);
    expect(outputSize(300, 300, { cx: 0.5, cy: 0.5, zoom: 4 })).toBe(256);
  });

  it("保留原始比例：水平與垂直使用相同縮放倍率", () => {
    const r = cropRect(1600, 900, { cx: 0.5, cy: 0.5, zoom: 1 });
    const k = 512 / r.size;
    expect((1600 * k) / (900 * k)).toBeCloseTo(1600 / 900, 10);
  });
});
