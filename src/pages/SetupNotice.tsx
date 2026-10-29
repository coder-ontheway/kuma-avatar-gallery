export default function SetupNotice() {
  return (
    <main className="page narrow">
      <div className="card notice">
        <h1>KUMA 熊兔大頭貼收藏館</h1>
        <p>網站尚未連接 Supabase，因此目前無法顯示作品。</p>
        <p className="muted">
          網站管理員請依 README「部署步驟」設定 <code>VITE_SUPABASE_URL</code> 與 <code>VITE_SUPABASE_ANON_KEY</code>，
          再重新部署。
        </p>
      </div>
    </main>
  );
}
