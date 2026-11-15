"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { describeError, useApi } from "./api-client";
import styles from "./live.module.css";

type VoteWindow = {
  id: string;
  label: string;
  phase: string;
  closesAt: string;
  rules: { ballotType: "single" | "approval" | "distributed" | "ranked"; maxPoints: number | null; maxSelections: number | null };
  options: { id: string; label: string }[];
  myBallot?: { receipt: string } | null;
};

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) => new Uint8Array((value.match(/../g) ?? []).map(pair => parseInt(pair, 16)));
async function digest(...parts: Uint8Array[]): Promise<Uint8Array> {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
}

/** Client-side Merkle check (same construction as packages/domain/src/merkle.ts): no trust in the server's verdict. */
async function verifyProof(commitment: string, path: { side: "left" | "right"; hash: string }[], root: string): Promise<boolean> {
  let node = await digest(new Uint8Array([0]), unhex(commitment));
  for (const step of path) {
    node = step.side === "right"
      ? await digest(new Uint8Array([1]), node, unhex(step.hash))
      : await digest(new Uint8Array([1]), unhex(step.hash), node);
  }
  return hex(node) === root;
}

type Results = { visible: boolean; tally?: { rows: { optionId: string; score: number; rank: number }[] } };

function BallotForm({ window, onSubmit }: { window: VoteWindow; onSubmit: (choice: unknown) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const type = window.rules.ballotType;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (type === "single") await onSubmit({ optionId: values.single });
    if (type === "approval") await onSubmit({ optionIds: Object.keys(values).filter(id => values[id] === "on") });
    if (type === "distributed") {
      await onSubmit({ allocations: Object.fromEntries(Object.entries(values).map(([id, v]) => [id, Number(v)]).filter(([, v]) => Number(v) > 0)) });
    }
    if (type === "ranked") {
      const ranked = Object.entries(values).filter(([, v]) => Number(v) > 0).sort(([, a], [, b]) => Number(a) - Number(b)).map(([id]) => id);
      await onSubmit({ ranking: ranked });
    }
  };
  const hint = type === "single" ? "Choose one option."
    : type === "approval" ? `Select up to ${window.rules.maxSelections} options.`
    : type === "distributed" ? `Distribute up to ${window.rules.maxPoints} points.`
    : `Rank up to ${window.rules.maxSelections} options (1 = first choice).`;
  return (
    <form onSubmit={submit}>
      <fieldset className={styles.fieldset}>
        <legend>{window.label}</legend>
        <p id={`hint-${window.id}`}>{hint}</p>
        {window.options.map(option => {
          const id = `opt-${window.id}-${option.id}`;
          if (type === "single") {
            return (
              <div key={option.id} className={styles.row}>
                <input type="radio" id={id} name={`ballot-${window.id}`} value={option.id}
                  onChange={() => setValues({ single: option.id })} aria-describedby={`hint-${window.id}`} />
                <label htmlFor={id}>{option.label}</label>
              </div>
            );
          }
          if (type === "approval") {
            return (
              <div key={option.id} className={styles.row}>
                <input type="checkbox" id={id} onChange={event => setValues(prev => ({ ...prev, [option.id]: event.target.checked ? "on" : "off" }))} />
                <label htmlFor={id}>{option.label}</label>
              </div>
            );
          }
          return (
            <div key={option.id}>
              <label htmlFor={id}>{option.label} ({type === "ranked" ? "rank" : "points"})</label>
              <input type="number" id={id} min={0} inputMode="numeric"
                onChange={event => setValues(prev => ({ ...prev, [option.id]: event.target.value }))} />
            </div>
          );
        })}
        <button type="submit">Submit vote</button>
      </fieldset>
    </form>
  );
}

