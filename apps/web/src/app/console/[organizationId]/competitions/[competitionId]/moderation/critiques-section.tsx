"use client";
import { useCallback, useEffect, useState } from "react";
import { ConsoleApiError } from "../../../../../../lib/console-client";
import { formatDate, StatusLine, useConsole } from "../use-console";
import styles from "../console.module.css";

interface Critique { id: string; body: string; status: string; revision: number; visibility: string; judgeName: string; entrantName: string; submittedAt: string | null; }
interface Appeal { id: string; kind: string; body: string; status: string; revision: number; critiqueBody: string; critiqueStatus: string; createdAt: string; trail: { actorKind: string; toStatus: string; note: string | null; recordedAt: string }[]; }

/** Producer moderation queue for public critiques, retractions and the appeal/correction trail (LC-21). */
export function CritiquesSection({ organizationId, competitionId }: { organizationId: string; competitionId: string }) {
  const { api, busy, message, run } = useConsole(organizationId, competitionId);
  const [enabled, setEnabled] = useState(true);
  const [view, setView] = useState("pending_moderation");
  const [critiques, setCritiques] = useState<Critique[]>([]);
  const [appeals, setAppeals] = useState<Appeal[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [retract, setRetract] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([
        api.get<{ items: Critique[] }>(`/critiques?status=${view}`), api.get<{ items: Appeal[] }>("/critiques/appeals")
      ]);
      setCritiques(c.items); setAppeals(a.items); setEnabled(true);
    } catch (error) {
      if (error instanceof ConsoleApiError && error.code === "feature_disabled") { setEnabled(false); return; }
      throw error;
    }
  }, [api, view]);
  useEffect(() => { void run(load); }, [run, load]);

  if (!enabled) return <section aria-labelledby="critiques-title"><h2 id="critiques-title">Critiques</h2><p>Critiques are not enabled for this event.</p></section>;
  const note = (id: string) => notes[id]?.trim() || undefined;
  return (
    <section aria-labelledby="critiques-title">
      <h2 id="critiques-title">Critiques</h2>
      <StatusLine message={message} busy={busy} />
      <label>Show
        <select value={view} onChange={e => setView(e.target.value)}>
          <option value="pending_moderation">Waiting for approval</option>
          <option value="published">Published</option>
          <option value="delivered">Delivered privately</option>
          <option value="rejected">Returned to judges</option>
          <option value="retracted">Retracted</option>
        </select>
      </label>
      {critiques.length === 0 ? <p>Nothing in this view.</p> : null}
      <ul>
        {critiques.map(c => (
          <li key={c.id} className={styles.panel}>
            <p><strong>{c.judgeName}</strong> on <strong>{c.entrantName}</strong> ({c.visibility}, submitted {formatDate(c.submittedAt)})</p>
            <blockquote>{c.body}</blockquote>
            <div className={styles.row}>
              <label>Note (required to return or retract)<input maxLength={1000} value={notes[c.id] ?? ""} onChange={e => setNotes({ ...notes, [c.id]: e.target.value })} /></label>
              {c.status === "pending_moderation" ? (["published", "rejected"] as const).map(decision => (
                <button key={decision} type="button" disabled={busy} onClick={() => void run(async () => {
                  await api.send("POST", `/critiques/${c.id}/moderation`, { decision, reason: note(c.id), expectedRevision: c.revision }); await load();
                }, { success: decision === "published" ? "Critique published." : "Critique returned to the judge.", onConflict: load })}>
                  {decision === "published" ? "Publish" : "Return"} critique by {c.judgeName}
                </button>
              )) : null}
              {c.status === "published" || c.status === "delivered" ? (
                <button type="button" disabled={busy} onClick={() => void run(async () => {
                  await api.send("POST", `/critiques/${c.id}/retraction`, { reason: note(c.id), expectedRevision: c.revision }); await load();
                }, { success: "Critique retracted.", onConflict: load })}>Retract critique by {c.judgeName}</button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <h3>Appeals and correction requests</h3>
      {appeals.length === 0 ? <p>No appeals.</p> : null}
      <ul>
        {appeals.map(a => (
          <li key={a.id} className={styles.panel}>
            <p>{a.kind === "appeal" ? "Appeal" : "Correction request"} — {a.status.replace(/_/g, " ")} (filed {formatDate(a.createdAt)})</p>
            <p>Entrant wrote: {a.body}</p>
            <p className={styles.muted}>Critique ({a.critiqueStatus}): {a.critiqueBody}</p>
            <ol aria-label="Appeal history">
              {a.trail.map((t, i) => <li key={i}>{formatDate(t.recordedAt)} — {t.actorKind}: {t.toStatus.replace(/_/g, " ")}{t.note ? ` (${t.note})` : ""}</li>)}
            </ol>
            {a.status === "open" || a.status === "under_review" ? (
              <div className={styles.row}>
                <label>Resolution note<input maxLength={1000} value={notes[a.id] ?? ""} onChange={e => setNotes({ ...notes, [a.id]: e.target.value })} /></label>
                <label><input type="checkbox" checked={retract[a.id] ?? false} onChange={e => setRetract({ ...retract, [a.id]: e.target.checked })} /> Retract the critique if upheld</label>
                {(a.status === "open" ? ["under_review", "upheld", "dismissed"] : ["upheld", "dismissed"]).map(status => (
                  <button key={status} type="button" disabled={busy} onClick={() => void run(async () => {
                    await api.send("POST", `/critiques/appeals/${a.id}/resolution`, {
                      status, reason: note(a.id), retract: status === "upheld" ? (retract[a.id] ?? false) : undefined, expectedRevision: a.revision
                    });
                    await load();
                  }, { success: `Appeal ${status.replace(/_/g, " ")}.`, onConflict: load })}>{status === "under_review" ? "Start review" : status === "upheld" ? "Uphold" : "Dismiss"}</button>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
