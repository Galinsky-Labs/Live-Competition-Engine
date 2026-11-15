"use client";

import { createContext, useCallback, useContext, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import styles from "../../signup/signup.module.css";

const TOKEN_KEY = "lce.platform.session";
const STEP_UP_KEY = "lce.platform.stepup";

interface StepUp { token: string; expiresAt: string }
interface OperatorContext {
  call(path: string, init?: RequestInit & { stepUp?: boolean }): Promise<Response>;
  stepUp: StepUp | null;
  setStepUp(value: StepUp | null): void;
  signOut(): void;
}

const Context = createContext<OperatorContext | null>(null);

export function useOperator(): OperatorContext {
  const value = useContext(Context);
  if (!value) throw new Error("useOperator outside OperatorGate");
  return value;
}

const read = (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string | null) => {
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch { /* unavailable */ }
};

/**
 * Platform operators paste their bearer session token (kept in sessionStorage for this tab only).
 * Every request is authorized server-side with platform.manage; this gate grants nothing itself.
 */
export function OperatorGate({ children }: { children: ReactNode }) {
  const id = useId();
  const [token, setToken] = useState<string | null>(null);
  const [stepUp, setStepUpState] = useState<StepUp | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setToken(read(TOKEN_KEY));
    const raw = read(STEP_UP_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as StepUp;
        if (new Date(parsed.expiresAt).getTime() > Date.now()) setStepUpState(parsed);
      } catch { /* ignore */ }
    }
    setLoaded(true);
  }, []);

  const setStepUp = useCallback((value: StepUp | null) => {
    setStepUpState(value);
    write(STEP_UP_KEY, value ? JSON.stringify(value) : null);
  }, []);

  const call = useCallback(async (path: string, init: RequestInit & { stepUp?: boolean } = {}) => {
    const { stepUp: withStepUp, ...rest } = init;
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    if (withStepUp && stepUp && new Date(stepUp.expiresAt).getTime() > Date.now()) headers["x-step-up-token"] = stepUp.token;
    return fetch(path, { ...rest, headers: { ...headers, ...(rest.headers as Record<string, string> | undefined) } });
  }, [token, stepUp]);

  const signOut = useCallback(() => { write(TOKEN_KEY, null); setStepUp(null); setToken(null); }, [setStepUp]);

  if (!loaded) return <p aria-busy="true">Loading…</p>;
  if (!token) {
    const onSubmit = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const value = String(new FormData(event.currentTarget).get("token") ?? "").trim();
      if (/^[A-Za-z0-9_-]{43}$/.test(value)) { write(TOKEN_KEY, value); setToken(value); }
    };
    return (
      <form className={styles.form} onSubmit={onSubmit}>
        <div className={styles.field}>
          <label htmlFor={`${id}-token`}>Operator session token</label>
          <input id={`${id}-token`} name="token" type="password" autoComplete="off" required minLength={43} maxLength={43} aria-describedby={`${id}-hint`} />
          <p className={styles.hint} id={`${id}-hint`}>Kept in this browser tab only. Requests require the platform.manage permission.</p>
        </div>
        <button className={styles.button} type="submit">Continue</button>
      </form>
    );
  }
  return (
    <Context.Provider value={{ call, stepUp, setStepUp, signOut }}>
      <p><button type="button" className={styles.secondary} onClick={signOut}>Forget session token</button></p>
      {children}
    </Context.Provider>
  );
}

/** Re-verification for destructive actions: spends one recovery code, grants 10 minutes for this session. */
export function StepUpPanel() {
  const id = useId();
  const { call, stepUp, setStepUp } = useOperator();
  const [error, setError] = useState<string | null>(null);
  const active = stepUp && new Date(stepUp.expiresAt).getTime() > Date.now();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const recoveryCode = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    const response = await call("/api/platform/step-up", { method: "POST", body: JSON.stringify({ method: "recovery_code", recoveryCode }) });
    if (!response.ok) { setError("Re-verification failed. Use an unused recovery code."); return; }
    const body = await response.json();
    setStepUp({ token: body.token, expiresAt: body.expiresAt });
    event.currentTarget.reset();
  }

  async function revoke() {
    await call("/api/platform/step-up", { method: "DELETE" });
    setStepUp(null);
  }

  return (
    <section aria-labelledby={`${id}-h`} className={styles.fieldset}>
      <h2 id={`${id}-h`}>Step-up verification</h2>
      <div role="status" aria-live="polite">
        {active ? <p>Verified until {new Date(stepUp!.expiresAt).toLocaleTimeString()}. <button type="button" className={styles.secondary} onClick={() => void revoke()}>End now</button></p>
          : <p className={styles.hint}>Suspension and deletion require re-verification within the last 10 minutes.</p>}
      </div>
      {!active ? (
        <form className={styles.form} onSubmit={onSubmit}>
          <div className={styles.field}>
            <label htmlFor={`${id}-code`}>Recovery code</label>
            <input id={`${id}-code`} name="code" type="password" autoComplete="one-time-code" required minLength={24} maxLength={24} />
          </div>
          {error ? <p role="alert" className={styles.error}>{error}</p> : null}
          <button className={styles.button} type="submit">Verify</button>
        </form>
      ) : null}
    </section>
  );
}
