import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Modal from "./Modal";
import { useDownloadAuth } from "./DownloadAuth";
import {
  clampState,
  drawCrop,
  initialState,
  MAX_ZOOM,
  minZoom,
  panBy,
  PLATFORM_CODE,
  PLATFORM_LABEL,
  renderAvatarBlob,
  zoomAt,
  type CropState,
  type Platform,
} from "../lib/crop";
import {
  clampLayer,
  drawTextLayers,
  ensureFonts,
  fitIntoCircle,
  FONT_LABEL,
  hitTest,
  insideCircle,
  layoutLayer,
  MAX_LAYERS,
  MAX_TEXT_LENGTH,
  newLayer,
  SAFE_RADIUS,
  type FontKey,
  type TextAlign,
  type TextLayer,
} from "../lib/textLayers";
import { previewUrl } from "../lib/api";
import { DownloadError, fetchOriginal, saveBlob, type Source } from "../lib/download";
import { avoidZones, constrainCrop, defaultCrop, PLATFORM_VISIBLE, zoneOnCanvas, type ProtectZone } from "../lib/protect";
import { avatarFileName, originalFileName } from "../lib/filename";

const BACKGROUNDS: { label: string; value: string | null }[] = [
  { label: "透明", value: null },
  { label: "白色", value: "#ffffff" },
  { label: "奶油", value: "#fff1dc" },
  { label: "粉紅", value: "#fbdde3" },
  { label: "天空", value: "#dcedfa" },
];

const TEXT_COLORS = ["#ffffff", "#4a3426", "#8a5a3b", "#e85d75", "#f4a7b9", "#ffcf4a", "#3d8bfd", "#2f7a4a", "#000000"];

const PLATFORM_HINT: Record<Platform, string> = {
  facebook: "圓形遮罩預覽：圓形以外的區域在大頭貼上通常不會顯示。下載的是方形圖片，上傳後可再於平台上微調。",
  instagram: "圓形遮罩預覽；虛線為建議安全範圍（參考用），請把熊大兔兔的臉、耳朵與文字放在虛線內。下載的是方形圖片。",
  line: "方形預覽；同時提供圓形顯示的參考效果，讓你了解不同顯示情況。下載的是方形圖片。",
};

const LIFE_HINT: Record<Platform, string> = {
  facebook: "Facebook 圓形大頭貼：臉、耳朵與胸口愛心會保持在圓形內，拖曳或放大時不會被切掉。",
  instagram: "Instagram 圓形大頭貼顯示較小：構圖會多留一點邊，讓兔兔耳朵完整。",
  line: "LINE 方形大頭貼：可放得比較大，角色仍完整保留在方形內。",
};

const PLATFORMS = Object.keys(PLATFORM_LABEL) as Platform[];

/** 生命共同體模式：各平台獨立裁切、保護區域、預設宣言 */
export interface LifeOptions {
  zones: ProtectZone[];
  presets: string[];
  defaultText: string;
}

interface Design {
  /** 各平台的裁切；一般收藏館三個平台共用同一個裁切（維持原本行為） */
  crops: Record<Platform, CropState>;
  layers: TextLayer[];
  bg: string | null;
}

function lifeLayer(text: string): TextLayer {
  return newLayer({ text, y: 0.88, size: 0.075, color: "#ffffff", strokeColor: "#8a5a3b", strokeWidth: 0.16 });
}

function makeInitialDesign(w: number, h: number, life?: LifeOptions): Design {
  if (!life) {
    const c = initialState();
    return { crops: { facebook: c, instagram: c, line: c }, layers: [], bg: null };
  }
  const crops = Object.fromEntries(PLATFORMS.map((p) => [p, defaultCrop(w, h, life.zones, p)])) as Record<Platform, CropState>;
  // 預設宣言放在下方並收進圓形範圍內（圓形大頭貼不會裁到字）
  return { crops, layers: life.defaultText ? [fitIntoCircle(lifeLayer(life.defaultText), 0.47)] : [], bg: null };
}

/** 生命共同體大頭貼輸出尺寸：Instagram 固定 1080；Facebook／LINE 依原圖裁切像素，至少 1080、最多 2048 */
export function lifeOutputSize(platform: Platform, srcW: number, srcH: number, crop: CropState): number {
  if (platform === "instagram") return 1080;
  const size = Math.min(srcW, srcH) / clampState(srcW, srcH, crop).zoom;
  return Math.round(Math.min(2048, Math.max(1080, size)));
}

