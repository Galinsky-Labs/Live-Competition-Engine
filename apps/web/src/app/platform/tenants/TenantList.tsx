"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import styles from "../../signup/signup.module.css";
import { useOperator } from "./operator";

interface Tenant { id: string; name: string; slug: string; status: string; activeMembers: number; openFraudFlags: number; subscriptionStatus: string | null; createdAt: string }

export function TenantList() {
  const id = useId();
  const { call } = useOperator();
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState({ q: "", status: "" });

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter.q) params.set("q", filter.q);
    if (filter.status) params.set("status", filter.status);
    const response = await call(`/api/platform/tenants?${params}`);
    if (!response.ok) { setError(response.status === 403 ? "This session lacks platform.manage." : "Could not load tenants."); return; }
    setError(null);
    setTenants((await response.json()).tenants);
  }, [call, filter]);

  useEffect(() => { void load(); }, [load]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setFilter({ q: String(form.get("q") ?? "").trim(), status: String(form.get("status") ?? "") });
  };

  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>All tenants</h2>
      <form className={styles.form} onSubmit={onSubmit} role="search">
        <div className={styles.field}>
          <label htmlFor={`${id}-q`}>Search name, slug or id</label>
          <input id={`${id}-q`} name="q" maxLength={100} />
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-status`}>Status</label>
          <select id={`${id}-status`} name="status" defaultValue="">
            <option value="">Any</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="scheduled_deletion">Scheduled for deletion</option>
            <option value="deleted">Deleted</option>
          </select>
        </div>
        <button className={styles.button} type="submit">Filter</button>
      </form>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      {tenants ? (
        <table className={styles.table}>
          <caption className={styles.hint}>{tenants.length} tenant(s)</caption>
          <thead><tr><th scope="col">Tenant</th><th scope="col">Status</th><th scope="col">Members</th><th scope="col">Open flags</th><th scope="col">Subscription</th></tr></thead>
          <tbody>
            {tenants.map(t => (
              <tr key={t.id}>
                <td><a className={styles.link} href={`/platform/tenants/${t.id}`}>{t.name}</a><br /><span className={styles.hint}>{t.slug}</span></td>
                <td>{t.status}</td>
                <td>{t.activeMembers}</td>
                <td>{t.openFraudFlags}</td>
                <td>{t.subscriptionStatus ?? "none"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
