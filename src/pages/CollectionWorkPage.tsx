import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { CardModal, CollectionAvatarEditor, IdCard } from "../components/CollectionCard";
import { previewUrl } from "../lib/api";
import { formatNo } from "../lib/card";
import { PLATFORM_LABEL, type Platform } from "../lib/crop";
import { canDownload, CollectionHeader, PreviewBanner, themeClass, useCollectionData, useFavorites } from "./CollectionHome";

/** 系列中單一作品的獨立頁面：身份證（可由系列關閉）、製作大頭貼、收藏卡 */
export default function CollectionWorkPage() {
  const { slug = "", no } = useParams();
  const [params] = useSearchParams();
  const preview = params.get("preview") === "1";
  const q = preview ? "?preview=1" : "";
  const base = `/c/${slug}`;
  const { settings, collection, works, loading, error, reload } = useCollectionData(slug, preview);
  const { favs, toggle } = useFavorites();
  const [editing, setEditing] = useState<Platform | null>(null);
  const [card, setCard] = useState(false);
  const idx = works.findIndex((w) => String(w.work_number) === no);
  const work = idx >= 0 ? works[idx] : null;
  const prev = idx > 0 ? works[idx - 1] : null;
  const next = idx >= 0 && idx < works.length - 1 ? works[idx + 1] : null;
  const downloadsEnabled = canDownload(settings, collection);
  const idOn = collection?.id_card_enabled ?? true;
  const cardOn = collection?.card_enabled ?? true;

  return (
    <div className={`site ${themeClass(collection)}`} data-testid="collection-work-page">
      <CollectionHeader brand={settings?.brand_name ?? "KUMA 工作室"} />
      {preview && <PreviewBanner />}
      <main className="page narrow-wide">
        <nav className="life-crumbs" aria-label="位置">
          <Link to={`${base}${q}`}>← {collection?.name ?? "回系列"}</Link>
        </nav>
        {loading && <p className="center muted pad">載入中…</p>}
        {error && (
          <div className="card notice center">
            <p className="error">{error}</p>
            <button type="button" className="btn primary" onClick={reload}>
              重新載入
            </button>
          </div>
        )}
        {!loading && !error && (!collection || !work) && (
          <div className="card notice center">
            <p>找不到這款作品，可能尚未上架。</p>
            <Link className="btn primary" to={`${base}${q}`}>
              看全部作品
            </Link>
          </div>
        )}
        {collection && work && (
          <div className="life-work">
            {idOn ? (
              <IdCard collection={collection} work={work} />
            ) : (
              <article className="id-card plain-work" data-testid="work-photo">
                <div className="id-card-photo">
                  <img src={previewUrl(work.preview_path!)} alt={`${formatNo(work.work_number)} ${work.nickname}`} width={work.width ?? undefined} height={work.height ?? undefined} />
                </div>
                <h1 className="life-nick">{formatNo(work.work_number)}｜{work.nickname}</h1>
                {work.title && <p className="life-work-title">{work.title}</p>}
                {work.description && <p className="muted">{work.description}</p>}
              </article>
            )}
            <div className="life-work-side stack">
              <button type="button" className={`btn ${favs.has(work.id) ? "primary" : "ghost"}`} aria-pressed={favs.has(work.id)} onClick={() => toggle(work.id)}>
                {favs.has(work.id) ? "♥ 已加入我的收藏" : "♡ 加入我的收藏"}
              </button>
              <button type="button" className="btn primary big" onClick={() => setEditing("facebook")} data-testid="make-avatar">
                製作我的專屬大頭貼
              </button>
              <div className="platform-btns" aria-label="選擇大頭貼平台">
                {(Object.keys(PLATFORM_LABEL) as Platform[]).map((p) => (
                  <button key={p} type="button" className={`pbtn pbtn-${p}`} onClick={() => setEditing(p)}>
                    {PLATFORM_LABEL[p]}
                  </button>
                ))}
              </div>
              {cardOn && (
                <button type="button" className="btn ghost big" onClick={() => setCard(true)} data-testid="open-card">
                  查看與下載收藏卡
                </button>
              )}
              <p className="tiny muted">大頭貼{cardOn ? "與收藏卡" : ""}都會用這一款的原始照片製作；下載前需要輸入「{collection.name}」的專屬下載密碼（請透過 Facebook 粉專私訊取得）。</p>
              <div className="row between life-pager">
                {prev ? <Link to={`${base}/${prev.work_number}${q}`}>← {formatNo(prev.work_number)} {prev.nickname}</Link> : <span />}
                {next ? <Link to={`${base}/${next.work_number}${q}`}>{formatNo(next.work_number)} {next.nickname} →</Link> : <span />}
              </div>
            </div>
          </div>
        )}
      </main>
      {editing && collection && work && (
        <CollectionAvatarEditor collection={collection} work={work} platform={editing} downloadsEnabled={downloadsEnabled} onClose={() => setEditing(null)} previewOnly={preview} />
      )}
      {card && cardOn && collection && work && <CardModal collection={collection} work={work} downloadsEnabled={downloadsEnabled} onClose={() => setCard(false)} previewOnly={preview} />}
    </div>
  );
}
