import {
  defaultDetectorOptions,
  detectBursts,
  identicalTimingClusters,
  newAccountRatio
} from "@live-competition-engine/domain/vote-anomalies";
import type { Sql } from "./audit.ts";

export interface StoredAnomalyFlag {
  id: string;
  kind: "burst" | "new_account_ratio" | "timing_cluster";
  fingerprint: string;
  details: Record<string, unknown>;
  status: "open" | "reviewed" | "dismissed";
  createdAt: Date;
}

/**
 * Run every detector over all submissions of a window (active, superseded and
 * voided ballots — abuse shows in attempts, not just counted ballots) and store
 * new flags. Idempotent: a flag with the same (kind, fingerprint) is stored once.
 * Never deletes or voids anything. Returns the number of NEW flags.
 */
export async function detectAndStoreAnomalies(tx: Sql, organizationId: string, windowId: string, opensAt: Date): Promise<number> {
  const ballots = await tx<{ id: string; created_at: Date; account_created_at: Date }[]>`
    SELECT b.id, b.created_at, a.created_at AS account_created_at
    FROM vote_ballots b JOIN accounts a ON a.id = b.account_id
    WHERE b.organization_id = ${organizationId} AND b.window_id = ${windowId}
    ORDER BY b.created_at, b.id
  `;
  const flags: { kind: StoredAnomalyFlag["kind"]; fingerprint: string; details: Record<string, unknown> }[] = [];
  for (const burst of detectBursts(ballots.map(b => b.created_at.getTime()), defaultDetectorOptions.burst)) {
    flags.push({ kind: "burst", fingerprint: new Date(burst.bucketStart).toISOString(), details: { ...burst, bucketMs: defaultDetectorOptions.burst.bucketMs } });
  }
  const ratio = newAccountRatio(ballots.map(b => b.account_created_at.getTime()), opensAt.getTime(), defaultDetectorOptions.newAccounts);
  if (ratio.flagged) flags.push({ kind: "new_account_ratio", fingerprint: "window", details: { ...ratio } });
  for (const cluster of identicalTimingClusters(ballots.map(b => ({ id: b.id, at: b.created_at.getTime() })), defaultDetectorOptions.timing)) {
    flags.push({ kind: "timing_cluster", fingerprint: cluster.ids[0]!, details: { ballotIds: cluster.ids, start: new Date(cluster.start).toISOString(), end: new Date(cluster.end).toISOString() } });
  }
  let created = 0;
  for (const flag of flags) {
    const rows = await tx`
      INSERT INTO vote_anomaly_flags (organization_id, window_id, kind, fingerprint, details)
      VALUES (${organizationId}, ${windowId}, ${flag.kind}, ${flag.fingerprint}, ${tx.json(flag.details as never)})
      ON CONFLICT (window_id, kind, fingerprint) DO NOTHING RETURNING id
    `;
    created += rows.length;
  }
  return created;
}
