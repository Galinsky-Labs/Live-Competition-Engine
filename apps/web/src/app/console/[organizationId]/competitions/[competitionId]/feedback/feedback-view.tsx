"use client";
import { useCallback, useEffect, useState } from "react";
import { ConsoleApiError } from "../../../../../../lib/console-client";
import { formatDate, StatusLine, useConsole } from "../use-console";
import styles from "../console.module.css";

interface Appeal { id: string; kind: string; body: string; status: string; revision: number; resolutionReason: string | null; }
interface Critique { id: string; roundLabel: string; visibility: string; body: string; submittedAt: string | null; appeals: Appeal[]; }

/** Entrant view of their own critiques with appeal / correction requests (LC-21). */
export function FeedbackView({ organizationId, competitionId }: { organizationId: string; competitionId: string }) {
  const { api, busy, message, run } = useConsole(organizationId, competitionId);
  const [items, setItems] = useState<Critique[] | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [draft, setDraft] = useState<{ critiqueId: string; kind: "appeal" | "correction"; body: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api.get<{ items: Critique[] }>("/critiques/mine")).items);
    } catch (error) {
      if (error instanceof ConsoleApiError && error.code === "feature_disabled") { setDisabled(true); return; }
      throw error;
    }
  }, [api]);
  useEffect(() => { void run(load); }, [run, load]);

  if (disabled) return <p>Feedback is not offered for this event.</p>;
  return (
    <>
      <StatusLine message={message} busy={busy} />
      {items && items.length === 0 ? <p>No feedback has been shared with you yet.</p> : null}
      {items?.map(c => {
        const open = c.appeals.some(a => a.status === "open" || a.status === "under_review");
        return (
          <article key={c.id} className={styles.panel} aria-labelledby={`fb-${c.id}`}>
            <h2 id={`fb-${c.id}`}>{c.roundLabel}</h2>
            <p className={styles.muted}>{c.visibility === "public" ? "Published feedback" : "Private feedback"} · {formatDate(c.submittedAt)}</p>
            <blockquote>{c.body}</blockquote>
            {c.appeals.length ? (
              <ul aria-label="Your requests">
                {c.appeals.map(a => (
                  <li key={a.id} className={styles.row}>
                    <span>{a.kind === "appeal" ? "Appeal" : "Correction request"}: {a.status.replace(/_/g, " ")}{a.resolutionReason ? ` — ${a.resolutionReason}` : ""}</span>
                    {a.status === "open" || a.status === "under_review" ? (
                      <button type="button" disabled={busy} onClick={() => void run(async () => { await api.send("POST", `/critiques/appeals/${a.id}/withdraw`, { expectedRevision: a.revision }); await load(); },
                        { success: "Request withdrawn.", onConflict: load })}>Withdraw request</button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {!open && draft?.critiqueId !== c.id ? (
              <button type="button" disabled={busy} onClick={() => setDraft({ critiqueId: c.id, kind: "correction", body: "" })}>Ask for a correction or appeal</button>
            ) : null}
            {draft?.critiqueId === c.id ? (
              <form onSubmit={event => {
                event.preventDefault();
                void run(async () => { await api.send("POST", `/critiques/${c.id}/appeals`, { kind: draft.kind, body: draft.body }); setDraft(null); await load(); },
                  { success: "Request sent to the producers." });
              }}>
                <fieldset>
                  <legend>Type of request</legend>
                  <label><input type="radio" name={`kind-${c.id}`} checked={draft.kind === "correction"} onChange={() => setDraft({ ...draft, kind: "correction" })} /> Correction (factual error)</label>
                  <label><input type="radio" name={`kind-${c.id}`} checked={draft.kind === "appeal"} onChange={() => setDraft({ ...draft, kind: "appeal" })} /> Appeal (unfair or inappropriate)</label>
                </fieldset>
                <label>Explain your request<textarea required maxLength={2000} value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} /></label>
                <div className={styles.row}>
                  <button type="submit" disabled={busy}>Send request</button>
                  <button type="button" onClick={() => setDraft(null)}>Cancel</button>
                </div>
              </form>
            ) : null}
          </article>
        );
      })}
    </>
  );
}
