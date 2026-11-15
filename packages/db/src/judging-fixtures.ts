import { randomUUID } from "node:crypto";
import { getSqlClient } from "./index.ts";

/** Integration-test helpers for LC-18..LC-21. Never import from production code. */
export async function createRound(organizationId: string, competitionId: string, ordinal = 1, status = "scheduled"): Promise<string> {
  const id = randomUUID();
  await getSqlClient()`INSERT INTO rounds (id, organization_id, competition_id, label, ordinal, status)
    VALUES (${id}, ${organizationId}, ${competitionId}, ${`Round ${ordinal}`}, ${ordinal}, ${status})`;
  return id;
}

/** A judge attached to the competition (optionally linked to an account), state `verified` unless told otherwise. */
export async function createCompetitionJudge(
  organizationId: string, competitionId: string, options: { accountId?: string; status?: string; actorAccountId: string; name?: string }
): Promise<string> {
  const sql = getSqlClient();
  const id = randomUUID();
  await sql`INSERT INTO judges (id, organization_id, display_name, account_id) VALUES (${id}, ${organizationId}, ${options.name ?? "Judge"}, ${options.accountId ?? null})`;
  await sql`INSERT INTO competition_judges (organization_id, competition_id, judge_id) VALUES (${organizationId}, ${competitionId}, ${id})`;
  const status = options.status ?? "verified";
  await sql`INSERT INTO competition_judge_states (organization_id, competition_id, judge_id, status, verified_at, verified_by_account_id, updated_by_account_id)
    VALUES (${organizationId}, ${competitionId}, ${id}, ${status}, ${status === "verified" ? new Date() : null},
      ${status === "verified" ? options.actorAccountId : null}, ${options.actorAccountId})`;
  return id;
}

export async function createPerformance(organizationId: string, competitionId: string, roundId: string, entryId: string, ordinal: number): Promise<string> {
  const id = randomUUID();
  await getSqlClient()`INSERT INTO performances (id, organization_id, competition_id, round_id, entry_id, ordinal)
    VALUES (${id}, ${organizationId}, ${competitionId}, ${roundId}, ${entryId}, ${ordinal})`;
  return id;
}
