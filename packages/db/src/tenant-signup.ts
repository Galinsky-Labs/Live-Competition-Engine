import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { requirePostmark } from "@live-competition-engine/config/providers";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  checkSlug,
  computeOnboardingChecklist,
  SIGNUP_RATE_LIMIT,
  SKIPPABLE_STEPS,
  validateFirstEvent,
  validateSignup,
  VERIFICATION_RESEND_LIMIT,
  VERIFICATION_TTL_MS,
  type OnboardingChecklist,
  type OnboardingStep
} from "@live-competition-engine/domain/tenant-signup";
import { recordAudit, type Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";
import { assertPlanLimit, getPublishedPlanByKey, startSubscription } from "./saas-plans.ts";

/**
 * LC-50 tenant signup and onboarding.
 *
 * Identity model: the engine has no password or OIDC login yet. Signup creates an account
 * with an UNVERIFIED email and immediately issues a bearer session through
 * AuthenticationService.issueSession; email ownership is proven later with a single-use
 * verification token. Account recovery remains the LC-03 recovery-code model.
 */

// ---------------------------------------------------------------- verification delivery

export interface VerificationMessage {
  accountId: string;
  email: string;
  token: string;
  expiresAt: Date;
}

/** Pluggable delivery. Returning `testToken` is permitted only for test-mode senders. */
export interface VerificationSender {
  sendVerification(message: VerificationMessage): Promise<{ testToken?: string }>;
}

/**
 * Default sender: delivers nothing. Logs only that a verification was issued (no email,
 * no token). In NODE_ENV=test it returns the token so tests and local runs can complete
 * the flow; in any other mode the token is unrecoverable and a real sender must be wired.
 */
export function createDefaultVerificationSender(
  mode: string | undefined = process.env.NODE_ENV,
  log: (message: string, fields: Record<string, unknown>) => void = (m, f) => console.info(m, f)
): VerificationSender {
  return {
    async sendVerification(message) {
      log("email verification issued (no delivery provider configured)", { accountId: message.accountId });
      return mode === "test" ? { testToken: message.token } : {};
    }
  };
}

/** Real delivery through Postmark's HTTP API. Fails closed when credentials are absent. */
export function createPostmarkVerificationSender(
  appUrl: string,
  fetchImpl: typeof fetch = fetch,
  credentials: () => { serverToken: string; defaultFrom: string } = () => requirePostmark()
): VerificationSender {
  return {
    async sendVerification(message) {
      const { serverToken, defaultFrom } = credentials();
      const link = new URL("/signup/verify", appUrl);
      link.searchParams.set("account", message.accountId);
      link.searchParams.set("token", message.token);
      const response = await fetchImpl("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "x-postmark-server-token": serverToken },
        body: JSON.stringify({
          From: defaultFrom,
          To: message.email,
          Subject: "Verify your email address",
          TextBody: `Confirm this email address for your new organization: ${link.toString()}\n\nThe link expires at ${message.expiresAt.toISOString()}.`,
          MessageStream: "outbound"
        }),
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new DomainError("verification_delivery_failed");
      return {};
    }
  };
}

// ---------------------------------------------------------------- helpers

const tokenHash = (token: string) => createHash("sha256").update(`email-verification\0${token}`, "utf8").digest("hex");
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Keyed hash of the client IP. Set SIGNUP_IP_HASH_KEY (>= 32 chars) in production; the
 * built-in fallback key only provides domain separation, and IPv4 hashes are brute-forceable
 * without a secret key.
 */
export function hashClientIp(ip: string, key = process.env.SIGNUP_IP_HASH_KEY): string {
  const secret = key && key.length >= 32 ? key : "lce-signup-ip-hash-v1";
  return createHmac("sha256", secret).update(ip.trim().toLowerCase().slice(0, 64), "utf8").digest("hex");
}

/** Count-and-record under a per-IP advisory lock so concurrent attempts cannot exceed the limit. */
export async function consumeSignupAttempt(ipHash: string, now = new Date()): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(ipHash)) throw new DomainError("invalid_ip_hash");
  await getSqlClient().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"signup_ip:" + ipHash}, 0))`;
    const since = new Date(now.getTime() - SIGNUP_RATE_LIMIT.windowMs);
    const [row] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM signup_attempts WHERE ip_hash = ${ipHash} AND attempted_at > ${since}
    `;
    if (row!.n >= SIGNUP_RATE_LIMIT.maxAttempts) throw new DomainError("rate_limited");
    await tx`INSERT INTO signup_attempts (ip_hash, attempted_at) VALUES (${ipHash}, ${now})`;
  });
}

