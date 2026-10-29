// 下載檔名處理：保留中文、移除不合法字元、避免重複檔名互相覆蓋

export function safeName(input: string, maxLen = 40): string {
  const cleaned = input
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, maxLen)
    .trim();
  return cleaned || "作品";
}

export function extFromMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "bin";
}

export function avatarFileName(platformCode: string, title: string): string {
  return `KUMA_${platformCode}_${safeName(title)}.png`;
}

export function originalFileName(title: string, mime: string): string {
  return `KUMA_原圖_${safeName(title)}.${extFromMime(mime)}`;
}

/** ZIP 內檔名：KUMA_01_作品名稱.png；同名時自動加 (2)、(3) */
export function uniqueZipNames(items: { title: string; mime_type: string }[]): string[] {
  const used = new Set<string>();
  const width = Math.max(2, String(items.length).length);
  return items.map((item, i) => {
    const base = `KUMA_${String(i + 1).padStart(width, "0")}_${safeName(item.title)}`;
    const ext = extFromMime(item.mime_type);
    let name = `${base}.${ext}`;
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${base} (${n++}).${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** 依檔案大小把 ZIP 分批，避免一次佔用太多記憶體 */
export function splitIntoParts<T extends { file_size: number }>(items: T[], maxBytes: number): T[][] {
  const parts: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length > 0 && size + item.file_size > maxBytes) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.file_size;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
