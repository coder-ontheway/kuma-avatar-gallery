import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { authLinkType, isConfigured, supabase } from "./lib/supabase";
import Home from "./pages/Home";
import CollectionHome from "./pages/CollectionHome";
import CollectionWorkPage from "./pages/CollectionWorkPage";
import AdminCollection, { AdminLifeRedirect } from "./pages/admin/AdminCollection";
import AdminCollections from "./pages/admin/AdminCollections";
import AdminLogs from "./pages/admin/AdminLogs";
import { LIFE_SLUG } from "./lib/api";
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
        <Route path="/c/:slug" element={<CollectionHome />} />
        <Route path="/c/:slug/:no" element={<CollectionWorkPage />} />
        {/* 舊網址（第一系列）繼續可用 */}
        <Route path="/life" element={<LegacyLifeRedirect />} />
        <Route path="/life/:no" element={<LegacyLifeRedirect />} />
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin/set-password" element={<SetPassword />} />
        <Route path="/admin" element={<AdminLayout />}>
          {/* 系列管理為後臺主要入口 */}
          <Route index element={<AdminCollections />} />
          <Route path="collections/:id" element={<AdminCollection />} />
          <Route path="images" element={<AdminImages />} />
          <Route path="logs" element={<AdminLogs />} />
          <Route path="life" element={<AdminLifeRedirect />} />
          <Route path="categories" element={<AdminCategories />} />
          <Route path="settings" element={<AdminSettings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </DownloadAuthProvider>
  );
}

function LegacyLifeRedirect() {
  const { no } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/c/${LIFE_SLUG}${no ? `/${no}` : ""}${search}`} replace />;
}
