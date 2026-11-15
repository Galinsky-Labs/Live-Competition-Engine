"use client";

import { useEffect, useRef, useState } from "react";

interface TimerView { status: string; remainingMs: number; overtimeMs: number; inGrace: boolean; runningSince: number | null; durationMs: number; extendedMs: number; accumulatedMs: number; serverNow: number }
interface Snapshot {
  serverNow: number;
  event: { title: string; status: string };
  stage: { label: string } | null;
  current: { displayName: string; ordinal: number; timer: TimerView | null } | null;
  next: { displayName: string; ordinal: number } | null;
  live: { caption: string | null; overlayMessage: string | null; safetyStopReason: string | null };
}

export const formatClock = (ms: number) => {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/** Remaining time on the server clock, corrected for this client's offset (latency handling). */
export function remainingAt(timer: TimerView, clientNow: number, offsetMs: number) {
  const serverNow = clientNow + offsetMs;
  const elapsed = timer.accumulatedMs + (timer.status === "running" && timer.runningSince !== null ? Math.max(0, serverNow - timer.runningSince) : 0);
  const remaining = timer.durationMs + timer.extendedMs - elapsed;
  return { remainingMs: Math.max(0, remaining), overtimeMs: Math.max(0, -remaining) };
}

/** Polls the server snapshot (every 2s) and ticks locally between polls. */
export function LiveView({ endpoint, variant }: { endpoint: string; variant: "overlay" | "page" }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [stale, setStale] = useState(false);
  const offset = useRef(0);
  const [, tick] = useState(0);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const sentAt = Date.now();
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as Snapshot;
        const receivedAt = Date.now();
        offset.current = data.serverNow - (sentAt + receivedAt) / 2;
        if (alive) { setSnap(data); setStale(false); }
      } catch {
        if (alive) setStale(true);
      }
    };
    poll();
    const pollId = setInterval(poll, 2000);
    const tickId = setInterval(() => tick(n => n + 1), 250);
    return () => { alive = false; clearInterval(pollId); clearInterval(tickId); };
  }, [endpoint]);
  if (!snap) return <p aria-busy="true">Connecting…</p>;
  const timer = snap.current?.timer && snap.current.timer.status !== "idle" ? remainingAt(snap.current.timer, Date.now(), offset.current) : null;
  return (
    <div className={variant === "overlay" ? "overlay" : undefined}>
      {stale ? <p role="status" className="badge">Reconnecting — showing last known state</p> : null}
      {snap.live.safetyStopReason ? <p role="alert" className="error">Show paused. Please stand by.</p> : null}
      {snap.live.overlayMessage ? <p className="lede">{snap.live.overlayMessage}</p> : null}
      <p className="eyebrow">{snap.event.title}{snap.stage ? ` · ${snap.stage.label}` : ""}</p>
      {snap.current ? (
        <>
          <h1>{snap.current.displayName}</h1>
          {timer ? (
            <p className="big-clock" aria-label={`Time remaining ${formatClock(timer.remainingMs)}`} style={{ color: timer.overtimeMs > 0 ? "#ff8a8a" : undefined }}>
              {timer.overtimeMs > 0 ? `+${formatClock(timer.overtimeMs)}` : formatClock(timer.remainingMs)}
            </p>
          ) : null}
        </>
      ) : <h1>{snap.event.status === "live" ? "Up next" : `Event ${snap.event.status}`}</h1>}
      {snap.next ? <p>Next: {snap.next.displayName}</p> : null}
      <p aria-live="polite" className="caption">{snap.live.caption ?? ""}</p>
    </div>
  );
}
