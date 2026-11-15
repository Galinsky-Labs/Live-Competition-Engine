import test from "node:test";
import assert from "node:assert/strict";
import { AuthenticationError, AuthenticationService } from "@live-competition-engine/auth";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createPostgresAuthStore } from "./auth-store.ts";
import { createAccount, createTenant, grantRole } from "./test-fixtures.ts";

test("a non-active tenant fails closed for every tenant-scoped authorization", async () => {
  const sql = getSqlClient();
  try {
    const org = await createTenant();
    const account = await createAccount(org);
    await grantRole(account, "tenant_operator", { organizationId: org });
    const auth = new AuthenticationService(createPostgresAuthStore());
    const { token } = await auth.issueSession(account);
    const header = `Bearer ${token}`;
    await auth.authorizeAction(header, "tenant.manage", { organizationId: org });
    for (const status of ["suspended", "scheduled_deletion", "deleted"]) {
      await sql`UPDATE organizations SET status = ${status}, deletion_scheduled_for = now() + interval '30 days' WHERE id = ${org}`;
      await assert.rejects(auth.authorize(header, org), (e: unknown) => e instanceof AuthenticationError && e.code === "forbidden");
      await assert.rejects(auth.authorizeAction(header, "tenant.manage", { organizationId: org }), AuthenticationError);
    }
    await sql`UPDATE organizations SET status = 'active', deletion_scheduled_for = NULL WHERE id = ${org}`;
    assert.equal((await auth.authorize(header, org)).accountId, account);
  } finally {
    await closeDatabaseConnection();
  }
});
