import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { getPasswordStatus, getSettings, listAdmins, saveSettings, setDownloadPassword, type PasswordStatus } from "../../lib/admin";
import type { AdminUser, SiteSettings } from "../../lib/types";

export default function AdminSettings() {
  const [s, setS] = useState<SiteSettings | null>(null);
  const [pwStatus, setPwStatus] = useState<PasswordStatus | null>(null);
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwMsg, setPwMsg] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  async function load() {
    try {
      const [settings, status, list] = await Promise.all([getSettings(), getPasswordStatus(), listAdmins()]);
      setS(settings);
      setPwStatus(status);
      setAdmins(list);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!s) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const fb = s.facebook_url.trim();
      if (fb && !/^https:\/\/\S+$/.test(fb)) throw new Error("Facebook 粉專網址必須以 https:// 開頭。");
      await saveSettings({ ...s, facebook_url: fb });
      setNotice("網站設定已儲存，前臺重新整理後即可看到。");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    if (pw.length < 6 || pw.length > 64) return setPwMsg({ type: "error", text: "下載密碼長度須為 6 到 64 個字元。" });
    if (pw !== pw2) return setPwMsg({ type: "error", text: "兩次輸入的密碼不一致。" });
    setBusy(true);
    try {
      await setDownloadPassword(pw);
      setPw("");
      setPw2("");
      setPwMsg({ type: "ok", text: "下載密碼已更新。舊密碼與先前發出的下載授權都已立即失效。" });
      setPwStatus(await getPasswordStatus());
    } catch (err) {
      setPwMsg({ type: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!s) return error ? <p className="error card">{error}</p> : <p className="muted center pad">載入中…</p>;

  const set = <K extends keyof SiteSettings>(k: K, v: SiteSettings[K]) => setS({ ...s, [k]: v });

  return (
    <div className="stack-lg">
      <h1>網站設定</h1>
      {error && <p className="error card" role="alert">{error}</p>}
      {notice && <p className="success card" role="status">{notice}</p>}

      <form className="card stack" onSubmit={changePassword}>
        <h2>粉絲下載密碼</h2>
        <p className="muted tiny">
          目前狀態：
          {pwStatus?.configured ? (
            <>已設定（第 {pwStatus.version} 版{pwStatus.updated_at ? `，${new Date(pwStatus.updated_at).toLocaleString("zh-TW")}` : ""}{pwStatus.updated_by_name ? ` 由 ${pwStatus.updated_by_name} 更新` : ""}）</>
          ) : (
            <strong className="error">尚未設定，粉絲目前無法下載</strong>
          )}
        </p>
        <p className="muted tiny">密碼只會以雜湊形式存放，任何人（包含管理員）都無法查看目前的密碼；忘記時直接設定新密碼即可。</p>
        <div className="grid-2">
          <label className="field">
            <span>新的下載密碼（6～64 字元）</span>
            <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </label>
          <label className="field">
            <span>再輸入一次</span>
            <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </label>
        </div>
        {pwMsg && <p className={pwMsg.type === "ok" ? "success" : "error"} role="status">{pwMsg.text}</p>}
        <div>
          <button className="btn primary" disabled={busy}>更換下載密碼</button>
        </div>
      </form>

      <form className="card stack" onSubmit={save}>
        <h2>網站內容</h2>
        <div className="grid-2">
          <label className="field">
            <span>網站名稱</span>
            <input value={s.site_name} maxLength={40} onChange={(e) => set("site_name", e.target.value)} />
          </label>
          <label className="field">
            <span>品牌名稱</span>
            <input value={s.brand_name} maxLength={40} onChange={(e) => set("brand_name", e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>網站公告（留空則不顯示）</span>
          <textarea rows={3} maxLength={1000} value={s.announcement} onChange={(e) => set("announcement", e.target.value)} />
        </label>
        <label className="field">
          <span>Facebook 粉專網址</span>
          <input type="url" placeholder="https://www.facebook.com/..." value={s.facebook_url} onChange={(e) => set("facebook_url", e.target.value)} />
        </label>
        <div className="grid-2">
          <label className="field">
            <span>最新更新日期</span>
            <input type="date" value={s.latest_update_date ?? ""} onChange={(e) => set("latest_update_date", e.target.value || null)} />
          </label>
          <label className="field">
            <span>本月作品區標題</span>
            <input value={s.monthly_title} maxLength={30} onChange={(e) => set("monthly_title", e.target.value)} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.monthly_public} onChange={(e) => set("monthly_public", e.target.checked)} />
          公開「本月作品」（關閉時，標記為本月的作品對粉絲隱藏，也無法下載）
        </label>
        <label className="check">
          <input type="checkbox" checked={s.downloads_enabled} onChange={(e) => set("downloads_enabled", e.target.checked)} />
          開放粉絲下載（關閉時仍可瀏覽與預覽，但無法下載）
        </label>
        <div>
          <button className="btn primary" disabled={busy}>儲存網站設定</button>
        </div>
      </form>

      <section className="card stack">
        <h2>授權管理員</h2>
        <p className="muted tiny">本網站固定最多 2 位管理員，權限相同。新增、停用管理員只能由網站擁有者在 Supabase SQL Editor 操作（請見 README），後臺無法新增第三位管理員。</p>
        <ul className="cat-list">
          {admins.map((a) => (
            <li key={a.user_id}>
              <span>
                {a.display_name} <span className="tiny muted">（{a.user_id.slice(0, 8)}…）</span>
              </span>
              <span className={`badge ${a.is_active ? "ok" : "gray"}`}>{a.is_active ? "有效" : "已停用"}</span>
            </li>
          ))}
        </ul>
        <div>
          <Link className="btn ghost" to="/admin/set-password">變更我的登入密碼</Link>
        </div>
      </section>
    </div>
  );
}
