import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CardModal, CollectionAvatarEditor } from "../components/CollectionCard";
import { useDownloadAuth } from "../components/DownloadAuth";
import { collectionPath, fetchCollection, fetchSettings, previewUrl } from "../lib/api";
import { formatNo } from "../lib/card";
import { DownloadError } from "../lib/download";
import { downloadCardsZip, loadFavorites, saveFavorites, type CardZipProgress } from "../lib/collectionDownload";
import type { Collection, CollectionWork, SiteSettings } from "../lib/types";

/** 讀取網址中的系列（#/c/:slug）。系列與作品數量都來自資料庫，不寫死在程式中。 */
export function useCollectionData(slug: string, preview: boolean) {
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [collection, setCollection] = useState<Collection | null>(null);
  const [works, setWorks] = useState<CollectionWork[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [s, c] = await Promise.all([fetchSettings(), fetchCollection(slug, preview)]);
      setSettings(s);
      setCollection(c.collection);
      setWorks(c.works);
      if (c.collection) document.title = `${c.collection.name}｜KUMA STUDIO`;
    } catch {
      setError("作品資料載入失敗，請檢查網路後重新整理。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, preview]);

  return { settings, collection, works, loading, error, reload: load };
}

export function useFavorites() {
  const [favs, setFavs] = useState<Set<string>>(() => loadFavorites());
  function toggle(id: string) {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveFavorites(next);
      return next;
    });
  }
  return { favs, toggle };
}

/** 系列能否下載：全站下載開關與系列自己的下載開關都要開啟（真正的阻擋在後端） */
export function canDownload(settings: SiteSettings | null, collection: Collection | null) {
  return Boolean(settings?.downloads_enabled && collection?.download_enabled);
}

export function themeClass(collection: Collection | null) {
  return `life theme-${collection?.card_theme ?? "forest"}`;
}

export function CollectionHeader({ brand }: { brand: string }) {
  return (
    <header className="site-header life-header">
      <div className="page header-inner">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">K</span>
          <span>
            <small>{brand}</small>
            <strong>KUMA STUDIO 收藏館</strong>
          </span>
        </Link>
        <Link className="btn small ghost" to="/#series">
          ← 全部系列
        </Link>
      </div>
    </header>
  );
}

export function PreviewBanner() {
  return (
    <div className="preview-banner" role="note">
      管理員預覽模式：草稿作品也會顯示（粉絲看不到）。
    </div>
  );
}

