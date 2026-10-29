import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";

/** 管理員設定自己的登入密碼（邀請信、重設密碼信、或登入後自行變更） */
export default function SetPassword() {
  const navigate = useNavigate();
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setHasSession(Boolean(data.session)));
    const { data } = supabase.auth.onAuthStateChange((_e, session) => setHasSession(Boolean(session)));
    return () => data.subscription.unsubscribe();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (pw.length < 10) return setMsg({ type: "error", text: "登入密碼至少 10 個字元。" });
    if (pw !== pw2) return setMsg({ type: "error", text: "兩次輸入的密碼不一致。" });
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setMsg({ type: "error", text: `設定失敗：${error.message}` });
    setPw("");
    setPw2("");
    setMsg({ type: "ok", text: "登入密碼已更新。" });
    setTimeout(() => navigate("/admin", { replace: true }), 1200);
  }

  if (hasSession === null) return <p className="center muted pad">載入中…</p>;

  return (
    <main className="page narrow admin-login">
      <form className="card stack" onSubmit={submit}>
        <h1>設定我的登入密碼</h1>
        {!hasSession ? (
          <>
            <p className="error">連結已失效或尚未登入，請重新申請重設密碼信，或先登入。</p>
            <Link to="/admin/login">前往登入</Link>
          </>
        ) : (
          <>
            <p className="muted">這是「管理員登入」用的密碼，只影響你自己的帳號，與粉絲下載密碼無關。</p>
            <label className="field">
              <span>新密碼（至少 10 個字元）</span>
              <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            </label>
            <label className="field">
              <span>再輸入一次</span>
              <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </label>
            {msg && <p className={msg.type === "ok" ? "success" : "error"} role="status">{msg.text}</p>}
            <button className="btn primary" disabled={busy}>
              {busy ? "儲存中…" : "儲存新密碼"}
            </button>
            <Link to="/admin" className="tiny center">回到管理後臺</Link>
          </>
        )}
      </form>
    </main>
  );
}
