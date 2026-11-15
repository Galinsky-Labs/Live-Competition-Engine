"use client";
import { useEffect, useState } from "react";
import type { ConsoleApi } from "../../../../../../lib/console-client";
import styles from "../console.module.css";

interface Criterion { key: string; label: string; min: number; max: number; step: number; weight: number; }
interface Sheet { id: string; values: Record<string, number>; status: string; revision: number; }
interface SheetResponse { rubric: { version: number; definition: { criteria: Criterion[] } }; sheet: Sheet | null; }

type Run = (work: () => Promise<void>, options?: { success?: string; onConflict?: () => Promise<void> }) => Promise<void>;

/** One judge's sheet for one performance: draft, submit (then read-only), or request a correction. */
export function ScorePanel({ api, run, busy, roundId, performanceId, name }: {
  api: ConsoleApi; run: Run; busy: boolean; roundId: string; performanceId: string; name: string;
}) {
  const [data, setData] = useState<SheetResponse | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [correctionReason, setCorrectionReason] = useState("");
  const path = `/rounds/${roundId}/performances/${performanceId}/scores`;

  const load = async () => {
    const result = await api.get<SheetResponse>(path);
    setData(result);
    setValues(Object.fromEntries(Object.entries(result.sheet?.values ?? {}).map(([k, v]) => [k, String(v)])));
  };
  // Reload whenever another performance is opened.
  useEffect(() => { void run(load); }, [path]);

  if (!data) return null;
  const numeric = () => Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, Number(v)]));
  const submitted = data.sheet?.status === "submitted";
  const save = (submit: boolean) => run(async () => {
    await api.send("PUT", path, { values: numeric(), submit, expectedRevision: data.sheet?.revision ?? 0 });
    await load();
  }, { success: submit ? "Scores submitted. They can now only change through an approved correction." : "Draft saved.", onConflict: load });

  return (
    <form className={styles.panel} aria-labelledby="score-title" onSubmit={event => {
      event.preventDefault();
      if (submitted) {
        void run(async () => {
          await api.send("POST", "/scoring/corrections", { sheetId: data.sheet!.id, values: numeric(), reason: correctionReason });
          setCorrectionReason("");
        }, { success: "Correction requested. A producer must approve it." });
      } else if (window.confirm(`Submit final scores for ${name}? Submitted scores cannot be edited.`)) {
        void save(true);
      }
    }}>
      <h2 id="score-title">Scores for {name}</h2>
      <p className={styles.muted}>Rubric version {data.rubric.version}. {submitted ? "Submitted — enter corrected values and a reason to request a correction." : data.sheet ? "Draft saved." : "Not scored yet."}</p>
      <fieldset>
        <legend>Criteria</legend>
        {data.rubric.definition.criteria.map(c => (
          <label key={c.key}>{c.label} ({c.min}–{c.max}, step {c.step}{c.weight !== 1 ? `, weight ${c.weight}` : ""})
            <input type="number" inputMode="decimal" min={c.min} max={c.max} step={c.step} value={values[c.key] ?? ""}
              onChange={e => setValues({ ...values, [c.key]: e.target.value })} />
          </label>
        ))}
      </fieldset>
      {submitted ? (
        <>
          <label>Reason for correction<textarea required maxLength={1000} value={correctionReason} onChange={e => setCorrectionReason(e.target.value)} /></label>
          <button type="submit" disabled={busy}>Request correction</button>
        </>
      ) : (
        <div className={styles.row}>
          <button type="button" disabled={busy} onClick={() => void save(false)}>Save draft</button>
          <button type="submit" disabled={busy}>Submit final scores</button>
        </div>
      )}
    </form>
  );
}
