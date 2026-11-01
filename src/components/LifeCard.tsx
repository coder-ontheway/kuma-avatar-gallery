import { useEffect, useMemo, useRef, useState } from "react";
import Modal from "./Modal";
import AvatarEditor, { type LifeOptions } from "./AvatarEditor";
import { useDownloadAuth } from "./DownloadAuth";
import { previewUrl } from "../lib/api";
import { CARD_H, CARD_W, drawCard, ensureCardFonts, formatNo } from "../lib/card";
import { DownloadError } from "../lib/download";
import { cardInfo, downloadCard, lifeAvatarTitle } from "../lib/lifeDownload";
import type { Platform } from "../lib/crop";
import type { Collection, CollectionWork } from "../lib/types";

function useImage(src: string | null) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => alive && setImg(i);
    i.onerror = () => alive && setError(true);
    i.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return { img, error };
}

/** 熊兔生命共同體身份證（網頁顯示） */
export function IdCard({ collection, work }: { collection: Collection; work: CollectionWork }) {
  return (
    <article className="id-card" data-testid="id-card">
      <div className="id-card-head">
        <span className="id-card-brand">KUMA STUDIO</span>
        <span className="id-card-kind">熊兔生命共同體身份證</span>
      </div>
      <div className="id-card-body">
        <div className="id-card-photo">
          <img src={previewUrl(work.preview_path!)} alt={`${formatNo(work.work_number)} ${work.nickname}`} width={work.width ?? undefined} height={work.height ?? undefined} />
        </div>
        <dl className="id-card-fields">
          <div>
            <dt>生命共同體編號</dt>
            <dd className="id-no">{formatNo(work.work_number)}</dd>
          </div>
          <div>
            <dt>專屬稱號</dt>
            <dd className="id-nick">{work.nickname}</dd>
          </div>
          {work.title && (
            <div>
              <dt>作品名稱</dt>
              <dd>{work.title}</dd>
            </div>
          )}
          {work.description && (
            <div>
              <dt>生命共同體介紹</dt>
              <dd>{work.description}</dd>
            </div>
          )}
          {work.manifesto && (
            <div>
              <dt>專屬愛心宣言</dt>
              <dd className="id-manifesto">❤ {work.manifesto}</dd>
            </div>
          )}
        </dl>
      </div>
      <div className="id-card-foot">{collection.name_en || "ONE HEART, ONE LIFE"}</div>
    </article>
  );
}

/** 收藏卡：預覽（公開預覽圖）＋粉絲宣言版本＋下載（原圖，需下載密碼） */
export function CardModal({
  collection,
  work,
  downloadsEnabled,
  onClose,
  previewOnly,
}: {
  collection: Collection;
  work: CollectionWork;
  downloadsEnabled: boolean;
  onClose: () => void;
  previewOnly?: boolean;
}) {
  const { ensureAuth } = useDownloadAuth();
  const { img, error } = useImage(work.preview_path ? previewUrl(work.preview_path) : null);
  const [mode, setMode] = useState<"official" | "mine">("official");
  const [mine, setMine] = useState(work.manifesto || collection.manifestos[0] || "");
  const manifesto = mode === "official" ? work.manifesto : mine;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const info = useMemo(() => cardInfo(collection, work, manifesto), [collection, work, manifesto]);

  useEffect(() => {
    if (!img || !canvasRef.current) return;
    let alive = true;
    const canvas = canvasRef.current;
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    const paint = () => {
      const ctx = canvas.getContext("2d");
      if (ctx && alive) drawCard(ctx, img, img.naturalWidth, img.naturalHeight, info, work.protect_zones);
    };
    paint();
    ensureCardFonts(info).then(paint);
    return () => {
      alive = false;
    };
  }, [img, info, work.protect_zones]);

  async function download() {
    setMsg(null);
    if (!downloadsEnabled) {
      setMsg({ type: "error", text: "目前暫停開放下載，請留意粉專公告。" });
      return;
    }
    if (!(await ensureAuth(collection.id))) return;
    setBusy(true);
    try {
      try {
        await downloadCard(collection, work, manifesto);
      } catch (e) {
        if (e instanceof DownloadError && e.code === "token_invalid" && (await ensureAuth(collection.id))) await downloadCard(collection, work, manifesto);
        else throw e;
      }
      setMsg({ type: "ok", text: "收藏卡下載完成！" });
    } catch (e) {
      setMsg({ type: "error", text: e instanceof DownloadError ? e.message : "下載失敗，請稍後再試。" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`收藏卡：${formatNo(work.work_number)} ${work.nickname}`} onClose={onClose} wide>
      <div className="card-maker">
        <div className="card-canvas-wrap">
          <canvas ref={canvasRef} className="card-canvas" data-testid="card-canvas" aria-label="收藏卡預覽" />
          {!img && !error && <p className="stage-msg">載入中…</p>}
          {error && <p className="stage-msg error">預覽圖載入失敗，請重新整理再試。</p>}
        </div>
        <div className="stack">
          <div className="seg" role="group" aria-label="收藏卡宣言">
            <button type="button" className={mode === "official" ? "active" : ""} aria-pressed={mode === "official"} onClick={() => setMode("official")}>
              官方宣言
            </button>
            <button type="button" className={mode === "mine" ? "active" : ""} aria-pressed={mode === "mine"} onClick={() => setMode("mine")}>
              我的宣言版本
            </button>
          </div>
          {mode === "mine" && (
            <div className="stack">
              <label className="field">
                <span>我的生命共同體宣言（最多 24 字，可用 Emoji）</span>
                <input value={mine} maxLength={24} onChange={(e) => setMine(e.target.value)} data-testid="card-manifesto" />
              </label>
              <div className="row wrap">
                {collection.manifestos.map((t) => (
                  <button key={t} type="button" className="chip small" onClick={() => setMine(t)}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="tiny muted">收藏卡為 1200 × 1800 高畫質 JPG。下載時使用原始照片製作；文字都在照片下方，不會遮住熊兔。</p>
          {!previewOnly && (
            <>
              <button type="button" className="btn primary big" onClick={download} disabled={busy || !img}>
                {busy ? "製作中…" : "下載這張收藏卡"}
              </button>
              {msg && (
                <p className={msg.type === "ok" ? "success" : "error"} role="status">
                  {msg.text}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** 製作我的生命共同體大頭貼：沿用原本的大頭貼編輯器（平台裁切、文字、下載密碼） */
export function LifeAvatarEditor({
  collection,
  work,
  platform,
  downloadsEnabled,
  onClose,
  previewOnly,
}: {
  collection: Collection;
  work: CollectionWork;
  platform: Platform;
  downloadsEnabled: boolean;
  onClose: () => void;
  previewOnly?: boolean;
}) {
  const life = useMemo<LifeOptions>(
    () => ({
      zones: work.protect_zones,
      presets: [...new Set([work.manifesto, ...collection.manifestos].filter(Boolean))],
      defaultText: work.manifesto || collection.manifestos[0] || "",
    }),
    [work, collection],
  );
  return (
    <AvatarEditor
      image={{
        id: work.id,
        title: `${formatNo(work.work_number)} ${work.nickname}`,
        preview_path: work.preview_path!,
        mime_type: work.mime_type ?? "image/jpeg",
        width: work.width ?? 1,
        height: work.height ?? 1,
      }}
      initialPlatform={platform}
      downloadsEnabled={downloadsEnabled}
      onClose={onClose}
      previewOnly={previewOnly}
      source="collection"
      collectionId={collection.id}
      life={life}
      fileTitle={lifeAvatarTitle(work)}
    />
  );
}