export default function CollectionHome() {
  const { slug = "" } = useParams();
  const [params] = useSearchParams();
  const preview = params.get("preview") === "1";
  const navigate = useNavigate();
  const { settings, collection, works, loading, error, reload } = useCollectionData(slug, preview);
  const { favs, toggle } = useFavorites();
  const [onlyFavs, setOnlyFavs] = useState(false);
  const [editing, setEditing] = useState<CollectionWork | null>(null);
  const [card, setCard] = useState<CollectionWork | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const brand = settings?.brand_name ?? "KUMA 工作室";
  const downloadsEnabled = canDownload(settings, collection);
  const hero = works[0];
  const base = collection ? collectionPath(collection) : `/c/${slug}`;
  const idOn = collection?.id_card_enabled ?? true;
  const cardOn = collection?.card_enabled ?? true;
  const shown = useMemo(() => (onlyFavs ? works.filter((w) => favs.has(w.id)) : works), [works, favs, onlyFavs]);
  const q = preview ? "?preview=1" : "";

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className={`site ${themeClass(collection)}`} data-testid="collection-page" data-slug={slug}>
      <CollectionHeader brand={brand} />
      {preview && <PreviewBanner />}
      <main className="page">
        {loading && <p className="center muted pad">作品載入中…</p>}
        {error && (
          <div className="card notice center">
            <p className="error">{error}</p>
            <button type="button" className="btn primary" onClick={reload}>
              重新載入
            </button>
          </div>
        )}
        {!loading && !error && (!collection || works.length === 0) && (
          <div className="card notice center empty">
            <h1 className="life-title">{collection?.name ?? "找不到這個系列"}</h1>
            {collection?.name_en && <p className="life-en">{collection.name_en}</p>}
            <p className="muted">{collection ? "系列作品準備中，請追蹤 Facebook 粉專獲得上架通知。" : "這個系列可能尚未公開或已下架。"}</p>
            <Link className="btn primary" to="/">
              看全部系列
            </Link>
          </div>
        )}

        {collection && works.length > 0 && (
          <>
            <section className="life-hero" aria-labelledby="life-title">
              <div className="life-hero-text">
                <p className="life-eyebrow">KUMA STUDIO 原創系列｜{works.length} 款作品</p>
                <h1 id="life-title" className="life-title">
                  {collection.name}
                </h1>
                <p className="life-en">{collection.name_en}</p>
                {collection.tagline && <p className="life-tagline">「{collection.tagline}」</p>}
                {collection.description && <p className="life-desc">{collection.description}</p>}
                <div className="life-entries">
                  <button type="button" className="btn life-btn" onClick={() => scrollTo("life-works")}>
                    {idOn ? "查看身份證" : "瀏覽全部作品"}
                  </button>
                  <button type="button" className="btn life-btn primary" onClick={() => setEditing(hero)}>
                    製作宣言大頭貼
                  </button>
                  {cardOn && (
                    <button type="button" className="btn life-btn" onClick={() => scrollTo("life-cards")}>
                      收藏卡
                    </button>
                  )}
                </div>
              </div>
              {collection.hero_path ? (
                <div className="life-hero-photo">
                  <img src={previewUrl(collection.hero_path)} alt={`${collection.name} 主視覺`} data-testid="collection-hero" />
                </div>
              ) : (
                <Link to={`${base}/${hero.work_number}${q}`} className="life-hero-photo" aria-label={`查看 ${formatNo(hero.work_number)} ${hero.nickname}`}>
                  <img src={previewUrl(hero.preview_path!)} alt={`${formatNo(hero.work_number)} ${hero.nickname}`} width={hero.width ?? undefined} height={hero.height ?? undefined} />
                  <span className="life-hero-badge">
                    {formatNo(hero.work_number)}｜{hero.nickname}
                  </span>
                </Link>
              )}
            </section>

            <section id="life-works" className="section" aria-labelledby="life-works-title">
              <div className="section-head">
                <h2 id="life-works-title" className="section-title life-section-title">
                  全部 {works.length} 款作品 <small>選出你的專屬編號</small>
                </h2>
                <button type="button" className={`chip ${onlyFavs ? "active" : ""}`} aria-pressed={onlyFavs} onClick={() => setOnlyFavs(!onlyFavs)}>
                  ♥ 我的收藏（{works.filter((w) => favs.has(w.id)).length}）
                </button>
              </div>
              {onlyFavs && shown.length === 0 && <p className="muted center pad">還沒有收藏。點作品右上角的 ♡ 就能收藏喜歡的作品。</p>}
              <div className="life-grid">
                {shown.map((w) => (
                  <article key={w.id} className="life-card" data-testid="life-card">
                    <Link to={`${base}/${w.work_number}${q}`} className="life-card-photo">
                      <img src={previewUrl(w.preview_path!)} alt={`${formatNo(w.work_number)} ${w.nickname}`} loading="lazy" decoding="async" width={w.width ?? undefined} height={w.height ?? undefined} />
                      <span className="life-no">{formatNo(w.work_number)}</span>
                      {!w.is_published && <span className="badge draft">草稿</span>}
                    </Link>
                    <button type="button" className={`fav ${favs.has(w.id) ? "on" : ""}`} aria-pressed={favs.has(w.id)} aria-label={favs.has(w.id) ? "取消收藏" : "加入我的收藏"} onClick={() => toggle(w.id)}>
                      {favs.has(w.id) ? "♥" : "♡"}
                    </button>
                    <div className="life-card-info">
                      <h3 className="life-nick">{w.nickname}</h3>
                      {w.title && <p className="life-work-title">{w.title}</p>}
                      <div className="life-actions">
                        <button type="button" className="btn small ghost" onClick={() => navigate(`${base}/${w.work_number}${q}`)}>
                          {idOn ? "查看身份證" : "查看作品"}
                        </button>
                        <button type="button" className="btn small primary" onClick={() => setEditing(w)}>
                          製作大頭貼
                        </button>
                        {cardOn && (
                          <button type="button" className="btn small ghost" onClick={() => setCard(w)}>
                            收藏卡
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            {cardOn && (
            <section id="life-cards" className="section life-cards" aria-labelledby="life-cards-title">
              <div className="section-head">
                <h2 id="life-cards-title" className="section-title life-section-title">
                  {collection.name}收藏卡 <small>{works.length} 張一套</small>
                </h2>
              </div>
              <p className="muted">每一款都有自己的收藏卡（1200 × 1800 高畫質圖片）。可以單張下載、勾選多張下載，或一次下載完整一套 ZIP。下載需要「{collection.name}」的專屬下載密碼（其他系列的密碼不能使用）。</p>
              <div className="row wrap">
                <button type="button" className={`btn small ${selectMode ? "primary" : "ghost"}`} onClick={() => setSelectMode(!selectMode)} aria-pressed={selectMode}>
                  {selectMode ? "完成選擇" : "選擇多張"}
                </button>
                {selectMode && (
                  <button type="button" className="btn small ghost" onClick={() => setSelected(selected.size === works.length ? new Set() : new Set(works.map((w) => w.id)))}>
                    {selected.size === works.length ? "全部取消" : "全選"}
                  </button>
                )}
              </div>
              <div className="card-strip">
                {works.map((w) => {
                  const on = selected.has(w.id);
                  return (
                    <div key={w.id} className={`mini-card ${selectMode && on ? "selected" : ""}`}>
                      <button
                        type="button"
                        className="mini-card-btn"
                        data-testid="mini-card"
                        aria-pressed={selectMode ? on : undefined}
                        onClick={() => {
                          if (!selectMode) return setCard(w);
                          const next = new Set(selected);
                          if (on) next.delete(w.id);
                          else next.add(w.id);
                          setSelected(next);
                        }}
                      >
                        <img src={previewUrl(w.preview_path!)} alt="" loading="lazy" />
                        <span className="mini-card-no">{formatNo(w.work_number)}</span>
                        <span className="mini-card-nick">{w.nickname}</span>
                        {selectMode && <span className="mini-check" aria-hidden="true">{on ? "✓" : ""}</span>}
                      </button>
                    </div>
                  );
                })}
              </div>
              <CardZipButtons
                collection={collection}
                works={works}
                selected={selectMode ? [...selected] : []}
                downloadsEnabled={downloadsEnabled}
                disabled={preview}
              />
            </section>
            )}
          </>
        )}
      </main>

      <footer className="site-footer">
        <div className="page">
          <p>
            © {new Date().getFullYear()} {brand}　KUMA STUDIO｜{collection?.name ?? "原創系列"}為 {brand} 原創角色作品
          </p>
          {settings?.facebook_url && (
            <a href={settings.facebook_url} target="_blank" rel="noopener noreferrer">
              追蹤 Facebook 粉專
            </a>
          )}
        </div>
      </footer>

      {editing && collection && (
        <CollectionAvatarEditor collection={collection} work={editing} platform="facebook" downloadsEnabled={downloadsEnabled} onClose={() => setEditing(null)} previewOnly={preview} />
      )}
      {card && collection && <CardModal collection={collection} work={card} downloadsEnabled={downloadsEnabled} onClose={() => setCard(null)} previewOnly={preview} />}
    </div>
  );
}

function CardZipButtons({
  collection,
  works,
  selected,
  downloadsEnabled,
  disabled,
}: {
  collection: Collection;
  works: CollectionWork[];
  selected: string[];
  downloadsEnabled: boolean;
  disabled: boolean;
}) {
  const { ensureAuth } = useDownloadAuth();
  const [progress, setProgress] = useState<CardZipProgress | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  async function run(ids: string[] | "all") {
    setMsg(null);
    if (!downloadsEnabled) {
      setMsg({ type: "error", text: "目前暫停開放下載，請留意粉專公告。" });
      return;
    }
    if (ids !== "all" && ids.length === 0) {
      setMsg({ type: "error", text: "請先點「選擇多張」，再勾選想要的收藏卡。" });
      return;
    }
    if (!(await ensureAuth(collection.id, collection.name))) return;
    setProgress({ done: 0, total: 0 });
    try {
      let r;
      try {
        r = await downloadCardsZip(collection, works, ids, setProgress);
      } catch (e) {
        if (e instanceof DownloadError && e.code === "token_invalid" && (await ensureAuth(collection.id, collection.name))) r = await downloadCardsZip(collection, works, ids, setProgress);
        else throw e;
      }
      setMsg(
        r.failed.length
          ? { type: "error", text: `已打包 ${r.files} 張；以下收藏卡失敗，請稍後再試：${r.failed.join("、")}` }
          : { type: "ok", text: `已完成！共 ${r.files} 張收藏卡。` },
      );
    } catch (e) {
      setMsg({ type: "error", text: e instanceof DownloadError ? e.message : "打包失敗，請稍後再試。" });
    } finally {
      setProgress(null);
    }
  }

  const label = progress ? (progress.total ? `製作中 ${progress.done}/${progress.total}` : "準備中…") : null;
  return (
    <div className="stack zip-row">
      <div className="row wrap">
        <button type="button" className="btn ghost" onClick={() => run(selected)} disabled={progress !== null || disabled}>
          下載已選收藏卡（{selected.length} 張，ZIP）
        </button>
        <button type="button" className="btn primary" onClick={() => run("all")} disabled={progress !== null || disabled}>
          {label ?? `下載完整 ${works.length} 張收藏卡（ZIP）`}
        </button>
      </div>
      {disabled && <p className="tiny muted">預覽模式不提供下載。</p>}
      {msg && (
        <p className={msg.type === "ok" ? "success" : "error"} role="status">
          {msg.text}
        </p>
      )}
    </div>
  );
}
