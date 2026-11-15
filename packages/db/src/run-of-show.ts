import { getSqlClient } from "./index.ts";
import type { Sql } from "./audit.ts";

/**
 * Public run-of-show projection: rounds and their ordered performances with the
 * participant's public display name only. No entry ids, account ids, scores or notes.
 */
export interface RunOfShowPerformance {
  id: string;
  ordinal: number;
  status: "queued" | "live" | "completed" | "skipped";
  displayName: string;
}

export interface RunOfShowRound {
  id: string;
  label: string;
  ordinal: number;
  status: "scheduled" | "live" | "completed" | "cancelled";
  performances: RunOfShowPerformance[];
}

export async function getRunOfShow(organizationId: string, competitionId: string, sql: Sql = getSqlClient()): Promise<RunOfShowRound[]> {
  const rows = await sql<{
    round_id: string; label: string; round_ordinal: number; round_status: RunOfShowRound["status"];
    performance_id: string | null; ordinal: number | null; status: RunOfShowPerformance["status"] | null; display_name: string | null;
  }[]>`
    SELECT r.id AS round_id, r.label, r.ordinal AS round_ordinal, r.status::text AS round_status,
      p.id AS performance_id, p.ordinal, p.status::text AS status, pt.display_name
    FROM rounds r
    LEFT JOIN performances p ON p.round_id = r.id AND p.organization_id = r.organization_id
    LEFT JOIN entries e ON e.id = p.entry_id AND e.organization_id = p.organization_id
    LEFT JOIN participants pt ON pt.id = e.participant_id AND pt.organization_id = e.organization_id
    WHERE r.organization_id = ${organizationId} AND r.competition_id = ${competitionId}
    ORDER BY r.ordinal, p.ordinal
  `;
  const rounds = new Map<string, RunOfShowRound>();
  for (const row of rows) {
    let round = rounds.get(row.round_id);
    if (!round) {
      round = { id: row.round_id, label: row.label, ordinal: row.round_ordinal, status: row.round_status, performances: [] };
      rounds.set(row.round_id, round);
    }
    if (row.performance_id && row.ordinal !== null && row.status) {
      round.performances.push({ id: row.performance_id, ordinal: row.ordinal, status: row.status, displayName: row.display_name ?? "" });
    }
  }
  return [...rounds.values()];
}
