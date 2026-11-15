"use client";

import { useState } from "react";
import styles from "../signup.module.css";

/** Verification is an explicit button press (POST), so link prefetchers cannot consume the token. */
export function VerifyEmail({ accountId, token }: { accountId: string; token: string }) {
  const [state, setState] = useState<"idle" | "busy" | "verified" | "expired" | "invalid">("idle");

  async function verify() {
    setState("busy");
    try {
      const response = await fetch("/api/signup/verify-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId, token })
      });
      if (response.ok) return setState("verified");
      const body = await response.json().catch(() => ({}));
      setState(body.error === "verification_expired" ? "expired" : "invalid");
    } catch {
      setState("invalid");
    }
  }

  return (
    <div>
      <div role="status" aria-live="polite">
        {state === "verified" ? <p className={styles.success}>Your email address is verified. <a className={styles.link} href="/signup/onboarding">Back to setup</a></p> : null}
        {state === "expired" ? <p className={styles.error}>This link has expired. Request a new one from your setup checklist.</p> : null}
        {state === "invalid" ? <p className={styles.error}>This link is not valid or was already used.</p> : null}
      </div>
      {state === "idle" || state === "busy" ? (
        <button type="button" className={styles.button} onClick={() => void verify()} disabled={state === "busy"}>
          {state === "busy" ? "Verifying…" : "Confirm my email address"}
        </button>
      ) : null}
    </div>
  );
}
