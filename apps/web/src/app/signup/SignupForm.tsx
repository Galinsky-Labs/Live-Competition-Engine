"use client";

import { useId, useState, type FormEvent } from "react";
import styles from "./signup.module.css";
import { SESSION_KEY, type StoredSession } from "./session";

export interface PlanOption {
  planKey: string;
  name: string;
  price: string;
  trialDays: number;
}

const messages: Record<string, string> = {
  slug_unavailable: "That address is already taken. Choose another.",
  slug_reserved: "That address is reserved. Choose another.",
  invalid_slug: "Use 3–40 lowercase letters, digits or single hyphens.",
  email_unavailable: "An account with that email already exists.",
  invalid_email: "Enter a valid email address.",
  invalid_organization_name: "Enter an organization name (2–120 characters).",
  rate_limited: "Too many signups from this network. Try again later.",
  plan_not_found: "That plan is no longer available."
};

export function SignupForm({ plans }: { plans: PlanOption[] }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugNote, setSlugNote] = useState<string | null>(null);
  const [done, setDone] = useState<{ slug: string; testToken?: string; accountId: string } | null>(null);

  async function checkSlug(slug: string) {
    if (!slug) return setSlugNote(null);
    try {
      const response = await fetch(`/api/signup/slug-availability?slug=${encodeURIComponent(slug)}`);
      const body = await response.json() as { available: boolean; reason?: string };
      setSlugNote(body.available ? "Available." : messages[body.reason ?? ""] ?? "Not available.");
    } catch {
      setSlugNote(null);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const planKey = String(form.get("planKey") ?? "");
    try {
      const response = await fetch("/api/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          organizationName: form.get("organizationName"),
          slug: form.get("slug"),
          ...(planKey ? { planKey } : {})
        })
      });
      const body = await response.json();
      if (!response.ok) {
        setError(messages[body.error] ?? "Signup failed. Check the form and try again.");
        return;
      }
      const stored: StoredSession = { token: body.session.token, organizationId: body.organizationId, accountId: body.accountId };
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(stored)); } catch { /* storage unavailable */ }
      setDone({ slug: body.slug, accountId: body.accountId, ...(body.verification?.testToken ? { testToken: body.verification.testToken } : {}) });
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <section className={styles.success} role="status" aria-live="polite">
        <h2>Organization “{done.slug}” created</h2>
        <p>We sent a verification link to your email address. Your session is active in this browser tab.</p>
        {done.testToken ? (
          <p className={styles.hint}>
            Test mode: <a className={styles.link} href={`/signup/verify?account=${done.accountId}&token=${done.testToken}`}>verify now</a>.
          </p>
        ) : null}
        <p><a className={styles.link} href="/signup/onboarding">Continue to your setup checklist</a></p>
      </section>
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate={false} aria-describedby={error ? `${id}-error` : undefined}>
      <div className={styles.field}>
        <label htmlFor={`${id}-email`}>Email address</label>
        <input id={`${id}-email`} name="email" type="email" autoComplete="email" required maxLength={320} />
      </div>
      <div className={styles.field}>
        <label htmlFor={`${id}-name`}>Organization name</label>
        <input id={`${id}-name`} name="organizationName" required minLength={2} maxLength={120} autoComplete="organization" />
      </div>
      <div className={styles.field}>
        <label htmlFor={`${id}-slug`}>Organization address</label>
        <input
          id={`${id}-slug`} name="slug" required minLength={3} maxLength={40}
          aria-describedby={`${id}-slug-hint ${id}-slug-note`} autoCapitalize="none" spellCheck={false}
          onBlur={event => void checkSlug(event.currentTarget.value.trim().toLowerCase())}
        />
        <p className={styles.hint} id={`${id}-slug-hint`}>Lowercase letters, digits and hyphens; 3–40 characters.</p>
        <p className={styles.hint} id={`${id}-slug-note`} aria-live="polite">{slugNote}</p>
      </div>
      {plans.length > 0 ? (
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Plan</legend>
          <label className={styles.plan}>
            <input type="radio" name="planKey" value="" defaultChecked /> Choose later
          </label>
          {plans.map(plan => (
            <label className={styles.plan} key={plan.planKey}>
              <input type="radio" name="planKey" value={plan.planKey} />
              <span>{plan.name} — {plan.price}{plan.trialDays > 0 ? ` (${plan.trialDays}-day trial)` : ""}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {error ? <p className={styles.error} role="alert" id={`${id}-error`}>{error}</p> : null}
      <button className={styles.button} type="submit" disabled={busy}>{busy ? "Creating…" : "Create organization"}</button>
    </form>
  );
}