async function issueVerificationToken(tx: Sql, accountId: string, email: string, now: Date) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MS);
  await tx`
    UPDATE account_email_verifications SET superseded_at = ${now}
    WHERE account_id = ${accountId} AND consumed_at IS NULL AND superseded_at IS NULL
  `;
  await tx`
    INSERT INTO account_email_verifications (id, account_id, email, token_hash, created_at, expires_at)
    VALUES (${randomUUID()}, ${accountId}, ${email}, ${tokenHash(token)}, ${now}, ${expiresAt})
  `;
  return { token, expiresAt };
}

// ---------------------------------------------------------------- signup

export interface SignupDeps {
  issueSession(accountId: string, now?: Date): Promise<{ token: string; session: { id: string; expiresAt: Date } }>;
  sender: VerificationSender;
}

export interface SignupResult {
  accountId: string;
  organizationId: string;
  slug: string;
  subscriptionId: string | null;
  session: { token: string; expiresAt: Date };
  verification: { status: "pending"; expiresAt: Date; delivered: boolean; testToken?: string };
}

export async function checkSlugAvailability(input: unknown): Promise<{ available: boolean; slug?: string; reason?: string }> {
  const check = checkSlug(input);
  if (!check.ok) return { available: false, reason: check.reason };
  const [row] = await getSqlClient()`SELECT 1 FROM organizations WHERE slug = ${check.slug}`;
  return row ? { available: false, slug: check.slug, reason: "slug_unavailable" } : { available: true, slug: check.slug };
}

/**
 * Public signup. Account, organization, active membership, tenant_operator grant, onboarding
 * state, verification token and optional plan trial are created in ONE transaction; the
 * session is issued and the verification sent only after commit.
 */
export async function signupTenant(rawInput: unknown, ipHash: string, deps: SignupDeps, now = new Date()): Promise<SignupResult> {
  const input = validateSignup(rawInput);
  await consumeSignupAttempt(ipHash, now);
  const accountId = randomUUID();
  const organizationId = randomUUID();

  const created = await getSqlClient().begin(async tx => {
    const account = await tx`
      INSERT INTO accounts (id, email, created_at) VALUES (${accountId}, ${input.email}, ${now})
      ON CONFLICT (email) DO NOTHING RETURNING id
    `;
    if (account.length !== 1) throw new DomainError("email_unavailable");
    const organization = await tx`
      INSERT INTO organizations (id, name, slug, created_at) VALUES (${organizationId}, ${input.organizationName}, ${input.slug}, ${now})
      ON CONFLICT (slug) DO NOTHING RETURNING id
    `;
    if (organization.length !== 1) throw new DomainError("slug_unavailable");
    await tx`
      INSERT INTO organization_memberships (organization_id, account_id, status, created_at)
      VALUES (${organizationId}, ${accountId}, 'active', ${now})
    `;
    const grantId = randomUUID();
    await tx`
      INSERT INTO role_grants (id, account_id, role, organization_id, competition_id, granted_by_account_id, granted_at)
      VALUES (${grantId}, ${accountId}, 'tenant_operator', ${organizationId}, NULL, ${accountId}, ${now})
    `;
    await tx`
      INSERT INTO tenant_onboarding (organization_id, created_by_account_id, created_at, updated_at)
      VALUES (${organizationId}, ${accountId}, ${now}, ${now})
    `;
    let subscriptionId: string | null = null;
    if (input.planKey) {
      const plan = await getPublishedPlanByKey(input.planKey, tx);
      if (!plan) throw new DomainError("plan_not_found");
      const started = await startSubscription(organizationId, accountId,
        { planId: plan.id, idempotencyKey: `signup:${organizationId}` }, now, tx);
      subscriptionId = started.subscription.id;
    }
    const verification = await issueVerificationToken(tx, accountId, input.email, now);
    await recordAudit(tx, {
      organizationId, actorAccountId: accountId, action: "tenant.signed_up", subjectType: "organization", subjectId: organizationId,
      details: { slug: input.slug, roleGrantId: grantId, planKey: input.planKey }
    });
    await recordAudit(tx, {
      organizationId: null, actorAccountId: accountId, action: "tenant.created", subjectType: "organization", subjectId: organizationId,
      details: { slug: input.slug, via: "self_signup" }
    });
    return { subscriptionId, verification };
  });

  const { token, session } = await deps.issueSession(accountId, now);
  let delivered = false;
  let testToken: string | undefined;
  try {
    const sent = await deps.sender.sendVerification({
      accountId, email: input.email, token: created.verification.token, expiresAt: created.verification.expiresAt
    });
    delivered = true;
    testToken = sent.testToken;
  } catch {
    // Signup has committed; the user can request a new verification email (resend).
  }
  return {
    accountId, organizationId, slug: input.slug, subscriptionId: created.subscriptionId,
    session: { token, expiresAt: session.expiresAt },
    verification: { status: "pending", expiresAt: created.verification.expiresAt, delivered, ...(testToken ? { testToken } : {}) }
  };
}

