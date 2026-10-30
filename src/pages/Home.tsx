import { useEffect, useMemo, useState } from "react";
import AvatarEditor from "../components/AvatarEditor";
import { useDownloadAuth } from "../components/DownloadAuth";
import { fetchCategories, fetchPublishedImages, fetchSettings, formatDate, previewUrl } from "../lib/api";
import { PLATFORM_LABEL, type Platform } from "../lib/crop";
import { DownloadError, downloadAllZip, type ZipProgress } from "../lib/download";
import type { Category, PublicImage, SiteSettings } from "../lib/types";

export default function Home() {
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [images, setImages] = useState<PublicImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [editing, setEditing] = useState<{ image: PublicImage; platform: Platform } | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [s, c, i] = await Promise.all([fetchSettings(), fetchCategories(), fetchPublishedImages()]);
      setSettings(s);
      setCategories(c);
      setImages(i);
      document.title = `${s.site_name}｜${s.brand_name}`;
    } catch {
      setError("作品資料載入失敗，請檢查網路後重新整理。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const catName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const usedCategories = useMemo(
    () => categories.filter((c) => images.some((i) => i.category_id === c.id)),
    [categories, images],
  );
  const monthly = images.filter((i) => i.is_monthly);
  const shown = filter === "all" ? images : images.filter((i) => i.category_id === filter);
  const siteName = settings?.site_name ?? "KUMA 熊兔大頭貼收藏館";
  const brand = settings?.brand_name ?? "KUMA 工作室";

  return (
    <div className="site">
      <header className="site-header">
        <div className="page header-inner">
          <a href="#/" className="brand">
            <span className="brand-mark" aria-hidden="true">K</span>
            <span>
              <small>{brand}</small>
              <strong>{siteName}</strong>
            </span>
          </a>
          {settings?.facebook_url && (
            <a className="btn fb" href={settings.facebook_url} target="_blank" rel="noopener noreferrer">
              Facebook 粉專
            </a>
          )}
        </div>
      </header>

      <main className="page">
        <section className="hero">
          <h1>{siteName}</h1>
          <p className="lead">熊大與兔兔的照片大頭貼，挑一張喜歡的，調整成 Facebook、Instagram 或 LINE 大頭貼吧！</p>
          {settings?.latest_update_date && (
            <p className="update-date">最新更新：{formatDate(settings.latest_update_date)}</p>
          )}
          {settings?.announcement && (
            <div className="announcement" role="note">
              <strong>公告</strong>
              <p>{settings.announcement}</p>
            </div>
          )}
        </section>

        <section className="howto card" aria-labelledby="howto-title">
          <h2 id="howto-title">瀏覽與下載說明</h2>
          <ol>
            <li>所有作品都可以自由瀏覽與預覽。</li>
            <li>點作品下方的「Facebook／Instagram／LINE」，進入大頭貼預覽。</li>
            <li>拖曳移動、捏合或用滑桿縮放，讓熊大兔兔的臉和耳朵留在圓圈內。</li>
            <li>按「下載大頭貼」並輸入粉絲下載密碼（請見 Facebook 粉專公告）。</li>
            <li>也可以使用「下載全部大頭貼」一次取得所有原始作品（ZIP）。</li>
          </ol>
        </section>

        {loading && <p className="center muted pad">作品載入中…</p>}
        {error && (
          <div className="card notice center">
            <p className="error">{error}</p>
            <button type="button" className="btn primary" onClick={load}>
              重新載入
            </button>
          </div>
        )}

        {!loading && !error && images.length === 0 && (
          <div className="card notice center empty">
            <h2>作品準備中</h2>
            <p className="muted">熊大和兔兔的大頭貼正在整理中，請稍後再回來看看，或追蹤 Facebook 粉專獲得更新通知。</p>
          </div>
        )}

        {monthly.length > 0 && (
          <section aria-labelledby="monthly-title" className="section">
            <h2 id="monthly-title" className="section-title">
              {settings?.monthly_title || "本月大頭貼"}
            </h2>
            <div className="grid">
              {monthly.map((img) => (
                <ImageCard key={img.id} image={img} category={catName.get(img.category_id ?? "")} onOpen={(p) => setEditing({ image: img, platform: p })} />
              ))}
            </div>
          </section>
        )}

        {images.length > 0 && (
          <section aria-labelledby="all-title" className="section">
            <div className="section-head">
              <h2 id="all-title" className="section-title">
                全部作品 <small>（{images.length} 張）</small>
              </h2>
              <DownloadAllButton disabled={!settings?.downloads_enabled} />
            </div>
            {usedCategories.length > 0 && (
              <div className="chips" role="tablist" aria-label="作品分類">
                <button type="button" role="tab" aria-selected={filter === "all"} className={`chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>
                  全部
                </button>
                {usedCategories.map((c) => (
                  <button key={c.id} type="button" role="tab" aria-selected={filter === c.id} className={`chip ${filter === c.id ? "active" : ""}`} onClick={() => setFilter(c.id)}>
                    {c.name}
                  </button>
                ))}
              </div>
            )}
            <div className="grid">
              {shown.map((img) => (
                <ImageCard key={img.id} image={img} category={catName.get(img.category_id ?? "")} onOpen={(p) => setEditing({ image: img, platform: p })} />
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="site-footer">
        <div className="page">
          <p>
            © {new Date().getFullYear()} {brand}　熊大與兔兔照片皆為 {brand} 作品
          </p>
          {settings?.facebook_url && (
            <a href={settings.facebook_url} target="_blank" rel="noopener noreferrer">
              追蹤 Facebook 粉專
            </a>
          )}
        </div>
      </footer>

      {editing && (
        <AvatarEditor
          image={editing.image}
          initialPlatform={editing.platform}
          downloadsEnabled={Boolean(settings?.downloads_enabled)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ImageCard({ image, category, onOpen }: { image: PublicImage; category?: string; onOpen: (p: Platform) => void }) {
  return (
    <article className="art-card" data-testid="art-card">
      <button type="button" className="art-thumb checker" onClick={() => onOpen("facebook")} aria-label={`預覽 ${image.title}`}>
        <img src={previewUrl(image.preview_path)} alt={image.title} loading="lazy" decoding="async" width={image.width} height={image.height} />
      </button>
      <div className="art-info">
        <h3>{image.title}</h3>
        <p className="meta">
          {category && <span className="tag">{category}</span>}
          {image.plain_preview_path && <span className="tag light">可拿掉文字</span>}
          {image.tags.map((t) => (
            <span key={t} className="tag light">
              {t}
            </span>
          ))}
          <span className="date">{formatDate(image.work_date)}</span>
        </p>
        <div className="platform-btns" aria-label="選擇大頭貼平台">
          {(Object.keys(PLATFORM_LABEL) as Platform[]).map((p) => (
            <button key={p} type="button" className={`pbtn pbtn-${p}`} onClick={() => onOpen(p)}>
              {PLATFORM_LABEL[p]}
            </button>
          ))}
        </div>
        <button type="button" className="btn primary block" onClick={() => onOpen("facebook")} disabled={!image.is_downloadable} title={image.is_downloadable ? "" : "此作品僅供瀏覽"}>
          {image.is_downloadable ? "預覽並下載" : "僅供瀏覽"}
        </button>
      </div>
    </article>
  );
}

function DownloadAllButton({ disabled }: { disabled: boolean }) {
  const { ensureAuth } = useDownloadAuth();
  const [progress, setProgress] = useState<ZipProgress | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  async function run() {
    setMsg(null);
    if (disabled) {
      setMsg({ type: "error", text: "目前暫停開放下載，請留意粉專公告。" });
      return;
    }
    if (!(await ensureAuth())) return;
    setProgress({ done: 0, total: 0, part: 1, parts: 1 });
    try {
      let result;
      try {
        result = await downloadAllZip(setProgress);
      } catch (e) {
        if (e instanceof DownloadError && e.code === "token_invalid" && (await ensureAuth())) {
          result = await downloadAllZip(setProgress);
        } else throw e;
      }
      setMsg(
        result.failed.length > 0
          ? { type: "error", text: `已打包 ${result.files} 張；以下作品下載失敗，請稍後再試：${result.failed.join("、")}` }
          : { type: "ok", text: `已完成！共 ${result.files} 張作品。` },
      );
    } catch (e) {
      setMsg({ type: "error", text: e instanceof DownloadError ? e.message : "打包失敗，請稍後再試。" });
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="download-all">
      <button type="button" className="btn primary" onClick={run} disabled={progress !== null}>
        {progress
          ? progress.total
            ? `打包中 ${progress.done}/${progress.total}${progress.parts > 1 ? `（第 ${progress.part}/${progress.parts} 個 ZIP）` : ""}`
            : "準備中…"
          : "下載全部大頭貼（ZIP）"}
      </button>
      {msg && (
        <p className={msg.type === "ok" ? "success" : "error"} role="status">
          {msg.text}
        </p>
      )}
    </div>
  );
}
