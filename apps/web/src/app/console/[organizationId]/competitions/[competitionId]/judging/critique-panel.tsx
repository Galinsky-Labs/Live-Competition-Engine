"use client";
import { useEffect, useState } from "react";
import type { ConsoleApi } from "../../../../../../lib/console-client";
import styles from "../console.module.css";

interface Critique { id: string; performanceId: string; visibility: "private" | "public"; body: string; status: string; revision: number; moderationReason: string | null; }
type Run = (work: () => Promise<void>, options?: { success?: string; onConflict?: () => Promise<void> }) => Promise<void>;

const statusText: Record<string, string> = {
  draft: "Draft (only you can see it)", delivered: "Delivered privately to the entrant", pending_moderation: "Waiting for producer approval",
  published: "Published", rejected: "Returned by a producer — edit and resubmit"
};

/** Write a critique for one performance (feature `critiques`). Hidden when the feature is off. */
export function CritiquePanel({ api, run, busy, roundId, performanceId, name }: {
  api: ConsoleApi; run: Run; busy: boolean; roundId: string; performanceId: string; name: string;
}) {
  const [current, setCurrent] = useState<Critique | null>(null);
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [available, setAvailable] = useState(true);

  const load = async () => {
    try {
      const list = await api.get<{ items: Critique[] }>("/judging/critiques");
      const found = list.items.find(c => c.performanceId === performanceId && !["withdrawn", "retracted"].includes(c.status)) ?? null;
      setCurrent(found);
      setBody(found?.body ?? "");
      setVisibility(found?.visibility ?? "private");
    } catch (error) {
      if ((error as { code?: string }).code === "feature_disabled") { setAvailable(false); return; }
      throw error;
    }
  };
  useEffect(() => { void run(load); }, [performanceId]);

  if (!available) return null;
  const editable = !current || current.status === "draft" || current.status === "rejected";
  return (
    <form className={styles.panel} aria-labelledby="critique-title" onSubmit={event => {
      event.preventDefault();
      void run(async () => {
        const saved = await api.send<Critique>("PUT", `/rounds/${roundId}/performances/${performanceId}/critique`, { body, visibility, expectedRevision: current?.revision ?? 0 });
        setCurrent(saved);
      }, { success: "Critique draft saved.", onConflict: load });
    }}>
      <h2 id="critique-title">Critique for {name}</h2>
      {current ? <p>Status: {statusText[current.status] ?? current.status}{current.moderationReason ? ` — note: ${current.moderationReason}` : ""}</p> : null}
      <label>Critique<textarea rows={6} maxLength={5000} required readOnly={!editable} value={body} onChange={e => setBody(e.target.value)} /></label>
      <fieldset disabled={!editable}>
        <legend>Who can read it</legend>
        <label><input type="radio" name="visibility" checked={visibility === "private"} onChange={() => setVisibility("private")} /> Only the entrant</label>
        <label><input type="radio" name="visibility" checked={visibility === "public"} onChange={() => setVisibility("public")} /> Public, after producer approval</label>
      </fieldset>
      <div className={styles.row}>
        {editable ? <button type="submit" disabled={busy}>Save critique draft</button> : null}
        {current?.status === "draft" ? (
          <button type="button" disabled={busy} onClick={() => void run(async () => { setCurrent(await api.send<Critique>("POST", `/critiques/${current.id}/submit`, { expectedRevision: current.revision })); },
            { success: current.visibility === "private" ? "Critique delivered to the entrant." : "Critique sent for approval.", onConflict: load })}>Submit critique</button>
        ) : null}
        {current && (current.status === "draft" || current.status === "pending_moderation") ? (
          <button type="button" disabled={busy} onClick={() => void run(async () => { await api.send("POST", `/critiques/${current.id}/withdraw`, { expectedRevision: current.revision }); await load(); },
            { success: "Critique withdrawn.", onConflict: load })}>Withdraw critique</button>
        ) : null}
      </div>
    </form>
  );
}
