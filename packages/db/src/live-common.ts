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

export interface ShowControlRow {
  state: "standby" | "running" | "paused" | "ended";
  pause_reason: string | null;
  current_performance_id: string | null;
  revision: number;
  broadcast_sequence: string;
  updated_at: Date;
}

/**
 * Lock (creating if needed) the competition's show-control row. Lock order for all
 * live-production writes is: show_controls -> stage_timers, which prevents deadlocks
 * between the safety stop and concurrent timer commands.
 */
export async function lockShowControl(tx: Sql, organizationId: string, competitionId: string): Promise<ShowControlRow> {
  await tx`INSERT INTO show_controls (organization_id, competition_id) VALUES (${organizationId}, ${competitionId})
    ON CONFLICT DO NOTHING`;
  const [row] = await tx<ShowControlRow[]>`
    SELECT state, pause_reason, current_performance_id, revision, broadcast_sequence::text, updated_at
    FROM show_controls WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} FOR UPDATE
  `;
  return row!;
}

/** Advance the monotonic sequence public overlays use to discard stale updates. Caller holds the show lock. */
export async function bumpBroadcastSequence(tx: Sql, organizationId: string, competitionId: string): Promise<number> {
  const [row] = await tx<{ broadcast_sequence: string }[]>`
    UPDATE show_controls SET broadcast_sequence = broadcast_sequence + 1
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
    RETURNING broadcast_sequence::text
  `;
  if (!row) throw new DomainError("show_control_not_found");
  return Number(row.broadcast_sequence);
}

/** Serialize writers of one competition-scoped channel for the rest of the transaction. */
export async function lockChannel(tx: Sql, channel: string, organizationId: string, competitionId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${channel}:${organizationId}:${competitionId}`}, 0))`;
}
