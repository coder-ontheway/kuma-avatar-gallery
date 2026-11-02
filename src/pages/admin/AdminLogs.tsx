import { useEffect, useState } from "react";
import { listAuditLog, listCollections } from "../../lib/adminCollections";
import type { AuditEntry } from "../../lib/types";

const ACTIONS: Record<string, string> = {
  "collection.create": "新增系列",
  "collection.update": "修改系列",
  "collection.delete": "刪除系列",
  "work.create": "新增作品",
  "work.update": "修改作品",
  "work.delete": "刪除作品",
  "password.set": "設定／修改下載密碼",
  "password.regenerate": "重新產生下載密碼",
  "password.enable": "重新啟用下載密碼",
  "password.disable": "停用下載密碼",
  "password.revoke": "撤銷下載密碼",
  "system.migrate": "系統升級",
};

export function actionLabel(a: string) {
  return ACTIONS[a] ?? a;
}

const FIELD: Record<string, string> = {
  name: "名稱", name_en: "英文名稱", slug: "網址代稱", tagline: "標語", description: "介紹", manifestos: "預設宣言", sort_order: "排序",
  status: "狀態", download_enabled: "下載開關", cover_path: "封面", hero_path: "主視覺", id_card_enabled: "身份證開關", card_enabled: "收藏卡開關",
  card_theme: "收藏卡主題", id_card_title: "身份證標題", manifesto_label: "宣言名稱", nickname: "稱號", title: "作品名稱", theme: "主題概念",
  manifesto: "宣言", work_number: "編號", protect_zones: "保護區域", preview_path: "照片", original_path: "原圖", mime_type: "檔案格式",
  file_size: "檔案大小", width: "寬", height: "高", is_downloadable: "可下載", collection_id: "所屬系列",
};

function describe(r: AuditEntry): string {
  const d = r.detail ?? {};
  const parts: string[] = [];
  if (Array.isArray(d.fields) && d.fields.length) parts.push(`欄位：${(d.fields as string[]).map((f) => FIELD[f] ?? f).join("、")}`);
  if (typeof d.published === "boolean") parts.push(d.published ? "公開" : "未公開");
  if (typeof d.version === "number") parts.push(`密碼第 ${d.version} 版`);
  if (d.mode === "move") parts.push(`作品移到其他系列（${d.moved} 款）`);
  if (d.mode === "delete") parts.push(`連同 ${d.deleted_works} 款作品刪除`);
  return parts.join("｜");
}

/** 管理紀錄：兩位管理員對系列、作品、下載密碼的操作（不含密碼內容） */
export default function AdminLogs() {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(200);

  useEffect(() => {
    listAuditLog(limit).then(setRows, (e) => setError((e as Error).message));
    listCollections().then((cs) => setNames(new Map(cs.map((c) => [c.id, c.name]))), () => undefined);
  }, [limit]);

  return (
    <div className="stack-lg">
      <div className="admin-title">
        <h1>管理紀錄</h1>
        <p className="muted">記錄兩位管理員新增、修改、刪除系列與作品，以及設定、停用、撤銷下載密碼的時間與操作者。紀錄不包含密碼內容，也無法被修改或刪除。</p>
      </div>
      {error && <p className="error card">{error}</p>}
      {!rows ? (
        <p className="muted center pad">載入中…</p>
      ) : (
        <div className="card table-wrap">
          <table className="log-table" data-testid="audit-table">
            <thead>
              <tr>
                <th>時間</th>
                <th>管理員</th>
                <th>操作</th>
                <th>系列</th>
                <th>對象</th>
                <th>內容</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{new Date(r.created_at).toLocaleString("zh-TW")}</td>
                  <td>{r.actor_name ?? "系統"}</td>
                  <td>{actionLabel(r.action)}</td>
                  <td>{r.collection_id ? names.get(r.collection_id) ?? "（已刪除）" : ""}</td>
                  <td>{r.target}</td>
                  <td className="tiny">{describe(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length >= limit && (
            <button className="btn small ghost" onClick={() => setLimit(limit + 200)}>
              顯示更多
            </button>
          )}
        </div>
      )}
    </div>
  );
}
