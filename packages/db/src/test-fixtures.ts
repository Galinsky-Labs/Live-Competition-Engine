import { randomUUID } from "node:crypto";
import type { CompetitionRole } from "@live-competition-engine/auth";
import { getSqlClient } from "./index.ts";

/**
 * Integration-test helpers. Each call creates uniquely named rows so tests can
 * run concurrently against one database. Never import from production code.
 */
export async function createTenant(name = "Fixture tenant"): Promise<string> {
  const id = randomUUID();
  await getSqlClient()`INSERT INTO organizations (id, name, slug) VALUES (${id}, ${name}, ${`fx-${id}`})`;
  return id;
}

export async function createAccount(organizationId?: string): Promise<string> {
  const id = randomUUID();
  const sql = getSqlClient();
  await sql`INSERT INTO accounts (id, email) VALUES (${id}, ${`fx-${id}@example.test`})`;
  if (organizationId) {
    await sql`INSERT INTO organization_memberships (organization_id, account_id) VALUES (${organizationId}, ${id})`;
  }
  return id;
}

export async function grantRole(
  accountId: string,
  role: CompetitionRole,
  scope: { organizationId?: string; competitionId?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await getSqlClient()`
    INSERT INTO role_grants (id, account_id, role, organization_id, competition_id, granted_by_account_id)
    VALUES (${id}, ${accountId}, ${role}, ${scope.organizationId ?? null}, ${scope.competitionId ?? null}, ${accountId})
  `;
  return id;
}

export async function createCompetition(organizationId: string, title = "Fixture competition"): Promise<string> {
  const id = randomUUID();
  await getSqlClient()`INSERT INTO competitions (id, organization_id, title) VALUES (${id}, ${organizationId}, ${title})`;
  return id;
}

export async function createEntry(organizationId: string, competitionId: string, displayName = "Fixture entrant"): Promise<{ participantId: string; entryId: string }> {
  const sql = getSqlClient();
  const participantId = randomUUID();
  const entryId = randomUUID();
  await sql`INSERT INTO participants (id, organization_id, display_name) VALUES (${participantId}, ${organizationId}, ${displayName})`;
  await sql`INSERT INTO entries (id, organization_id, competition_id, participant_id, status) VALUES (${entryId}, ${organizationId}, ${competitionId}, ${participantId}, 'approved')`;
  return { participantId, entryId };
}

/** Enable a feature at platform and tenant scope for a test tenant. */
export async function enableFeature(feature: string, organizationId: string, actorAccountId: string): Promise<void> {
  const sql = getSqlClient();
  await sql`
    INSERT INTO feature_flags (scope_key, feature, scope, enabled, revision, updated_by_account_id)
    VALUES ('platform', ${feature}, 'platform', true, 1, ${actorAccountId})
    ON CONFLICT (scope_key, feature) DO UPDATE SET enabled = true
  `;
  await sql`
    INSERT INTO feature_flags (scope_key, feature, scope, organization_id, enabled, revision, updated_by_account_id)
    VALUES (${`tenant:${organizationId}`}, ${feature}, 'tenant', ${organizationId}, true, 1, ${actorAccountId})
    ON CONFLICT (scope_key, feature) DO UPDATE SET enabled = true
  `;
}