/** Consume a verification token. Wrong, consumed and superseded tokens are indistinguishable. */
export async function verifyEmail(accountId: unknown, token: unknown, now = new Date()): Promise<{ accountId: string; verifiedAt: Date }> {
  if (!isUuid(accountId) || typeof token !== "string" || !TOKEN_PATTERN.test(token)) throw new DomainError("invalid_verification_token");
  return getSqlClient().begin(async tx => {
    const [row] = await tx<{ id: string; email: string; expires_at: Date; consumed_at: Date | null; superseded_at: Date | null; account_email: string | null }[]>`
      SELECT v.id, v.email, v.expires_at, v.consumed_at, v.superseded_at, a.email AS account_email
      FROM account_email_verifications v JOIN accounts a ON a.id = v.account_id
      WHERE v.account_id = ${accountId} AND v.token_hash = ${tokenHash(token)} AND a.disabled_at IS NULL
      FOR UPDATE OF v
    `;
    if (!row || row.consumed_at || row.superseded_at || row.account_email !== row.email) throw new DomainError("invalid_verification_token");
    if (row.expires_at.getTime() <= now.getTime()) throw new DomainError("verification_expired");
    await tx`UPDATE account_email_verifications SET consumed_at = ${now} WHERE id = ${row.id}`;
    await tx`UPDATE accounts SET email_verified_at = ${now} WHERE id = ${accountId}`;
    await recordAudit(tx, {
      organizationId: null, actorAccountId: accountId, action: "account.email_verified", subjectType: "account", subjectId: accountId
    });
    return { accountId, verifiedAt: now };
  });
}

