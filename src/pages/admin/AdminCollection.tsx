import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import Modal from "../../components/Modal";
import { CardModal, CollectionAvatarEditor } from "../../components/CollectionCard";
import { adminPreviewUrl } from "../../lib/admin";
import {
  createWork,
  deleteCollection,
  deleteWork,
  getCollection,
  getCollectionPasswordStatus,
  getLifeCollection,
  addExtraAvatar,
  removeExtraAvatar,
  removeWorkAvatar,
  setWorkAvatar,
  listAuditLog,
  listCollections,
  listWorks,
  regenerateCollectionPassword,
  removeCollectionImage,
  revokeCollectionPassword,
  saveWorkOrder,
  setCollectionImage,
  setCollectionPassword,
  setCollectionPasswordEnabled,
  setWorkPhoto,
  updateCollection,
  updateWork,
  type CollectionPasswordStatus,
} from "../../lib/adminCollections";
import { CARD_THEMES, formatNo } from "../../lib/card";
import { formatBytes } from "../../lib/filename";
import { validateFile } from "../../lib/imageProcessing";
import { planBatch } from "../../lib/lifeMatch";
import { ZONE_PAD, type ProtectZone } from "../../lib/protect";
import type { AdminCollectionWork, AuditEntry, CardTheme, Collection, CollectionStatus } from "../../lib/types";
import { actionLabel } from "./AdminLogs";

export const STATUS_LABEL: Record<CollectionStatus, string> = { draft: "草稿", published: "公開", archived: "已下架" };

/** 舊網址 #/admin/life → 第一系列的管理頁 */
export function AdminLifeRedirect() {
  const [id, setId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    getLifeCollection().then((c) => setId(c?.id ?? null), () => setId(null));
  }, []);
  if (id === undefined) return <p className="muted center pad">載入中…</p>;
  return <Navigate to={id ? `/admin/collections/${id}` : "/admin"} replace />;
}

interface PlanItem {
  file: File;
  target: number; // 作品編號
  isNew: boolean;
  /** photo：完整照片（身份證、收藏卡）；avatar：大頭貼版 */
  kind: "photo" | "avatar";
  status: "ready" | "uploading" | "done" | "error";
  message?: string;
}

