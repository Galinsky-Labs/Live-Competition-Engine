"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatDate, StatusLine, useConsole } from "../use-console";
import styles from "../console.module.css";

interface Judge { judgeId: string; displayName: string; status: string; verifiedAt: string | null; revision: number; linkedAccount: boolean; activeRecusals: number; }
interface Invitation { id: string; email: string; displayName: string; status: string; expiresAt: string; }
interface Recusal { id: string; judgeId: string; entryId: string; source: string; reason: string; declaredAt: string; rescindedAt: string | null; }

const nextStatuses: Record<string, [string, string][]> = {
  active: [["verified", "Verify"], ["suspended", "Suspend"], ["removed", "Remove"]],
  verified: [["suspended", "Suspend"], ["removed", "Remove"]],
  suspended: [["active", "Reactivate"], ["removed", "Remove"]],
  removed: []
};

export function JudgesConsole({ organizationId, competitionId }: { organizationId: string; competitionId: string }) {
  const { api, busy, message, run } = useConsole(organizationId, competitionId);
  const [judges, setJudges] = useState<Judge[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [recusals, setRecusals] = useState<Recusal[]>([]);
  const [invite, setInvite] = useState({ email: "", displayName: "", expiresInHours: 72 });
  const [issued, setIssued] = useState<{ email: string; token: string } | null>(null);
  const [recusal, setRecusal] = useState({ judgeId: "", entryId: "", reason: "" });

  const load = useCallback(async () => {
    const [j, i, r] = await Promise.all([
      api.get<{ items: Judge[] }>("/judges"), api.get<{ items: Invitation[] }>("/judges/invitations"), api.get<{ items: Recusal[] }>("/judges/recusals")
    ]);
    setJudges(j.items); setInvitations(i.items); setRecusals(r.items);
  }, [api]);
  useEffect(() => { void run(load); }, [run, load]);

  const submitInvite = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await api.send<{ token: string; invitation: Invitation }>("POST", "/judges/invitations", invite);
      setIssued({ email: result.invitation.email, token: result.token });
      setInvite({ email: "", displayName: "", expiresInHours: 72 });
      await load();
    }, { success: "Invitation created. Share the code below privately; it is shown only once." });
  };
  const judgeName = (id: string) => judges.find(j => j.judgeId === id)?.displayName ?? id;

  return (
    <>
      <StatusLine message={message} busy={busy} />
      <section aria-labelledby="invite-title" className={styles.panel}>
        <h2 id="invite-title">Invite a judge</h2>
        <form onSubmit={submitInvite} className={styles.row}>
          <label>Email<input type="email" required maxLength={320} value={invite.email} onChange={e => setInvite({ ...invite, email: e.target.value })} /></label>
          <label>Display name<input required maxLength={120} value={invite.displayName} onChange={e => setInvite({ ...invite, displayName: e.target.value })} /></label>
          <label>Valid for (hours)<input type="number" min={1} max={720} value={invite.expiresInHours} onChange={e => setInvite({ ...invite, expiresInHours: Number(e.target.value) })} /></label>
          <button type="submit" disabled={busy}>Create invitation</button>
        </form>
        {issued ? (
          <div role="note">
            <p>Invitation code for {issued.email} (single use; the judge signs in with that email and enters it on the Judging page):</p>
            <p><code>{issued.token}</code></p>
            <button type="button" onClick={() => setIssued(null)}>Hide code</button>
          </div>
        ) : null}
        <h3>Invitations</h3>
        <ul>
          {invitations.map(i => (
            <li key={i.id} className={styles.row}>
              <span>{i.displayName} ({i.email}) — {i.status}, expires {formatDate(i.expiresAt)}</span>
              {i.status === "open" ? (
                <button type="button" disabled={busy} onClick={() => void run(async () => { await api.send("DELETE", `/judges/invitations/${i.id}`); await load(); }, { success: "Invitation revoked." })}>
                  Revoke invitation for {i.email}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="judges-title">
        <h2 id="judges-title">Judges</h2>
        <table>
          <thead><tr><th scope="col">Judge</th><th scope="col">Status</th><th scope="col">Recusals</th><th scope="col">Actions</th></tr></thead>
          <tbody>
            {judges.map(j => (
              <tr key={j.judgeId}>
                <th scope="row">{j.displayName}</th>
                <td>{j.status}{j.verifiedAt ? ` (verified ${formatDate(j.verifiedAt)})` : ""}</td>
                <td>{j.activeRecusals}</td>
                <td className={styles.row}>
                  {(nextStatuses[j.status] ?? []).map(([status, text]) => (
                    <button key={status} type="button" disabled={busy} onClick={() => void run(async () => {
                      await api.send("POST", `/judges/${j.judgeId}/status`, { status, expectedRevision: j.revision });
                      await load();
                    }, { success: `${j.displayName}: ${text.toLowerCase()} done.`, onConflict: load })}>{text} {j.displayName}</button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="recusal-title" className={styles.panel}>
        <h2 id="recusal-title">Recusals and conflicts of interest</h2>
        <form className={styles.row} onSubmit={event => {
          event.preventDefault();
          void run(async () => { await api.send("POST", "/judges/recusals", recusal); setRecusal({ judgeId: "", entryId: "", reason: "" }); await load(); }, { success: "Judge recused." });
        }}>
          <label>Judge
            <select required value={recusal.judgeId} onChange={e => setRecusal({ ...recusal, judgeId: e.target.value })}>
              <option value="">Choose a judge</option>
              {judges.map(j => <option key={j.judgeId} value={j.judgeId}>{j.displayName}</option>)}
            </select>
          </label>
          <label>Entry id<input required pattern="[0-9a-fA-F-]{36}" value={recusal.entryId} onChange={e => setRecusal({ ...recusal, entryId: e.target.value })} /></label>
          <label>Reason<input required maxLength={1000} value={recusal.reason} onChange={e => setRecusal({ ...recusal, reason: e.target.value })} /></label>
          <button type="submit" disabled={busy}>Recuse judge</button>
        </form>
        <ul>
          {recusals.map(r => (
            <li key={r.id} className={styles.row}>
              <span>{judgeName(r.judgeId)} · entry {r.entryId.slice(0, 8)} · {r.source === "self_declared" ? "declared by judge" : "set by producer"} · {r.reason} · {r.rescindedAt ? `lifted ${formatDate(r.rescindedAt)}` : "active"}</span>
              {!r.rescindedAt ? (
                <button type="button" disabled={busy} onClick={() => {
                  const reason = window.prompt("Reason for lifting this recusal");
                  if (reason) void run(async () => { await api.send("POST", `/judges/recusals/${r.id}/rescind`, { reason }); await load(); }, { success: "Recusal lifted." });
                }}>Lift recusal of {judgeName(r.judgeId)}</button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
