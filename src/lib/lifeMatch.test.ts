import { describe, expect, it } from "vitest";
import { matchLifeFiles, numberFromName } from "./lifeMatch";

const pending = Array.from({ length: 10 }, (_, i) => ({ work_number: i + 1, has_photo: false }));
const f = (name: string) => ({ name });

describe("批次上傳對應作品編號", () => {
  it("辨識檔名中的編號", () => {
    expect(numberFromName("No.003 星空.jpg")).toBe(3);
    expect(numberFromName("kuma_no_10.png")).toBe(10);
    expect(numberFromName("生命共同體007.jpeg")).toBe(7);
    expect(numberFromName("002_心動.png")).toBe(2);
    expect(numberFromName("IMG_4755.jpeg")).toBeNull();
    expect(numberFromName("snow.png")).toBeNull();
  });

  it("相機檔名 IMG_4755～4764 依序對應 No.001～No.010，建立十筆獨立資料", () => {
    const files = [4762, 4755, 4760, 4756, 4764, 4757, 4758, 4763, 4759, 4761].map((n) => f(`IMG_${n}.jpeg`));
    const r = matchLifeFiles(files, pending);
    const map = Object.fromEntries(r.map((x) => [x.file.name, x.work_number]));
    expect(map["IMG_4755.jpeg"]).toBe(1);
    expect(map["IMG_4764.jpeg"]).toBe(10);
    expect(new Set(r.map((x) => x.work_number)).size).toBe(10);
    expect(r.every((x) => !x.isNew)).toBe(true);
  });

  it("有編號的檔案優先，其餘依序填入空位，超出的建立新作品", () => {
    const works = pending.map((w) => (w.work_number <= 2 ? { ...w, has_photo: true } : w)).slice(0, 4);
    const r = matchLifeFiles([f("b.png"), f("No.004.png"), f("a.png"), f("c.png")], works);
    const map = Object.fromEntries(r.map((x) => [x.file.name, x]));
    expect(map["No.004.png"]).toMatchObject({ work_number: 4, byName: true, isNew: false });
    expect(map["a.png"]).toMatchObject({ work_number: 3, isNew: false });
    expect(map["b.png"]).toMatchObject({ work_number: 5, isNew: true });
    expect(map["c.png"]).toMatchObject({ work_number: 6, isNew: true });
  });

  it("檔名編號是新的編號時建立新作品", () => {
    const r = matchLifeFiles([f("No.011.png")], pending);
    expect(r[0]).toMatchObject({ work_number: 11, isNew: true, byName: true });
  });
});
