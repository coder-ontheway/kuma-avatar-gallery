import { createContext, useCallback, useContext, useRef, useState, type FormEvent, type ReactNode } from "react";
import Modal from "./Modal";
import { DownloadError, hasValidToken, verifyPassword, type AuthScope } from "../lib/download";

interface Ctx {
  /**
   * 確認已有有效的下載授權；沒有時跳出密碼視窗。回傳 false 代表使用者取消。
   * scope 為主題系列 id 時，要求輸入該系列的專屬下載密碼。
   */
  ensureAuth: (scope?: AuthScope) => Promise<boolean>;
}

const DownloadAuthContext = createContext<Ctx>({ ensureAuth: async () => false });

export function useDownloadAuth() {
  return useContext(DownloadAuthContext);
}

export function DownloadAuthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ scope: AuthScope } | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ensureAuth = useCallback((scope: AuthScope = null) => {
    if (hasValidToken(scope)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpen({ scope });
    });
  }, []);

  const finish = useCallback((ok: boolean) => {
    setOpen(null);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  return (
    <DownloadAuthContext.Provider value={{ ensureAuth }}>
      {children}
      {open && <PasswordDialog scope={open.scope} onDone={finish} />}
    </DownloadAuthContext.Provider>
  );
}

function PasswordDialog({ scope, onDone }: { scope: AuthScope; onDone: (ok: boolean) => void }) {
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
      await verifyPassword(password, scope);
      onDone(true);
    } catch (err) {
      setError(err instanceof DownloadError ? err.message : "驗證失敗，請稍後再試。");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={scope ? "輸入生命共同體下載密碼" : "輸入下載密碼"} onClose={cancel}>
      <form onSubmit={submit} className="stack">
        {scope ? (
          <p className="muted">熊兔生命共同體限定收藏館有自己的專屬下載密碼，和原本收藏館的密碼不同。密碼請見 KUMA 工作室 Facebook 粉專公告。</p>
        ) : (
          <p className="muted">下載原始作品需要粉絲專屬下載密碼。密碼請見 KUMA 工作室 Facebook 粉專公告。</p>
        )}
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
