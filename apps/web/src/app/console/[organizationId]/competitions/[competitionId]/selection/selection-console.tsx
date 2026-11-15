"use client";
import { useCallback, useEffect, useState } from "react";
import { formatDate, StatusLine, useConsole } from "../use-console";
import styles from "../console.module.css";

interface Review {
  id: string; displayName: string; status: string; revision: number; waitlistPosition: number | null; entryId: string | null;
  submittedAt: string | null; answers: Record<string, unknown>; contactEmail: string | null;
  consents: { key: string; version: string }[]; media: { fieldKey: string; mediaId: string }[];
}
interface Summary {
  competition: { title: string; status: string }; capacity: number | null; closesAt: string | null;
  counts: Record<string, number>; rounds: { id: string; label: string; ordinal: number; status: string; lineupRevision: number }[];
}
interface Lineup { revision: number; slots: { performanceId: string; entryId: string; ordinal: number; status: string; displayName: string }[]; }
interface Panel { assigned: { judgeId: string; displayName: string; role: string }[]; available: { judgeId: string; displayName: string }[]; }

const decisions = [["under_review", "Mark under review"], ["selected", "Select"], ["waitlisted", "Waitlist"], ["declined", "Decline"]] as const;
const filters = ["", "submitted", "under_review", "selected", "waitlisted", "declined", "withdrawn"];
const label = (status: string) => status.replace(/_/g, " ");

