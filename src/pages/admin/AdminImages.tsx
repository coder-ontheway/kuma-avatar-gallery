import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import AvatarEditor from "../../components/AvatarEditor";
import Modal from "../../components/Modal";
import {
  adminPreviewUrl,
  deleteImage,
  listAdminImages,
  listDownloadStats,
  totalDownloads,
  listCategories,
  publishImages,
  removePlainVersion,
  replaceImageFile,
  saveOrder,
  setPlainVersion,
  updateImage,
  uploadNewImage,
} from "../../lib/admin";
import { formatBytes } from "../../lib/filename";
import { titleFromFileName, validateFile } from "../../lib/imageProcessing";
import { matchPlainFiles } from "../../lib/plainMatch";
import { formatDate } from "../../lib/api";
import type { AdminImage, Category, DownloadStats } from "../../lib/types";

type Filter = "all" | "draft" | "published";

interface UploadItem {
  name: string;
  status: "waiting" | "uploading" | "done" | "error";
  message?: string;
}

export default function AdminImages() {
  const [images, setImages] = useState<AdminImage[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [updateDate, setUpdateDate] = useState(true);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploadCategory, setUploadCategory] = useState<string>("");
  const [uploadMonthly, setUploadMonthly] = useState(true);
  const [editing, setEditing] = useState<AdminImage | null>(null);
  const [previewing, setPreviewing] = useState<AdminImage | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<AdminImage | null>(null);
  const plainRef = useRef<HTMLInputElement>(null);
  const plainTarget = useRef<AdminImage | null>(null);
  const plainBatchRef = useRef<HTMLInputElement>(null);
  const [plainUploads, setPlainUploads] = useState<UploadItem[]>([]);
  const [stats, setStats] = useState<Map<string, DownloadStats> | null>(null);
  const [statsError, setStatsError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [imgs, cats] = await Promise.all([listAdminImages(), listCategories()]);
      setImages(imgs);
      setCategories(cats);
      setSelected(new Set(imgs.filter((i) => !i.is_published).map((i) => i.id)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // 下載次數另外讀取：讀不到時不影響作品管理
    try {
      setStats(await listDownloadStats());
      setStatsError("");
    } catch (e) {
      setStats(null);
      setStatsError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const catName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const drafts = images.filter((i) => !i.is_published);
  const shown = images.filter((i) => (filter === "all" ? true : filter === "draft" ? !i.is_published : i.is_published));
  const selectedDrafts = drafts.filter((d) => selected.has(d.id));

  function flash(text: string) {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? "" : n)), 4000);
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    const items: UploadItem[] = list.map((f) => ({ name: f.name, status: "waiting" }));
    setUploads(items);
    let order = images.reduce((m, i) => Math.max(m, i.sort_order), 0);
    const added: AdminImage[] = [];
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const setItem = (patch: Partial<UploadItem>) =>
        setUploads((u) => u.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
      const invalid = validateFile(file);
      if (invalid) {
        setItem({ status: "error", message: invalid });
        continue;
      }
      setItem({ status: "uploading" });
      try {
        order += 10;
        const img = await uploadNewImage(file, {
          title: titleFromFileName(file.name),
          category_id: uploadCategory || null,
          sort_order: order,
          is_monthly: uploadMonthly,
        });
        added.push(img);
        setItem({ status: "done" });
      } catch (e) {
        setItem({ status: "error", message: (e as Error).message });
      }
    }
    if (fileRef.current) fileRef.current.value = "";
    if (added.length > 0) {
      setImages((prev) => [...prev, ...added]);
      setSelected((s) => new Set([...s, ...added.map((a) => a.id)]));
      flash(`已上傳 ${added.length} 張草稿。請確認名稱、分類與排序後按「發布」。`);
    }
  }

  async function onReplace(files: FileList | null) {
    const target = replaceTarget.current;
    const file = files?.[0];
    if (replaceRef.current) replaceRef.current.value = "";
    if (!target || !file) return;
    await run(async () => {
      const updated = await replaceImageFile(target, file);
      setImages((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
      flash(`已替換「${updated.title}」的圖片。`);
    });
  }

  async function onPlain(files: FileList | null) {
    const target = plainTarget.current;
    const file = files?.[0];
    if (plainRef.current) plainRef.current.value = "";
    if (!target || !file) return;
    const invalid = validateFile(file);
    if (invalid) return setError(invalid);
    await run(async () => {
      const updated = await setPlainVersion(target, file);
      setImages((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
      flash(`已設定「${updated.title}」的無字版，粉絲可在編輯器選擇「拿掉文字」。`);
    });
  }

  async function onPlainBatch(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    if (plainBatchRef.current) plainBatchRef.current.value = "";
    const { matched, unmatched } = matchPlainFiles(list, images);
    const items: UploadItem[] = [
      ...matched.map((m) => ({ name: `${m.file.name} → ${m.image.title}`, status: "waiting" as const })),
      ...unmatched.map((f) => ({ name: f.name, status: "error" as const, message: "找不到同名作品" })),
    ];
    setPlainUploads(items);
    let ok = 0;
    for (let i = 0; i < matched.length; i++) {
      const { file, image } = matched[i];
      const setItem = (patch: Partial<UploadItem>) =>
        setPlainUploads((u) => u.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
      const invalid = validateFile(file);
      if (invalid) {
        setItem({ status: "error", message: invalid });
        continue;
      }
      setItem({ status: "uploading" });
      try {
        const current = images.find((x) => x.id === image.id) ?? image;
        const updated = await setPlainVersion(current, file);
        setImages((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
        setItem({ status: "done" });
        ok++;
      } catch (e) {
        setItem({ status: "error", message: (e as Error).message });
      }
    }
    if (ok > 0) flash(`已設定 ${ok} 張作品的無字版。`);
  }

  async function dropPlain(img: AdminImage) {
    if (!window.confirm(`要移除「${img.title}」的無字版嗎？粉絲將無法再選擇「拿掉文字」。`)) return;
    await run(async () => {
      const updated = await removePlainVersion(img);
      setImages((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
      flash(`已移除「${img.title}」的無字版。`);
    });
  }

  async function patch(img: AdminImage, p: Partial<AdminImage>, msg?: string) {
    await run(async () => {
      const updated = await updateImage(img.id, p);
      setImages((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
      if (msg) flash(msg);
    });
  }

  async function move(img: AdminImage, dir: -1 | 1) {
    const ordered = [...images];
    const idx = ordered.findIndex((i) => i.id === img.id);
    const to = idx + dir;
    if (to < 0 || to >= ordered.length) return;
    [ordered[idx], ordered[to]] = [ordered[to], ordered[idx]];
    const renumbered = ordered.map((i, n) => ({ ...i, sort_order: (n + 1) * 10 }));
    const changed = renumbered.filter((i) => images.find((o) => o.id === i.id)?.sort_order !== i.sort_order);
    setImages(renumbered);
    await run(() => saveOrder(changed.map((c) => ({ id: c.id, sort_order: c.sort_order }))));
  }

  async function remove(img: AdminImage) {
    if (!window.confirm(`確定要刪除「${img.title}」嗎？原圖與預覽圖都會一併刪除，無法復原。`)) return;
    await run(async () => {
      await deleteImage(img);
      setImages((prev) => prev.filter((i) => i.id !== img.id));
      flash(`已刪除「${img.title}」。`);
    });
  }

  async function publish() {
    const ids = selectedDrafts.map((d) => d.id);
    if (ids.length === 0 && !updateDate) return;
    if (!window.confirm(`確定要發布 ${ids.length} 張作品${updateDate ? "，並把最新更新日期設為今天" : ""}嗎？`)) return;
    await run(async () => {
      await publishImages(ids, updateDate);
      await load();
      flash(`已發布 ${ids.length} 張作品，粉絲現在就能看到。`);
    });
  }

  async function clearMonthly() {
    const monthly = images.filter((i) => i.is_monthly);
    if (monthly.length === 0) return;
    if (!window.confirm(`要把 ${monthly.length} 張作品移出「本月大頭貼」嗎？（作品仍會保留在全部作品中）`)) return;
    await run(async () => {
      for (const m of monthly) await updateImage(m.id, { is_monthly: false });
      await load();
      flash("已清除本月標記。");
    });
  }

  return (
    <div className="stack-lg">
      <div className="admin-title">
        <h1>作品管理</h1>
        <p className="muted">共 {images.length} 張｜已發布 {images.length - drafts.length} 張｜草稿 {drafts.length} 張</p>
      </div>

      {error && <p className="error card" role="alert">{error}</p>}
      {notice && <p className="success card" role="status">{notice}</p>}

      <section className="card stack">
        <h2>① 上傳本月新照片</h2>
        <p className="muted tiny">支援 PNG、JPG、WebP，單張 20MB 以內。上傳後先存成「草稿」，粉絲看不到，確認後再發布。原圖會存放在私有空間，粉絲需輸入下載密碼才能下載。</p>
        <div className="row wrap">
          <label className="field inline">
            <span>預設分類</span>
            <select value={uploadCategory} onChange={(e) => setUploadCategory(e.target.value)}>
              <option value="">（未分類）</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={uploadMonthly} onChange={(e) => setUploadMonthly(e.target.checked)} />
            標記為本月作品
          </label>
        </div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(e) => onFiles(e.target.files)} className="file-input" data-testid="upload-input" />
        {uploads.length > 0 && (
          <ul className="upload-list">
            {uploads.map((u, i) => (
              <li key={i} className={`up-${u.status}`}>
                <span>{u.name}</span>
                <span>
                  {u.status === "waiting" && "等待中"}
                  {u.status === "uploading" && "上傳中…"}
                  {u.status === "done" && "✓ 完成"}
                  {u.status === "error" && `✕ ${u.message}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack">
        <h2>無字版（選用）</h2>
        <p className="muted tiny">
          作品上的文字（例如「收到」）是畫在圖裡的。若另外準備一張<strong>同樣構圖但沒有文字</strong>的圖，上傳成「無字版」，粉絲就能在編輯器選擇「拿掉文字」，再加上自己的文字。無字版原圖同樣存放在私有空間，下載需要密碼。
        </p>
        <p className="muted tiny">
          批次上傳會依<strong>檔名</strong>對應作品：檔名去掉編號與「_無字」「-notext」等字尾後，要和作品名稱相同。例如作品「received」可對應「01_received_無字.png」。也可以在下方清單對單張作品按「無字版」。
        </p>
        <input ref={plainBatchRef} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(e) => onPlainBatch(e.target.files)} className="file-input" data-testid="plain-batch-input" />
        {plainUploads.length > 0 && (
          <ul className="upload-list">
            {plainUploads.map((u, i) => (
              <li key={i} className={`up-${u.status}`}>
                <span>{u.name}</span>
                <span>
                  {u.status === "waiting" && "等待中"}
                  {u.status === "uploading" && "上傳中…"}
                  {u.status === "done" && "✓ 完成"}
                  {u.status === "error" && `✕ ${u.message}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack">
        <h2>② 發布</h2>
        <p className="muted tiny">在下方清單勾選要發布的草稿（預設全選），確認名稱、分類、排序後按「發布」。</p>
        <label className="check">
          <input type="checkbox" checked={updateDate} onChange={(e) => setUpdateDate(e.target.checked)} />
          同時把網站「最新更新日期」設為今天
        </label>
        <div className="row wrap">
          <button className="btn primary" onClick={publish} disabled={busy || (selectedDrafts.length === 0 && !updateDate)}>
            發布選取的草稿（{selectedDrafts.length}）
          </button>
          <button className="btn ghost" onClick={clearMonthly} disabled={busy}>
            清除所有「本月作品」標記
          </button>
        </div>
      </section>

      <section className="stack">
        <div className="row wrap between">
          <div className="chips">
            {(["all", "draft", "published"] as Filter[]).map((f) => (
              <button key={f} className={`chip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
                {f === "all" ? "全部" : f === "draft" ? `草稿（${drafts.length}）` : "已發布"}
              </button>
            ))}
          </div>
          <button className="btn small ghost" onClick={load} disabled={loading}>重新整理</button>
        </div>
        {stats ? (
          <p className="tiny muted" data-testid="download-total">
            全部作品累計下載 {[...stats.values()].reduce((n, s) => n + totalDownloads(s), 0)} 次。每按一次下載算一次；「下載全部（ZIP）」時每張作品各算一次。
          </p>
        ) : statsError ? (
          <p className="tiny muted">下載次數暫時讀不到（{statsError}）。</p>
        ) : null}

        {loading ? (
          <p className="muted center pad">載入中…</p>
        ) : shown.length === 0 ? (
          <p className="muted center pad card">目前沒有作品，請先上傳照片。</p>
        ) : (
          <ul className="admin-list">
            {shown.map((img) => {
              const idx = images.findIndex((i) => i.id === img.id);
              return (
                <li key={img.id} className={`admin-item ${img.is_published ? "" : "draft"}`} data-testid="admin-item">
                  {!img.is_published && (
                    <input
                      type="checkbox"
                      className="select-box"
                      aria-label={`選取 ${img.title}`}
                      checked={selected.has(img.id)}
                      onChange={(e) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(img.id);
                          else n.delete(img.id);
                          return n;
                        })
                      }
                    />
                  )}
                  <button className="admin-thumb checker" onClick={() => setPreviewing(img)} aria-label={`預覽 ${img.title} 的平台裁切效果`} title="預覽不同平台的裁切效果">
                    <img src={adminPreviewUrl(img.preview_path)} alt="" loading="lazy" />
                  </button>
                  <div className="admin-item-info">
                    <strong>{img.title}</strong>
                    <div className="meta">
                      <span className={`badge ${img.is_published ? "ok" : "warn"}`}>{img.is_published ? "已發布" : "草稿"}</span>
                      {img.is_monthly && <span className="badge pink">本月</span>}
                      {!img.is_downloadable && <span className="badge gray">不可下載</span>}
                      {img.plain_preview_path && <span className="badge ok">有無字版</span>}
                      <span className="tag">{catName.get(img.category_id ?? "") ?? "未分類"}</span>
                    </div>
                    <div className="tiny muted">
                      {img.mime_type.replace("image/", "").toUpperCase()}｜{formatBytes(img.file_size)}｜{img.width}×{img.height}｜{formatDate(img.work_date)}｜排序 {img.sort_order}
                    </div>
                    {stats && <DownloadCount s={stats.get(img.id)} />}
                  </div>
                  <div className="admin-actions">
                    <button className="btn small ghost" onClick={() => move(img, -1)} disabled={busy || idx <= 0} aria-label="上移">↑</button>
                    <button className="btn small ghost" onClick={() => move(img, 1)} disabled={busy || idx >= images.length - 1} aria-label="下移">↓</button>
                    <button className="btn small ghost" onClick={() => setEditing(img)}>編輯</button>
                    <button
                      className="btn small ghost"
                      onClick={() => {
                        replaceTarget.current = img;
                        replaceRef.current?.click();
                      }}
                      disabled={busy}
                    >
                      替換
                    </button>
                    <button
                      className="btn small ghost"
                      onClick={() => {
                        plainTarget.current = img;
                        plainRef.current?.click();
                      }}
                      disabled={busy}
                      title="上傳同一張作品沒有文字的版本"
                    >
                      {img.plain_preview_path ? "換無字版" : "無字版"}
                    </button>
                    {img.plain_preview_path && (
                      <button className="btn small ghost" onClick={() => dropPlain(img)} disabled={busy}>
                        移除無字版
                      </button>
                    )}
                    <button className="btn small ghost" onClick={() => patch(img, { is_published: !img.is_published }, img.is_published ? "已改為不公開。" : "已公開。")} disabled={busy}>
                      {img.is_published ? "取消公開" : "公開"}
                    </button>
                    <button className="btn small ghost" onClick={() => patch(img, { is_downloadable: !img.is_downloadable })} disabled={busy}>
                      {img.is_downloadable ? "停止下載" : "開放下載"}
                    </button>
                    <button className="btn small ghost" onClick={() => patch(img, { is_monthly: !img.is_monthly })} disabled={busy}>
                      {img.is_monthly ? "移出本月" : "設為本月"}
                    </button>
                    <button className="btn small danger" onClick={() => remove(img)} disabled={busy}>刪除</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <input ref={replaceRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => onReplace(e.target.files)} />
      <input ref={plainRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => onPlain(e.target.files)} data-testid="plain-input" />

      {editing && (
        <EditDialog
          image={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSave={async (p) => {
            await patch(editing, p, "已儲存。");
            setEditing(null);
          }}
        />
      )}
      {previewing && (
        <AvatarEditor image={previewing} initialPlatform="facebook" downloadsEnabled={false} previewOnly onClose={() => setPreviewing(null)} />
      )}
    </div>
  );
}

function EditDialog({
  image,
  categories,
  onClose,
  onSave,
}: {
  image: AdminImage;
  categories: Category[];
  onClose: () => void;
  onSave: (p: Partial<AdminImage>) => Promise<void>;
}) {
  const [title, setTitle] = useState(image.title);
  const [description, setDescription] = useState(image.description);
  const [categoryId, setCategoryId] = useState(image.category_id ?? "");
  const [tags, setTags] = useState(image.tags.join("、"));
  const [workDate, setWorkDate] = useState(image.work_date);
  const [err, setErr] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setErr("請輸入作品名稱。");
    await onSave({
      title: title.trim(),
      description: description.trim(),
      category_id: categoryId || null,
      tags: tags.split(/[、,，\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 8),
      work_date: workDate,
    });
  }

  return (
    <Modal title="編輯作品" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>作品名稱</span>
          <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label className="field">
          <span>分類</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">（未分類）</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>描述</span>
          <textarea value={description} maxLength={500} rows={3} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          <span>標籤（以頓號或空白分隔，最多 8 個）</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="例如：早安、可愛" />
        </label>
        <label className="field">
          <span>作品日期</span>
          <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} required />
        </label>
        {err && <p className="error">{err}</p>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary">儲存</button>
        </div>
      </form>
    </Modal>
  );
}

function DownloadCount({ s }: { s: DownloadStats | undefined }) {
  const total = totalDownloads(s);
  return (
    <div className="download-count" data-testid="download-count">
      下載 <b>{total}</b> 次
      {s && total > 0 && (
        <>
          （大頭貼 {s.avatar_count}・原圖 {s.original_count}・ZIP {s.zip_count}）
          {s.last_downloaded_at && <>｜最後下載 {new Date(s.last_downloaded_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "medium", timeStyle: "short" })}</>}
        </>
      )}
    </div>
  );
}
