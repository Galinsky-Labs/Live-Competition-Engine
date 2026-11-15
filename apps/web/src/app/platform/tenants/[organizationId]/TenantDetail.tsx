"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import styles from "../../../signup/signup.module.css";
import { useOperator } from "../operator";

interface Detail {
  tenant: { id: string; name: string; slug: string; status: string; lifecycleRevision: number; deletionScheduledFor: string | null; activeMembers: number; subscriptionStatus: string | null };
  lifecycle: { id: string; action: string; from_status: string; to_status: string; reason: string; created_at: string }[];
  notes: { id: string; body: string; createdAt: string; authorAccountId: string }[];
  flags: { id: string; severity: string; reason: string; status: string; revision: number; createdAt: string }[];
}

const actionsFor: Record<string, { action: string; label: string; destructive: boolean }[]> = {
  active: [{ action: "suspend", label: "Suspend", destructive: true }, { action: "schedule_deletion", label: "Schedule deletion (30-day grace)", destructive: true }],
  suspended: [{ action: "reactivate", label: "Reactivate", destructive: false }, { action: "schedule_deletion", label: "Schedule deletion (30-day grace)", destructive: true }],
  scheduled_deletion: [{ action: "cancel_deletion", label: "Cancel deletion (stays suspended)", destructive: false }, { action: "finalize_deletion", label: "Finalize deletion", destructive: true }],
  deleted: []
};

const errorText: Record<string, string> = {
  step_up_required: "Re-verify with a recovery code first (step-up).",
  tenant_revision_conflict: "The tenant changed meanwhile. Reloaded; try again.",
  invalid_state_deletion_grace_period: "The 30-day grace period has not elapsed.",
  invalid_reason: "Give a reason of at least 3 characters.",
  invalid_note: "Enter a note.",
  flag_revision_conflict: "The flag changed meanwhile. Reloaded; try again."
};

export function TenantDetail({ organizationId }: { organizationId: string }) {
  const id = useId();
  const { call } = useOperator();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await call(`/api/platform/tenants/${encodeURIComponent(organizationId)}`);
    if (!response.ok) { setError(response.status === 404 ? "Tenant not found." : response.status === 403 ? "This session lacks platform.manage." : "Could not load tenant."); return; }
    setDetail(await response.json());
  }, [call, organizationId]);

  useEffect(() => { void load(); }, [load]);

  async function submit(path: string, body: unknown, success: string, stepUp = false) {
    setError(null);
    const response = await call(path, { method: "POST", body: JSON.stringify(body), stepUp });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(errorText[payload.error] ?? `Request failed (${payload.error ?? response.status}).`);
      if (response.status === 409) await load();
      return false;
    }
    setMessage(success);
    await load();
    return true;
  }

  if (error && !detail) return <p role="alert" className={styles.error}>{error}</p>;
  if (!detail) return <p aria-busy="true">Loading…</p>;
  const { tenant } = detail;

  return (
    <div>
      <div role="status" aria-live="polite" className={styles.hint}>{message}</div>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      <h2>{tenant.name}</h2>
      <dl>
        <dt>Slug</dt><dd>{tenant.slug}</dd>
        <dt>Status</dt><dd>{tenant.status}{tenant.deletionScheduledFor ? ` (deletion after ${new Date(tenant.deletionScheduledFor).toLocaleString()})` : ""}</dd>
        <dt>Active members</dt><dd>{tenant.activeMembers}</dd>
        <dt>Subscription</dt><dd>{tenant.subscriptionStatus ?? "none"}</dd>
      </dl>

      <section aria-labelledby={`${id}-life`}>
        <h2 id={`${id}-life`}>Lifecycle</h2>
        {(actionsFor[tenant.status] ?? []).length === 0 ? <p>No further lifecycle actions.</p> : (
          <form className={styles.form} onSubmit={async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const action = String(form.get("action"));
            const destructive = actionsFor[tenant.status]!.find(a => a.action === action)?.destructive ?? true;
            await submit(`/api/platform/tenants/${tenant.id}/lifecycle`,
              { action, reason: form.get("reason"), expectedRevision: tenant.lifecycleRevision }, `Applied ${action}.`, destructive);
          }}>
            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>Action</legend>
              {actionsFor[tenant.status]!.map((a, index) => (
                <label className={styles.plan} key={a.action}>
                  <input type="radio" name="action" value={a.action} defaultChecked={index === 0} />
                  {a.label}{a.destructive ? " — requires step-up" : ""}
                </label>
              ))}
            </fieldset>
            <div className={styles.field}>
              <label htmlFor={`${id}-reason`}>Reason (recorded in the audit log)</label>
              <textarea id={`${id}-reason`} name="reason" required minLength={3} maxLength={1000} rows={2} />
            </div>
            <button className={styles.button} type="submit">Apply</button>
          </form>
        )}
        <h3>History</h3>
        <ul>
          {detail.lifecycle.map(e => <li key={e.id}>{new Date(e.created_at).toLocaleString()}: {e.action} ({e.from_status} → {e.to_status}) — {e.reason}</li>)}
        </ul>
      </section>

      <section aria-labelledby={`${id}-flags`}>
        <h2 id={`${id}-flags`}>Fraud flags</h2>
        <ul>
          {detail.flags.map(f => (
            <li key={f.id}>
              <strong>{f.severity}</strong> · {f.status} · {f.reason}{" "}
              {f.status === "open" ? (
                <button type="button" className={styles.secondary} onClick={() => {
                  const resolution = window.prompt("Resolution (at least 3 characters)");
                  if (resolution) void submit(`/api/platform/fraud-flags/${f.id}/resolve`, { resolution, expectedRevision: f.revision }, "Flag resolved.");
                }}>Resolve</button>
              ) : null}
            </li>
          ))}
        </ul>
        <form className={styles.form} onSubmit={async (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const formElement = event.currentTarget;
          const form = new FormData(formElement);
          if (await submit("/api/platform/fraud-flags", { subjectType: "organization", subjectId: tenant.id, severity: form.get("severity"), reason: form.get("reason") }, "Flag raised.")) formElement.reset();
        }}>
          <div className={styles.field}>
            <label htmlFor={`${id}-sev`}>Severity</label>
            <select id={`${id}-sev`} name="severity" defaultValue="medium">
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor={`${id}-freason`}>Reason</label>
            <input id={`${id}-freason`} name="reason" required minLength={3} maxLength={2000} />
          </div>
          <button className={styles.button} type="submit">Raise flag</button>
        </form>
      </section>

      <section aria-labelledby={`${id}-notes`}>
        <h2 id={`${id}-notes`}>Support notes</h2>
        <ul>{detail.notes.map(n => <li key={n.id}>{new Date(n.createdAt).toLocaleString()}: {n.body}</li>)}</ul>
        <form className={styles.form} onSubmit={async (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const formElement = event.currentTarget;
          if (await submit(`/api/platform/tenants/${tenant.id}/notes`, { body: new FormData(formElement).get("body") }, "Note added.")) formElement.reset();
        }}>
          <div className={styles.field}>
            <label htmlFor={`${id}-note`}>New note (append-only)</label>
            <textarea id={`${id}-note`} name="body" required maxLength={4000} rows={3} />
          </div>
          <button className={styles.button} type="submit">Add note</button>
        </form>
      </section>
    </div>
  );
}