export function SelectionConsole({ organizationId, competitionId }: { organizationId: string; competitionId: string }) {
  const { api, busy, message, run } = useConsole(organizationId, competitionId);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState("submitted");
  const [items, setItems] = useState<Review[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [choice, setChoice] = useState<Record<string, { status: string; reason: string }>>({});
  const [bulk, setBulk] = useState({ status: "selected", reason: "" });
  const [selectedEntrants, setSelectedEntrants] = useState<Review[]>([]);
  const [roundId, setRoundId] = useState("");
  const [lineup, setLineup] = useState<Lineup | null>(null);
  const [order, setOrder] = useState<{ entryId: string; displayName: string }[]>([]);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [judge, setJudge] = useState({ judgeId: "", role: "panelist" });

  const loadApplications = useCallback(async () => {
    const [s, list, selected] = await Promise.all([
      api.get<Summary>("/selection"),
      api.get<{ items: Review[] }>(`/applications${filter ? `?status=${filter}` : ""}`),
      api.get<{ items: Review[] }>("/applications?status=selected&limit=200")
    ]);
    setSummary(s);
    setItems(list.items);
    setSelectedEntrants(selected.items);
    setChecked(new Set());
  }, [api, filter]);

  const loadRound = useCallback(async (id: string) => {
    if (!id) { setLineup(null); setPanel(null); return; }
    const [l, p] = await Promise.all([api.get<Lineup>(`/rounds/${id}/lineup`), api.get<Panel>(`/rounds/${id}/panel`)]);
    setLineup(l);
    setOrder(l.slots.map(s => ({ entryId: s.entryId, displayName: s.displayName })));
    setPanel(p);
  }, [api]);

  useEffect(() => { void run(loadApplications); }, [run, loadApplications]);
  useEffect(() => { void run(() => loadRound(roundId)); }, [run, loadRound, roundId]);

  const decide = (decisionsToSend: { applicationId: string; status: string; reason: string; expectedRevision: number }[]) =>
    run(async () => {
      await api.send("POST", "/applications/bulk-decisions", {
        decisions: decisionsToSend.map(d => ({ ...d, reason: d.reason.trim() || undefined }))
      });
      await loadApplications();
    }, { success: `Recorded ${decisionsToSend.length} decision${decisionsToSend.length === 1 ? "" : "s"}.`, onConflict: loadApplications });

  const move = (index: number, delta: number) => setOrder(current => {
    const next = [...current];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    return next;
  });

  return (
    <>
      <StatusLine message={message} busy={busy} />
      {summary ? (
        <section className={styles.panel} aria-labelledby="overview-title">
          <h2 id="overview-title">{summary.competition.title}</h2>
          <p>Event status: {label(summary.competition.status)} · Applications close: {formatDate(summary.closesAt)} · Capacity: {summary.capacity ?? "unlimited"}</p>
          <ul className={styles.row} aria-label="Applications by status">
            {Object.entries(summary.counts).map(([status, count]) => <li key={status}>{label(status)}: {count}</li>)}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="review-title">
        <h2 id="review-title">Applications</h2>
        <div className={styles.row}>
          <label>Show
            <select value={filter} onChange={e => setFilter(e.target.value)} disabled={busy}>
              {filters.map(f => <option key={f} value={f}>{f ? label(f) : "all submitted"}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => void run(loadApplications)} disabled={busy}>Refresh</button>
        </div>
        <fieldset className={styles.panel}>
          <legend>Decide for checked applications ({checked.size})</legend>
          <div className={styles.row}>
            <label>Decision
              <select value={bulk.status} onChange={e => setBulk({ ...bulk, status: e.target.value })}>
                {decisions.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </label>
            <label>Reason (required to decline)
              <input value={bulk.reason} maxLength={1000} onChange={e => setBulk({ ...bulk, reason: e.target.value })} />
            </label>
            <button type="button" disabled={busy || checked.size === 0} onClick={() => void decide(items.filter(i => checked.has(i.id))
              .map(i => ({ applicationId: i.id, status: bulk.status, reason: bulk.reason, expectedRevision: i.revision })))}>
              Apply to checked
            </button>
          </div>
        </fieldset>
        {items.length === 0 && !busy ? <p>No applications in this view.</p> : null}
        <table>
          <caption className={styles.muted}>Contact details appear only when the applicant agreed to share them.</caption>
          <thead><tr><th scope="col">Pick</th><th scope="col">Applicant</th><th scope="col">Status</th><th scope="col">Answers</th><th scope="col">Decision</th></tr></thead>
          <tbody>
            {items.map(item => {
              const current = choice[item.id] ?? { status: "selected", reason: "" };
              return (
                <tr key={item.id}>
                  <td>
                    <input type="checkbox" aria-label={`Include ${item.displayName} in bulk decision`} checked={checked.has(item.id)}
                      onChange={e => setChecked(prev => { const next = new Set(prev); if (e.target.checked) next.add(item.id); else next.delete(item.id); return next; })} />
                  </td>
                  <th scope="row">
                    {item.displayName}
                    <div className={styles.muted}>Submitted {formatDate(item.submittedAt)}</div>
                    {item.contactEmail ? <div>Contact: {item.contactEmail}</div> : null}
                  </th>
                  <td>{label(item.status)}{item.waitlistPosition ? ` (#${item.waitlistPosition})` : ""}</td>
                  <td>
                    <details>
                      <summary>View answers</summary>
                      <dl>
                        {Object.entries(item.answers).map(([key, value]) => (
                          <div key={key}><dt>{key}</dt><dd>{Array.isArray(value) ? value.join(", ") : String(value)}</dd></div>
                        ))}
                      </dl>
                      <p className={styles.muted}>Consents: {item.consents.map(c => `${c.key} (${c.version})`).join(", ") || "none"} · Media items: {item.media.length}</p>
                    </details>
                  </td>
                  <td>
                    <div className={styles.row}>
                      <label>Decision for {item.displayName}
                        <select value={current.status} onChange={e => setChoice({ ...choice, [item.id]: { ...current, status: e.target.value } })}>
                          {decisions.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                        </select>
                      </label>
                      <label>Reason
                        <input value={current.reason} maxLength={1000} onChange={e => setChoice({ ...choice, [item.id]: { ...current, reason: e.target.value } })} />
                      </label>
                      <button type="button" disabled={busy}
                        onClick={() => void decide([{ applicationId: item.id, status: current.status, reason: current.reason, expectedRevision: item.revision }])}>
                        Record decision for {item.displayName}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="rounds-title">
        <h2 id="rounds-title">Running order and judge panel</h2>
        <label>Round
          <select value={roundId} onChange={e => setRoundId(e.target.value)} disabled={busy}>
            <option value="">Choose a round</option>
            {summary?.rounds.map(r => <option key={r.id} value={r.id}>{r.ordinal}. {r.label} ({label(r.status)})</option>)}
          </select>
        </label>
        {lineup ? (
          <div className={styles.panel}>
            <h3>Running order (version {lineup.revision})</h3>
            <ol>
              {order.map((slot, index) => (
                <li key={slot.entryId} className={styles.row}>
                  <span>{slot.displayName}</span>
                  <button type="button" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label={`Move ${slot.displayName} earlier`}>Earlier</button>
                  <button type="button" disabled={busy || index === order.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${slot.displayName} later`}>Later</button>
                  <button type="button" disabled={busy} onClick={() => setOrder(order.filter(o => o.entryId !== slot.entryId))} aria-label={`Remove ${slot.displayName} from running order`}>Remove</button>
                </li>
              ))}
            </ol>
            <div className={styles.row}>
              {selectedEntrants.filter(s => s.entryId && !order.some(o => o.entryId === s.entryId)).map(s => (
                <button key={s.id} type="button" disabled={busy} onClick={() => setOrder([...order, { entryId: s.entryId!, displayName: s.displayName }])}>
                  Add {s.displayName}
                </button>
              ))}
            </div>
            <button type="button" disabled={busy} onClick={() => void run(async () => {
              await api.send("PUT", `/rounds/${roundId}/lineup`, { entryIds: order.map(o => o.entryId), expectedRevision: lineup.revision });
              await loadRound(roundId);
            }, { success: "Running order saved.", onConflict: () => loadRound(roundId) })}>Save running order</button>
          </div>
        ) : null}
        {panel ? (
          <div className={styles.panel}>
            <h3>Judge panel</h3>
            <ul>
              {panel.assigned.map(a => (
                <li key={a.judgeId} className={styles.row}>
                  <span>{a.displayName} — {a.role === "head" ? "head judge" : "panelist"}</span>
                  <button type="button" disabled={busy} onClick={() => void run(async () => {
                    setPanel(await api.send<Panel>("DELETE", `/rounds/${roundId}/panel?judgeId=${a.judgeId}`));
                  }, { success: `${a.displayName} removed from the panel.` })}>Remove {a.displayName}</button>
                </li>
              ))}
            </ul>
            <div className={styles.row}>
              <label>Judge
                <select value={judge.judgeId} onChange={e => setJudge({ ...judge, judgeId: e.target.value })}>
                  <option value="">Choose a judge</option>
                  {panel.available.map(a => <option key={a.judgeId} value={a.judgeId}>{a.displayName}</option>)}
                </select>
              </label>
              <label>Role
                <select value={judge.role} onChange={e => setJudge({ ...judge, role: e.target.value })}>
                  <option value="panelist">Panelist</option>
                  <option value="head">Head judge</option>
                </select>
              </label>
              <button type="button" disabled={busy || !judge.judgeId} onClick={() => void run(async () => {
                setPanel(await api.send<Panel>("POST", `/rounds/${roundId}/panel`, judge));
              }, { success: "Panel updated.", onConflict: () => loadRound(roundId) })}>Assign judge</button>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}