export function VotingPanel({ base, token, onStatus }: { base: string; token: string; onStatus: (message: string) => void }) {
  const api = useApi(token);
  const [windows, setWindows] = useState<VoteWindow[]>([]);
  const [results, setResults] = useState<Record<string, Results>>({});
  const [pendingKeys, setPendingKeys] = useState<Record<string, string>>({});
  const [receipts, setReceipts] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    if (!token) return;
    const list = await api(`${base}/voting/windows`);
    if (!list.ok) return;
    const ids = ((list.body.windows as VoteWindow[]) ?? []).map(window => window.id);
    const detailed: VoteWindow[] = [];
    const nextResults: Record<string, Results> = {};
    for (const id of ids) {
      const detail = await api(`${base}/voting/windows/${id}`);
      if (detail.ok) detailed.push(detail.body as unknown as VoteWindow);
      const result = await api(`${base}/voting/windows/${id}/results`);
      if (result.ok) nextResults[id] = result.body as unknown as Results;
    }
    setWindows(detailed);
    setResults(nextResults);
  }, [api, base, token]);

  useEffect(() => { void refresh(); }, [refresh]);

  const cast = async (windowId: string, choice: unknown) => {
    // Reuse the idempotency key until the server confirms, so a retry never double-votes.
    const key = pendingKeys[windowId] ?? crypto.randomUUID();
    setPendingKeys(prev => ({ ...prev, [windowId]: key }));
    const result = await api(`${base}/voting/windows/${windowId}/ballots`, "POST", { choice }, { "idempotency-key": key });
    if (!result.ok) {
      onStatus(describeError(result));
      if (result.status !== 409 && result.status < 500) setPendingKeys(prev => ({ ...prev, [windowId]: crypto.randomUUID() }));
      return;
    }
    setPendingKeys(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== windowId)));
    setReceipts(prev => ({ ...prev, [windowId]: String(result.body.receipt) }));
    onStatus("Vote recorded. Keep your receipt to verify it was counted.");
    await refresh();
  };

  const verify = async (windowId: string, receipt: string) => {
    const result = await api(`${base}/voting/windows/${windowId}/proof?receipt=${encodeURIComponent(receipt)}`);
    if (!result.ok) {
      onStatus(describeError(result));
      return;
    }
    const proof = result.body as { included: boolean; commitment: string; path: { side: "left" | "right"; hash: string }[]; merkleRoot: string; snapshotVersion: number };
    const valid = proof.included && await verifyProof(proof.commitment, proof.path, proof.merkleRoot);
    onStatus(valid
      ? `Verified: your ballot is included in count version ${proof.snapshotVersion} (root ${proof.merkleRoot.slice(0, 16)}…).`
      : `Your ballot is not included in count version ${proof.snapshotVersion}.`);
  };

  return (
    <section aria-labelledby="voting-heading" className={styles.card}>
      <h2 id="voting-heading">Voting</h2>
      {windows.length === 0 ? <p>No votes are scheduled.</p> : null}
      {windows.map(window => {
        const receipt = receipts[window.id] ?? window.myBallot?.receipt;
        const tally = results[window.id]?.visible ? results[window.id]?.tally : undefined;
        return (
          <article key={window.id} aria-label={window.label}>
            <h3>{window.label}</h3>
            <p>Status: {window.phase}{window.phase === "open" ? ` (closes ${new Date(window.closesAt).toLocaleString()})` : ""}</p>
            {window.phase === "open" && !receipt ? <BallotForm window={window} onSubmit={choice => cast(window.id, choice)} /> : null}
            {receipt ? (
              <p>
                Your receipt: <code>{receipt}</code>{" "}
                {window.phase === "closed" ? (
                  <button type="button" onClick={() => verify(window.id, receipt)}>Verify my vote was counted</button>
                ) : null}
              </p>
            ) : null}
            {tally ? (
              <table>
                <caption>Results</caption>
                <thead><tr><th scope="col">Rank</th><th scope="col">Option</th><th scope="col">Score</th></tr></thead>
                <tbody>
                  {tally.rows.map(row => (
                    <tr key={row.optionId}>
                      <td>{row.rank}</td>
                      <td>{window.options.find(option => option.id === row.optionId)?.label ?? row.optionId}</td>
                      <td>{row.score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
