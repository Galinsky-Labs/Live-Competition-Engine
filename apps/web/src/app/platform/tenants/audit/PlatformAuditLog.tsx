"use client";

import { useEffect, useState } from "react";
import styles from "../../../signup/signup.module.css";
import { useOperator } from "../operator";

interface AuditEvent { sequence: string; actor_account_id: string | null; action: string; subject_type: string; subject_id: string; recorded_at: string }
interface AuditResponse { events: AuditEvent[]; verification: { valid: boolean; count: number; firstInvalidSequence: number | null } }

export function PlatformAuditLog() {
  const { call } = useOperator();
  const [data, setData] = useState<AuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await call("/api/platform/audit?limit=100");
      if (!response.ok) { setError(response.status === 403 ? "This session lacks platform.manage." : "Could not load the audit log."); return; }
      setData(await response.json());
    })();
  }, [call]);

  if (error) return <p role="alert" className={styles.error}>{error}</p>;
  if (!data) return <p aria-busy="true">Loading…</p>;
  return (
    <div>
      <p role="status">
        Hash chain: {data.verification.valid ? `verified (${data.verification.count} events)` : `BROKEN at sequence ${data.verification.firstInvalidSequence}`}
      </p>
      <table className={styles.table}>
        <caption className={styles.hint}>Most recent 100 platform events</caption>
        <thead><tr><th scope="col">#</th><th scope="col">When</th><th scope="col">Action</th><th scope="col">Subject</th><th scope="col">Actor</th></tr></thead>
        <tbody>
          {data.events.map(e => (
            <tr key={e.sequence}>
              <td>{e.sequence}</td>
              <td>{new Date(e.recorded_at).toLocaleString()}</td>
              <td>{e.action}</td>
              <td>{e.subject_type} {e.subject_id}</td>
              <td>{e.actor_account_id ?? "system"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
