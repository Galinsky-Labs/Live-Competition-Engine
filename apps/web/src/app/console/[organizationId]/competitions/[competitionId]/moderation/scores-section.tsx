"use client";
import { useCallback, useEffect, useState } from "react";
import { formatDate, StatusLine, useConsole } from "../use-console";
import styles from "../console.module.css";

interface Rubric { id: string; version: number; status: string; createdAt: string; definition: { criteria: { key: string; label: string }[]; aggregation: { method: string; trim: number }; normalization: string; tieBreakers: unknown[] }; }
interface Correction { id: string; status: string; reason: string; originalValues: Record<string, number>; proposedValues: Record<string, number>; revision: number; createdAt: string; performanceId: string; }
interface Standing { entryId: string; displayName: string; rank: number | null; score: number | null; judgeCount: number; tieBreak: string | null; tied: boolean; }
interface Summary { rounds: { id: string; label: string; ordinal: number }[]; }

const example = JSON.stringify({
  criteria: [{ key: "execution", label: "Execution", min: 0, max: 10, step: 0.5, weight: 2 }, { key: "originality", label: "Originality", min: 0, max: 10, step: 1, weight: 1 }],
  aggregation: { method: "trimmed_mean", trim: 1 }, normalization: "none", tieBreakers: [{ type: "criterion", key: "execution" }, { type: "head_judge" }]
}, null, 2);
const values = (v: Record<string, number>) => Object.entries(v).map(([k, n]) => `${k} ${n}`).join(", ");

/** Producer view of rubric versions, score corrections and standings (LC-20). */
export function ScoresSection({ organizationId, competitionId }: { organizationId: string; competitionId: string }) {
  const { api, busy, message, run } = useConsole(organizationId, competitionId);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [draft, setDraft] = useState(example);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [decisionReason, setDecisionReason] = useState<Record<string, string>>({});
  const [rounds, setRounds] = useState<Summary["rounds"]>([]);
  const [roundId, setRoundId] = useState("");
  const [standings, setStandings] = useState<Standing[] | null>(null);

  const load = useCallback(async () => {
    const [r, c, s] = await Promise.all([
      api.get<{ items: Rubric[] }>("/scoring/rubrics"), api.get<{ items: Correction[] }>("/scoring/corrections?status=pending"), api.get<Summary>("/selection")
    ]);
    setRubrics(r.items); setCorrections(c.items); setRounds(s.rounds);
  }, [api]);
  useEffect(() => { void run(load); }, [run, load]);

  return (
    <section aria-labelledby="scores-title">
      <h2 id="scores-title">Scoring</h2>
      <StatusLine message={message} busy={busy} />
      <div className={styles.panel}>
        <h3>Rubric versions</h3>
        <ul>
          {rubrics.map(r => (
            <li key={r.id} className={styles.row}>
              <span>Version {r.version} — {r.status} · {r.definition.criteria.map(c => c.label).join(", ")} · {r.definition.aggregation.method.replace(/_/g, " ")}{r.definition.normalization === "z_score" ? " · z-score" : ""}</span>
              {r.status === "draft" ? (
                <button type="button" disabled={busy} onClick={() => void run(async () => { await api.send("POST", `/scoring/rubrics/${r.id}/activate`); await load(); }, { success: `Version ${r.version} is now active.` })}>
                  Activate version {r.version}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        <form onSubmit={event => {
          event.preventDefault();
          void run(async () => {
            let definition: unknown;
            try { definition = JSON.parse(draft); } catch { throw new Error("The rubric is not valid JSON."); }
            await api.send("POST", "/scoring/rubrics", { definition });
            await load();
          }, { success: "New rubric version created as a draft." });
        }}>
          <label>New rubric version (JSON: criteria, aggregation, normalization, tieBreakers)
            <textarea rows={10} cols={70} value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false} />
          </label>
          <button type="submit" disabled={busy}>Create draft version</button>
        </form>
      </div>

      <div className={styles.panel}>
        <h3>Pending score corrections</h3>
        {corrections.length === 0 ? <p>No pending corrections.</p> : null}
        <ul>
          {corrections.map(c => (
            <li key={c.id}>
              <p>Requested {formatDate(c.createdAt)}: {values(c.originalValues)} → <strong>{values(c.proposedValues)}</strong>. Reason: {c.reason}</p>
              <div className={styles.row}>
                <label>Decision note (required to reject)
                  <input maxLength={1000} value={decisionReason[c.id] ?? ""} onChange={e => setDecisionReason({ ...decisionReason, [c.id]: e.target.value })} />
                </label>
                {(["approved", "rejected"] as const).map(decision => (
                  <button key={decision} type="button" disabled={busy} onClick={() => void run(async () => {
                    await api.send("POST", `/scoring/corrections/${c.id}/decision`, { decision, reason: decisionReason[c.id] || undefined, expectedRevision: c.revision });
                    await load();
                  }, { success: `Correction ${decision}.`, onConflict: load })}>{decision === "approved" ? "Approve" : "Reject"} correction</button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.panel}>
        <h3>Standings</h3>
        <div className={styles.row}>
          <label>Scope
            <select value={roundId} onChange={e => setRoundId(e.target.value)}>
              <option value="">Whole competition</option>
              {rounds.map(r => <option key={r.id} value={r.id}>{r.ordinal}. {r.label}</option>)}
            </select>
          </label>
          <button type="button" disabled={busy} onClick={() => void run(async () => {
            setStandings((await api.get<{ standings: Standing[] }>(`/scoring/standings${roundId ? `?roundId=${roundId}` : ""}`)).standings);
          })}>Show standings</button>
        </div>
        {standings ? (
          <table>
            <caption className={styles.muted}>Provisional: computed from submitted scores under the active rubric.</caption>
            <thead><tr><th scope="col">Rank</th><th scope="col">Entrant</th><th scope="col">Score</th><th scope="col">Sheets</th><th scope="col">Tie-break</th></tr></thead>
            <tbody>
              {standings.map(s => (
                <tr key={s.entryId}>
                  <td>{s.rank ?? "—"}{s.tied ? " (tied)" : ""}</td>
                  <th scope="row">{s.displayName}</th>
                  <td>{s.score ?? "not scored"}</td>
                  <td>{s.judgeCount}</td>
                  <td>{s.tieBreak?.replace(/_/g, " ") ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
}
