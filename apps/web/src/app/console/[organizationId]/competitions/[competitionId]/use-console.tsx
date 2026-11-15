"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import { ConsoleApiError, createConsoleApi, hostAuthorization, messageOf } from "../../../../../lib/console-client";
import styles from "./console.module.css";

/** Shared client state for console components: API, busy flag, announced status message. */
export function useConsole(organizationId: string, competitionId: string) {
  const api = useMemo(() => createConsoleApi(organizationId, competitionId, hostAuthorization()), [organizationId, competitionId]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(0);
  const run = useCallback(async (work: () => Promise<void>, options: { success?: string; onConflict?: () => Promise<void> } = {}) => {
    pending.current++;
    setBusy(true);
    setMessage("");
    try {
      await work();
      if (options.success) setMessage(options.success);
    } catch (error) {
      setMessage(messageOf(error));
      if (error instanceof ConsoleApiError && error.status === 409 && options.onConflict) {
        try { await options.onConflict(); } catch { /* keep the conflict message */ }
      }
    } finally {
      if (--pending.current === 0) setBusy(false);
    }
  }, []);
  return { api, busy, message, run };
}

export function StatusLine({ message, busy }: { message: string; busy: boolean }) {
  return <p role="status" aria-live="polite" className={styles.status}>{message || (busy ? "Working…" : "")}</p>;
}

export function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}
