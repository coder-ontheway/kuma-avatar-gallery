import { useEffect } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { authLinkType, isConfigured, supabase } from "./lib/supabase";
import Home from "./pages/Home";
import SetupNotice from "./pages/SetupNotice";
import AdminLogin from "./pages/admin/AdminLogin";
import AdminLayout from "./pages/admin/AdminLayout";
import AdminImages from "./pages/admin/AdminImages";
import AdminCategories from "./pages/admin/AdminCategories";
import AdminSettings from "./pages/admin/AdminSettings";
import SetPassword from "./pages/admin/SetPassword";
import { DownloadAuthProvider } from "./components/DownloadAuth";

export default function App() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isConfigured) return;
    // 管理員從邀請信或重設密碼信回到網站時，導向設定密碼頁
    if (authLinkType) navigate("/admin/set-password", { replace: true });
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") navigate("/admin/set-password", { replace: true });
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  if (!isConfigured) return <SetupNotice />;

  return (
    <DownloadAuthProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin/set-password" element={<SetPassword />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminImages />} />
          <Route path="categories" element={<AdminCategories />} />
          <Route path="settings" element={<AdminSettings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </DownloadAuthProvider>
  );
}
