import { useEffect, useState, type FormEvent } from "react";
import { createCategory, deleteCategory, listCategories, updateCategory } from "../../lib/admin";
import type { Category } from "../../lib/types";

export default function AdminCategories() {
  const [cats, setCats] = useState<Category[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setCats(await listCategories());
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function run(fn: () => Promise<void>, ok: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
      setNotice(ok);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    const max = cats.reduce((m, c) => Math.max(m, c.sort_order), 0);
    await run(() => createCategory(n, max + 10), `已新增分類「${n}」。`);
    setName("");
  }

  async function rename(c: Category) {
    const n = window.prompt("新的分類名稱", c.name)?.trim();
    if (!n || n === c.name) return;
    await run(() => updateCategory(c.id, { name: n }), "已更新分類名稱。");
  }

  async function move(idx: number, dir: -1 | 1) {
    const to = idx + dir;
    if (to < 0 || to >= cats.length) return;
    const list = [...cats];
    [list[idx], list[to]] = [list[to], list[idx]];
    await run(async () => {
      for (let i = 0; i < list.length; i++) {
        const order = (i + 1) * 10;
        if (list[i].sort_order !== order) await updateCategory(list[i].id, { sort_order: order });
      }
    }, "已更新排序。");
  }

  async function remove(c: Category) {
    if (!window.confirm(`確定刪除分類「${c.name}」？此分類下的作品會變成「未分類」，作品本身不會被刪除。`)) return;
    await run(() => deleteCategory(c.id), `已刪除分類「${c.name}」。`);
  }

  return (
    <div className="stack-lg">
      <h1>分類管理</h1>
      {error && <p className="error card" role="alert">{error}</p>}
      {notice && <p className="success card" role="status">{notice}</p>}
      <form className="card row wrap" onSubmit={add}>
        <label className="field inline grow">
          <span>新增分類</span>
          <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} placeholder="例如：生日快樂" />
        </label>
        <button className="btn primary" disabled={busy || !name.trim()}>新增</button>
      </form>
      <ul className="card cat-list">
        {cats.map((c, i) => (
          <li key={c.id}>
            <span>{c.name}</span>
            <div className="row">
              <button className="btn small ghost" onClick={() => move(i, -1)} disabled={busy || i === 0} aria-label="上移">↑</button>
              <button className="btn small ghost" onClick={() => move(i, 1)} disabled={busy || i === cats.length - 1} aria-label="下移">↓</button>
              <button className="btn small ghost" onClick={() => rename(c)} disabled={busy}>改名</button>
              <button className="btn small danger" onClick={() => remove(c)} disabled={busy}>刪除</button>
            </div>
          </li>
        ))}
        {cats.length === 0 && <li className="muted">尚無分類</li>}
      </ul>
    </div>
  );
}
