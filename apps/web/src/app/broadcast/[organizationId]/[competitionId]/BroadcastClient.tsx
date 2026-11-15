"use client";

import { useEffect, useRef, useState } from "react";
import { publicTimerRemaining, shouldApplyUpdate } from "@live-competition-engine/domain/broadcast";
import type { PublicOverlay, PublicScoreboard } from "@live-competition-engine/db/broadcast";
import styles from "./broadcast.module.css";

type Mode = "overlay" | "captions" | "scoreboard";
type Data = PublicOverlay | PublicScoreboard;

function formatClock(ms: number) {
  const total = Math.ceil(Math.abs(ms) / 1000);
  const text = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  return ms < 0 ? `+${text}` : text;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);
  return reduced;
}

/**
 * Polls the public broadcast API with If-None-Match, keeps a server clock offset
 * from `x-server-now` (sent on 200 and 304), ignores payloads with an older
 * `sequence`, and renders the countdown locally between polls.
 */
export function BroadcastClient({ mode, endpoint, initial, initialServerNow }: { mode: Mode; endpoint: string; initial: Data; initialServerNow: number }) {
  const [data, setData] = useState<Data>(initial);
  const [now, setNow] = useState(initialServerNow);
  const offset = useRef(0);
  const etag = useRef<string | null>(null);
  const sequence = useRef<number>(initial.sequence);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    offset.current = initialServerNow - Date.now();
  }, [initialServerNow]);

  useEffect(() => {
    let stopped = false;
    const interval = mode === "scoreboard" ? 5000 : 1000;
    const poll = async () => {
      try {
        const sentAt = Date.now();
        const response = await fetch(endpoint, { cache: "no-store", headers: etag.current ? { "if-none-match": etag.current } : {} });
        const serverNow = Number(response.headers.get("x-server-now"));
        if (Number.isFinite(serverNow) && serverNow > 0) {
          // Assume symmetric latency: the server stamped the response mid-flight.
          offset.current = serverNow - (sentAt + Date.now()) / 2;
        }
        if (response.status === 200) {
          const body = await response.json() as Data;
          if (!stopped && shouldApplyUpdate(sequence.current, body.sequence)) {
            sequence.current = body.sequence;
            etag.current = response.headers.get("etag");
            setData(body);
          }
        }
      } catch {
        // Keep showing the last good frame; the next poll retries.
      }
    };
    const id = setInterval(poll, interval);
    return () => { stopped = true; clearInterval(id); };
  }, [endpoint, mode]);

  useEffect(() => {
    if (mode === "scoreboard") return;
    const id = setInterval(() => setNow(Date.now() + offset.current), reducedMotion ? 1000 : 250);
    return () => clearInterval(id);
  }, [mode, reducedMotion]);

  if (mode === "scoreboard") {
    const board = data as PublicScoreboard;
    return (
      <section className={styles.scoreboard} aria-labelledby="scoreboard-title">
        <h1 id="scoreboard-title" className={styles.boardTitle}>{board.competition.title}</h1>
        {board.rounds.length === 0 ? <p>No published results yet.</p> : board.rounds.map(round => (
          <table key={round.ordinal} className={styles.table}>
            <caption>{round.label}</caption>
            <thead><tr><th scope="col">Rank</th><th scope="col">Name</th><th scope="col">Score</th></tr></thead>
            <tbody>
              {round.standings.map((row, index) => (
                <tr key={`${round.ordinal}-${index}`}>
                  <td>{row.rank ?? "—"}</td>
                  <td>{row.displayName}</td>
                  <td>{row.score ?? "—"}{row.final ? "" : " (provisional)"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </section>
    );
  }

  const overlay = data as PublicOverlay;
  const remaining = overlay.timer ? publicTimerRemaining(overlay.timer, now) : null;
  const captionsOnly = mode === "captions";
  return (
    <div className={styles.stage}>
      {!captionsOnly && overlay.current ? (
        <section className={styles.nowCard} aria-label="Now performing">
          <p className={styles.kicker}>{overlay.current.roundLabel}</p>
          <p className={styles.name}>{overlay.current.displayName}</p>
        </section>
      ) : null}
      {!captionsOnly && overlay.timer && remaining !== null ? (
        <div className={`${styles.timer} ${remaining <= 0 && overlay.timer.status !== "idle" ? styles.overtime : ""}`}
          role="timer" aria-label={`${overlay.timer.label} ${overlay.timer.status}`}>
          {formatClock(remaining)}
          {overlay.timer.status === "paused" ? <span className={styles.paused}> paused</span> : null}
        </div>
      ) : null}
      {!captionsOnly && overlay.show.state === "paused" ? <p className={styles.notice}>We will be right back</p> : null}
      {!captionsOnly && overlay.next && !overlay.current ? <p className={styles.notice}>Up next: {overlay.next.displayName}</p> : null}
      <div aria-live="polite">
        {overlay.lowerThird ? (
          <section className={styles.lowerThird} aria-label="Lower third">
            <p className={styles.ltTitle}>{overlay.lowerThird.text}</p>
            {overlay.lowerThird.subtitle ? <p className={styles.ltSubtitle}>{overlay.lowerThird.subtitle}</p> : null}
          </section>
        ) : null}
        {overlay.caption ? <p className={styles.caption}>{overlay.caption.text}</p> : null}
      </div>
    </div>
  );
}