function loadImage(src: string, crossOrigin = true): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("圖片載入失敗"));
    img.src = src;
  });
}

export interface EditorImage {
  id: string;
  title: string;
  preview_path: string;
  /** 無字版預覽圖；有值時粉絲可切換「拿掉作品上的文字」 */
  plain_preview_path?: string | null;
  mime_type: string;
  width: number;
  height: number;
}

interface Props {
  image: EditorImage;
  initialPlatform: Platform;
  downloadsEnabled: boolean;
  onClose: () => void;
  /** 管理員預覽模式：不顯示下載按鈕 */
  previewOnly?: boolean;
  /** 作品來源（下載時使用）；預設為原本的收藏館 */
  source?: Source;
  /** 熊兔生命共同體模式 */
  life?: LifeOptions;
  /** 下載檔名前綴（例如 No.001_熊兔共生體） */
  fileTitle?: string;
}

type DragState = { kind: "image" } | { kind: "text"; id: string; offX: number; offY: number } | null;

export default function AvatarEditor({ image, initialPlatform, downloadsEnabled, onClose, previewOnly, source = "images", life, fileTitle: fileTitleProp }: Props) {
  const { ensureAuth } = useDownloadAuth();
  const [platform, setPlatform] = useState<Platform>(initialPlatform);
  const [panel, setPanel] = useState<"photo" | "text">(life ? "text" : "photo");
  const initialDesign = useCallback(() => makeInitialDesign(image.width, image.height, life), [image.width, image.height, life]);
  const [design, setDesignState] = useState<Design>(initialDesign);
  const [history, setHistory] = useState<Design[]>([]);
  const lastRecord = useRef(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customBg, setCustomBg] = useState("#ffe7b8");
  const [plain, setPlain] = useState(false);
  const usePlain = plain && !!image.plain_preview_path;
  const sourcePath = usePlain ? image.plain_preview_path! : image.preview_path;
  const baseTitle = fileTitleProp ?? image.title;
  const fileTitle = usePlain ? `${baseTitle}_無字` : baseTitle;
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<"" | "avatar" | "original">("");
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [fontTick, setFontTick] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const roundRef = useRef<HTMLCanvasElement>(null);
  const squareRef = useRef<HTMLCanvasElement>(null);
  const miniRefs = useRef<Partial<Record<Platform, HTMLCanvasElement | null>>>({});
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null);
  const drag = useRef<DragState>(null);

  const w = img?.naturalWidth ?? image.width;
  const h = img?.naturalHeight ?? image.height;
  const { crops, layers: rawLayers, bg } = design;
  const crop = crops[platform];
  const circleRadius = platform === "line" ? null : PLATFORM_VISIBLE[platform].radius;
  // 保護區域在目前裁切畫面上的位置（生命共同體模式）
  const ellipses = useMemo(
    () => (life ? life.zones.map((z) => zoneOnCanvas(z, w, h, clampState(w, h, crop))) : []),
    [life, w, h, crop],
  );
  // 實際顯示與下載用的文字位置：自動避開臉、耳朵與愛心（粉絲拖到保護區域上時，文字會停在最近的空位）
  const layers = useMemo(
    () => (ellipses.length ? rawLayers.map((l) => avoidZones(l, ellipses, circleRadius)) : rawLayers),
    // fontTick：字型載入後文字尺寸可能改變
    [rawLayers, ellipses, circleRadius, fontTick], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const selected = layers.find((l) => l.id === selectedId) ?? null;

  const designRef = useRef(design);
  designRef.current = design;

  /** 更新設計；連續操作（拖曳、滑桿）在 600ms 內只記一筆歷史，方便「撤銷」 */
  const setDesign = useCallback((fn: (d: Design) => Design) => {
    const prev = designRef.current;
    const next = fn(prev);
    if (next === prev) return;
    const now = Date.now();
    if (now - lastRecord.current > 600) setHistory((hs) => [...hs.slice(-49), prev]);
    lastRecord.current = now;
    designRef.current = next;
    setDesignState(next);
  }, []);

  function undo() {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory(history.slice(0, -1));
    designRef.current = prev;
    setDesignState(prev);
    lastRecord.current = 0;
    if (selectedId && !prev.layers.some((l) => l.id === selectedId)) setSelectedId(null);
  }

  /** 生命共同體：套用預設宣言（有選取中的文字就替換內容，沒有就新增一個） */
  function applyPreset(text: string) {
    lastRecord.current = 0;
    if (selected) {
      updateLayer(selected.id, { text });
    } else if (rawLayers.length > 0) {
      updateLayer(rawLayers[0].id, { text });
      setSelectedId(rawLayers[0].id);
    } else {
      const layer = fitIntoCircle(lifeLayer(text), 0.47);
      setDesign((d) => ({ ...d, layers: [...d.layers, layer] }));
      setSelectedId(layer.id);
    }
    lastRecord.current = 0;
  }

  function clearText() {
    lastRecord.current = 0;
    setDesign((d) => ({ ...d, layers: [] }));
    lastRecord.current = 0;
    setSelectedId(null);
  }

  function resetDesign() {
    lastRecord.current = 0;
    setDesign(() => initialDesign());
    lastRecord.current = 0;
    setSelectedId(null);
  }

  const updateCrop = useCallback(
    (fn: (s: CropState) => CropState) =>
      setDesign((d) => {
        const prev = d.crops[platform];
        if (!life) {
          const next = fn(prev);
          return { ...d, crops: { facebook: next, instagram: next, line: next } };
        }
        // 生命共同體：只調整目前平台，且不允許切掉保護區域
        const next = constrainCrop(w, h, prev, fn(prev), life.zones, platform);
        return { ...d, crops: { ...d.crops, [platform]: next } };
      }),
    [setDesign, platform, life, w, h],
  );

  function updateLayer(id: string, patch: Partial<TextLayer>) {
    setDesign((d) => ({
      ...d,
      layers: d.layers.map((l) => (l.id === id ? clampLayer({ ...l, ...patch }) : l)),
    }));
  }

  function addLayer() {
    if (layers.length >= MAX_LAYERS) return;
    const offset = layers.length * 0.07;
    const layer = clampLayer(life ? fitIntoCircle(lifeLayer(life.presets[0] ?? "輸入文字"), 0.47) : newLayer({ y: Math.max(0.2, 0.74 - offset) }));
    lastRecord.current = 0;
    setDesign((d) => ({ ...d, layers: [...d.layers, layer] }));
    lastRecord.current = 0;
    setSelectedId(layer.id);
    setPanel("text");
  }

  function removeLayer(id: string) {
    lastRecord.current = 0;
    setDesign((d) => ({ ...d, layers: d.layers.filter((l) => l.id !== id) }));
    lastRecord.current = 0;
    setSelectedId(null);
  }

  useEffect(() => {
    let alive = true;
    loadImage(previewUrl(sourcePath))
      .then((i) => alive && setImg(i))
      .catch(() => alive && setLoadError("預覽圖載入失敗，請重新整理頁面再試。"));
    return () => {
      alive = false;
    };
  }, [sourcePath]);

  // 字型（含中文、表情符號）載入完成後重新繪製，避免預覽掉字
  useEffect(() => {
    let alive = true;
    ensureFonts(rawLayers).then(() => alive && setFontTick((t) => t + 1));
    return () => {
      alive = false;
    };
  }, [rawLayers]);

  // 重新繪製預覽（與下載共用 drawCrop / drawTextLayers）
  useEffect(() => {
    if (!img) return;
    let frame = requestAnimationFrame(() => {
      const draw = (canvas: HTMLCanvasElement | null) => {
        if (!canvas) return;
        const cssSize = canvas.clientWidth || 300;
        const px = Math.round(cssSize * Math.min(3, window.devicePixelRatio || 1));
        if (canvas.width !== px) {
          canvas.width = px;
          canvas.height = px;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        drawCrop(ctx, img, w, h, crop, px, { background: bg });
        drawTextLayers(ctx, layers, px);
      };
      draw(canvasRef.current);
      draw(roundRef.current);
      draw(squareRef.current);
      // 生命共同體：三個平台各自的裁切同時預覽
      if (life) {
        for (const p of PLATFORMS) {
          const canvas = miniRefs.current[p];
          if (!canvas) continue;
          const px = Math.round((canvas.clientWidth || 96) * Math.min(3, window.devicePixelRatio || 1));
          if (canvas.width !== px) {
            canvas.width = px;
            canvas.height = px;
          }
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          const c = clampState(w, h, crops[p]);
          const es = life.zones.map((z) => zoneOnCanvas(z, w, h, c));
          const r = p === "line" ? null : PLATFORM_VISIBLE[p].radius;
          drawCrop(ctx, img, w, h, c, px, { background: bg });
          drawTextLayers(ctx, rawLayers.map((l) => avoidZones(l, es, r)), px);
        }
      }
      frame = 0;
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [img, w, h, crop, crops, rawLayers, layers, bg, platform, panel, fontTick, life]);

  // 滑鼠滾輪縮放
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      updateCrop((s) => zoomAt(w, h, s, s.zoom * Math.exp(-e.deltaY * 0.0015), fx, fy));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [w, h, updateCrop]);

  function stagePoint(e: { clientX: number; clientY: number }) {
    const rect = stageRef.current!.getBoundingClientRect();
    return { fx: (e.clientX - rect.left) / rect.width, fy: (e.clientY - rect.top) / rect.height };
  }

  function onPointerDown(e: ReactPointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinch.current = null;
    lastRecord.current = 0; // 每次新的拖曳都是一個可撤銷的步驟
    if (pointers.current.size === 1) {
      const { fx, fy } = stagePoint(e);
      const hit = hitTest(layers.map((l) => clampLayer(l)), fx, fy);
      if (hit) {
        setSelectedId(hit.id);
        setPanel("text");
        drag.current = { kind: "text", id: hit.id, offX: fx - hit.x, offY: fy - hit.y };
      } else {
        drag.current = { kind: "image" };
      }
    } else {
      drag.current = { kind: "image" };
    }
  }

  function onPointerMove(e: ReactPointerEvent) {
    const map = pointers.current;
    const prev = map.get(e.pointerId);
    if (!prev || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    map.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (map.size === 1) {
      const d = drag.current;
      if (d?.kind === "text") {
        const { fx, fy } = stagePoint(e);
        updateLayer(d.id, { x: fx - d.offX, y: fy - d.offY });
        return;
      }
      const dx = (e.clientX - prev.x) / rect.width;
      const dy = (e.clientY - prev.y) / rect.height;
      updateCrop((s) => panBy(w, h, s, dx, dy));
    } else if (map.size === 2) {
      const [a, b] = [...map.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const last = pinch.current;
      pinch.current = { dist, mid };
      if (!last || last.dist === 0) return;
      const fx = (mid.x - rect.left) / rect.width;
      const fy = (mid.y - rect.top) / rect.height;
      updateCrop((s) => {
        const zoomed = zoomAt(w, h, s, s.zoom * (dist / last.dist), fx, fy);
        return panBy(w, h, zoomed, (mid.x - last.mid.x) / rect.width, (mid.y - last.mid.y) / rect.height);
      });
    }
  }

  function onPointerUp(e: ReactPointerEvent) {
    pointers.current.delete(e.pointerId);
    pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (selected && panel === "text" && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const v = d[e.key];
      if (v) updateLayer(selected.id, { x: selected.x + v[0] / 2, y: selected.y + v[1] / 2 });
      return;
    }
    const keys: Record<string, () => void> = {
      ArrowLeft: () => updateCrop((s) => panBy(w, h, s, step, 0)),
      ArrowRight: () => updateCrop((s) => panBy(w, h, s, -step, 0)),
      ArrowUp: () => updateCrop((s) => panBy(w, h, s, 0, step)),
      ArrowDown: () => updateCrop((s) => panBy(w, h, s, 0, -step)),
      "+": () => updateCrop((s) => zoomAt(w, h, s, s.zoom * 1.1)),
      "=": () => updateCrop((s) => zoomAt(w, h, s, s.zoom * 1.1)),
      "-": () => updateCrop((s) => zoomAt(w, h, s, s.zoom / 1.1)),
    };
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
    }
  }

  async function withOriginal(kind: "avatar" | "original") {
    setMessage(null);
    if (!downloadsEnabled) {
      setMessage({ type: "error", text: "目前暫停開放下載，請留意粉專公告。" });
      return;
    }
    const ok = await ensureAuth();
    if (!ok) return;
    setBusy(kind);
    try {
      const variant = usePlain ? "plain" : "original";
      const { blob } = await fetchOriginal(image.id, variant, kind, source).catch(async (e) => {
        // 憑證失效（例如密碼剛更新）時重新要求輸入一次
        if (e instanceof DownloadError && e.code === "token_invalid" && (await ensureAuth())) {
          return fetchOriginal(image.id, variant, kind, source);
        }
        throw e;
      });
      if (kind === "original") {
        saveBlob(blob, originalFileName(fileTitle, blob.type || image.mime_type));
        setMessage({ type: "ok", text: "原圖下載完成。" });
        return;
      }
      const url = URL.createObjectURL(blob);
      try {
        // 以「原圖」解析度重新合成（不是截取螢幕預覽）
        const original = await loadImage(url, false);
        const ow = original.naturalWidth;
        const oh = original.naturalHeight;
        const out = await renderAvatarBlob(original, ow, oh, crop, { background: bg }, layers, life ? lifeOutputSize(platform, ow, oh, crop) : undefined);
        saveBlob(out, avatarFileName(PLATFORM_CODE[platform], fileTitle));
        setMessage({ type: "ok", text: layers.some((l) => l.text.trim()) ? "你的專屬大頭貼下載完成！" : `${PLATFORM_LABEL[platform]} 大頭貼下載完成。` });
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setMessage({ type: "error", text: e instanceof DownloadError ? e.message : "下載失敗，請稍後再試。" });
    } finally {
      setBusy("");
    }
  }

  const minZ = minZoom(w, h);
  const circle = platform !== "line";
  const circleLimit = life ? (circleRadius ?? 0.5) : platform === "instagram" ? SAFE_RADIUS : 0.5;
  const outside = useMemo(
    () => layers.filter((l) => l.text.trim() && !insideCircle(clampLayer(l), circleLimit)),
    // fontTick：字型載入後文字尺寸可能改變
    [layers, circleLimit, fontTick], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const selClamped = selected ? clampLayer(selected) : null;
  const selLayout = selected ? layoutLayer(selected) : null;
  const hasText = layers.some((l) => l.text.trim());

  return (
    <Modal title={previewOnly ? `平台裁切預覽：${image.title}` : `大頭貼編輯器：${image.title}`} onClose={onClose} wide>
      <div className="editor">
        <div className="tabs" role="tablist" aria-label="選擇大頭貼用途">
          {(Object.keys(PLATFORM_LABEL) as Platform[]).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={platform === p}
              className={`tab ${platform === p ? "active" : ""} tab-${p}`}
              onClick={() => setPlatform(p)}
            >
              {PLATFORM_LABEL[p]}
            </button>
          ))}
        </div>

        <div className="editor-main">
          <div className="stage-wrap">
            <div
              ref={stageRef}
              className="stage checker"
              tabIndex={0}
              role="application"
              aria-label="編輯區：拖曳圖片或文字移動、雙指或滾輪縮放圖片、方向鍵微調"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onKeyDown}
              data-testid="crop-stage"
            >
              <canvas ref={canvasRef} className="stage-canvas" data-testid="crop-canvas" />
              <svg className="stage-overlay" viewBox="0 0 100 100" aria-hidden="true">
                {circle ? (
                  <>
                    <path d="M0 0H100V100H0Z M50 0A50 50 0 1 0 50.001 0Z" fillRule="evenodd" className="mask" />
                    <circle cx="50" cy="50" r="49.7" className="ring" />
                  </>
                ) : (
                  <rect x="0.3" y="0.3" width="99.4" height="99.4" className="ring" />
                )}
                {!life && (platform === "instagram" || (panel === "text" && layers.length > 0)) && (
                  <circle cx="50" cy="50" r={SAFE_RADIUS * 100} className="safe" />
                )}
                {life && panel === "text" &&
                  ellipses.map((e, i) => (
                    <ellipse key={i} cx={e.cx * 100} cy={e.cy * 100} rx={e.rx * 100} ry={e.ry * 100} className="protect" />
                  ))}
                {selClamped && selLayout && panel === "text" && (
                  <rect
                    x={(selClamped.x - selLayout.w / 2) * 100}
                    y={(selClamped.y - selLayout.h / 2) * 100}
                    width={selLayout.w * 100}
                    height={selLayout.h * 100}
                    className="sel"
                  />
                )}
              </svg>
              {!img && !loadError && <div className="stage-msg">載入預覽中…</div>}
              {loadError && <div className="stage-msg error">{loadError}</div>}
            </div>
            <p className="tiny muted center">拖曳圖片或文字可移動；雙指捏合或滑鼠滾輪可縮放圖片。</p>
            {life && panel === "text" && (
              <p className="tiny muted center">虛線範圍是熊兔的臉、耳朵與胸口愛心，文字會自動避開，不會遮住。</p>
            )}
            {circle && outside.length > 0 && (
              <div className="warn-box" role="status">
                <span>
                  有 {outside.length} 個文字區塊超出圓形{platform === "instagram" && !life ? "安全" : ""}範圍，圓形大頭貼可能會遮住。
                </span>
                <button
                  type="button"
                  className="btn small ghost"
                  onClick={() => {
                    lastRecord.current = 0;
                    setDesign((d) => ({ ...d, layers: d.layers.map((l) => (l.text.trim() ? fitIntoCircle(l, life ? circleLimit : undefined) : l)) }));
                  }}
                >
                  移入安全範圍
                </button>
              </div>
            )}
          </div>

          <div className="editor-side">
            {image.plain_preview_path && (
              <div className="plain-toggle" role="group" aria-label="作品上的文字">
                <span className="tiny muted">作品上的文字</span>
                <div className="seg">
                  <button type="button" aria-pressed={!plain} className={!plain ? "active" : ""} onClick={() => setPlain(false)}>
                    保留原本文字
                  </button>
                  <button type="button" aria-pressed={plain} className={plain ? "active" : ""} onClick={() => setPlain(true)}>
                    拿掉文字
                  </button>
                </div>
              </div>
            )}
            <div className="seg" role="tablist" aria-label="編輯項目">
              <button type="button" role="tab" aria-selected={panel === "photo"} className={panel === "photo" ? "active" : ""} onClick={() => setPanel("photo")}>
                圖片與背景
              </button>
              <button type="button" role="tab" aria-selected={panel === "text"} className={panel === "text" ? "active" : ""} onClick={() => setPanel("text")}>
                文字{layers.length > 0 ? `（${layers.length}）` : ""}
              </button>
            </div>

            {panel === "photo" ? (
              <PhotoPanel
                zoom={crop.zoom}
                minZ={minZ}
                bg={bg}
                customBg={customBg}
                onZoom={(z) => updateCrop((s) => zoomAt(w, h, s, z))}
                onCenter={() => {
                  lastRecord.current = 0;
                  updateCrop((s) => clampState(w, h, { ...s, cx: 0.5, cy: 0.5 }));
                }}
                onFit={() => {
                  lastRecord.current = 0;
                  updateCrop(() => clampState(w, h, { cx: 0.5, cy: 0.5, zoom: minZ }));
                }}
                onResetCrop={() => {
                  lastRecord.current = 0;
                  updateCrop(() => (life ? defaultCrop(w, h, life.zones, platform) : initialState()));
                }}
                onBg={(v) => {
                  lastRecord.current = 0;
                  setDesign((d) => ({ ...d, bg: v }));
                }}
                onCustomBg={(v) => {
                  setCustomBg(v);
                  setDesign((d) => ({ ...d, bg: v }));
                }}
              />
            ) : (
              <>
              {life && (
                <div className="stack presets" data-testid="manifesto-presets">
                  <span className="tiny muted">選一句宣言（可再自由修改）</span>
                  <div className="row wrap">
                    {life.presets.map((t) => (
                      <button key={t} type="button" className="chip small" onClick={() => applyPreset(t)}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <TextPanel
                layers={layers}
                selected={selected}
                onSelect={setSelectedId}
                onAdd={addLayer}
                onRemove={removeLayer}
                onChange={(patch) => selected && updateLayer(selected.id, patch)}
                onCommitPoint={() => (lastRecord.current = 0)}
              />
              </>
            )}

            <div className="row wrap">
              <button type="button" className="btn small ghost" onClick={undo} disabled={history.length === 0}>
                ↶ 撤銷
              </button>
              <button type="button" className="btn small ghost" onClick={resetDesign}>
                {life ? "恢復預設" : "重設設計"}
              </button>
              {life && (
                <button type="button" className="btn small ghost" onClick={clearText} disabled={rawLayers.length === 0}>
                  恢復原始圖片（移除文字）
                </button>
              )}
            </div>

            {life && (
              <div className="platform-minis" role="group" aria-label="三個平台的裁切預覽">
                {PLATFORMS.map((p) => (
                  <button key={p} type="button" className={`mini ${platform === p ? "active" : ""}`} onClick={() => setPlatform(p)} aria-pressed={platform === p}>
                    <canvas ref={(el) => (miniRefs.current[p] = el)} className={`mini-canvas ${p === "line" ? "" : "round"}`} data-testid={`mini-${p}`} />
                    <span>{PLATFORM_LABEL[p]}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="thumbs">
              <figure>
                <canvas ref={roundRef} className="thumb round checker" />
                <figcaption>圓形顯示</figcaption>
              </figure>
              <figure>
                <canvas ref={squareRef} className="thumb checker" />
                <figcaption>方形顯示</figcaption>
              </figure>
            </div>
            <p className="hint">{life ? LIFE_HINT[platform] : PLATFORM_HINT[platform]}</p>

            {!previewOnly && (
              <div className="stack">
                <button type="button" className="btn primary big" disabled={!img || busy !== ""} onClick={() => withOriginal("avatar")}>
                  {busy === "avatar" ? "製作中…" : hasText ? "下載我的專屬大頭貼" : `下載 ${PLATFORM_LABEL[platform]} 大頭貼`}
                </button>
                <button type="button" className="btn ghost" disabled={busy !== ""} onClick={() => withOriginal("original")}>
                  {busy === "original" ? "下載中…" : "下載原始圖片"}
                </button>
                {message && (
                  <p className={message.type === "ok" ? "success" : "error"} role="status">
                    {message.text}
                  </p>
                )}
                <p className="tiny muted">
                  下載檔名：{avatarFileName(PLATFORM_CODE[platform], fileTitle)}。你的文字與排版只在這個瀏覽器中處理，不會上傳或儲存，關閉視窗後不會保留。
                  此為通用的大頭貼裁切示意，各平台實際顯示可能因版本與裝置略有不同。
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function PhotoPanel(props: {
  zoom: number;
  minZ: number;
  bg: string | null;
  customBg: string;
  onZoom: (z: number) => void;
  onCenter: () => void;
  onFit: () => void;
  onResetCrop: () => void;
  onBg: (v: string | null) => void;
  onCustomBg: (v: string) => void;
}) {
  const { zoom, minZ, bg, customBg } = props;
  return (
    <div className="stack">
      <label className="field">
        <span>縮放（{Math.round(zoom * 100)}%）</span>
        <input type="range" min={minZ} max={MAX_ZOOM} step={0.01} value={zoom} onChange={(e) => props.onZoom(Number(e.target.value))} aria-label="縮放" />
      </label>
      <div className="row wrap">
        <button type="button" className="btn small ghost" onClick={props.onCenter}>
          置中
        </button>
        <button type="button" className="btn small ghost" onClick={props.onFit}>
          顯示完整圖片
        </button>
        <button type="button" className="btn small ghost" onClick={props.onResetCrop}>
          重設裁切
        </button>
      </div>
      <fieldset className="bg-picker">
        <legend>背景</legend>
        <div className="row wrap">
          {BACKGROUNDS.map((b) => (
            <button
              key={b.label}
              type="button"
              className={`swatch ${bg === b.value ? "active" : ""} ${b.value ? "" : "checker"}`}
              style={b.value ? { background: b.value } : undefined}
              onClick={() => props.onBg(b.value)}
              aria-pressed={bg === b.value}
              title={b.label}
            >
              <span>{b.label}</span>
            </button>
          ))}
          <label className={`swatch custom ${bg === customBg ? "active" : ""}`} title="自訂顏色">
            <input type="color" value={customBg} onChange={(e) => props.onCustomBg(e.target.value)} />
            <span>自訂</span>
          </label>
        </div>
        <p className="tiny muted">背景色只會出現在作品本身透明的地方；作品若已有底色，看起來不會改變。選「透明」時，透明背景的 PNG 會保留透明。</p>
      </fieldset>
    </div>
  );
}

function TextPanel(props: {
  layers: TextLayer[];
  selected: TextLayer | null;
  onSelect: (id: string | null) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onChange: (patch: Partial<TextLayer>) => void;
  onCommitPoint: () => void;
}) {
  const { layers, selected, onChange, onCommitPoint } = props;
  const change = (patch: Partial<TextLayer>) => {
    onCommitPoint();
    onChange(patch);
  };
  return (
    <div className="stack text-panel">
      <div className="row wrap">
        {layers.map((l, i) => (
          <button key={l.id} type="button" className={`chip small ${selected?.id === l.id ? "active" : ""}`} onClick={() => props.onSelect(l.id)} title={l.text}>
            {i + 1}. {l.text.split("\n")[0].slice(0, 6) || "（空白）"}
          </button>
        ))}
        <button type="button" className="btn small primary" onClick={props.onAdd} disabled={layers.length >= MAX_LAYERS}>
          ＋ 新增文字
        </button>
      </div>

      {!selected ? (
        <p className="muted tiny">
          {layers.length === 0 ? "按「新增文字」開始創作，可以加上名字、祝福語或表情符號。" : "點選上方文字區塊，或直接點畫面上的文字來編輯。"}
        </p>
      ) : (
        <div className="stack">
          <label className="field">
            <span>文字內容（可換行，最多 {MAX_TEXT_LENGTH} 字）</span>
            <textarea rows={2} value={selected.text} maxLength={MAX_TEXT_LENGTH} onFocus={onCommitPoint} onChange={(e) => onChange({ text: e.target.value })} data-testid="text-input" />
          </label>

          <div className="grid-2 tight">
            <label className="field">
              <span>字體</span>
              <select value={selected.font} onChange={(e) => change({ font: e.target.value as FontKey })}>
                {(Object.keys(FONT_LABEL) as FontKey[]).map((f) => (
                  <option key={f} value={f}>
                    {FONT_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>大小（{Math.round(selected.size * 100)}）</span>
              <input type="range" min={0.04} max={0.3} step={0.005} value={selected.size} onPointerDown={onCommitPoint} onChange={(e) => onChange({ size: Number(e.target.value) })} aria-label="文字大小" data-testid="text-size" />
            </label>
          </div>

          <div className="field">
            <span>文字顏色</span>
            <div className="row wrap">
              {TEXT_COLORS.map((c) => (
                <button key={c} type="button" className={`dot ${selected.color === c ? "active" : ""}`} style={{ background: c }} aria-label={`文字顏色 ${c}`} onClick={() => change({ color: c })} />
              ))}
              <input type="color" className="color-input" value={selected.color} onChange={(e) => onChange({ color: e.target.value })} aria-label="自訂文字顏色" />
            </div>
          </div>

          <div className="row wrap">
            <div className="seg small" role="group" aria-label="對齊">
              {(["left", "center", "right"] as TextAlign[]).map((a) => (
                <button key={a} type="button" className={selected.align === a ? "active" : ""} onClick={() => change({ align: a })}>
                  {a === "left" ? "靠左" : a === "center" ? "置中" : "靠右"}
                </button>
              ))}
            </div>
            <button type="button" className={`btn small ${selected.bold ? "primary" : "ghost"}`} onClick={() => change({ bold: !selected.bold })} aria-pressed={selected.bold}>
              粗體
            </button>
            <button type="button" className={`btn small ${selected.shadow ? "primary" : "ghost"}`} onClick={() => change({ shadow: !selected.shadow })} aria-pressed={selected.shadow}>
              陰影
            </button>
            <button type="button" className="btn small ghost" onClick={() => change({ x: 0.5 })}>
              移到水平中央
            </button>
          </div>

          <div className="grid-2 tight">
            <label className="field">
              <span>描邊粗細</span>
              <input type="range" min={0} max={0.3} step={0.01} value={selected.strokeWidth} onPointerDown={onCommitPoint} onChange={(e) => onChange({ strokeWidth: Number(e.target.value) })} aria-label="描邊粗細" />
            </label>
            <label className="field">
              <span>描邊顏色</span>
              <input type="color" className="color-input wide" value={selected.strokeColor} onChange={(e) => onChange({ strokeColor: e.target.value })} aria-label="描邊顏色" />
            </label>
          </div>

          <div className="grid-2 tight">
            <label className="field">
              <span>文字背景透明度（{Math.round(selected.bgOpacity * 100)}%）</span>
              <input type="range" min={0} max={1} step={0.05} value={selected.bgOpacity} onPointerDown={onCommitPoint} onChange={(e) => onChange({ bgOpacity: Number(e.target.value) })} aria-label="文字背景透明度" />
            </label>
            <label className="field">
              <span>文字背景色</span>
              <input type="color" className="color-input wide" value={selected.bgColor} onChange={(e) => onChange({ bgColor: e.target.value, bgOpacity: selected.bgOpacity || 0.8 })} aria-label="文字背景色" />
            </label>
          </div>
          <label className="field">
            <span>背景圓角</span>
            <input type="range" min={0} max={1} step={0.05} value={selected.bgRadius} onPointerDown={onCommitPoint} onChange={(e) => onChange({ bgRadius: Number(e.target.value) })} aria-label="背景圓角" />
          </label>

          <div className="row wrap">
            <button type="button" className="btn small danger" onClick={() => props.onRemove(selected.id)}>
              刪除這個文字
            </button>
            <button type="button" className="btn small ghost" onClick={() => props.onSelect(null)}>
              完成
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
