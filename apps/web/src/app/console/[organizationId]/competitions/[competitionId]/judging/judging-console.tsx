"use client";
import { useCallback, useEffect, useState } from "react";
import { ConsoleApiError } from "../../../../../../lib/console-client";
import { StatusLine, useConsole } from "../use-console";
import styles from "../console.module.css";
import { CritiquePanel } from "./critique-panel";
import { ScorePanel } from "./score-panel";

interface Performance { performanceId: string; entryId: string; displayName: string; ordinal: number; status: string; recused: boolean; }
interface Assignments { status: string; rounds: { roundId: string; label: string; ordinal: number; status: string; panelRole: string; performances: Performance[] }[]; }

/** Judge console: accept an invitation, see assigned rounds only, declare conflicts, open a performance. */
export function JudgingConsole({ organizationId, competitionId }: { organizationId: string; competitionId: string }) {
  const { api, busy, message, run } = useConsole(organizationId, competitionId);
  const [assignments, setAssignments] = useState<Assignments | null>(null);
  const [notJudge, setNotJudge] = useState(false);
  const [token, setToken] = useState("");
  const [open, setOpen] = useState<{ roundId: string; performanceId: string; name: string } | null>(null);
  const [conflict, setConflict] = useState<{ entryId: string; name: string; reason: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setAssignments(await api.get<Assignments>("/judging/assignments"));
      setNotJudge(false);
    } catch (error) {
      if (error instanceof ConsoleApiError && (error.status === 403 || error.status === 404)) { setAssignments(null); setNotJudge(true); return; }
      throw error;
    }
  }, [api]);
  useEffect(() => { void run(load); }, [run, load]);

  return (
    <>
      <StatusLine message={message} busy={busy} />
      {notJudge ? (
        <section aria-labelledby="accept-title" className={styles.panel}>
          <h2 id="accept-title">Accept a judging invitation</h2>
          <p>Sign in with the email address the invitation was sent to, then enter the code you received.</p>
          <form className={styles.row} onSubmit={event => {
            event.preventDefault();
            void run(async () => { await api.send("POST", "/judges/invitations/accept", { token: token.trim() }); setToken(""); await load(); },
              { success: "Invitation accepted. A producer will verify you before scoring opens." });
          }}>
            <label>Invitation code<input required autoComplete="off" value={token} onChange={e => setToken(e.target.value)} /></label>
            <button type="submit" disabled={busy}>Accept invitation</button>
          </form>
        </section>
      ) : null}
      {assignments ? (
        <section aria-labelledby="assigned-title">
          <h2 id="assigned-title">Your assigned rounds</h2>
          <p>Status: {assignments.status}{assignments.status !== "verified" ? " — scoring opens once a producer verifies you." : ""}</p>
          {assignments.rounds.length === 0 ? <p>You are not on any round panel yet.</p> : null}
          {assignments.rounds.map(round => (
            <div key={round.roundId} className={styles.panel}>
              <h3>{round.ordinal}. {round.label} ({round.status}){round.panelRole === "head" ? " — head judge" : ""}</h3>
              <ol>
                {round.performances.map(p => (
                  <li key={p.performanceId} className={styles.row}>
                    <span>{p.displayName} ({p.status}){p.recused ? " — recused" : ""}</span>
                    {!p.recused ? (
                      <>
                        <button type="button" disabled={busy} aria-pressed={open?.performanceId === p.performanceId}
                          onClick={() => setOpen({ roundId: round.roundId, performanceId: p.performanceId, name: p.displayName })}>
                          Open {p.displayName}
                        </button>
                        <button type="button" disabled={busy} onClick={() => setConflict({ entryId: p.entryId, name: p.displayName, reason: "" })}>
                          Declare a conflict with {p.displayName}
                        </button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </section>
      ) : null}
      {open ? (
        <>
          <ScorePanel key={`s-${open.performanceId}`} api={api} run={run} busy={busy} roundId={open.roundId} performanceId={open.performanceId} name={open.name} />
          <CritiquePanel key={`c-${open.performanceId}`} api={api} run={run} busy={busy} roundId={open.roundId} performanceId={open.performanceId} name={open.name} />
        </>
      ) : null}
      {conflict ? (
        <form className={styles.panel} aria-labelledby="conflict-title" onSubmit={event => {
          event.preventDefault();
          void run(async () => { await api.send("POST", "/judging/conflicts", { entryId: conflict.entryId, reason: conflict.reason }); setConflict(null); await load(); },
            { success: "Conflict declared. You are recused from this entry." });
        }}>
          <h2 id="conflict-title">Declare a conflict with {conflict.name}</h2>
          <label>Reason<textarea required maxLength={1000} value={conflict.reason} onChange={e => setConflict({ ...conflict, reason: e.target.value })} /></label>
          <div className={styles.row}>
            <button type="submit" disabled={busy}>Declare and recuse myself</button>
            <button type="button" onClick={() => setConflict(null)}>Cancel</button>
          </div>
        </form>
      ) : null}
    </>
  );
}
