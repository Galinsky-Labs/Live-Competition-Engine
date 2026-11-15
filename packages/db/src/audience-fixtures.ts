import { randomUUID } from "node:crypto";
import { getSqlClient } from "./index.ts";
import { createEntry } from "./test-fixtures.ts";

/**
 * Integration-test helpers for the audience and voting modules (LC-27..29).
 * Never import from production code.
 */
export async function createPerformance(organizationId: string, competitionId: string): Promise<{ roundId: string; entryId: string; performanceId: string }> {
  const sql = getSqlClient();
  const { entryId } = await createEntry(organizationId, competitionId);
  const roundId = randomUUID();
  const performanceId = randomUUID();
  const [row] = await sql<{ next: number }[]>`SELECT coalesce(max(ordinal), 0) + 1 AS next FROM rounds WHERE competition_id = ${competitionId}`;
  const next = row!.next;
  await sql`INSERT INTO rounds (id, organization_id, competition_id, label, ordinal) VALUES (${roundId}, ${organizationId}, ${competitionId}, 'Round', ${next})`;
  await sql`INSERT INTO performances (id, organization_id, competition_id, round_id, entry_id, ordinal) VALUES (${performanceId}, ${organizationId}, ${competitionId}, ${roundId}, ${entryId}, 1)`;
  return { roundId, entryId, performanceId };
}

// Child tables first. Tables that do not exist yet (earlier migrations) are skipped.
const tenantTables = [
  "vote_anomaly_flags", "vote_tally_snapshots", "vote_ballot_voids", "vote_ballots", "vote_window_options", "vote_windows",
  "rate_limit_counters", "audience_poll_votes", "audience_poll_options", "audience_polls",
  "audience_question_upvotes", "audience_questions", "chat_mutes", "chat_messages", "audience_blocked_terms",
  "audience_reaction_counts", "audience_consents", "audience_settings",
  "feature_decision_audit", "feature_flags", "entitlement_decisions", "entitlement_grants",
  "results", "performances", "rounds", "entries", "participants", "role_grants", "competitions", "organization_memberships"
];

/** Remove every row a test created for these tenants (audit_events stay; they are append-only). */
export async function cleanupTenants(organizationIds: string[], accountIds: string[] = []): Promise<void> {
  const sql = getSqlClient();
  const existing = new Set((await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `).map(row => row.table_name));
  for (const table of tenantTables) {
    if (!existing.has(table)) continue;
    await sql`DELETE FROM ${sql(table)} WHERE organization_id IN ${sql(organizationIds)}`;
  }
  await sql`DELETE FROM organizations WHERE id IN ${sql(organizationIds)}`;
  for (const accountId of accountIds) {
    // An account may still be referenced by a shared platform-scope feature flag row; keep it then.
    try {
      await sql`DELETE FROM accounts WHERE id = ${accountId}`;
    } catch {
      /* referenced elsewhere */
    }
  }
}
