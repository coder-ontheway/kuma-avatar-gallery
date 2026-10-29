import { createContext, useCallback, useContext, useRef, useState, type FormEvent, type ReactNode } from "react";
import Modal from "./Modal";
import { DownloadError, hasValidToken, verifyPassword } from "../lib/download";

interface Ctx {
  /** 確認已有有效的下載授權；沒有時跳出密碼視窗。回傳 false 代表使用者取消 */
  ensureAuth: () => Promise<boolean>;
}

const DownloadAuthContext = createContext<Ctx>({ ensureAuth: async () => false });

export function useDownloadAuth() {
  return useContext(DownloadAuthContext);
}

export function DownloadAuthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ensureAuth = useCallback(() => {
    if (hasValidToken()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpen(true);
    });
  }, []);

  const finish = useCallback((ok: boolean) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  return (
    <DownloadAuthContext.Provider value={{ ensureAuth }}>
      {children}
      {open && <PasswordDialog onDone={finish} />}
    </DownloadAuthContext.Provider>
  );
}

function PasswordDialog({ onDone }: { onDone: (ok: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const cancel = useCallback(() => onDone(false), [onDone]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password) {
      setError("請輸入下載密碼。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await verifyPassword(password);
      onDone(true);
    } catch (err) {
      setError(err instanceof DownloadError ? err.message : "驗證失敗，請稍後再試。");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="輸入下載密碼" onClose={cancel}>
      <form onSubmit={submit} className="stack">
        <p className="muted">下載原始作品需要粉絲專屬下載密碼。密碼請見 KUMA 工作室 Facebook 粉專公告。</p>
        <label className="field">
          <span>下載密碼</span>
          <input
            type="password"
            autoComplete="off"
            autoFocus
            value={password}
            maxLength={128}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby="pw-error"
          />
        </label>
        <p id="pw-error" className="error" role="alert">
          {error}
        </p>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={cancel}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "驗證中…" : "確認"}
          </button>
        </div>
        <p className="tiny muted">驗證成功後 15 分鐘內下載不需再次輸入。</p>
      </form>
    </Modal>
  );
}
