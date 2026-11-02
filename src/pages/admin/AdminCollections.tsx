import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import Modal from "../../components/Modal";
import { adminPreviewUrl } from "../../lib/admin";
import { createCollection, getOverview, listCollections, slugify, updateCollection } from "../../lib/adminCollections";
import { CARD_THEMES } from "../../lib/card";
import type { CardTheme, Collection, CollectionOverview } from "../../lib/types";
import { STATUS_LABEL } from "./AdminCollection";

/** 系列管理中心（後臺主要入口）：所有系列、作品數、公開狀態、密碼與下載狀態 */
export default function AdminCollections() {
  const navigate = useNavigate();
  const [list, setList] = useState<Collection[]>([]);
  const [stats, setStats] = useState<Map<string, CollectionOverview>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [cs, ov] = await Promise.all([listCollections(), getOverview()]);
      setList(cs);
      setStats(ov);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function move(c: Collection, dir: -1 | 1) {
    const idx = list.findIndex((x) => x.id === c.id);
    const to = idx + dir;
    if (to < 0 || to >= list.length) return;
    const ordered = [...list];
    [ordered[idx], ordered[to]] = [ordered[to], ordered[idx]];
    const renumbered = ordered.map((x, n) => ({ ...x, sort_order: (n + 1) * 10 }));
    setList(renumbered);
    setBusy(true);
    try {
      for (const x of renumbered) {
        if (list.find((o) => o.id === x.id)?.sort_order !== x.sort_order) await updateCollection(x.id, { sort_order: x.sort_order });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-lg">
      <div className="admin-title row between wrap">
        <div>
          <h1>系列管理中心</h1>
          <p className="muted">每個系列有自己的作品、身份證、宣言、收藏卡與專屬下載密碼。新增系列不需要修改程式。</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)} data-testid="new-collection">
          ＋ 新增系列
        </button>
      </div>
      {error && <p className="error card" role="alert">{error}</p>}
      {loading ? (
        <p className="muted center pad">載入中…</p>
      ) : list.length === 0 ? (
        <p className="muted card center">還沒有任何系列，按「新增系列」開始。</p>
      ) : (
        <ul className="admin-list" data-testid="collection-list">
          {list.map((c, idx) => {
            const o = stats.get(c.id);
            const cover = c.cover_path;
            const downloadOk = c.status === "published" && c.download_enabled && o?.password_enabled;
            return (
              <li key={c.id} className={`admin-item ${c.status === "published" ? "" : "draft"}`} data-testid="collection-item" data-slug={c.slug}>
                <Link className="admin-thumb" to={`/admin/collections/${c.id}`} aria-label={`管理 ${c.name}`}>
                  {cover ? <img src={adminPreviewUrl(cover)} alt="" loading="lazy" /> : <span className="pending-thumb">{c.name.slice(0, 2)}</span>}
                </Link>
                <div className="admin-item-info">
                  <strong>{c.name}</strong>
                  {c.name_en && <span className="tiny muted"> {c.name_en}</span>}
                  <div className="meta">
                    <span className={`badge ${c.status === "published" ? "ok" : c.status === "draft" ? "warn" : "gray"}`} data-testid="collection-status">
                      {STATUS_LABEL[c.status]}
                    </span>
                    <span className={`badge ${o?.password_configured ? (o.password_enabled ? "ok" : "warn") : "warn"}`} data-testid="collection-password">
                      {o?.password_configured ? (o.password_enabled ? "密碼已設定" : "密碼已停用") : "未設定密碼"}
                    </span>
                    <span className={`badge ${downloadOk ? "ok" : "gray"}`} data-testid="collection-download">
                      {downloadOk ? "可下載" : c.download_enabled ? "下載未開放" : "下載已關閉"}
                    </span>
                    <span className="badge gray">收藏卡：{CARD_THEMES[c.card_theme]?.label ?? c.card_theme}</span>
                  </div>
                  <div className="tiny muted" data-testid="collection-counts">
                    作品 {o?.work_count ?? 0} 款｜已上傳照片 {o?.photo_count ?? 0}｜已公開 {o?.published_count ?? 0}
                    ｜近 48 小時密碼驗證：成功 {o?.verify_ok_48h ?? 0}、失敗 {o?.verify_fail_48h ?? 0}
                  </div>
                </div>
                <div className="admin-actions">
                  <button className="btn small ghost" onClick={() => move(c, -1)} disabled={busy || idx === 0} aria-label="上移">↑</button>
                  <button className="btn small ghost" onClick={() => move(c, 1)} disabled={busy || idx === list.length - 1} aria-label="下移">↓</button>
                  <Link className="btn small primary" to={`/admin/collections/${c.id}`} data-testid="manage-collection">
                    管理系列
                  </Link>
                  <a className="btn small ghost" href={`#/c/${c.slug}?preview=1`} target="_blank" rel="noopener">
                    預覽 ↗
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="tiny muted">
        原本的「大頭貼收藏館」作品（首頁下方的 Facebook／Instagram／LINE 大頭貼）在 <Link to="/admin/images">大頭貼作品</Link> 管理，使用「網站設定」裡的下載密碼。
      </p>
      {creating && (
        <CreateCollectionDialog
          nextSort={list.reduce((m, c) => Math.max(m, c.sort_order), 0) + 10}
          onClose={() => setCreating(false)}
          onCreated={(c) => navigate(`/admin/collections/${c.id}`)}
        />
      )}
    </div>
  );
}

function CreateCollectionDialog({ nextSort, onClose, onCreated }: { nextSort: number; onClose: () => void; onCreated: (c: Collection) => void }) {
  const [f, setF] = useState({ name: "", name_en: "", slug: "", tagline: "", card_theme: "forest" as CardTheme, id_card_title: "熊兔合體身份證", manifesto_label: "專屬宣言" });
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const slug = slugTouched ? f.slug : f.name_en ? slugify(f.name_en) : "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const c = await createCollection({ ...f, slug: slug || slugify(""), sort_order: nextSort, status: "draft" });
      onCreated(c);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="新增系列" onClose={onClose}>
      <form className="stack" onSubmit={submit} data-testid="create-collection">
        <label className="field">
          <span>系列名稱</span>
          <input required maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="例：熊大寵妻系列" data-testid="cc-name" />
        </label>
        <label className="field">
          <span>英文名稱</span>
          <input maxLength={60} value={f.name_en} onChange={(e) => setF({ ...f, name_en: e.target.value })} placeholder="例：PAMPER MY BUNNY" data-testid="cc-name-en" />
        </label>
        <label className="field">
          <span>網址代稱（小寫英文、數字、-；粉絲網址為 #/c/代稱）</span>
          <input
            value={slug}
            pattern="[a-z0-9][a-z0-9\-]{1,40}"
            placeholder="留空會自動產生"
            onChange={(e) => {
              setSlugTouched(true);
              setF({ ...f, slug: e.target.value.toLowerCase() });
            }}
            data-testid="cc-slug"
          />
        </label>
        <label className="field">
          <span>主題標語</span>
          <input maxLength={80} value={f.tagline} onChange={(e) => setF({ ...f, tagline: e.target.value })} />
        </label>
        <div className="grid-2 tight">
          <label className="field">
            <span>身份證標題</span>
            <input required maxLength={20} value={f.id_card_title} onChange={(e) => setF({ ...f, id_card_title: e.target.value })} />
          </label>
          <label className="field">
            <span>宣言名稱</span>
            <input required maxLength={12} value={f.manifesto_label} onChange={(e) => setF({ ...f, manifesto_label: e.target.value })} />
          </label>
        </div>
        <label className="field">
          <span>收藏卡主題</span>
          <select value={f.card_theme} onChange={(e) => setF({ ...f, card_theme: e.target.value as CardTheme })} data-testid="cc-theme">
            {(Object.keys(CARD_THEMES) as CardTheme[]).map((k) => (
              <option key={k} value={k}>
                {CARD_THEMES[k].label}（{CARD_THEMES[k].hint}）
              </option>
            ))}
          </select>
        </label>
        <p className="tiny muted">新系列會先存成「草稿」。上傳作品、設定專屬下載密碼後，再到系列設定把狀態改成「公開」。</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy} data-testid="cc-submit">
            {busy ? "建立中…" : "建立系列"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
