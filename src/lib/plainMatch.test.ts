import { describe, expect, it } from "vitest";
import { matchPlainFiles, plainTitleFromFileName } from "./plainMatch";

describe("plainTitleFromFileName", () => {
  it("去掉無字版字尾與編號", () => {
    expect(plainTitleFromFileName("01_received_無字.png")).toBe("received");
    expect(plainTitleFromFileName("received-notext.PNG")).toBe("received");
    expect(plainTitleFromFileName("02_good_morning (無字版).webp")).toBe("good morning");
    expect(plainTitleFromFileName("bear_pose_plain.png")).toBe("bear pose");
    expect(plainTitleFromFileName("bye.png")).toBe("bye");
  });
});

describe("matchPlainFiles", () => {
  const images = [
    { id: "1", title: "received" },
    { id: "2", title: "good morning" },
    { id: "3", title: "Bye" },
  ];
  it("依名稱對應（不分大小寫、底線與空白視為相同）", () => {
    const r = matchPlainFiles([{ name: "01_received_無字.png" }, { name: "good_morning_notext.png" }, { name: "bye.png" }, { name: "unknown.png" }], images);
    expect(r.matched.map((m) => [m.file.name, m.image.id])).toEqual([
      ["01_received_無字.png", "1"],
      ["good_morning_notext.png", "2"],
      ["bye.png", "3"],
    ]);
    expect(r.unmatched.map((f) => f.name)).toEqual(["unknown.png"]);
  });
  it("同一張作品只對應一個檔案", () => {
    const r = matchPlainFiles([{ name: "received_無字.png" }, { name: "received_notext.png" }], images);
    expect(r.matched.length).toBe(1);
    expect(r.unmatched.map((f) => f.name)).toEqual(["received_notext.png"]);
  });
});
