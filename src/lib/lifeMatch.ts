// 批次上傳時，把多個檔案對應到系列中的作品編號。
// 規則（依序）：
//   1. 檔名有明確編號，例如「No.003」「no_3」「NO-010」「生命共同體003」或開頭「003_」「3-」→ 對應該編號
//   2. 其餘檔案依檔名排序，依序填入「還沒有照片」的作品（編號由小到大）
//   3. 還有剩下的檔案 → 建立新作品（接在最大編號後面）
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
    /^0*(\d{1,3})(?=[\s._-]|$)/.exec(base);
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
