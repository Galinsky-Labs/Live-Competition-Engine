"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import styles from "../../../signup/signup.module.css";
import { useOperator } from "../operator";

interface Version { version: number; title: string; body: string; severity: string; status: string; targetOrganizationIds: string[] | null }
interface Announcement { id: string; kind: string; publishedVersion: number | null; withdrawnAt: string | null; versions: Version[] }

export function AnnouncementsAdmin() {
  const id = useId();
  const { call } = useOperator();
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await call("/api/platform/announcements");
    if (!response.ok) { setError(response.status === 403 ? "This session lacks platform.manage." : "Could not load announcements."); return; }
    setItems((await response.json()).announcements);
  }, [call]);

  useEffect(() => { void load(); }, [load]);

  async function post(path: string, body: unknown, success: string) {
    setError(null);
    const response = await call(path, { method: "POST", body: JSON.stringify(body) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(`Request failed (${payload.error ?? response.status}).`);
      return false;
    }
    setMessage(success);
    await load();
    return true;
  }

  const targets = (raw: FormDataEntryValue | null) => {
    const list = String(raw ?? "").split(/[\s,]+/).filter(Boolean);
    return list.length ? list : null;
  };

  return (
    <div>
      <div role="status" aria-live="polite" className={styles.hint}>{message}</div>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      <section aria-labelledby={`${id}-new`}>
        <h2 id={`${id}-new`}>New draft</h2>
        <form className={styles.form} onSubmit={async (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const formElement = event.currentTarget;
          const form = new FormData(formElement);
          const ok = await post("/api/platform/announcements", {
            kind: form.get("kind"), title: form.get("title"), body: form.get("body"), severity: form.get("severity"),
            targetOrganizationIds: targets(form.get("targets"))
          }, "Draft created.");
          if (ok) formElement.reset();
        }}>
          <div className={styles.field}>
            <label htmlFor={`${id}-kind`}>Kind</label>
            <select id={`${id}-kind`} name="kind" defaultValue="release_note">
              <option value="release_note">Release note</option><option value="announcement">Announcement</option>
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor={`${id}-severity`}>Severity</label>
            <select id={`${id}-severity`} name="severity" defaultValue="info">
              <option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option>
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor={`${id}-title`}>Title</label>
            <input id={`${id}-title`} name="title" required maxLength={200} />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${id}-body`}>Body</label>
            <textarea id={`${id}-body`} name="body" required maxLength={20000} rows={5} />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${id}-targets`}>Target tenant ids (optional; blank = all tenants)</label>
            <input id={`${id}-targets`} name="targets" />
          </div>
          <button className={styles.button} type="submit">Create draft</button>
        </form>
      </section>
      <section aria-labelledby={`${id}-list`}>
        <h2 id={`${id}-list`}>Existing</h2>
        <ul className={styles.checklist}>
          {(items ?? []).map(a => {
            const latest = a.versions[0];
            return (
              <li key={a.id}>
                <span>
                  <strong>{latest?.title}</strong> ({a.kind}) — v{latest?.version} {latest?.status}
                  {a.publishedVersion ? `; live: v${a.publishedVersion}` : "; not live"}{a.withdrawnAt ? "; withdrawn" : ""}
                  {latest?.targetOrganizationIds ? `; ${latest.targetOrganizationIds.length} target tenant(s)` : "; all tenants"}
                </span>
                {!a.withdrawnAt ? (
                  <span>
                    {latest && latest.status === "draft" ? (
                      <button type="button" className={styles.secondary} onClick={() => void post(`/api/platform/announcements/${a.id}/publish`, { version: latest.version }, `Published v${latest.version}.`)}>Publish v{latest.version}</button>
                    ) : null}{" "}
                    <button type="button" className={styles.secondary} onClick={() => void post(`/api/platform/announcements/${a.id}/withdraw`, {}, "Withdrawn.")}>Withdraw</button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
