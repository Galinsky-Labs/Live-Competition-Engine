import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuthenticationService } from "@live-competition-engine/auth";
import { ProviderNotConfiguredError } from "@live-competition-engine/config/providers";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createPostgresAuthStore } from "./auth-store.ts";
import { verifyAuditChain } from "./audit.ts";
import { createAccount, createTenant } from "./test-fixtures.ts";
import { createPlanVersion, publishPlan } from "./saas-plans.ts";
import {
  checkSlugAvailability,
  consumeSignupAttempt,
  createDefaultVerificationSender,
  createFirstEvent,
  createPostmarkVerificationSender,
  getOnboardingChecklist,
  hashClientIp,
  resendVerification,
  setOnboardingStepSkipped,
  signupTenant,
  verifyEmail,
  type VerificationSender
} from "./tenant-signup.ts";

after(closeDatabaseConnection);

const auth = new AuthenticationService(createPostgresAuthStore());
const sender = createDefaultVerificationSender("test", () => undefined);
const deps = { issueSession: (id: string, now?: Date) => auth.issueSession(id, now), sender };
const unique = () => randomUUID().replaceAll("-", "").slice(0, 12);
const freshIp = () => hashClientIp(`203.0.113.${randomUUID()}`);
const input = (overrides: Record<string, unknown> = {}) => {
  const u = unique();
  return { email: `owner-${u}@example.org`, organizationName: `Org ${u}`, slug: `org-${u}`, ...overrides };
};

test("signup creates account, tenant, membership and operator grant atomically and issues a session", async () => {
  const result = await signupTenant(input(), freshIp(), deps);
  const sql = getSqlClient();
  const [account] = await sql`SELECT email_verified_at FROM accounts WHERE id = ${result.accountId}`;
  assert.equal(account!.email_verified_at, null);
  const [membership] = await sql`SELECT status FROM organization_memberships WHERE organization_id = ${result.organizationId} AND account_id = ${result.accountId}`;
  assert.equal(membership!.status, "active");
  const principal = await auth.authorizeAction(`Bearer ${result.session.token}`, "tenant.manage", { organizationId: result.organizationId });
  assert.equal(principal.role, "tenant_operator");
  assert.ok(result.verification.testToken);
  assert.equal(result.subscriptionId, null);

  const before = await getOnboardingChecklist(result.organizationId, result.accountId);
  assert.equal(before.steps.find(s => s.key === "email_verified")?.status, "pending");
  assert.equal(before.steps.find(s => s.key === "payment_setup")?.status, "external_pending");

  await assert.rejects(verifyEmail(result.accountId, "A".repeat(43)), { code: "invalid_verification_token" });
  const verified = await verifyEmail(result.accountId, result.verification.testToken);
  assert.equal(verified.accountId, result.accountId);
  await assert.rejects(verifyEmail(result.accountId, result.verification.testToken), { code: "invalid_verification_token" });
  const afterVerify = await getOnboardingChecklist(result.organizationId, result.accountId);
  assert.equal(afterVerify.steps.find(s => s.key === "email_verified")?.status, "complete");
  await assert.rejects(resendVerification(result.accountId, sender), { code: "email_already_verified" });

  assert.equal((await verifyAuditChain(result.organizationId)).valid, true);
  assert.equal((await verifyAuditChain(null)).valid, true);
});