export default function AdminCollection() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [collection, setCollection] = useState<Collection | null>(null);
  const [deleting, setDeleting] = useState(false);
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
  const singleTarget = useRef<{ work: AdminCollectionWork; kind: "photo" | "avatar" } | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const c = await getCollection(id);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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

  // 更新後的作品資料不含額外大頭貼，沿用畫面上已有的清單
  const replaceWork = (w: AdminCollectionWork) =>
    setWorks((prev) => prev.map((x) => (x.id === w.id ? { ...w, extra_avatars: w.extra_avatars ?? x.extra_avatars } : x)));
  const extraRef = useRef<HTMLInputElement>(null);
  const extraTarget = useRef<AdminCollectionWork | null>(null);
  const withPhoto = works.filter((w) => w.preview_path);
  const pending = works.filter((w) => !w.preview_path);
  const published = works.filter((w) => w.is_published);

  // ---------- 批次上傳 ----------
  function onBatch(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    const matched = planBatch(
      list,
      works.map((w) => ({ work_number: w.work_number, has_photo: Boolean(w.preview_path), has_avatar: Boolean(w.avatar_preview_path) })),
    );
    setPlan(
      matched.map((m) => {
        const invalid = validateFile(m.file);
        return { file: m.file, target: m.work_number, isNew: m.isNew, kind: m.kind, status: invalid ? "error" : "ready", message: invalid ?? undefined };
      }),
    );
    if (batchRef.current) batchRef.current.value = "";
  }

  function setTarget(i: number, n: number) {
    setPlan((p) => p.map((it, idx) => (idx === i ? { ...it, target: n, isNew: !works.some((w) => w.work_number === n) } : it)));
  }

  async function startBatch() {
    if (!collection) return;
    const keys = plan.filter((p) => p.status === "ready").map((p) => `${p.kind}:${p.target}`);
    if (new Set(keys).size !== keys.length) {
      setError("有兩個檔案對應到同一個編號的同一種照片，請調整後再上傳。");
      return;
    }
    const replacing = plan.filter((p) => {
      const w = works.find((x) => x.work_number === p.target);
      return p.status === "ready" && (p.kind === "photo" ? w?.preview_path : w?.avatar_preview_path);
    });
    if (replacing.length > 0 && !window.confirm(`有 ${replacing.length} 張照片會替換掉作品原本的照片。要繼續嗎？`)) return;
    setBusy(true);
    setError("");
    let ok = 0;
    let current = [...works];
    // 先上傳完整照片（建立作品），再上傳大頭貼版；同一種照片依編號由小到大，
    // 讓新建立的作品排序跟著編號走（不受手機選檔順序影響）
    const order = plan
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (a.p.kind === b.p.kind ? a.p.target - b.p.target || a.i - b.i : a.p.kind === "photo" ? -1 : 1));
    for (const { i } of order) {
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
        const updated = item.kind === "avatar" ? await setWorkAvatar(work, item.file) : await setWorkPhoto(work, item.file);
        current = current.map((w) => (w.id === updated.id ? { ...updated, extra_avatars: w.extra_avatars } : w));
        set({ status: "done" });
        ok++;
      } catch (e) {
        set({ status: "error", message: (e as Error).message });
      }
    }
    setWorks(current.sort((a, b) => a.sort_order - b.sort_order || a.work_number - b.work_number));
    setBusy(false);
    if (ok > 0) flash(`已上傳 ${ok} 張照片，依編號建立／更新為獨立作品（草稿）。確認後請按「公開」。`);
  }

  // ---------- 單張上傳／替換 ----------
  function pickSingle(w: AdminCollectionWork, kind: "photo" | "avatar" = "photo") {
    singleTarget.current = { work: w, kind };
    singleRef.current?.click();
  }

  async function onSingle(files: FileList | null) {
    const t = singleTarget.current;
    const file = files?.[0];
    if (singleRef.current) singleRef.current.value = "";
    if (!t || !file) return;
    const { work: w, kind } = t;
    const invalid = validateFile(file);
    if (invalid) return setError(invalid);
    const label = kind === "avatar" ? "大頭貼版" : "照片";
    const has = kind === "avatar" ? w.avatar_preview_path : w.preview_path;
    if (has && !window.confirm(`要把 ${formatNo(w.work_number)}「${w.nickname}」的${label}換成「${file.name}」嗎？舊檔案會刪除。`)) return;
    await run(async () => {
      replaceWork(kind === "avatar" ? await setWorkAvatar(w, file) : await setWorkPhoto(w, file));
      flash(`已上傳 ${formatNo(w.work_number)} 的${label}。`);
    });
  }

  // ---------- 額外大頭貼（同一款作品的第 2 張以後；可一次選多張） ----------
  function pickExtra(w: AdminCollectionWork) {
    extraTarget.current = w;
    extraRef.current?.click();
  }

  async function onExtra(files: FileList | null) {
    const w = extraTarget.current;
    const list = files ? [...files] : [];
    if (extraRef.current) extraRef.current.value = "";
    if (!w || list.length === 0) return;
    for (const f of list) {
      const invalid = validateFile(f);
      if (invalid) return setError(invalid);
    }
    await run(async () => {
      let work = w;
      for (const f of list) {
        const added = await addExtraAvatar(work, f);
        work = { ...work, extra_avatars: [...(work.extra_avatars ?? []), added] };
        replaceWork(work);
      }
      flash(`已替 ${formatNo(w.work_number)} 新增 ${list.length} 張大頭貼。粉絲製作大頭貼時可以切換款式。`);
    });
  }

  async function removeExtra(w: AdminCollectionWork, avatarId: string, n: number) {
    const a = w.extra_avatars?.find((x) => x.id === avatarId);
    if (!a || !window.confirm(`要移除 ${formatNo(w.work_number)} 的大頭貼 ${n} 嗎？原圖會一併刪除。`)) return;
    await run(async () => {
      await removeExtraAvatar(a);
      replaceWork({ ...w, extra_avatars: (w.extra_avatars ?? []).filter((x) => x.id !== avatarId) });
      flash(`已移除 ${formatNo(w.work_number)} 的大頭貼 ${n}。`);
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
        <Link to="/admin">← 系列管理</Link>
        <h1>找不到系列</h1>
        <p className="error">{error || "這個系列可能已被刪除。"}</p>
      </div>
    );

  return (
    <div className="stack-lg admin-life">
      <div className="admin-title">
        <Link to="/admin" className="tiny">← 系列管理中心</Link>
        <h1>{collection.name}</h1>
        <p className="muted">
          <span className={`badge ${collection.status === "published" ? "ok" : collection.status === "draft" ? "warn" : "gray"}`}>{STATUS_LABEL[collection.status]}</span>{" "}
          共 {works.length} 款｜已上傳照片 {withPhoto.length}｜待上傳 {pending.length}｜已公開 {published.length}
        </p>
        <div className="row wrap">
          <a className="btn small ghost" href={`#/c/${collection.slug}?preview=1`} target="_blank" rel="noopener">預覽粉絲頁面（含草稿）↗</a>
          <a className="btn small ghost" href={`#/c/${collection.slug}`} target="_blank" rel="noopener">粉絲實際看到的頁面 ↗</a>
        </div>
      </div>

      {error && <p className="error card" role="alert">{error}</p>}
      {notice && <p className="success card" role="status">{notice}</p>}

      <CollectionPasswordForm collection={collection} />

      <CollectionForm collection={collection} busy={busy} onSave={(p) => run(async () => {
        setCollection(await updateCollection(collection.id, p));
        flash("系列設定已儲存。");
      })} />

      <CollectionImages collection={collection} busy={busy} onChange={(kind, file) => run(async () => {
        setCollection(file ? await setCollectionImage(collection, kind, file) : await removeCollectionImage(collection, kind));
        flash(kind === "cover" ? "系列封面已更新。" : "系列主視覺已更新。");
      })} />

      <section className="card stack">
        <h2>上傳照片（可一次選多張）</h2>
        <p className="muted tiny">
          每張照片會成為<strong>一款獨立作品</strong>（各自的原圖、編號、稱號、身份證與收藏卡）。不需要先把照片合成一張。
          檔名有編號（例如 <code>No.003.jpg</code>、<code>003_星空.jpg</code>、<code>bear_loves_rabbit_03_umbrella.png</code>）會對應到該編號；其他檔案依檔名順序填入「待上傳」的作品，超出的會建立新作品。
          檔名含 <code>avatar</code> 或「大頭貼」的檔案會存成同編號作品的<strong>大頭貼版</strong>（同一場景另外構圖的方形大頭貼；完整照片用於身份證與收藏卡，大頭貼版用於製作大頭貼）。上傳前可以在下表修改對應。
        </p>
        <input ref={batchRef} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(e) => onBatch(e.target.files)} className="file-input" data-testid="life-batch-input" />
        {plan.length > 0 && (
          <>
            <ul className="upload-list" data-testid="life-plan">
              {plan.map((p, i) => (
                <li key={i} className={`up-${p.status === "ready" ? "waiting" : p.status}`}>
                  <span>
                    <span className={`badge ${p.kind === "avatar" ? "pink" : "gray"}`}>{p.kind === "avatar" ? "大頭貼版" : "完整照片"}</span> {p.file.name}（{formatBytes(p.file.size)}）
                  </span>
                  <span className="row">
                    {p.status === "ready" ? (
                      <select value={p.target} onChange={(e) => setTarget(i, Number(e.target.value))} aria-label={`${p.file.name} 對應的作品`}>
                        {[...new Set([...works.map((w) => w.work_number), ...plan.map((x) => x.target)])]
                          .sort((a, b) => a - b)
                          .map((n) => {
                            const w = works.find((x) => x.work_number === n);
                            return (
                              <option key={n} value={n}>
                                {formatNo(n)} {w ? `${w.nickname}${(p.kind === "avatar" ? w.avatar_preview_path : w.preview_path) ? "（替換）" : ""}` : "（新增作品）"}
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
        <input ref={extraRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => onExtra(e.target.files)} data-testid="extra-avatar-input" />
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
                  {w.avatar_preview_path && <span className="badge pink" data-testid="has-avatar">有大頭貼版</span>}
                  {(w.extra_avatars?.length ?? 0) > 0 && (
                    <span className="badge pink" data-testid="extra-count">共 {(w.avatar_preview_path ? 1 : 0) + w.extra_avatars!.length} 款大頭貼</span>
                  )}
                </div>
                {(w.extra_avatars?.length ?? 0) > 0 && (
                  <div className="extra-avatars" data-testid="extra-avatars">
                    {w.extra_avatars!.map((a, i) => {
                      const n = (w.avatar_preview_path ? 2 : 1) + i;
                      return (
                        <span key={a.id} className="extra-avatar">
                          <img src={adminPreviewUrl(a.preview_path)} alt={`大頭貼 ${n}`} loading="lazy" />
                          <button type="button" className="extra-avatar-remove" disabled={busy} aria-label={`移除大頭貼 ${n}`} onClick={() => removeExtra(w, a.id, n)}>×</button>
                        </span>
                      );
                    })}
                  </div>
                )}
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
                <button className="btn small ghost" onClick={() => pickSingle(w, "avatar")} disabled={busy} data-testid="avatar-upload">
                  {w.avatar_preview_path ? "替換大頭貼版" : "上傳大頭貼版"}
                </button>
                {w.avatar_preview_path && (
                  <button
                    className="btn small ghost"
                    disabled={busy}
                    onClick={() => window.confirm(`要移除 ${formatNo(w.work_number)} 的大頭貼版嗎？粉絲製作大頭貼時會改用完整照片。`) && run(async () => replaceWork(await removeWorkAvatar(w)))}
                  >
                    移除大頭貼版
                  </button>
                )}
                <button className="btn small ghost" onClick={() => pickExtra(w)} disabled={busy} data-testid="extra-avatar-add">
                  ＋ 其他款大頭貼
                </button>
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
      <CollectionLog collectionId={collection.id} />

      <section className="card stack danger-zone">
        <h2>刪除系列</h2>
        <p className="muted tiny">刪除前會請你選擇作品要「移到其他系列」或「一起刪除」，並輸入系列名稱確認。只想暫時不讓粉絲看到，請改用上方的「狀態：已下架」。</p>
        <div>
          <button className="btn danger" onClick={() => setDeleting(true)} disabled={busy} data-testid="delete-collection">
            刪除「{collection.name}」…
          </button>
        </div>
      </section>
      {deleting && (
        <DeleteCollectionDialog
          collection={collection}
          workCount={works.length}
          onClose={() => setDeleting(false)}
          onDeleted={() => navigate("/admin", { replace: true })}
        />
      )}

      {avatarFor && <CollectionAvatarEditor collection={collection} work={avatarFor} platform="facebook" downloadsEnabled={false} onClose={() => setAvatarFor(null)} previewOnly />}
      {cardFor && <CardModal collection={collection} work={cardFor} downloadsEnabled={false} onClose={() => setCardFor(null)} previewOnly />}
    </div>
  );
}

/** 系列專屬粉絲下載密碼：每個系列各自一組，互相不能通用 */
function CollectionPasswordForm({ collection }: { collection: Collection }) {
  const collectionId = collection.id;
  const [status, setStatus] = useState<CollectionPasswordStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  async function refresh() {
    setStatus(await getCollectionPasswordStatus(collectionId));
  }

  useEffect(() => {
    setGenerated(null);
    getCollectionPasswordStatus(collectionId).then(setStatus, (e) => setLoadError((e as Error).message));
  }, [collectionId]);

  async function act(fn: () => Promise<void>, ok: string) {
    setMsg(null);
    setBusy(true);
    try {
      await fn();
      setMsg({ type: "ok", text: ok });
      await refresh();
    } catch (err) {
      setMsg({ type: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw.length < 6 || pw.length > 64) return setMsg({ type: "error", text: "下載密碼長度須為 6 到 64 個字元。" });
    if (pw !== pw2) return setMsg({ type: "error", text: "兩次輸入的密碼不一致。" });
    await act(async () => {
      await setCollectionPassword(collectionId, pw);
      setPw("");
      setPw2("");
      setGenerated(null);
    }, `「${collection.name}」的下載密碼已更新。舊密碼與先前發出的下載授權已立即失效；其他系列的密碼不受影響。`);
  }

  async function regenerate() {
    if (status?.configured && !window.confirm(`要重新產生「${collection.name}」的下載密碼嗎？目前的密碼會立即失效。`)) return;
    await act(async () => {
      setGenerated(await regenerateCollectionPassword(collectionId));
    }, "已產生新密碼。這組密碼只會顯示這一次，請立即複製並透過 Messenger 提供給粉絲。");
  }

  async function toggle(enabled: boolean) {
    if (!enabled && !window.confirm(`要停用「${collection.name}」的下載密碼嗎？粉絲將無法下載這個系列（其他系列不受影響）。`)) return;
    await act(() => setCollectionPasswordEnabled(collectionId, enabled), enabled ? "已重新啟用下載密碼。" : "已停用下載密碼：粉絲目前無法下載這個系列，已驗證的授權也已失效。");
  }

  async function revoke() {
    if (!window.confirm(`要立即撤銷「${collection.name}」的下載密碼嗎？撤銷後需要設定新密碼，粉絲才能再下載。`)) return;
    await act(async () => {
      await revokeCollectionPassword(collectionId);
      setGenerated(null);
    }, "已撤銷：舊密碼與所有已發出的下載授權立即失效。請設定新密碼後再提供給粉絲。");
  }

  const state = !status ? "讀取中…" : !status.configured ? "未設定" : status.is_enabled ? "已設定・啟用中" : "已設定・已停用";

  return (
    <form className="card stack" onSubmit={submit} data-testid="collection-password-form">
      <h2>「{collection.name}」專屬下載密碼</h2>
      <p className="muted tiny" data-testid="password-state">
        目前狀態：
        {loadError ? (
          <strong className="error">{loadError}</strong>
        ) : (
          <>
            <strong className={status && status.configured && status.is_enabled ? "success" : "error"}>{state}</strong>
            {status?.configured && (
              <>（第 {status.version} 版{status.updated_at ? `，${new Date(status.updated_at).toLocaleString("zh-TW")}` : ""}{status.updated_by_name ? ` 由 ${status.updated_by_name} 更新` : ""}）</>
            )}
            {status && !status.configured && "：粉絲目前無法下載這個系列的大頭貼與收藏卡"}
          </>
        )}
      </p>
      {!collection.download_enabled && <p className="error tiny">這個系列在「系列設定」中已關閉下載，即使密碼啟用中粉絲也無法下載。</p>}
      <p className="muted tiny">
        這組密碼只用於「{collection.name}」（大頭貼、收藏卡、ZIP），和其他系列、以及原本大頭貼收藏館的密碼互相不能通用。
        密碼只以雜湊形式存放，任何人（包含管理員）都無法查看；忘記時直接設定或重新產生新密碼即可。
      </p>
      {generated && (
        <div className="generated-pw" role="status">
          <span>新密碼（只顯示這一次）：</span>
          <code data-testid="generated-password">{generated}</code>
          <button type="button" className="btn small ghost" onClick={() => navigator.clipboard?.writeText(generated).catch(() => undefined)}>
            複製
          </button>
        </div>
      )}
      <div className="grid-2">
        <label className="field">
          <span>新的下載密碼（6～64 字元）</span>
          <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} data-testid="collection-pw" />
        </label>
        <label className="field">
          <span>再輸入一次</span>
          <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} data-testid="collection-pw2" />
        </label>
      </div>
      {msg && <p className={msg.type === "ok" ? "success" : "error"} role="status">{msg.text}</p>}
      <div className="row wrap">
        <button className="btn primary" disabled={busy || Boolean(loadError)} data-testid="collection-pw-save">
          {status?.configured ? "修改下載密碼" : "設定下載密碼"}
        </button>
        <button type="button" className="btn ghost" disabled={busy || Boolean(loadError)} onClick={regenerate} data-testid="collection-pw-regenerate">
          重新產生密碼
        </button>
        {status?.configured && status.is_enabled && (
          <button type="button" className="btn ghost" disabled={busy} onClick={() => toggle(false)} data-testid="collection-pw-disable">
            停用密碼
          </button>
        )}
        {status?.configured && !status.is_enabled && (
          <button type="button" className="btn primary" disabled={busy} onClick={() => toggle(true)} data-testid="collection-pw-enable">
            重新啟用密碼
          </button>
        )}
        {status?.configured && (
          <button type="button" className="btn danger" disabled={busy} onClick={revoke} data-testid="collection-pw-revoke">
            立即撤銷
          </button>
        )}
      </div>
    </form>
  );
}

/** 系列封面與主視覺（公開圖片，最長邊 1200px） */
function CollectionImages({ collection, busy, onChange }: { collection: Collection; busy: boolean; onChange: (kind: "cover" | "hero", file: File | null) => void }) {
  const items: { kind: "cover" | "hero"; label: string; hint: string; path: string | null }[] = [
    { kind: "cover", label: "系列封面", hint: "首頁系列卡片使用（建議 4:3 或正方形）。未設定時使用第一款作品。", path: collection.cover_path },
    { kind: "hero", label: "系列主視覺", hint: "系列頁最上方的大圖。未設定時使用第一款作品。", path: collection.hero_path },
  ];
  return (
    <section className="card stack">
      <h2>系列封面與主視覺</h2>
      <div className="grid-2">
        {items.map((it) => (
          <div key={it.kind} className="stack">
            <strong>{it.label}</strong>
            <p className="tiny muted">{it.hint}</p>
            {it.path ? <img className="collection-image-thumb" src={adminPreviewUrl(it.path)} alt={it.label} data-testid={`${it.kind}-thumb`} /> : <p className="tiny muted">（尚未設定）</p>}
            <div className="row wrap">
              <label className="btn small ghost file-btn">
                {it.path ? "更換" : "上傳"}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  disabled={busy}
                  data-testid={`${it.kind}-input`}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (!f) return;
                    const invalid = validateFile(f);
                    if (invalid) return window.alert(invalid);
                    onChange(it.kind, f);
                  }}
                />
              </label>
              {it.path && (
                <button type="button" className="btn small ghost" disabled={busy} onClick={() => onChange(it.kind, null)}>
                  移除
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CollectionLog({ collectionId }: { collectionId: string }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    listAuditLog(15, collectionId).then(setRows, () => setRows([]));
  }, [collectionId]);
  return (
    <section className="card stack">
      <div className="row between wrap">
        <h2>最近的管理紀錄</h2>
        <Link className="btn small ghost" to="/admin/logs">全部紀錄</Link>
      </div>
      {!rows ? (
        <p className="muted tiny">讀取中…</p>
      ) : rows.length === 0 ? (
        <p className="muted tiny">尚無紀錄。</p>
      ) : (
        <ul className="log-list">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="tiny muted">{new Date(r.created_at).toLocaleString("zh-TW")}</span> <strong>{r.actor_name ?? "系統"}</strong> {actionLabel(r.action)}　{r.target}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 刪除系列：選擇作品的處理方式，並輸入系列名稱確認 */
export function DeleteCollectionDialog({
  collection,
  workCount,
  onClose,
  onDeleted,
}: {
  collection: Collection;
  workCount: number;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [others, setOthers] = useState<Collection[]>([]);
  const [mode, setMode] = useState<"move" | "delete">(workCount > 0 ? "move" : "delete");
  const [target, setTarget] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    listCollections().then((cs) => {
      const rest = cs.filter((c) => c.id !== collection.id);
      setOthers(rest);
      setTarget(rest[0]?.id ?? "");
      if (rest.length === 0) setMode("delete");
    }, () => undefined);
  }, [collection.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (confirm !== collection.name) return setError("請輸入完整的系列名稱以確認。");
    if (mode === "move" && !target) return setError("請選擇要移入的系列。");
    setBusy(true);
    try {
      await deleteCollection(collection, mode, mode === "move" ? target : null, confirm);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`刪除系列：${collection.name}`} onClose={onClose}>
      <form className="stack" onSubmit={submit} data-testid="delete-collection-dialog">
        <p>
          這個系列底下有 <strong>{workCount}</strong> 款作品。請選擇要怎麼處理：
        </p>
        <label className="check">
          <input type="radio" name="mode" checked={mode === "move"} disabled={others.length === 0} onChange={() => setMode("move")} />
          把作品移到其他系列（移過去都先設為草稿；編號衝突時自動接在後面）
        </label>
        {mode === "move" && (
          <label className="field">
            <span>移入的系列</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} data-testid="delete-target">
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="check">
          <input type="radio" name="mode" checked={mode === "delete"} onChange={() => setMode("delete")} data-testid="delete-mode-delete" />
          <span className="error">連同 {workCount} 款作品與照片一起永久刪除（無法復原）</span>
        </label>
        <label className="field">
          <span>請輸入系列名稱「{collection.name}」以確認</span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="delete-confirm" />
        </label>
        <p className="tiny muted">系列的專屬下載密碼會一併刪除。管理紀錄會保留。</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn danger" disabled={busy || confirm !== collection.name} data-testid="delete-submit">
            {busy ? "刪除中…" : "確認刪除系列"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CollectionForm({ collection, busy, onSave }: { collection: Collection; busy: boolean; onSave: (p: Partial<Collection>) => void }) {
  const init = () => ({
    name: collection.name,
    name_en: collection.name_en,
    slug: collection.slug,
    tagline: collection.tagline,
    description: collection.description,
    manifestos: collection.manifestos.join("\n"),
    sort_order: collection.sort_order,
    status: collection.status,
    download_enabled: collection.download_enabled,
    id_card_enabled: collection.id_card_enabled,
    card_enabled: collection.card_enabled,
    card_theme: collection.card_theme,
    id_card_title: collection.id_card_title,
    manifesto_label: collection.manifesto_label,
  });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [collection]); // eslint-disable-line react-hooks/exhaustive-deps
  function submit(e: FormEvent) {
    e.preventDefault();
    const manifestos = f.manifestos.split("\n").map((s) => s.trim()).filter(Boolean);
    if (f.status === "published" && collection.status !== "published" && !window.confirm(`要公開「${f.name}」嗎？粉絲馬上就能在首頁看到這個系列。`)) return;
    if (f.slug !== collection.slug && !window.confirm("更改網址代稱後，舊的系列網址會失效。要繼續嗎？")) return;
    const { manifestos: _m, ...rest } = f;
    onSave({ ...rest, manifestos });
  }
  return (
    <form className="card stack" onSubmit={submit} data-testid="collection-form">
      <h2>系列設定</h2>
      <div className="grid-2">
        <label className="field">
          <span>系列名稱</span>
          <input value={f.name} maxLength={40} required onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="cf-name" />
        </label>
        <label className="field">
          <span>英文名稱</span>
          <input value={f.name_en} maxLength={60} onChange={(e) => setF({ ...f, name_en: e.target.value })} />
        </label>
      </div>
      <div className="grid-2">
        <label className="field">
          <span>狀態</span>
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as CollectionStatus })} data-testid="cf-status">
            <option value="draft">草稿（只有管理員看得到）</option>
            <option value="published">公開（首頁顯示）</option>
            <option value="archived">已下架（粉絲看不到、不能下載）</option>
          </select>
        </label>
        <label className="field">
          <span>網址代稱（#/c/代稱）</span>
          <input value={f.slug} pattern="[a-z0-9][a-z0-9\-]{1,40}" required onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} />
        </label>
      </div>
      <label className="field">
        <span>系列主題標語</span>
        <input value={f.tagline} maxLength={80} onChange={(e) => setF({ ...f, tagline: e.target.value })} />
      </label>
      <label className="field">
        <span>系列介紹</span>
        <textarea rows={3} value={f.description} maxLength={1000} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </label>
      <label className="field">
        <span>這個系列的預設宣言（一行一句，每句 40 字內，最多 30 句；粉絲製作大頭貼與收藏卡時可選）</span>
        <textarea rows={6} value={f.manifestos} onChange={(e) => setF({ ...f, manifestos: e.target.value })} data-testid="life-manifestos" />
      </label>
      <div className="grid-2">
        <label className="field">
          <span>身份證標題</span>
          <input value={f.id_card_title} maxLength={20} required onChange={(e) => setF({ ...f, id_card_title: e.target.value })} data-testid="cf-idtitle" />
        </label>
        <label className="field">
          <span>宣言名稱（例：專屬愛心宣言、寵妻宣言）</span>
          <input value={f.manifesto_label} maxLength={12} required onChange={(e) => setF({ ...f, manifesto_label: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span>收藏卡主題</span>
        <select value={f.card_theme} onChange={(e) => setF({ ...f, card_theme: e.target.value as CardTheme })} data-testid="cf-theme">
          {(Object.keys(CARD_THEMES) as CardTheme[]).map((k) => (
            <option key={k} value={k}>
              {CARD_THEMES[k].label}（{CARD_THEMES[k].hint}）
            </option>
          ))}
        </select>
      </label>
      <div className="stack tight">
        <label className="check">
          <input type="checkbox" checked={f.id_card_enabled} onChange={(e) => setF({ ...f, id_card_enabled: e.target.checked })} data-testid="cf-idcard" />
          啟用身份證
        </label>
        <label className="check">
          <input type="checkbox" checked={f.card_enabled} onChange={(e) => setF({ ...f, card_enabled: e.target.checked })} data-testid="cf-card" />
          啟用收藏卡（單張與整套 ZIP）
        </label>
        <label className="check">
          <input type="checkbox" checked={f.download_enabled} onChange={(e) => setF({ ...f, download_enabled: e.target.checked })} data-testid="cf-download" />
          開放粉絲下載這個系列（關閉後後端立即拒絕下載，不影響其他系列）
        </label>
      </div>
      <label className="field inline">
        <span>系列排序（數字小的排前面）</span>
        <input type="number" value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: Number(e.target.value) })} style={{ width: 90 }} />
      </label>
      <div>
        <button className="btn primary" type="submit" disabled={busy} data-testid="cf-save">
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
          <span>作品介紹（顯示在身份證與收藏卡）</span>
          <textarea rows={3} maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </label>
        <label className="field">
          <span>主題宣言（收藏卡與大頭貼預設文字）</span>
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
