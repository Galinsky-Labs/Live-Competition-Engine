import test, { after } from "node:test";
import assert from "node:assert/strict";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createCompetition, createTenant } from "./test-fixtures.ts";
import { listAuditEvents } from "./audit.ts";
import { evaluateStoredFeature } from "./feature-flags.ts";
import {
  effectiveTenantFeatures,
  listTenantOverrides,
  setPlatformFeature,
  setTenantCeiling,
  setTenantScopedFeature
} from "./feature-control.ts";

after(closeDatabaseConnection);

const code = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as { code?: string }).code; }
  return "no_error";
};

async function platformRevision(feature: string): Promise<number> {
  const [row] = await getSqlClient()<{ revision: number }[]>`SELECT revision FROM feature_flags WHERE scope_key = 'platform' AND feature = ${feature}`;
  return row?.revision ?? 0;
}

async function ensurePlatformOn(actor: string, feature: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await setPlatformFeature(actor, { feature, enabled: true, expectedRevision: await platformRevision(feature) });
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "revision_conflict") throw error;
    }
  }
}

test("platform flag changes are audited in the platform chain", async () => {
  const actor = await createAccount();
  await ensurePlatformOn(actor, "polls");
  const events = await listAuditEvents(null, { subjectType: "feature_flag", subjectId: "platform:polls" });
  assert.ok(events.some(event => event.actor_account_id === actor && event.action === "feature.platform_flag_set"));
  assert.equal(await code(setPlatformFeature(actor, { feature: "not_a_feature", enabled: true, expectedRevision: 0 })), "invalid_feature");
});

test("ceiling lock vetoes the feature and blocks tenant enablement at every scope", async () => {
  const platformActor = await createAccount();
  const org = await createTenant();
  const operator = await createAccount(org);
  const member = await createAccount(org);
  const event = await createCompetition(org);
  await ensurePlatformOn(platformActor, "polls");
  const enabled = await setTenantScopedFeature(org, operator, { scope: "tenant", feature: "polls", enabled: true, expectedRevision: 0 });
  assert.equal(enabled.revision, 1);
  assert.equal((await evaluateStoredFeature("polls", { organizationId: org })).enabled, true);

  const lock = await setTenantCeiling(platformActor, { organizationId: org, feature: "polls", locked: true, reason: "abuse", expectedRevision: 0 });
  assert.equal(lock.tenantFlagRevision, 2);
  assert.equal((await evaluateStoredFeature("polls", { organizationId: org })).enabled, false);
  assert.equal(await code(setTenantScopedFeature(org, operator, { scope: "tenant", feature: "polls", enabled: true, expectedRevision: 2 })), "feature_locked_by_platform");
  assert.equal(await code(setTenantScopedFeature(org, operator, { scope: "event", eventId: event, feature: "polls", enabled: true, expectedRevision: 0 })), "feature_locked_by_platform");
  assert.equal(await code(setTenantScopedFeature(org, operator, { scope: "account", accountId: member, feature: "polls", enabled: true, expectedRevision: 0 })), "feature_locked_by_platform");
  // Disabling is always allowed.
  await setTenantScopedFeature(org, operator, { scope: "event", eventId: event, feature: "polls", enabled: false, expectedRevision: 0 });

  const view = (await effectiveTenantFeatures(org)).find(row => row.feature === "polls")!;
  assert.equal(view.enabled, false);
  assert.equal(view.controlledBy, "ceiling");
  assert.equal(view.tenantMayEnable, false);

  const overrides = await listTenantOverrides({ organizationId: org });
  assert.equal(overrides.find(row => row.feature === "polls")?.ceiling.locked, true);

  await setTenantCeiling(platformActor, { organizationId: org, feature: "polls", locked: false, expectedRevision: 1 });
  await setTenantScopedFeature(org, operator, { scope: "tenant", feature: "polls", enabled: true, expectedRevision: 2 });
  const audit = await listAuditEvents(org, { subjectType: "feature_ceiling" });
  assert.equal(audit.length, 2);
});

test("ceiling writes use optimistic revisions and stale tenant writes conflict", async () => {
  const platformActor = await createAccount();
  const org = await createTenant();
  assert.equal(await code(setTenantCeiling(platformActor, { organizationId: org, feature: "chat", locked: true, expectedRevision: 3 })), "revision_conflict");
  assert.equal(await code(setTenantScopedFeature(org, platformActor, { scope: "tenant", feature: "chat", enabled: false, expectedRevision: 9 })), "revision_conflict");
});

test("concurrent tenant enable and platform lock always end locked and vetoed", async () => {
  const platformActor = await createAccount();
  const org = await createTenant();
  const operator = await createAccount(org);
  await ensurePlatformOn(platformActor, "questions");
  const results = await Promise.allSettled([
    setTenantScopedFeature(org, operator, { scope: "tenant", feature: "questions", enabled: true, expectedRevision: 0 }),
    setTenantCeiling(platformActor, { organizationId: org, feature: "questions", locked: true, expectedRevision: 0 })
  ]);
  assert.equal(results[1]!.status, "fulfilled");
  assert.equal((await evaluateStoredFeature("questions", { organizationId: org })).enabled, false);
});

test("cross-tenant scoped writes are refused", async () => {
  const org = await createTenant();
  const otherOrg = await createTenant();
  const operator = await createAccount(org);
  const foreignEvent = await createCompetition(otherOrg);
  const foreignMember = await createAccount(otherOrg);
  assert.equal(await code(setTenantScopedFeature(org, operator, { scope: "event", eventId: foreignEvent, feature: "chat", enabled: false, expectedRevision: 0 })), "invalid_feature_scope");
  assert.equal(await code(setTenantScopedFeature(org, operator, { scope: "account", accountId: foreignMember, feature: "chat", enabled: false, expectedRevision: 0 })), "invalid_feature_scope");
  assert.equal(await code(setTenantScopedFeature(org, operator, { scope: "platform", feature: "chat", enabled: true, expectedRevision: 0 })), "invalid_feature_scope");
  assert.equal((await listTenantOverrides({ organizationId: otherOrg })).length, 0);
});
