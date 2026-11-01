import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { CardModal, IdCard, LifeAvatarEditor } from "../components/LifeCard";
import { formatNo } from "../lib/card";
import { PLATFORM_LABEL, type Platform } from "../lib/crop";
import { LifeHeader, PreviewBanner, useFavorites, useLifeData } from "./LifeHome";

/** 單一款生命共同體的獨立作品頁：身份證、製作大頭貼、收藏卡 */
export default function LifeWork() {
  const { no } = useParams();
  const [params] = useSearchParams();
  const preview = params.get("preview") === "1";
  const q = preview ? "?preview=1" : "";
  const { settings, collection, works, loading, error, reload } = useLifeData(preview);
  const { favs, toggle } = useFavorites();
  const [editing, setEditing] = useState<Platform | null>(null);
  const [card, setCard] = useState(false);
  const idx = works.findIndex((w) => String(w.work_number) === no);
  const work = idx >= 0 ? works[idx] : null;
  const prev = idx > 0 ? works[idx - 1] : null;
  const next = idx >= 0 && idx < works.length - 1 ? works[idx + 1] : null;
  const downloadsEnabled = Boolean(settings?.downloads_enabled);

  return (
    <div className="site life">
      <LifeHeader brand={settings?.brand_name ?? "KUMA 工作室"} />
      {preview && <PreviewBanner />}
      <main className="page narrow-wide">
        <nav className="life-crumbs" aria-label="位置">
          <Link to={`/life${q}`}>← 熊兔生命共同體限定收藏館</Link>
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
            <Link className="btn primary" to={`/life${q}`}>
              看全部作品
            </Link>
          </div>
        )}
        {collection && work && (
          <div className="life-work">
            <IdCard collection={collection} work={work} />
            <div className="life-work-side stack">
              <button type="button" className={`btn ${favs.has(work.id) ? "primary" : "ghost"}`} aria-pressed={favs.has(work.id)} onClick={() => toggle(work.id)}>
                {favs.has(work.id) ? "♥ 已加入我的收藏" : "♡ 加入我的收藏"}
              </button>
              <button type="button" className="btn primary big" onClick={() => setEditing("facebook")} data-testid="make-avatar">
                製作我的生命共同體
              </button>
              <div className="platform-btns" aria-label="選擇大頭貼平台">
                {(Object.keys(PLATFORM_LABEL) as Platform[]).map((p) => (
                  <button key={p} type="button" className={`pbtn pbtn-${p}`} onClick={() => setEditing(p)}>
                    {PLATFORM_LABEL[p]}
                  </button>
                ))}
              </div>
              <button type="button" className="btn ghost big" onClick={() => setCard(true)} data-testid="open-card">
                查看與下載收藏卡
              </button>
              <p className="tiny muted">大頭貼與收藏卡都會用這一款的原始照片製作；下載前需要輸入生命共同體專屬下載密碼（請見 Facebook 粉專私訊）。</p>
              <div className="row between life-pager">
                {prev ? <Link to={`/life/${prev.work_number}${q}`}>← {formatNo(prev.work_number)} {prev.nickname}</Link> : <span />}
                {next ? <Link to={`/life/${next.work_number}${q}`}>{formatNo(next.work_number)} {next.nickname} →</Link> : <span />}
              </div>
            </div>
          </div>
        )}
      </main>
      {editing && collection && work && (
        <LifeAvatarEditor collection={collection} work={work} platform={editing} downloadsEnabled={downloadsEnabled} onClose={() => setEditing(null)} previewOnly={preview} />
      )}
      {card && collection && work && <CardModal collection={collection} work={work} downloadsEnabled={downloadsEnabled} onClose={() => setCard(false)} previewOnly={preview} />}
    </div>
  );
}
