import { DomainError } from "@live-competition-engine/domain";
import type { Sql } from "./audit.ts";

/** Shared helpers for the live-production modules (LC-22..LC-26). */

/** Statuses in which a competition's public projections may be served. */
export const PUBLIC_COMPETITION_STATUSES = ["published", "live", "paused", "completed"] as const;

export async function assertCompetitionInTenant(sql: Sql, organizationId: string, competitionId: string): Promise<{ status: string; title: string }> {
  const [row] = await sql<{ status: string; title: string }[]>`
    SELECT status::text AS status, title FROM competitions
    WHERE organization_id = ${organizationId} AND id = ${competitionId}
  `;
  if (!row) throw new DomainError("competition_not_found");
  return row;
}

/** True only for an existing competition of the tenant in a publicly visible status. */
export async function isCompetitionPublic(sql: Sql, organizationId: string, competitionId: string): Promise<boolean> {
  const [row] = await sql<{ status: string }[]>`
    SELECT status::text AS status FROM competitions
    WHERE organization_id = ${organizationId} AND id = ${competitionId}
  `;
  return !!row && (PUBLIC_COMPETITION_STATUSES as readonly string[]).includes(row.status);
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: unknown; constraint_name?: unknown };
  return e?.code === "23505" && (constraint === undefined || e.constraint_name === constraint);
}

/** Serialize writers of one competition-scoped channel for the rest of the transaction. */
export async function lockChannel(tx: Sql, channel: string, organizationId: string, competitionId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${channel}:${organizationId}:${competitionId}`}, 0))`;
}
