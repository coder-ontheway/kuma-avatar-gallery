import { useEffect, useRef, useState, type FormEvent } from "react";
import Modal from "../../components/Modal";
import { CardModal, LifeAvatarEditor } from "../../components/LifeCard";
import { adminPreviewUrl } from "../../lib/admin";
import {
  createWork,
  deleteWork,
  getLifeCollection,
  listWorks,
  saveWorkOrder,
  setWorkPhoto,
  updateCollection,
  updateWork,
} from "../../lib/adminLife";
import { formatNo } from "../../lib/card";
import { formatBytes } from "../../lib/filename";
import { validateFile } from "../../lib/imageProcessing";
import { matchLifeFiles } from "../../lib/lifeMatch";
import { ZONE_PAD, type ProtectZone } from "../../lib/protect";
import type { AdminCollectionWork, Collection } from "../../lib/types";

interface PlanItem {
  file: File;
  target: number; // 作品編號
  isNew: boolean;
  status: "ready" | "uploading" | "done" | "error";
  message?: string;
}

export default function AdminLife() {
  const [collection, setCollection] = useState<Collection | null>(null);
  const [works, setWorks] = useState<AdminCollectionWork[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [editing, setEditing] = useState<AdminCollectionWork | null>(null);
  const [zonesFor, setZonesFor] = useState<AdminCollectionWork | null>(null);
  const [avatarFor, setAvatarFor] = useState<AdminCollectionWork | null>(null);
  const [cardFor, setCardFor] = useState<AdminCollectionWork | null>(null);
  const batchRef = useRef<HTMLInputElement>(null);
  const singleRef = useRef<HTMLInputElement>(null);
  const singleTarget = useRef<AdminCollectionWork | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const c = await getLifeCollection();
      setCollection(c);
      setWorks(c ? await listWorks(c.id) : []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function flash(text: string) {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? "" : n)), 5000);
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

  const replaceWork = (w: AdminCollectionWork) => setWorks((prev) => prev.map((x) => (x.id === w.id ? w : x)));
  const withPhoto = works.filter((w) => w.preview_path);
  const pending = works.filter((w) => !w.preview_path);
  const published = works.filter((w) => w.is_published);

  // ---------- 批次上傳 ----------
  function onBatch(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    const matched = matchLifeFiles(list, works.map((w) => ({ work_number: w.work_number, has_photo: Boolean(w.preview_path) })));
    setPlan(
      matched.map((m) => {
        const invalid = validateFile(m.file);
        return { file: m.file, target: m.work_number, isNew: m.isNew, status: invalid ? "error" : "ready", message: invalid ?? undefined };
      }),
    );
    if (batchRef.current) batchRef.current.value = "";
  }

  function setTarget(i: number, n: number) {
    setPlan((p) => p.map((it, idx) => (idx === i ? { ...it, target: n, isNew: !works.some((w) => w.work_number === n) } : it)));
  }

  async function startBatch() {
    if (!collection) return;
    const nums = plan.filter((p) => p.status === "ready").map((p) => p.target);
    if (new Set(nums).size !== nums.length) {
      setError("有兩個檔案對應到同一個編號，請調整後再上傳。");
      return;
    }
    const replacing = plan.filter((p) => p.status === "ready" && works.find((w) => w.work_number === p.target)?.preview_path);
    if (replacing.length > 0 && !window.confirm(`有 ${replacing.length} 款作品已經有照片，上傳後會替換成新照片。要繼續嗎？`)) return;
    setBusy(true);
    setError("");
    let ok = 0;
    let current = [...works];
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      if (item.status !== "ready") continue;
      const set = (patch: Partial<PlanItem>) => setPlan((p) => p.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
      set({ status: "uploading" });
      try {
        let work = current.find((w) => w.work_number === item.target);
        if (!work) {
          const maxSort = current.reduce((m, w) => Math.max(m, w.sort_order), 0);
          work = await createWork(collection.id, { work_number: item.target, nickname: `新作品 ${formatNo(item.target)}`, sort_order: maxSort + 10 });
          current = [...current, work];
        }
        const updated = await setWorkPhoto(work, item.file);
        current = current.map((w) => (w.id === updated.id ? updated : w));
        set({ status: "done" });
        ok++;
      } catch (e) {
        set({ status: "error", message: (e as Error).message });
      }
    }
    setWorks(current.sort((a, b) => a.sort_order - b.sort_order || a.work_number - b.work_number));
    setBusy(false);
    if (ok > 0) flash(`已上傳 ${ok} 張照片，各自建立／更新為獨立作品（草稿）。確認後請按「公開」。`);
  }

  // ---------- 單張上傳／替換 ----------
  function pickSingle(w: AdminCollectionWork) {
    singleTarget.current = w;
    singleRef.current?.click();
  }

  async function onSingle(files: FileList | null) {
    const w = singleTarget.current;
    const file = files?.[0];
    if (singleRef.current) singleRef.current.value = "";
    if (!w || !file) return;
    const invalid = validateFile(file);
    if (invalid) return setError(invalid);
    if (w.preview_path && !window.confirm(`要把 ${formatNo(w.work_number)}「${w.nickname}」的照片換成「${file.name}」嗎？舊照片會刪除。`)) return;
    await run(async () => {
      replaceWork(await setWorkPhoto(w, file));
      flash(`已上傳 ${formatNo(w.work_number)} 的照片。`);
    });
  }

  async function patch(w: AdminCollectionWork, p: Partial<AdminCollectionWork>, msg?: string) {
    await run(async () => {
      replaceWork(await updateWork(w.id, p));
      if (msg) flash(msg);
    });
  }

  async function publishAllReady() {
    const ready = works.filter((w) => w.preview_path && !w.is_published);
    if (ready.length === 0) return;
    if (!window.confirm(`要公開 ${ready.length} 款已上傳照片的作品嗎？粉絲馬上就能看到。`)) return;
    await run(async () => {
      for (const w of ready) replaceWork(await updateWork(w.id, { is_published: true }));
      flash(`已公開 ${ready.length} 款作品。`);
    });
  }

  async function move(w: AdminCollectionWork, dir: -1 | 1) {
    const ordered = [...works];
    const idx = ordered.findIndex((x) => x.id === w.id);
    const to = idx + dir;
    if (to < 0 || to >= ordered.length) return;
    [ordered[idx], ordered[to]] = [ordered[to], ordered[idx]];
    const renumbered = ordered.map((x, n) => ({ ...x, sort_order: (n + 1) * 10 }));
    const changed = renumbered.filter((x) => works.find((o) => o.id === x.id)?.sort_order !== x.sort_order);
    setWorks(renumbered);
    await run(() => saveWorkOrder(changed.map((c) => ({ id: c.id, sort_order: c.sort_order }))));
  }

  async function remove(w: AdminCollectionWork) {
    if (!window.confirm(`確定要刪除 ${formatNo(w.work_number)}「${w.nickname}」嗎？資料與照片都會刪除，無法復原。`)) return;
    await run(async () => {
      await deleteWork(w);
      setWorks((prev) => prev.filter((x) => x.id !== w.id));
      flash(`已刪除 ${formatNo(w.work_number)}。`);
    });
  }

  async function addWork() {
    if (!collection) return;
    const n = works.reduce((m, w) => Math.max(m, w.work_number), 0) + 1;
    const sort = works.reduce((m, w) => Math.max(m, w.sort_order), 0) + 10;
    await run(async () => {
      const w = await createWork(collection.id, { work_number: n, nickname: `新作品 ${formatNo(n)}`, sort_order: sort });
      setWorks((prev) => [...prev, w]);
      setEditing(w);
    });
  }

  if (loading) return <p className="muted center pad">載入中…</p>;
  if (!collection)
    return (
      <div className="card stack">
        <h1>熊兔生命共同體</h1>
        <p className="error">{error || "找不到系列資料。請先在 Supabase SQL Editor 執行 supabase/migrations/20261101000000_life_collection.sql。"}</p>
      </div>
    );

  return (
    <div className="stack-lg admin-life">
      <div className="admin-title">
        <h1>熊兔生命共同體</h1>
        <p className="muted">
          共 {works.length} 款｜已上傳照片 {withPhoto.length}｜待上傳 {pending.length}｜已公開 {published.length}
        </p>
        <div className="row wrap">
          <a className="btn small ghost" href="#/life?preview=1" target="_blank" rel="noopener">預覽粉絲頁面（含草稿）↗</a>
          <a className="btn small ghost" href="#/life" target="_blank" rel="noopener">粉絲實際看到的頁面 ↗</a>
        </div>
      </div>

      {error && <p className="error card" role="alert">{error}</p>}
      {notice && <p className="success card" role="status">{notice}</p>}

      <CollectionForm collection={collection} busy={busy} onSave={(p) => run(async () => {
        setCollection(await updateCollection(collection.id, p));
        flash("系列設定已儲存。");
      })} />

      <section className="card stack">
        <h2>上傳照片（可一次選多張）</h2>
        <p className="muted tiny">
          每張照片會成為<strong>一款獨立作品</strong>（各自的原圖、編號、稱號、身份證與收藏卡）。不需要先把照片合成一張。
          檔名有編號（例如 <code>No.003.jpg</code>、<code>003_星空.jpg</code>）會對應到該編號；其他檔案依檔名順序填入「待上傳」的作品，超出的會建立新作品。上傳前可以在下表修改對應。
        </p>
        <input ref={batchRef} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(e) => onBatch(e.target.files)} className="file-input" data-testid="life-batch-input" />
        {plan.length > 0 && (
          <>
            <ul className="upload-list" data-testid="life-plan">
              {plan.map((p, i) => (
                <li key={i} className={`up-${p.status === "ready" ? "waiting" : p.status}`}>
                  <span>{p.file.name}（{formatBytes(p.file.size)}）</span>
                  <span className="row">
                    {p.status === "ready" ? (
                      <select value={p.target} onChange={(e) => setTarget(i, Number(e.target.value))} aria-label={`${p.file.name} 對應的作品`}>
                        {[...works.map((w) => w.work_number), ...(p.isNew ? [p.target] : [])]
                          .sort((a, b) => a - b)
                          .map((n) => {
                            const w = works.find((x) => x.work_number === n);
                            return (
                              <option key={n} value={n}>
                                {formatNo(n)} {w ? `${w.nickname}${w.preview_path ? "（替換）" : ""}` : "（新增作品）"}
                              </option>
                            );
                          })}
                      </select>
                    ) : p.status === "uploading" ? (
                      "上傳中…"
                    ) : p.status === "done" ? (
                      `✓ ${formatNo(p.target)} 完成`
                    ) : (
                      `✕ ${p.message}`
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="row wrap">
              <button className="btn primary" onClick={startBatch} disabled={busy || !plan.some((p) => p.status === "ready")} data-testid="life-batch-start">
                開始上傳（{plan.filter((p) => p.status === "ready").length} 張）
              </button>
              <button className="btn ghost" onClick={() => setPlan([])} disabled={busy}>
                清除清單
              </button>
            </div>
          </>
        )}
        <input ref={singleRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => onSingle(e.target.files)} data-testid="life-single-input" />
      </section>

      <section className="stack">
        <div className="row wrap between">
          <h2>作品清單</h2>
          <div className="row wrap">
            <button className="btn small primary" onClick={publishAllReady} disabled={busy || !works.some((w) => w.preview_path && !w.is_published)}>
              公開所有已上傳的草稿
            </button>
            <button className="btn small ghost" onClick={addWork} disabled={busy}>
              ＋ 新增一款
            </button>
            <button className="btn small ghost" onClick={load} disabled={busy}>
              重新整理
            </button>
          </div>
        </div>
        <ul className="admin-list">
          {works.map((w, idx) => (
            <li key={w.id} className={`admin-item ${w.is_published ? "" : "draft"}`} data-testid="life-admin-item">
              {w.preview_path ? (
                <button className="admin-thumb" onClick={() => setAvatarFor(w)} title="預覽大頭貼裁切" aria-label={`預覽 ${w.nickname} 的大頭貼`}>
                  <img src={adminPreviewUrl(w.preview_path)} alt="" loading="lazy" />
                </button>
              ) : (
                <button className="admin-thumb pending-thumb" onClick={() => pickSingle(w)} aria-label={`上傳 ${formatNo(w.work_number)} 的照片`}>
                  待上傳
                </button>
              )}
              <div className="admin-item-info">
                <strong>
                  {formatNo(w.work_number)}｜{w.nickname}
                </strong>
                <div className="meta">
                  <span className={`badge ${w.is_published ? "ok" : "warn"}`}>{w.is_published ? "已公開" : w.preview_path ? "草稿" : "待上傳"}</span>
                  {!w.is_downloadable && <span className="badge gray">不可下載</span>}
                  {w.protect_zones.length === 0 && w.preview_path && <span className="badge warn">未設保護區域</span>}
                </div>
                <div className="tiny muted">
                  {w.title || "（未填作品名稱）"}｜宣言：{w.manifesto || "（未填）"}
                </div>
                {w.preview_path && (
                  <div className="tiny muted">
                    {w.mime_type?.replace("image/", "").toUpperCase()}｜{formatBytes(w.file_size ?? 0)}｜{w.width}×{w.height}｜排序 {w.sort_order}
                  </div>
                )}
              </div>
              <div className="admin-actions">
                <button className="btn small ghost" onClick={() => move(w, -1)} disabled={busy || idx <= 0} aria-label="上移">↑</button>
                <button className="btn small ghost" onClick={() => move(w, 1)} disabled={busy || idx >= works.length - 1} aria-label="下移">↓</button>
                <button className="btn small ghost" onClick={() => setEditing(w)}>編輯資料</button>
                <button className="btn small ghost" onClick={() => pickSingle(w)} disabled={busy}>{w.preview_path ? "替換照片" : "上傳照片"}</button>
                {w.preview_path && (
                  <>
                    <button className="btn small ghost" onClick={() => setZonesFor(w)}>保護區域</button>
                    <button className="btn small ghost" onClick={() => setCardFor(w)}>預覽收藏卡</button>
                  </>
                )}
                <button
                  className={`btn small ${w.is_published ? "ghost" : "primary"}`}
                  onClick={() => patch(w, { is_published: !w.is_published }, w.is_published ? `已下架 ${formatNo(w.work_number)}。` : `已公開 ${formatNo(w.work_number)}。`)}
                  disabled={busy || (!w.is_published && !w.preview_path)}
                  title={!w.preview_path ? "請先上傳照片" : ""}
                >
                  {w.is_published ? "下架" : "公開"}
                </button>
                <button className="btn small danger" onClick={() => remove(w)} disabled={busy}>刪除</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {editing && (
        <WorkForm
          work={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(p) =>
            run(async () => {
              replaceWork(await updateWork(editing.id, p));
              setEditing(null);
              flash("作品資料已儲存。");
            })
          }
        />
      )}
      {zonesFor && (
        <ZoneEditor
          work={zonesFor}
          busy={busy}
          onClose={() => setZonesFor(null)}
          onSave={(zones) =>
            run(async () => {
              replaceWork(await updateWork(zonesFor.id, { protect_zones: zones }));
              setZonesFor(null);
              flash("保護區域已儲存。");
            })
          }
        />
      )}
      {avatarFor && <LifeAvatarEditor collection={collection} work={avatarFor} platform="facebook" downloadsEnabled={false} onClose={() => setAvatarFor(null)} previewOnly />}
      {cardFor && <CardModal collection={collection} work={cardFor} downloadsEnabled={false} onClose={() => setCardFor(null)} previewOnly />}
    </div>
  );
}

function CollectionForm({ collection, busy, onSave }: { collection: Collection; busy: boolean; onSave: (p: Partial<Collection>) => void }) {
  const [f, setF] = useState({
    name: collection.name,
    name_en: collection.name_en,
    tagline: collection.tagline,
    description: collection.description,
    manifestos: collection.manifestos.join("\n"),
    sort_order: collection.sort_order,
    is_published: collection.is_published,
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const manifestos = f.manifestos.split("\n").map((s) => s.trim()).filter(Boolean);
    onSave({ ...f, manifestos });
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <h2>系列設定</h2>
      <div className="grid-2">
        <label className="field">
          <span>系列名稱</span>
          <input value={f.name} maxLength={40} required onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="field">
          <span>英文名稱</span>
          <input value={f.name_en} maxLength={60} onChange={(e) => setF({ ...f, name_en: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span>系列主題句</span>
        <input value={f.tagline} maxLength={80} onChange={(e) => setF({ ...f, tagline: e.target.value })} />
      </label>
      <label className="field">
        <span>系列說明</span>
        <textarea rows={3} value={f.description} maxLength={1000} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </label>
      <label className="field">
        <span>粉絲可選的預設宣言（一行一句，每句 40 字內，最多 30 句）</span>
        <textarea rows={6} value={f.manifestos} onChange={(e) => setF({ ...f, manifestos: e.target.value })} data-testid="life-manifestos" />
      </label>
      <div className="row wrap">
        <label className="field inline">
          <span>系列排序</span>
          <input type="number" value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: Number(e.target.value) })} style={{ width: 90 }} />
        </label>
        <label className="check">
          <input type="checkbox" checked={f.is_published} onChange={(e) => setF({ ...f, is_published: e.target.checked })} />
          公開這個系列（關閉時首頁不顯示入口，粉絲也無法瀏覽或下載）
        </label>
      </div>
      <div>
        <button className="btn primary" type="submit" disabled={busy}>
          儲存系列設定
        </button>
      </div>
    </form>
  );
}

function WorkForm({ work, busy, onClose, onSave }: { work: AdminCollectionWork; busy: boolean; onClose: () => void; onSave: (p: Partial<AdminCollectionWork>) => void }) {
  const [f, setF] = useState({
    work_number: work.work_number,
    nickname: work.nickname,
    title: work.title,
    theme: work.theme,
    description: work.description,
    manifesto: work.manifesto,
    sort_order: work.sort_order,
    is_downloadable: work.is_downloadable,
  });
  return (
    <Modal title={`編輯 ${formatNo(work.work_number)}`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(f);
        }}
      >
        <div className="grid-2 tight">
          <label className="field">
            <span>作品編號（No.）</span>
            <input type="number" min={1} max={999} required value={f.work_number} onChange={(e) => setF({ ...f, work_number: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>排序</span>
            <input type="number" value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: Number(e.target.value) })} />
          </label>
        </div>
        <label className="field">
          <span>專屬稱號</span>
          <input required maxLength={30} value={f.nickname} onChange={(e) => setF({ ...f, nickname: e.target.value })} />
        </label>
        <label className="field">
          <span>作品名稱</span>
          <input maxLength={60} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </label>
        <label className="field">
          <span>主題概念</span>
          <input maxLength={100} value={f.theme} onChange={(e) => setF({ ...f, theme: e.target.value })} />
        </label>
        <label className="field">
          <span>生命共同體介紹（顯示在身份證與收藏卡）</span>
          <textarea rows={3} maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </label>
        <label className="field">
          <span>專屬愛心宣言（收藏卡與大頭貼預設文字）</span>
          <input maxLength={60} value={f.manifesto} onChange={(e) => setF({ ...f, manifesto: e.target.value })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={f.is_downloadable} onChange={(e) => setF({ ...f, is_downloadable: e.target.checked })} />
          開放粉絲下載（大頭貼與收藏卡）
        </label>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            儲存
          </button>
        </div>
      </form>
    </Modal>
  );
}

const ZONE_SLIDERS: { key: keyof Omit<ProtectZone, "label">; label: string }[] = [
  { key: "x", label: "左" },
  { key: "y", label: "上" },
  { key: "w", label: "寬" },
  { key: "h", label: "高" },
];

/** 保護區域編輯：標出臉、耳朵與胸口愛心；粉絲的文字會自動避開，裁切也不會切掉這些區域 */
function ZoneEditor({ work, busy, onClose, onSave }: { work: AdminCollectionWork; busy: boolean; onClose: () => void; onSave: (z: ProtectZone[]) => void }) {
  const [zones, setZones] = useState<ProtectZone[]>(
    work.protect_zones.length ? work.protect_zones : [{ label: "臉與耳朵", x: 0.3, y: 0.1, w: 0.4, h: 0.4 }, { label: "胸口愛心", x: 0.43, y: 0.52, w: 0.14, h: 0.12 }],
  );
  const [sel, setSel] = useState(0);
  const set = (i: number, p: Partial<ProtectZone>) => setZones((zs) => zs.map((z, k) => (k === i ? { ...z, ...p } : z)));
  const aspect = (work.width ?? 1) / (work.height ?? 1);
  return (
    <Modal title={`保護區域：${formatNo(work.work_number)} ${work.nickname}`} onClose={onClose} wide>
      <div className="zone-editor">
        <div className="zone-stage" style={{ aspectRatio: String(aspect) }}>
          <img src={adminPreviewUrl(work.preview_path!)} alt="" />
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {zones.map((z, i) => (
              <g key={i} className={i === sel ? "zone sel" : "zone"}>
                <rect x={z.x * 100} y={z.y * 100} width={z.w * 100} height={z.h * 100} />
                <ellipse cx={(z.x + z.w / 2) * 100} cy={(z.y + z.h / 2) * 100} rx={(z.w / 2) * 100 * ZONE_PAD} ry={(z.h / 2) * 100} />
              </g>
            ))}
          </svg>
        </div>
        <div className="stack">
          <p className="tiny muted">
            用滑桿把框框對準<strong>臉與兩邊耳朵</strong>、<strong>胸口愛心</strong>。粉絲的文字會自動避開這些區域，三個平台的裁切也不會切掉它們（以虛線橢圓計算）。
          </p>
          <div className="row wrap">
            {zones.map((z, i) => (
              <button key={i} type="button" className={`chip small ${i === sel ? "active" : ""}`} onClick={() => setSel(i)}>
                {z.label || `區域 ${i + 1}`}
              </button>
            ))}
            <button type="button" className="btn small ghost" disabled={zones.length >= 6} onClick={() => { setZones([...zones, { label: "新區域", x: 0.4, y: 0.4, w: 0.2, h: 0.2 }]); setSel(zones.length); }}>
              ＋ 新增區域
            </button>
          </div>
          {zones[sel] && (
            <div className="stack">
              <label className="field">
                <span>名稱</span>
                <input value={zones[sel].label} maxLength={20} onChange={(e) => set(sel, { label: e.target.value })} />
              </label>
              {ZONE_SLIDERS.map(({ key, label }) => (
                <label key={key} className="field">
                  <span>{label}（{Math.round(zones[sel][key] * 100)}%）</span>
                  <input type="range" min={key === "w" || key === "h" ? 0.02 : 0} max={1} step={0.005} value={zones[sel][key]} onChange={(e) => set(sel, { [key]: Number(e.target.value) })} />
                </label>
              ))}
              <button type="button" className="btn small danger" onClick={() => { setZones(zones.filter((_, k) => k !== sel)); setSel(0); }}>
                刪除這個區域
              </button>
            </div>
          )}
          <div className="row end">
            <button type="button" className="btn ghost" onClick={onClose}>取消</button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => onSave(zones.map((z) => ({ ...z, w: Math.min(z.w, 1 - z.x), h: Math.min(z.h, 1 - z.y) })))}>
              儲存保護區域
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
