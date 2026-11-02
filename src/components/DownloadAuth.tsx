import { createContext, useCallback, useContext, useRef, useState, type FormEvent, type ReactNode } from "react";
import Modal from "./Modal";
import { DownloadError, hasValidToken, verifyPassword, type AuthScope } from "../lib/download";

interface Ctx {
  /**
   * 確認已有有效的下載授權；沒有時跳出密碼視窗。回傳 false 代表使用者取消。
   * scope 為系列 id 時，要求輸入「該系列」的專屬下載密碼（label 為顯示用的系列名稱）。
   * 每個系列的授權分開保存：通過 A 系列不代表可以下載 B 系列。
   */
  ensureAuth: (scope?: AuthScope, label?: string) => Promise<boolean>;
}

const DownloadAuthContext = createContext<Ctx>({ ensureAuth: async () => false });

export function useDownloadAuth() {
  return useContext(DownloadAuthContext);
}

export function DownloadAuthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ scope: AuthScope; label?: string } | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ensureAuth = useCallback((scope: AuthScope = null, label?: string) => {
    if (hasValidToken(scope)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpen({ scope, label });
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
      {open && <PasswordDialog scope={open.scope} label={open.label} onDone={finish} />}
    </DownloadAuthContext.Provider>
  );
}

function PasswordDialog({ scope, label, onDone }: { scope: AuthScope; label?: string; onDone: (ok: boolean) => void }) {
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
    <Modal title={scope ? `輸入「${label ?? "這個系列"}」下載密碼` : "輸入下載密碼"} onClose={cancel}>
      <form onSubmit={submit} className="stack" data-testid="password-dialog">
        {scope ? (
          <p className="muted">
            每個系列都有自己的專屬下載密碼，請輸入「{label ?? "這個系列"}」的密碼（其他系列或大頭貼收藏館的密碼不能使用）。密碼請透過 KUMA 工作室 Facebook 粉專私訊取得。
          </p>
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
        <p className="tiny muted">驗證成功後 15 分鐘內下載{scope ? "這個系列" : ""}不需再次輸入。</p>
      </form>
    </Modal>
  );
}