test("slug and email conflicts roll back the whole signup; concurrent duplicate slugs yield one tenant", async () => {
  const first = input();
  await signupTenant(first, freshIp(), deps);
  const second = input({ slug: first.slug });
  await assert.rejects(signupTenant(second, freshIp(), deps), { code: "slug_unavailable" });
  const [orphan] = await getSqlClient()`SELECT id FROM accounts WHERE email = ${second.email}`;
  assert.equal(orphan, undefined, "account insert must roll back with the failed organization insert");
  await assert.rejects(signupTenant(input({ email: first.email }), freshIp(), deps), { code: "email_unavailable" });
  await assert.rejects(signupTenant(input({ slug: "admin" }), freshIp(), deps), { code: "slug_reserved" });
  assert.deepEqual(await checkSlugAvailability(first.slug), { available: false, slug: first.slug, reason: "slug_unavailable" });
  assert.deepEqual(await checkSlugAvailability("www"), { available: false, reason: "slug_reserved" });

  const slug = `race-${unique()}`;
  const results = await Promise.allSettled([1, 2, 3].map(() => signupTenant(input({ slug }), freshIp(), deps)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.ok(results.filter(r => r.status === "rejected").every(r => (r as PromiseRejectedResult).reason.code === "slug_unavailable"));
});

test("signups are rate limited per hashed IP, including under concurrency, and raw IPs are never stored", async () => {
  const ip = `198.51.100.${randomUUID()}`;
  const ipHash = hashClientIp(ip);
  assert.notEqual(ipHash, hashClientIp(ip, "k".repeat(32)), "hash is keyed");
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => consumeSignupAttempt(ipHash)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 5);
  await assert.rejects(signupTenant(input(), ipHash, deps), { code: "rate_limited" });
  const rows = await getSqlClient()`SELECT ip_hash FROM signup_attempts WHERE ip_hash = ${ipHash}`;
  assert.equal(rows.length, 5);
  const [leak] = await getSqlClient()`SELECT 1 FROM signup_attempts WHERE ip_hash LIKE ${"%" + ip + "%"}`;
  assert.equal(leak, undefined);
  // Outside the window the bucket refills.
  await consumeSignupAttempt(ipHash, new Date(Date.now() + 61 * 60 * 1000));
});

test("signup with a plan key starts a trial; an unknown plan aborts the signup", async () => {
  const operator = await createAccount();
  const planKey = `p${unique()}`;
  const plan = await createPlanVersion(operator, {
    planKey, name: "Trial", currency: "USD", billingInterval: "month", priceMinor: 1500, trialDays: 14, features: [],
    limits: { max_events_per_month: 3, max_storage_bytes: 0, max_members: 5, max_custom_domains: 0 }
  });
  await publishPlan(operator, plan.id);
  const result = await signupTenant(input({ planKey }), freshIp(), deps);
  const [sub] = await getSqlClient()`SELECT status, plan_id FROM tenant_subscriptions WHERE id = ${result.subscriptionId}`;
  assert.equal(sub!.status, "trialing");
  assert.equal(sub!.plan_id, plan.id);

  const missing = input({ planKey: `missing${unique()}` });
  await assert.rejects(signupTenant(missing, freshIp(), deps), { code: "plan_not_found" });
  const [org] = await getSqlClient()`SELECT id FROM organizations WHERE slug = ${missing.slug}`;
  assert.equal(org, undefined);

  // Guided first event: one draft competition, repeated calls return it.
  const first = await createFirstEvent(result.organizationId, result.accountId, { title: "Opening night" });
  assert.equal(first.created, true);
  const again = await createFirstEvent(result.organizationId, result.accountId, { title: "Another" });
  assert.deepEqual(again, { competitionId: first.competitionId, created: false });
  const [competition] = await getSqlClient()`SELECT status, organization_id FROM competitions WHERE id = ${first.competitionId}`;
  assert.equal(competition!.status, "draft");
  assert.equal(competition!.organization_id, result.organizationId);
  const checklist = await getOnboardingChecklist(result.organizationId, result.accountId);
  assert.equal(checklist.steps.find(s => s.key === "first_event_created")?.status, "complete");
  assert.equal(checklist.firstEventId, first.competitionId);
});

test("verification tokens are superseded on resend, expire, and failed delivery does not undo signup", async () => {
  const failing: VerificationSender = { sendVerification: async () => { throw new Error("smtp down"); } };
  const result = await signupTenant(input(), freshIp(), { ...deps, sender: failing });
  assert.equal(result.verification.delivered, false);
  assert.equal(result.verification.testToken, undefined);
  const resent = await resendVerification(result.accountId, sender);
  assert.ok(resent.testToken);
  const third = await resendVerification(result.accountId, sender);
  await assert.rejects(verifyEmail(result.accountId, resent.testToken), { code: "invalid_verification_token" });
  await assert.rejects(verifyEmail(result.accountId, third.testToken, new Date(Date.now() + 25 * 3600 * 1000)), { code: "verification_expired" });
  // Another account cannot use this token.
  const other = await createAccount();
  await assert.rejects(verifyEmail(other, third.testToken), { code: "invalid_verification_token" });
  await verifyEmail(result.accountId, third.testToken);
  // Resend rate limit (5 per hour per account).
  const fresh = await signupTenant(input(), freshIp(), deps);
  for (let i = 0; i < 4; i++) await resendVerification(fresh.accountId, sender);
  await assert.rejects(resendVerification(fresh.accountId, sender), { code: "rate_limited" });
});

test("onboarding is tenant-isolated and first events need an active plan", async () => {
  const a = await signupTenant(input(), freshIp(), deps);
  const orgB = await createTenant();
  const actorB = await createAccount(orgB);
  await assert.rejects(createFirstEvent(a.organizationId, a.accountId, { title: "No plan yet" }), { code: "no_active_subscription" });
  await assert.rejects(createFirstEvent(randomUUID(), a.accountId, { title: "Ghost" }), { code: "organization_not_found" });
  await assert.rejects(createFirstEvent(a.organizationId, a.accountId, { title: "x" }), { code: "invalid_event_title" });

  const skipped = await setOnboardingStepSkipped(a.organizationId, a.accountId, "custom_domain_claimed", true);
  assert.equal(skipped.steps.find(s => s.key === "custom_domain_claimed")?.status, "skipped");
  await assert.rejects(setOnboardingStepSkipped(a.organizationId, a.accountId, "email_verified", true), { code: "invalid_onboarding_step" });
  const b = await getOnboardingChecklist(orgB, actorB);
  assert.equal(b.steps.find(s => s.key === "custom_domain_claimed")?.status, "pending");

  // The composite FK refuses pointing tenant B's onboarding at tenant A's competition.
  const [competition] = await getSqlClient()`
    INSERT INTO competitions (id, organization_id, title) VALUES (${randomUUID()}, ${a.organizationId}, 'A event') RETURNING id
  `;
  await assert.rejects(getSqlClient()`UPDATE tenant_onboarding SET first_event_id = ${competition!.id} WHERE organization_id = ${orgB}`, /foreign key/);
  const bAfter = await getOnboardingChecklist(orgB, actorB);
  assert.equal(bAfter.steps.find(s => s.key === "first_event_created")?.status, "pending");
});

test("Postmark verification sender fails closed and sends only the expected request", async () => {
  const message = { accountId: randomUUID(), email: "x@example.org", token: "t".repeat(43), expiresAt: new Date() };
  const unconfigured = createPostmarkVerificationSender("https://app.example.org", fetch, () => { throw new ProviderNotConfiguredError("postmark"); });
  await assert.rejects(unconfigured.sendVerification(message), { code: "provider_not_configured" });
  const calls: Request[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(url, init));
    return new Response("{}", { status: calls.length === 1 ? 200 : 500 });
  }) as typeof fetch;
  const sender = createPostmarkVerificationSender("https://app.example.org", fake, () => ({ serverToken: "server-token", defaultFrom: "noreply@example.org" }));
  assert.deepEqual(await sender.sendVerification(message), {});
  assert.equal(calls[0]!.headers.get("x-postmark-server-token"), "server-token");
  const body = await calls[0]!.json();
  assert.equal(body.To, "x@example.org");
  assert.match(body.TextBody, /https:\/\/app\.example\.org\/signup\/verify\?account=/);
  await assert.rejects(sender.sendVerification(message), { code: "verification_delivery_failed" });
  // The default sender never returns the token outside test mode.
  assert.deepEqual(await createDefaultVerificationSender("production", () => undefined).sendVerification(message), {});
});
