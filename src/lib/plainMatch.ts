// 批次上傳無字版：依檔名對應到既有作品
//   例如「01_received_無字.png」「received-notext.png」都會對應到名稱為「received」的作品
import { titleFromFileName } from "./imageProcessing";

const PLAIN_SUFFIX = /[\s_\-（(]*(無字版?|无字版?|去字|沒字|notext|no[\s_\-]?text|plain|blank)[)）]?$/i;

function norm(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\s_\-]+/g, " ").trim();
}

export function plainTitleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").replace(PLAIN_SUFFIX, "");
  return titleFromFileName(base);
}

export function matchPlainFiles<F extends { name: string }, I extends { id: string; title: string }>(
  files: F[],
  images: I[],
): { matched: { file: F; image: I }[]; unmatched: F[] } {
  const byTitle = new Map<string, I>();
  for (const img of images) if (!byTitle.has(norm(img.title))) byTitle.set(norm(img.title), img);
  const matched: { file: F; image: I }[] = [];
  const unmatched: F[] = [];
  const used = new Set<string>();
  for (const file of files) {
    const img = byTitle.get(norm(plainTitleFromFileName(file.name)));
    if (img && !used.has(img.id)) {
      matched.push({ file, image: img });
      used.add(img.id);
    } else unmatched.push(file);
  }
  return { matched, unmatched };
}
