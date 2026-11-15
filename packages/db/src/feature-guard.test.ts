import test, { after } from "node:test";
import assert from "node:assert/strict";
import { closeDatabaseConnection } from "./index.ts";
import { createAccount, createCompetition, createTenant, enableFeature } from "./test-fixtures.ts";
import { isFeatureEnabled, requireEnabledFeature } from "./feature-guard.ts";

after(closeDatabaseConnection);

test("feature guard: enabled, disabled and cross-tenant scope map to typed errors", async () => {
  const org = await createTenant();
  const other = await createTenant();
  const actor = await createAccount(org);
  const foreignEvent = await createCompetition(other);
  const foreignAccount = await createAccount(other);
  await enableFeature("polls", org, actor);
  await requireEnabledFeature("polls", { organizationId: org, accountId: actor });
  assert.equal(await isFeatureEnabled("ppv", { organizationId: org }), false);
  await assert.rejects(requireEnabledFeature("ppv", { organizationId: org }), { code: "feature_disabled" });
  await assert.rejects(requireEnabledFeature("polls", { organizationId: org, eventId: foreignEvent }), { code: "forbidden" });
  await assert.rejects(requireEnabledFeature("polls", { organizationId: org, accountId: foreignAccount }), { code: "forbidden" });
});
