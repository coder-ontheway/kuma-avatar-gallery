import { describe, expect, it } from "vitest";
import { avatarFileName, safeName, splitIntoParts, uniqueZipNames } from "./filename";

describe("檔名", () => {
  it("大頭貼檔名格式", () => {
    expect(avatarFileName("FB", "熊大的早安")).toBe("KUMA_FB_熊大的早安.png");
    expect(avatarFileName("IG", "兔兔")).toBe("KUMA_IG_兔兔.png");
    expect(avatarFileName("LINE", "放閃")).toBe("KUMA_LINE_放閃.png");
  });

  it("移除不合法字元", () => {
    expect(safeName('a/b\\c:d*e?"f<g>h|i')).toBe("abcdefghi");
    expect(safeName("   ")).toBe("作品");
    expect(safeName("../../etc")).toBe("etc");
  });

  it("ZIP 內重複名稱不會互相覆蓋", () => {
    const names = uniqueZipNames([
      { title: "熊大", mime_type: "image/png" },
      { title: "熊大", mime_type: "image/png" },
      { title: "兔兔", mime_type: "image/jpeg" },
    ]);
    expect(names).toEqual(["KUMA_01_熊大.png", "KUMA_02_熊大.png", "KUMA_03_兔兔.jpg"]);
    expect(new Set(names).size).toBe(3);
  });

  it("依容量分批", () => {
    const parts = splitIntoParts([{ file_size: 60 }, { file_size: 50 }, { file_size: 10 }, { file_size: 200 }], 100);
    expect(parts.map((p) => p.length)).toEqual([1, 2, 1]);
  });
});
