"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./control.module.css";

interface Performance { id: string; ordinal: number; status: string; displayName: string }
interface Round { id: string; label: string; ordinal: number; status: string; resultsPublished: boolean; publicationRevision: number; performances: Performance[] }
interface View {
  show: { state: string; pauseReason: string | null; revision: number; broadcastSequence: number };
  rounds: Round[];
  now: Performance | null;
  next: Performance | null;
  judgeStatus: { status: string; source: string; judges: Array<{ judgeId: string; displayName: string; submitted: boolean | null }> } | null;
  entries: Array<{ entryId: string; displayName: string }>;
  serverNow: string;
}
interface Timer { timerId: string; label: string; performanceId: string | null; status: string; phase: string; remainingMs: number; sequence: number; pauseReason: string | null }
interface Caption { id: string; kind: string; text: string; subtitle: string | null }

const TOKEN_KEY = "lce-control-token";

function formatMs(ms: number) {
  const sign = ms < 0 ? "-" : "";
  const total = Math.floor(Math.abs(ms) / 1000);
  return `${sign}${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const newKey = () => `ui-${crypto.randomUUID()}`;

export function ControlRoomClient({ organizationId, competitionId }: { organizationId: string; competitionId: string }) {
  const base = `/api/organizations/${organizationId}/competitions/${competitionId}`;
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [timers, setTimers] = useState<Timer[]>([]);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [status, setStatus] = useState("Not connected");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    try { setToken(sessionStorage.getItem(TOKEN_KEY)); } catch { /* storage unavailable */ }
  }, []);

  const call = useCallback(async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${response.status} ${data.error ?? "request_failed"}`);
    return data;
  }, [base, token]);

  const refresh = useCallback(async () => {
    if (!token || busy.current) return;
    busy.current = true;
    try {
      const [room, timerList, captionList] = await Promise.all([
        call("GET", "/control-room"), call("GET", "/timers"), call("GET", "/captions").catch(() => ({ captions: [] }))
      ]);
      setView(room);
      setTimers(timerList.timers);
      setCaptions(captionList.captions ?? []);
      setStatus(`Connected · updated ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      setStatus(`Disconnected: ${(e as Error).message}`);
    } finally {
      busy.current = false;
    }
  }, [call, token]);

  useEffect(() => {
    if (!token) return;
    void refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh, token]);

  const run = async (label: string, method: string, path: string, body?: unknown) => {
    setError(null);
    try {
      await call(method, path, body);
      setStatus(`${label}: done`);
      await refresh();
    } catch (e) {
      setError(`${label} failed: ${(e as Error).message}`);
    }
  };

  const connect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("token") ?? "").trim();
    try { sessionStorage.setItem(TOKEN_KEY, value); } catch { /* ignore */ }
    setToken(value);
  };

  const form = (handler: (data: FormData) => Promise<void>) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = event.currentTarget;
    void handler(new FormData(target)).then(() => target.reset());
  };

  if (!token) {
    return (
      <form className={styles.panel} onSubmit={connect}>
        <h2>Sign in</h2>
        <p>Paste a session token for an account with <code>event.manage</code> on this competition. It is kept only in this tab.</p>
        <label htmlFor="token">Session token</label>
        <input id="token" name="token" type="password" autoComplete="off" required />
        <button type="submit">Connect</button>
      </form>
    );
  }

  const revision = view?.show.revision;
  return (
    <div className={styles.grid}>
      <p className={styles.status} role="status" aria-live="polite">{status}</p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      <section className={styles.panel} aria-labelledby="show-heading">
        <h2 id="show-heading">Show</h2>
        <p>State: <strong>{view?.show.state ?? "…"}</strong>{view?.show.pauseReason ? ` — ${view.show.pauseReason}` : ""}</p>
        <div className={styles.row}>
          <button type="button" onClick={() => run("Start show", "POST", "/control-room/show", { command: "start", expectedRevision: revision })}>Start show</button>
          <button type="button" onClick={() => run("Resume show", "POST", "/control-room/show", { command: "resume", expectedRevision: revision })}>Resume show</button>
          <button type="button" onClick={() => { if (confirm("End the show? This cannot be undone.")) void run("End show", "POST", "/control-room/show", { command: "end", expectedRevision: revision }); }}>End show</button>
        </div>
        <form onSubmit={form(async data => run("Safety stop", "POST", "/control-room/safety-stop", { reason: data.get("reason") }))} className={styles.stop}>
          <label htmlFor="reason">Safety stop reason</label>
          <input id="reason" name="reason" maxLength={200} required />
          <button type="submit" className={styles.danger}>Safety stop</button>
        </form>
      </section>

      <section className={styles.panel} aria-labelledby="now-heading">
        <h2 id="now-heading">Now / next</h2>
        <dl>
          <dt>Now</dt><dd>{view?.now?.displayName ?? "—"}</dd>
          <dt>Next</dt><dd>{view?.next?.displayName ?? "—"}</dd>
        </dl>
        <h3>Judges</h3>
        {view?.judgeStatus ? (
          <>
            <p>Source: {view.judgeStatus.source} ({view.judgeStatus.status})</p>
            <ul>{view.judgeStatus.judges.map(judge => (
              <li key={judge.judgeId}>{judge.displayName}: {judge.submitted === null ? "unknown" : judge.submitted ? "submitted" : "pending"}</li>
            ))}</ul>
          </>
        ) : <p>No live performance.</p>}
      </section>

      <section className={`${styles.panel} ${styles.wide}`} aria-labelledby="lineup-heading">
        <h2 id="lineup-heading">Lineup</h2>
        <form onSubmit={form(async data => run("Add round", "POST", "/control-room/rounds", { label: data.get("label") }))} className={styles.row}>
          <label htmlFor="round-label">New round label</label>
          <input id="round-label" name="label" maxLength={80} required />
          <button type="submit">Add round</button>
        </form>
        {view?.rounds.map(round => {
          const ids = round.performances.map(p => p.id);
          const move = (index: number, delta: number) => {
            const order = [...ids];
            const [item] = order.splice(index, 1);
            order.splice(index + delta, 0, item!);
            void run("Reorder", "PUT", `/control-room/rounds/${round.id}/lineup`, { performanceIds: order, expectedRevision: revision });
          };
          return (
            <article key={round.id} className={styles.round} aria-labelledby={`round-${round.id}`}>
              <h3 id={`round-${round.id}`}>{round.ordinal}. {round.label} <span className={styles.badge}>{round.status}</span></h3>
              <div className={styles.row}>
                <button type="button" onClick={() => run("Round live", "POST", `/control-room/rounds/${round.id}/status`, { status: "live" })}>Go live</button>
                <button type="button" onClick={() => run("Round complete", "POST", `/control-room/rounds/${round.id}/status`, { status: "completed" })}>Complete</button>
                <button type="button" onClick={() => run("Round cancel", "POST", `/control-room/rounds/${round.id}/status`, { status: "cancelled" })}>Cancel</button>
                <button type="button" aria-pressed={round.resultsPublished}
                  onClick={() => run("Publication", "POST", `/control-room/rounds/${round.id}/publication`, { published: !round.resultsPublished, expectedRevision: round.publicationRevision })}>
                  {round.resultsPublished ? "Unpublish results" : "Publish results"}
                </button>
              </div>
              <table className={styles.table}>
                <caption className={styles.sr}>Performances in {round.label}</caption>
                <thead><tr><th scope="col">#</th><th scope="col">Performer</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
                <tbody>
                  {round.performances.map((performance, index) => (
                    <tr key={performance.id} aria-current={performance.status === "live" ? "true" : undefined}>
                      <td>{performance.ordinal}</td>
                      <td>{performance.displayName}</td>
                      <td>{performance.status}</td>
                      <td className={styles.row}>
                        <button type="button" onClick={() => run("Go live", "POST", `/control-room/performances/${performance.id}/status`, { status: "live" })}>Live</button>
                        <button type="button" onClick={() => run("Complete", "POST", `/control-room/performances/${performance.id}/status`, { status: "completed" })}>Done</button>
                        <button type="button" onClick={() => run("Skip", "POST", `/control-room/performances/${performance.id}/status`, { status: "skipped" })}>Skip</button>
                        <button type="button" disabled={index === 0} aria-label={`Move ${performance.displayName} up`} onClick={() => move(index, -1)}>↑</button>
                        <button type="button" disabled={index === ids.length - 1} aria-label={`Move ${performance.displayName} down`} onClick={() => move(index, 1)}>↓</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <form onSubmit={form(async data => run("Add performance", "POST", `/control-room/rounds/${round.id}/performances`, { entryId: data.get("entryId") }))} className={styles.row}>
                <label htmlFor={`entry-${round.id}`}>Add entry</label>
                <select id={`entry-${round.id}`} name="entryId" required>
                  {view.entries.map(entry => <option key={entry.entryId} value={entry.entryId}>{entry.displayName}</option>)}
                </select>
                <button type="submit">Add</button>
              </form>
            </article>
          );
        })}
      </section>

      <section className={styles.panel} aria-labelledby="timers-heading">
        <h2 id="timers-heading">Timers</h2>
        <ul className={styles.list}>
          {timers.map(timer => (
            <li key={timer.timerId}>
              <strong>{timer.label}</strong> <span className={styles.badge}>{timer.phase}</span>{" "}
              <span className={styles.mono}>{formatMs(timer.remainingMs)}</span>
              {timer.pauseReason ? <small> ({timer.pauseReason})</small> : null}
              <div className={styles.row}>
                {(["start", "pause", "resume", "reset"] as const).map(type => (
                  <button key={type} type="button" onClick={() => run(`Timer ${type}`, "POST", `/timers/${timer.timerId}/commands`, { type, idempotencyKey: newKey(), expectedSequence: timer.sequence })}>{type}</button>
                ))}
                <button type="button" onClick={() => run("Timer extend", "POST", `/timers/${timer.timerId}/commands`, { type: "extend", amountMs: 30_000, idempotencyKey: newKey() })}>+30s</button>
              </div>
            </li>
          ))}
        </ul>
        <form onSubmit={form(async data => run("Create timer", "POST", "/timers", {
          label: data.get("label"), durationMs: Number(data.get("seconds")) * 1000, maxExtensionMs: 300_000,
          performanceId: data.get("performanceId") || null
        }))}>
          <label htmlFor="timer-label">Timer label</label>
          <input id="timer-label" name="label" maxLength={80} required />
          <label htmlFor="timer-seconds">Duration (seconds)</label>
          <input id="timer-seconds" name="seconds" type="number" min={1} max={21600} defaultValue={180} required />
          <label htmlFor="timer-performance">Performance (optional)</label>
          <select id="timer-performance" name="performanceId" defaultValue="">
            <option value="">Whole stage</option>
            {view?.rounds.flatMap(round => round.performances).map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
          <button type="submit">Create timer</button>
        </form>
      </section>

      <section className={styles.panel} aria-labelledby="captions-heading">
        <h2 id="captions-heading">On-air text</h2>
        <ul className={styles.list}>
          {captions.map(caption => (
            <li key={caption.id}>
              <span className={styles.badge}>{caption.kind}</span> {caption.text}{caption.subtitle ? ` — ${caption.subtitle}` : ""}
              <button type="button" onClick={() => run("Clear caption", "POST", `/captions/${caption.id}/clear`, {})}>Clear</button>
            </li>
          ))}
        </ul>
        <form onSubmit={form(async data => run("Set caption", "POST", "/captions", {
          kind: data.get("kind"), text: data.get("text"), subtitle: data.get("subtitle") || null, idempotencyKey: newKey()
        }))}>
          <label htmlFor="caption-kind">Kind</label>
          <select id="caption-kind" name="kind"><option value="lower_third">Lower third</option><option value="caption">Caption</option></select>
          <label htmlFor="caption-text">Text</label>
          <input id="caption-text" name="text" maxLength={120} required />
          <label htmlFor="caption-subtitle">Subtitle (lower third)</label>
          <input id="caption-subtitle" name="subtitle" maxLength={120} />
          <button type="submit">Put on air</button>
        </form>
      </section>

      <p className={styles.small}>
        <button type="button" onClick={() => { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } setToken(null); setView(null); }}>Disconnect</button>
      </p>
    </div>
  );
}
