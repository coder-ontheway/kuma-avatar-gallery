import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase";
import { checkIsAdmin } from "../../lib/admin";

type Status = "loading" | "anon" | "denied" | "ok";

/**
 * 管理後臺外框。這裡的判斷只是為了顯示正確畫面；
 * 真正的權限由資料庫 RLS、RPC 與 Storage 政策在伺服器端強制執行。
 */
export default function AdminLayout() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>("loading");
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let alive = true;
    async function check(s: Session | null) {
      if (!alive) return;
      setSession(s);
      if (!s) return setStatus("anon");
      const ok = await checkIsAdmin();
      if (alive) setStatus(ok ? "ok" : "denied");
    }
    supabase.auth.getSession().then(({ data }) => check(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "SIGNED_OUT" || event === "SIGNED_IN") check(s);
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    navigate("/admin/login", { replace: true });
  }

  if (status === "loading") return <p className="center muted pad">確認管理員身分中…</p>;
  if (status === "anon") return <Navigate to="/admin/login" replace />;
  if (status === "denied")
    return (
      <main className="page narrow">
        <div className="card stack center">
          <h1>沒有管理權限</h1>
          <p className="muted">此帳號（{session?.user.email}）不在授權管理員名單中，或權限已被停用。</p>
          <button className="btn primary" onClick={signOut}>
            登出
          </button>
        </div>
      </main>
    );

  return (
    <div className="admin">
      <header className="admin-header">
        <div className="page header-inner">
          <strong>KUMA 管理後臺</strong>
          <nav className="admin-nav">
            <NavLink to="/admin" end>作品管理</NavLink>
            <NavLink to="/admin/categories">分類管理</NavLink>
            <NavLink to="/admin/settings">網站設定</NavLink>
            <a href="#/" target="_blank" rel="noopener">查看網站 ↗</a>
          </nav>
          <div className="row">
            <span className="tiny muted hide-sm">{session?.user.email}</span>
            <button className="btn small ghost" onClick={signOut}>登出</button>
          </div>
        </div>
      </header>
      <main className="page admin-main">
        <Outlet />
      </main>
    </div>
  );
}
