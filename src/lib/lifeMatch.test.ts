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

describe("完整照片＋大頭貼版配對（熊大寵妻系列檔名）", () => {
  const names = ["01_bedtime", "02_tea", "03_umbrella", "04_breakfast", "05_garden"];
  const files = names.flatMap((n) => [f(`bear_loves_rabbit_${n}.png`), f(`bear_loves_rabbit_avatar_${n}.png`)]);

  it("辨識底線包住的編號", () => {
    expect(numberFromName("bear_loves_rabbit_03_umbrella.png")).toBe(3);
    expect(numberFromName("bear_loves_rabbit_avatar_05_garden.png")).toBe(5);
    expect(numberFromName("IMG_4755.jpeg")).toBeNull();
  });

  it("新系列：10 個檔案建立 5 筆作品，每筆各有完整照片與大頭貼版", async () => {
    const { planBatch } = await import("./lifeMatch");
    const plan = planBatch(files, []);
    expect(plan.filter((p) => p.kind === "photo").map((p) => p.work_number).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(plan.filter((p) => p.kind === "avatar").map((p) => p.work_number).sort()).toEqual([1, 2, 3, 4, 5]);
    for (const p of plan) expect(p.file.name.includes(`_0${p.work_number}_`)).toBe(true);
    expect(new Set(plan.map((p) => p.work_number)).size).toBe(5);
  });

  it("沒有編號的大頭貼版與同名完整照片配對", async () => {
    const { planBatch } = await import("./lifeMatch");
    const plan = planBatch([f("tea.png"), f("tea_avatar.png"), f("garden.png"), f("garden-avatar.png")], []);
    const n = (name: string) => plan.find((p) => p.file.name === name)!.work_number;
    expect(n("tea_avatar.png")).toBe(n("tea.png"));
    expect(n("garden-avatar.png")).toBe(n("garden.png"));
  });
});
