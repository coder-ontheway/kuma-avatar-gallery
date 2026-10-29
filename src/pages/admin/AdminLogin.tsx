import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { checkIsAdmin } from "../../lib/admin";

export default function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setInfo("");
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (err) {
      setBusy(false);
      setError("登入失敗：電子郵件或密碼不正確。");
      return;
    }
    // 由資料庫（伺服器端）判斷是否為授權管理員
    if (!(await checkIsAdmin())) {
      await supabase.auth.signOut();
      setBusy(false);
      setError("此帳號沒有管理權限。");
      return;
    }
    navigate("/admin", { replace: true });
  }

  async function forgot() {
    setError("");
    if (!email.trim()) {
      setError("請先輸入你的電子郵件，再按「忘記密碼」。");
      return;
    }
    const redirectTo = window.location.origin + window.location.pathname;
    await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
    // 不透露帳號是否存在
    setInfo("如果這個電子郵件是管理員帳號，你會收到重設密碼信。");
  }

  return (
    <main className="page narrow admin-login">
      <form className="card stack" onSubmit={submit}>
        <h1>管理員登入</h1>
        <p className="muted">KUMA 熊兔大頭貼收藏館管理後臺，僅限授權管理員使用。</p>
        <label className="field">
          <span>電子郵件</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>密碼</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        {info && <p className="success" role="status">{info}</p>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "登入中…" : "登入"}
        </button>
        <button className="btn link" type="button" onClick={forgot}>
          忘記密碼
        </button>
        <Link to="/" className="tiny center">
          ← 回到網站首頁
        </Link>
      </form>
    </main>
  );
}
