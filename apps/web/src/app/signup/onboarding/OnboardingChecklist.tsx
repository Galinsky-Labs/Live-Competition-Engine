"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import styles from "../signup.module.css";
import { readStoredSession, type StoredSession } from "../session";

interface Step { key: string; status: "complete" | "pending" | "skipped" | "external_pending"; required: boolean }
interface Checklist { steps: Step[]; completed: number; total: number; ready: boolean; firstEventId: string | null }

const labels: Record<string, string> = {
  email_verified: "Verify your email address",
  branding_set: "Set your branding (theme and logo)",
  custom_domain_claimed: "Claim a custom domain",
  members_invited: "Invite team members",
  payment_setup: "Set up payment",
  first_event_created: "Create your first event"
};
const statusText: Record<Step["status"], string> = {
  complete: "Done", pending: "To do", skipped: "Skipped", external_pending: "Pending (billing)"
};
const skippable = new Set(["branding_set", "custom_domain_claimed", "members_invited", "payment_setup"]);
const errors: Record<string, string> = {
  no_active_subscription: "Choose a plan before creating events.",
  plan_limit_exceeded: "Your plan's monthly event limit is reached.",
  invalid_event_title: "Enter an event title (2–160 characters).",
  invalid_event_start: "Enter a start time in the future.",
  tenant_suspended: "This organization is suspended."
};

export function OnboardingChecklist() {
  const id = useId();
  const [session, setSession] = useState<StoredSession | null>(null);
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const call = useCallback(async (path: string, init: RequestInit = {}) => {
    if (!session) throw new Error("no session");
    return fetch(`/api/organizations/${session.organizationId}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json", ...(init.headers ?? {}) }
    });
  }, [session]);

  const load = useCallback(async () => {
    const response = await call("/onboarding");
    if (!response.ok) {
      setError(response.status === 401 || response.status === 403 ? "Your session has ended. Sign up or recover your account to continue." : "Could not load your checklist.");
      return;
    }
    setChecklist(await response.json());
  }, [call]);

  useEffect(() => { setSession(readStoredSession()); setReady(true); }, []);
  useEffect(() => { if (session) void load(); }, [session, load]);

  async function toggleSkip(step: Step) {
    setError(null);
    const response = await call("/onboarding", { method: "POST", body: JSON.stringify({ step: step.key, skipped: step.status !== "skipped" }) });
    if (response.ok) { setChecklist(await response.json()); setMessage(`${labels[step.key]}: updated.`); }
    else setError("Could not update that step.");
  }

  async function resend() {
    setError(null);
    const response = await fetch("/api/signup/verify-email/resend", { method: "POST", headers: { authorization: `Bearer ${session?.token}` } });
    setMessage(response.ok ? "A new verification email is on its way." : null);
    if (!response.ok) setError(response.status === 429 ? "Too many requests. Try again later." : "Could not send a new verification email.");
  }

  async function createEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const startsAtLocal = String(form.get("startsAt") ?? "");
    const response = await call("/onboarding/first-event", {
      method: "POST",
      body: JSON.stringify({
        title: form.get("title"),
        ...(startsAtLocal ? { startsAt: new Date(startsAtLocal).toISOString() } : {})
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setError(errors[body.error] ?? "Could not create the event."); return; }
    setMessage("Your first event was created as a draft.");
    await load();
  }

  if (!ready) return <p aria-busy="true">Loading…</p>;
  if (!session) {
    return <p className={styles.error} role="alert">No active signup session in this tab. <a className={styles.link} href="/signup">Create an organization</a>.</p>;
  }

  return (
    <div>
      <div role="status" aria-live="polite" className={styles.hint}>{message}</div>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      {checklist ? (
        <>
          <p>{checklist.completed} of {checklist.total} steps complete{checklist.ready ? " — you are ready to go." : "."}</p>
          <ul className={styles.checklist} aria-label="Setup steps">
            {checklist.steps.map(step => (
              <li key={step.key}>
                <span>{labels[step.key] ?? step.key}{step.required ? "" : " (optional)"}</span>
                <span>
                  <span className={styles.badge}>{statusText[step.status]}</span>{" "}
                  {step.key === "email_verified" && step.status === "pending" ? (
                    <button type="button" className={styles.secondary} onClick={() => void resend()}>Resend email</button>
                  ) : null}
                  {skippable.has(step.key) && step.status !== "complete" ? (
                    <button type="button" className={styles.secondary} onClick={() => void toggleSkip(step)}>
                      {step.status === "skipped" ? "Undo skip" : "Skip"}
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {checklist.firstEventId === null ? (
            <section aria-labelledby={`${id}-event`}>
              <h2 id={`${id}-event`}>Create your first event</h2>
              <form className={styles.form} onSubmit={createEvent}>
                <div className={styles.field}>
                  <label htmlFor={`${id}-title`}>Event title</label>
                  <input id={`${id}-title`} name="title" required minLength={2} maxLength={160} />
                </div>
                <div className={styles.field}>
                  <label htmlFor={`${id}-start`}>Start time (optional)</label>
                  <input id={`${id}-start`} name="startsAt" type="datetime-local" />
                </div>
                <button type="submit" className={styles.button}>Create draft event</button>
              </form>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
