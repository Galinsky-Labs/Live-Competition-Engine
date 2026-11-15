import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { AuthenticationService } from "@live-competition-engine/auth";
import { CredentialService } from "@live-competition-engine/auth/credentials";
import { parseServerEnv } from "@live-competition-engine/config";
import { closeDatabaseConnection } from "./index.ts";
import { createPostgresAuthStore } from "./auth-store.ts";
import { accountSummary, createPostgresCredentialStore } from "./credential-store.ts";
import { addMemberByEmail, createOrganization, OrganizationError } from "./organizations.ts";

test("password sign-up, login, tenant creation and append-only audit", async () => {
  const sql = postgres(parseServerEnv().DATABASE_URL, { max: 1 });
  const auth = new AuthenticationService(createPostgresAuthStore());
  const credentials = new CredentialService(createPostgresCredentialStore(), auth);
  const email = `owner-${randomUUID()}@example.test`;
  const slug = `org-${randomUUID().slice(0, 8)}`;
  try {
    const created = await credentials.signUp(email.toUpperCase(), "a sufficiently long passphrase");
    const login = await credentials.login(email, "a sufficiently long passphrase");
    assert.equal(login.accountId, created.accountId);
    await assert.rejects(credentials.signUp(email, "a sufficiently long passphrase"), /email_taken/);
    await assert.rejects(credentials.login(email, "wrong passphrase here"), /invalid/);

    const org = await createOrganization(created.accountId, "Tenant Name", slug);
    await assert.rejects(createOrganization(created.accountId, "Other", slug), (e: unknown) => e instanceof OrganizationError && e.code === "slug_taken");
    await assert.rejects(createOrganization(created.accountId, "Other", "api"), (e: unknown) => e instanceof OrganizationError && e.code === "invalid_slug");
    const principal = await auth.authorizeAction(`Bearer ${login.token}`, "tenant.manage", { organizationId: org.id });
    assert.equal(principal.role, "tenant_operator");
    const summary = await accountSummary(created.accountId);
    assert.deepEqual(summary?.organizations.map(o => [o.slug, o.roles]), [[slug, ["tenant_operator"]]]);

    const otherEmail = `member-${randomUUID()}@example.test`;
    const other = await credentials.signUp(otherEmail, "another long passphrase");
    assert.equal(await addMemberByEmail(org.id, created.accountId, otherEmail), other.accountId);
    await assert.rejects(auth.authorizeAction(`Bearer ${other.token}`, "tenant.manage", { organizationId: org.id }), /forbidden/);

    const [audit] = await sql<{ id: string }[]>`SELECT id FROM engine_audit_log WHERE organization_id = ${org.id} ORDER BY id LIMIT 1`;
    await assert.rejects(sql`UPDATE engine_audit_log SET action = 'x.y' WHERE id = ${audit!.id}`, /append-only/);
    await assert.rejects(sql`DELETE FROM engine_audit_log WHERE id = ${audit!.id}`, /append-only/);
    const [attempts] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM login_attempts WHERE email_hash = ${email}`;
    assert.equal(attempts!.n, 0, "attempt log never stores raw email");
  } finally {
    await sql.end();
    await closeDatabaseConnection();
  }
});
