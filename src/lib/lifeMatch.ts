// 批次上傳時，把多個檔案對應到系列中的作品編號。
// 規則（依序）：
//   1. 檔名有明確編號，例如「No.003」「no_3」「NO-010」「生命共同體003」或開頭「003_」「3-」→ 對應該編號
//   2. 其餘檔案依檔名排序，依序填入「還沒有照片」的作品（編號由小到大）
//   3. 還有剩下的檔案 → 建立新作品（接在最大編號後面）
//   檔名含 avatar／大頭貼 的檔案視為該編號的「大頭貼版」（另外構圖的方形大頭貼），不會另外建立作品。
// 相機檔名如 IMG_4755 的數字不會被當成作品編號。

export interface MatchTarget {
  work_number: number;
  has_photo: boolean;
}

export interface MatchResult<F> {
  file: F;
  /** 對應的作品編號；isNew 為 true 代表要新增一款作品 */
  work_number: number;
  isNew: boolean;
  /** 由檔名辨識（true）或依序填入（false） */
  byName: boolean;
}

export function numberFromName(name: string): number | null {
  const base = name.replace(/\.[^.]+$/, "");
  const m =
    /(?:^|[^a-z])no[\s._-]*0*(\d{1,3})(?!\d)/i.exec(base) ??
    /生命共同體[\s._-]*0*(\d{1,3})(?!\d)/.exec(base) ??
    /^0*(\d{1,3})(?=[\s._-]|$)/.exec(base) ??
    // 例：bear_loves_rabbit_01_bedtime（以底線、連字號或空白隔開的 1～3 位數；IMG_4755 這類 4 位數不算）
    /[\s_-]0*(\d{1,3})(?=[\s._-]|$)/.exec(base);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 999 ? n : null;
}

export function matchLifeFiles<F extends { name: string }>(files: F[], works: MatchTarget[]): MatchResult<F>[] {
  const used = new Set<number>();
  const existing = new Set(works.map((w) => w.work_number));
  const results: (MatchResult<F> | null)[] = files.map(() => null);
  const sorted = files.map((f, i) => ({ f, i })).sort((a, b) => a.f.name.localeCompare(b.f.name, "zh-Hant", { numeric: true }));

  for (const { f, i } of sorted) {
    const n = numberFromName(f.name);
    if (n !== null && !used.has(n)) {
      used.add(n);
      results[i] = { file: f, work_number: n, isNew: !existing.has(n), byName: true };
    }
  }
  const open = works
    .filter((w) => !w.has_photo && !used.has(w.work_number))
    .map((w) => w.work_number)
    .sort((a, b) => a - b);
  let next = Math.max(0, ...works.map((w) => w.work_number), ...used) + 1;
  for (const { f, i } of sorted) {
    if (results[i]) continue;
    const n = open.shift();
    if (n !== undefined) {
      used.add(n);
      results[i] = { file: f, work_number: n, isNew: false, byName: false };
    } else {
      while (used.has(next) || existing.has(next)) next++;
      used.add(next);
      results[i] = { file: f, work_number: next, isNew: true, byName: false };
    }
  }
  return results as MatchResult<F>[];
}

/** 檔名含 avatar／頭貼 → 大頭貼版 */
export function isAvatarFile(name: string): boolean {
  return /avatar|頭貼|頭像/i.test(name);
}

/** 去掉 avatar 字樣後的檔名主幹，用來把大頭貼版與完整照片配對 */
function stem(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[\s._-]*(avatar|大頭貼|頭貼|頭像)[\s._-]*/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export interface PairedPlan<F> {
  file: F;
  work_number: number;
  isNew: boolean;
  kind: "photo" | "avatar";
}

/**
 * 批次上傳：完整照片依 matchLifeFiles 對應；大頭貼版依檔名編號，或與同名的完整照片配對，
 * 否則填入還沒有大頭貼版的作品。每個場景一筆作品，完整照片與大頭貼版各自保存、不合成。
 */
export function planBatch<F extends { name: string }>(files: F[], works: (MatchTarget & { has_avatar?: boolean })[]): PairedPlan<F>[] {
  const photos = files.filter((f) => !isAvatarFile(f.name));
  const avatars = files.filter((f) => isAvatarFile(f.name));
  const photoPlan = matchLifeFiles(photos, works);
  const byStem = new Map(photoPlan.map((p) => [stem(p.file.name), p.work_number]));
  const known = new Set([...works.map((w) => w.work_number), ...photoPlan.map((p) => p.work_number)]);
  const usedAvatar = new Set<number>();
  const out: PairedPlan<F>[] = photoPlan.map((p) => ({ file: p.file, work_number: p.work_number, isNew: p.isNew, kind: "photo" }));
  const sorted = [...avatars].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant", { numeric: true }));
  const openAvatar = works.filter((w) => !w.has_avatar).map((w) => w.work_number).sort((a, b) => a - b);
  for (const f of sorted) {
    let n = numberFromName(f.name) ?? byStem.get(stem(f.name)) ?? null;
    if (n === null || usedAvatar.has(n)) n = openAvatar.find((x) => !usedAvatar.has(x)) ?? null;
    if (n === null) n = Math.max(0, ...known) + 1;
    usedAvatar.add(n);
    out.push({ file: f, work_number: n, isNew: !known.has(n), kind: "avatar" });
    known.add(n);
  }
  return out;
}