/** Issue a fresh token for the authenticated account (previous tokens are superseded). */
export async function resendVerification(accountId: string, sender: VerificationSender, now = new Date()): Promise<{ expiresAt: Date; delivered: boolean; testToken?: string }> {
  const issued = await getSqlClient().begin(async tx => {
    const [account] = await tx<{ email: string | null; email_verified_at: Date | null }[]>`
      SELECT email, email_verified_at FROM accounts WHERE id = ${accountId} AND disabled_at IS NULL FOR UPDATE
    `;
    if (!account || !account.email) throw new DomainError("account_not_found");
    if (account.email_verified_at) throw new DomainError("email_already_verified");
    const since = new Date(now.getTime() - VERIFICATION_RESEND_LIMIT.windowMs);
    const [count] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM account_email_verifications WHERE account_id = ${accountId} AND created_at > ${since}
    `;
    if (count!.n >= VERIFICATION_RESEND_LIMIT.maxTokens) throw new DomainError("rate_limited");
    return { email: account.email, ...(await issueVerificationToken(tx, accountId, account.email, now)) };
  });
  const sent = await sender.sendVerification({ accountId, email: issued.email, token: issued.token, expiresAt: issued.expiresAt });
  return { expiresAt: issued.expiresAt, delivered: true, ...(sent.testToken ? { testToken: sent.testToken } : {}) };
}

// ---------------------------------------------------------------- onboarding

async function ensureOnboarding(tx: Sql, organizationId: string, actorAccountId: string) {
  await tx`
    INSERT INTO tenant_onboarding (organization_id, created_by_account_id)
    SELECT ${organizationId}, ${actorAccountId} WHERE EXISTS (SELECT 1 FROM organizations WHERE id = ${organizationId})
    ON CONFLICT (organization_id) DO NOTHING
  `;
  const [row] = await tx<{ skipped_steps: string[]; first_event_id: string | null; created_by_account_id: string; revision: number }[]>`
    SELECT skipped_steps, first_event_id, created_by_account_id, revision FROM tenant_onboarding
    WHERE organization_id = ${organizationId} FOR UPDATE
  `;
  if (!row) throw new DomainError("organization_not_found");
  return row;
}

export interface OnboardingView extends OnboardingChecklist {
  organizationId: string;
  firstEventId: string | null;
  revision: number;
}

/** Checklist computed from real data: themes (LC-06), domains (LC-07), memberships, competitions. */
export async function getOnboardingChecklist(organizationId: string, actorAccountId: string): Promise<OnboardingView> {
  return getSqlClient().begin(async tx => {
    const state = await ensureOnboarding(tx, organizationId, actorAccountId);
    const [facts] = await tx<{ verified: boolean; theme: boolean; domains: number; members: number; events: number }[]>`
      SELECT
        EXISTS (SELECT 1 FROM accounts WHERE id = ${state.created_by_account_id} AND email_verified_at IS NOT NULL) AS verified,
        EXISTS (SELECT 1 FROM organization_theme_versions WHERE organization_id = ${organizationId} AND is_active) AS theme,
        (SELECT count(*)::int FROM organization_domains WHERE organization_id = ${organizationId}) AS domains,
        (SELECT count(*)::int FROM organization_memberships WHERE organization_id = ${organizationId} AND status = 'active') AS members,
        (SELECT count(*)::int FROM competitions WHERE organization_id = ${organizationId}) AS events
    `;
    const checklist = computeOnboardingChecklist({
      emailVerified: facts!.verified, hasActiveTheme: facts!.theme, domainClaims: facts!.domains,
      activeMembers: facts!.members, paymentSetupComplete: null, firstEventId: state.first_event_id,
      eventCount: facts!.events, skippedSteps: state.skipped_steps
    });
    return { organizationId, firstEventId: state.first_event_id, revision: state.revision, ...checklist };
  });
}

export async function setOnboardingStepSkipped(organizationId: string, actorAccountId: string, step: string, skipped: boolean): Promise<OnboardingView> {
  if (!SKIPPABLE_STEPS.includes(step as OnboardingStep)) throw new DomainError("invalid_onboarding_step");
  await getSqlClient().begin(async tx => {
    const state = await ensureOnboarding(tx, organizationId, actorAccountId);
    const next = skipped ? [...new Set([...state.skipped_steps, step])] : state.skipped_steps.filter(s => s !== step);
    await tx`
      UPDATE tenant_onboarding SET skipped_steps = ${next}, revision = revision + 1, updated_at = now()
      WHERE organization_id = ${organizationId}
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: skipped ? "onboarding.step_skipped" : "onboarding.step_unskipped",
      subjectType: "organization", subjectId: organizationId, details: { step }
    });
  });
  return getOnboardingChecklist(organizationId, actorAccountId);
}

/** Lifecycle guard hook (LC-53 assertTenantActive) run inside the first-event transaction. */
export type TenantActiveCheck = (organizationId: string, sql: Sql) => Promise<void>;

/**
 * Guided first event: creates ONE draft competition per tenant. Repeated calls return the
 * same event (natural idempotency). Enforces the plan's max_events_per_month limit.
 */
export async function createFirstEvent(
  organizationId: string,
  actorAccountId: string,
  rawInput: unknown,
  options: { now?: Date; assertActive?: TenantActiveCheck } = {}
): Promise<{ competitionId: string; created: boolean }> {
  const now = options.now ?? new Date();
  const input = validateFirstEvent(rawInput, now);
  return getSqlClient().begin(async tx => {
    const state = await ensureOnboarding(tx, organizationId, actorAccountId);
    if (options.assertActive) await options.assertActive(organizationId, tx);
    if (state.first_event_id) return { competitionId: state.first_event_id, created: false };
    await assertPlanLimit(organizationId, "max_events_per_month", 1, { sql: tx, now });
    const competitionId = randomUUID();
    await tx`
      INSERT INTO competitions (id, organization_id, title, description, status, starts_at, created_at, updated_at)
      VALUES (${competitionId}, ${organizationId}, ${input.title}, ${input.description}, 'draft', ${input.startsAt}, ${now}, ${now})
    `;
    await tx`
      UPDATE tenant_onboarding SET first_event_id = ${competitionId}, revision = revision + 1, updated_at = ${now}
      WHERE organization_id = ${organizationId}
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "competition.created", subjectType: "competition", subjectId: competitionId,
      details: { status: "draft", via: "onboarding_first_event" }
    });
    return { competitionId, created: true };
  });
}
