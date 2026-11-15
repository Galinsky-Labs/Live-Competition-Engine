import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  assertSubscriptionTransition,
  canTransitionSubscription,
  endedStatus,
  validateConsent,
  type CreatorType,
  type PlanInput,
  type SubscriptionStatus
} from "@live-competition-engine/domain/subscriptions";
import { isIdempotencyKey } from "@live-competition-engine/domain/payments";
import { recordAudit, type Sql } from "./audit.ts";
import { endGrantsForSource, hasActiveGrant, issueGrant, truncateGrantsForSource } from "./entitlement-grants.ts";
import { isFeatureEnabled, requireEnabledFeature } from "./feature-guard.ts";
import { getSqlClient } from "./index.ts";
import { recordCapturedPayment, type EventOutcome, type PaymentHooks } from "./payments.ts";
import type { PaymentEvent, PaymentProvider, PaymentProviderName } from "./providers/payments.ts";

export interface MembershipPlan {
  id: string;
  organizationId: string;
  creatorType: CreatorType;
  creatorId: string | null;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  interval: "month" | "year";
  termsVersion: string;
  status: "active" | "archived";
  revision: number;
}

export interface Subscription {
  id: string;
  organizationId: string;
  planId: string;
  accountId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  consentTermsVersion: string;
  consentAt: Date;
  provider: PaymentProviderName;
  providerSubscriptionId: string | null;
  revision: number;
}

type Row = Record<string, unknown>;
const mapPlan = (row: Row): MembershipPlan => ({
  id: row.id as string,
  organizationId: row.organization_id as string,
  creatorType: row.creator_type as CreatorType,
  creatorId: (row.creator_id as string | null) ?? null,
  name: row.name as string,
  description: row.description as string,
  priceMinor: Number(row.price_minor),
  currency: row.currency as string,
  interval: row.billing_interval as "month" | "year",
  termsVersion: row.terms_version as string,
  status: row.status as "active" | "archived",
  revision: Number(row.revision)
});
const mapSubscription = (row: Row): Subscription => ({
  id: row.id as string,
  organizationId: row.organization_id as string,
  planId: row.plan_id as string,
  accountId: row.account_id as string,
  status: row.status as SubscriptionStatus,
  currentPeriodStart: (row.current_period_start as Date | null) ?? null,
  currentPeriodEnd: (row.current_period_end as Date | null) ?? null,
  cancelAtPeriodEnd: row.cancel_at_period_end as boolean,
  consentTermsVersion: row.consent_terms_version as string,
  consentAt: row.consent_at as Date,
  provider: row.provider as PaymentProviderName,
  providerSubscriptionId: (row.provider_subscription_id as string | null) ?? null,
  revision: Number(row.revision)
});

/** Features a plan depends on: recurring billing always, creator memberships for non-tenant creators. */
const planFeatures = (creatorType: CreatorType) =>
  (creatorType === "tenant" ? ["subscriptions"] : ["subscriptions", "creator_memberships"]) as ("subscriptions" | "creator_memberships")[];

async function requirePlanFeatures(organizationId: string, creatorType: CreatorType, accountId?: string) {
  for (const feature of planFeatures(creatorType)) await requireEnabledFeature(feature, { organizationId, ...(accountId ? { accountId } : {}) });
}

async function planFeaturesEnabled(organizationId: string, creatorType: CreatorType, accountId?: string) {
  for (const feature of planFeatures(creatorType)) {
    if (!(await isFeatureEnabled(feature, { organizationId, ...(accountId ? { accountId } : {}) }))) return false;
  }
  return true;
}

export async function createMembershipPlan(organizationId: string, input: PlanInput, actorAccountId: string): Promise<MembershipPlan> {
  await requirePlanFeatures(organizationId, input.creatorType, input.creatorType === "account" ? input.creatorId! : undefined);
  return getSqlClient().begin(async tx => {
    if (input.creatorType === "participant") {
      const found = await tx`SELECT 1 FROM participants WHERE organization_id = ${organizationId} AND id = ${input.creatorId}`;
      if (found.length !== 1) throw new DomainError("creator_not_found");
    } else if (input.creatorType === "account") {
      const found = await tx`SELECT 1 FROM organization_memberships WHERE organization_id = ${organizationId} AND account_id = ${input.creatorId} AND status = 'active'`;
      if (found.length !== 1) throw new DomainError("creator_not_found");
    }
    const [row] = await tx<Row[]>`
      INSERT INTO membership_plans (organization_id, creator_type, creator_id, name, description, price_minor, currency, billing_interval, terms_version, created_by_account_id)
      VALUES (${organizationId}, ${input.creatorType}, ${input.creatorId}, ${input.name}, ${input.description}, ${input.priceMinor},
        ${input.currency}, ${input.interval}, ${input.termsVersion}, ${actorAccountId})
      RETURNING *
    `;
    const plan = mapPlan(row!);
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "subscription.plan_created", subjectType: "membership_plan", subjectId: plan.id,
      details: { creatorType: plan.creatorType, creatorId: plan.creatorId, priceMinor: plan.priceMinor, currency: plan.currency, interval: plan.interval, termsVersion: plan.termsVersion }
    });
    return plan;
  });
}

export async function getPlan(sql: Sql, organizationId: string, planId: string): Promise<MembershipPlan | null> {
  if (!isUuid(planId)) return null;
  const [row] = await sql<Row[]>`SELECT * FROM membership_plans WHERE organization_id = ${organizationId} AND id = ${planId}`;
  return row ? mapPlan(row) : null;
}

/** Active plans whose families are enabled for the viewer; disabled families surface no price. */
export async function listMembershipPlans(organizationId: string, accountId?: string): Promise<MembershipPlan[]> {
  const rows = await getSqlClient()<Row[]>`
    SELECT * FROM membership_plans WHERE organization_id = ${organizationId} AND status = 'active' ORDER BY created_at LIMIT 200
  `;
  const plans = rows.map(mapPlan);
  const allowed: Record<string, boolean> = {};
  for (const type of new Set(plans.map(p => p.creatorType))) allowed[type] = await planFeaturesEnabled(organizationId, type, accountId);
  return plans.filter(plan => allowed[plan.creatorType]);
}

export async function archivePlan(organizationId: string, planId: string, actorAccountId: string): Promise<MembershipPlan> {
  return getSqlClient().begin(async tx => {
    const [row] = await tx<Row[]>`
      UPDATE membership_plans SET status = 'archived', revision = revision + 1, updated_at = now()
      WHERE organization_id = ${organizationId} AND id = ${planId} RETURNING *
    `;
    if (!row) throw new DomainError("plan_not_found");
    await recordAudit(tx, { organizationId, actorAccountId, action: "subscription.plan_archived", subjectType: "membership_plan", subjectId: planId });
    return mapPlan(row);
  });
}

async function transition(tx: Sql, sub: Subscription, to: SubscriptionStatus, reason: string, patch: {
  periodStart?: Date; periodEnd?: Date; providerSubscriptionId?: string; cancelAtPeriodEnd?: boolean
} = {}): Promise<Subscription> {
  assertSubscriptionTransition(sub.status, to);
  const ended = to === "cancelled" || to === "expired";
  const [row] = await tx<Row[]>`
    UPDATE subscriptions SET status = ${to},
      current_period_start = coalesce(${patch.periodStart ?? null}, current_period_start),
      current_period_end = coalesce(${patch.periodEnd ?? null}, current_period_end),
      provider_subscription_id = coalesce(provider_subscription_id, ${patch.providerSubscriptionId ?? null}),
      cancel_at_period_end = coalesce(${patch.cancelAtPeriodEnd ?? null}, cancel_at_period_end),
      ended_at = ${ended ? new Date() : null},
      revision = revision + 1, updated_at = now()
    WHERE organization_id = ${sub.organizationId} AND id = ${sub.id} AND revision = ${sub.revision}
    RETURNING *
  `;
  if (!row) throw new DomainError("subscription_revision_conflict");
  if (sub.status !== to) {
    await tx`INSERT INTO subscription_history (organization_id, subscription_id, from_status, to_status, reason)
      VALUES (${sub.organizationId}, ${sub.id}, ${sub.status}, ${to}, ${reason})`;
    await recordAudit(tx, {
      organizationId: sub.organizationId, actorAccountId: null, action: `subscription.${to}`, subjectType: "subscription", subjectId: sub.id,
      details: { from: sub.status, reason }
    });
  }
  return mapSubscription(row);
}

export interface SubscribeResult { subscription: Subscription; redirectUrl: string | null }

/**
 * Start a subscription: records explicit consent (terms version, price,
 * currency, interval, timestamp) before any provider call, then opens a hosted
 * subscription checkout. Access starts only when the provider reports the
 * first paid invoice.
 */
export async function subscribe(
  organizationId: string,
  input: { planId: string; accountId: string; consent: unknown; idempotencyKey: string },
  provider: PaymentProvider,
  urls: (subscriptionId: string) => { successUrl: string; cancelUrl: string },
  now = new Date()
): Promise<SubscribeResult> {
  if (!isIdempotencyKey(input.idempotencyKey)) throw new DomainError("invalid_idempotency_key");
  const sql = getSqlClient();
  const plan = await getPlan(sql, organizationId, input.planId);
  if (!plan || plan.status !== "active") throw new DomainError("plan_not_found");
  await requirePlanFeatures(organizationId, plan.creatorType, input.accountId);
  if (plan.creatorType === "account" && plan.creatorId === input.accountId) throw new DomainError("forbidden");
  const consent = validateConsent(input.consent, plan);
  const subscription = await sql.begin(async tx => {
    const inserted = await tx<Row[]>`
      INSERT INTO subscriptions (organization_id, plan_id, account_id, consent_terms_version, consent_price_minor, consent_currency,
        consent_interval, consent_at, provider, idempotency_key)
      VALUES (${organizationId}, ${plan.id}, ${input.accountId}, ${consent.termsVersion}, ${plan.priceMinor}, ${plan.currency},
        ${plan.interval}, ${now}, ${provider.name}, ${input.idempotencyKey})
      ON CONFLICT (organization_id, account_id, idempotency_key) DO NOTHING
      RETURNING *
    `;
    if (!inserted[0]) {
      const [existing] = await tx<Row[]>`SELECT * FROM subscriptions WHERE organization_id = ${organizationId} AND account_id = ${input.accountId} AND idempotency_key = ${input.idempotencyKey}`;
      if (!existing || existing.plan_id !== plan.id) throw new DomainError("idempotency_conflict");
      return mapSubscription(existing);
    }
    const sub = mapSubscription(inserted[0]);
    await tx`INSERT INTO subscription_history (organization_id, subscription_id, from_status, to_status, reason)
      VALUES (${organizationId}, ${sub.id}, NULL, 'incomplete', 'consent_recorded')`;
    await recordAudit(tx, {
      organizationId, actorAccountId: input.accountId, action: "subscription.consent_recorded", subjectType: "subscription", subjectId: sub.id,
      details: { planId: plan.id, termsVersion: consent.termsVersion, priceMinor: plan.priceMinor, currency: plan.currency, interval: plan.interval, consentAt: now.toISOString() }
    });
    return sub;
  }).catch((error: unknown) => {
    if ((error as { code?: string }).code === "23505") throw new DomainError("subscription_conflict_exists");
    throw error;
  });
  if (subscription.status !== "incomplete") return { subscription, redirectUrl: null };
  const session = await provider.createSubscriptionCheckout({
    organizationId, subscriptionId: subscription.id, amountMinor: plan.priceMinor, currency: plan.currency, interval: plan.interval,
    description: plan.name, ...urls(subscription.id), idempotencyKey: `subscription-checkout:${subscription.id}`
  });
  await sql`UPDATE subscriptions SET provider_checkout_reference = ${session.reference}, updated_at = now()
    WHERE organization_id = ${organizationId} AND id = ${subscription.id} AND provider_checkout_reference IS NULL`;
  return { subscription, redirectUrl: session.redirectUrl };
}

export async function getSubscription(organizationId: string, subscriptionId: string, sql: Sql = getSqlClient()): Promise<Subscription | null> {
  if (!isUuid(organizationId) || !isUuid(subscriptionId)) return null;
  const [row] = await sql<Row[]>`SELECT * FROM subscriptions WHERE organization_id = ${organizationId} AND id = ${subscriptionId}`;
  return row ? mapSubscription(row) : null;
}

export async function listAccountSubscriptions(organizationId: string, accountId: string): Promise<Subscription[]> {
  const rows = await getSqlClient()<Row[]>`
    SELECT * FROM subscriptions WHERE organization_id = ${organizationId} AND account_id = ${accountId} ORDER BY created_at DESC LIMIT 200
  `;
  return rows.map(mapSubscription);
}

async function lockSubscription(tx: Sql, provider: PaymentProviderName, event: { providerSubscriptionId: string; organizationId: string | null; subscriptionId: string | null }): Promise<Subscription | null> {
  const [byProvider] = await tx<Row[]>`
    SELECT * FROM subscriptions WHERE provider = ${provider} AND provider_subscription_id = ${event.providerSubscriptionId} FOR UPDATE
  `;
  if (byProvider) return mapSubscription(byProvider);
  // First invoice can arrive before checkout.session.completed: fall back to the metadata we set.
  if (!event.organizationId || !event.subscriptionId) return null;
  const [byMetadata] = await tx<Row[]>`
    SELECT * FROM subscriptions WHERE organization_id = ${event.organizationId} AND id = ${event.subscriptionId}
      AND provider = ${provider} AND (provider_subscription_id IS NULL OR provider_subscription_id = ${event.providerSubscriptionId})
    FOR UPDATE
  `;
  return byMetadata ? mapSubscription(byMetadata) : null;
}

/** Subscription lifecycle driven by verified provider events. */
export async function applySubscriptionEvent(tx: Sql, provider: PaymentProviderName, event: PaymentEvent, hooks: PaymentHooks): Promise<EventOutcome> {
  switch (event.kind) {
    case "subscription_checkout_completed": {
      const sub = await getSubscription(event.organizationId, event.subscriptionId, tx);
      if (!sub || sub.provider !== provider) return { outcome: "subscription_not_found", organizationId: null };
      await tx`UPDATE subscriptions SET provider_subscription_id = ${event.providerSubscriptionId}, updated_at = now()
        WHERE organization_id = ${sub.organizationId} AND id = ${sub.id} AND provider_subscription_id IS NULL`;
      return { outcome: "subscription_linked", organizationId: sub.organizationId };
    }
    case "subscription_checkout_expired": {
      const [row] = await tx<Row[]>`SELECT * FROM subscriptions WHERE organization_id = ${event.organizationId} AND id = ${event.subscriptionId} FOR UPDATE`;
      if (!row) return { outcome: "subscription_not_found", organizationId: null };
      const sub = mapSubscription(row);
      if (sub.status !== "incomplete") return { outcome: "ignored", organizationId: sub.organizationId };
      await transition(tx, sub, "expired", "checkout_expired");
      return { outcome: "subscription_expired", organizationId: sub.organizationId };
    }
    case "invoice_paid": {
      const sub = await lockSubscription(tx, provider, event);
      if (!sub) return { outcome: "subscription_not_found", organizationId: null };
      const plan = (await getPlan(tx, sub.organizationId, sub.planId))!;
      const payee = plan.creatorType === "tenant" ? {} : { payeeType: plan.creatorType as "participant" | "account", payeeId: plan.creatorId! };
      const { created } = await recordCapturedPayment(tx, {
        organizationId: sub.organizationId, accountId: sub.accountId, purpose: "subscription", subjectId: sub.id, ...payee,
        description: plan.name, amountMinor: event.amountMinor, currency: event.currency, provider,
        idempotencyKey: `invoice:${event.invoiceId}`.slice(0, 120)
      }, event.paymentReference ?? `invoice:${event.invoiceId}`, hooks);
      if (!created) return { outcome: "duplicate_invoice", organizationId: sub.organizationId };
      if (!canTransitionSubscription(sub.status, "active")) {
        await recordAudit(tx, { organizationId: sub.organizationId, actorAccountId: null, action: "subscription.paid_after_end", subjectType: "subscription", subjectId: sub.id, details: { invoiceId: event.invoiceId } });
        return { outcome: "paid_after_end", organizationId: sub.organizationId };
      }
      const advance = !sub.currentPeriodEnd || event.periodEnd > sub.currentPeriodEnd;
      await transition(tx, sub, "active", sub.status === "incomplete" ? "first_invoice_paid" : "renewed", {
        providerSubscriptionId: event.providerSubscriptionId,
        ...(advance ? { periodStart: event.periodStart, periodEnd: event.periodEnd } : {})
      });
      // content.view bounded to the paid period.
      await issueGrant(tx, {
        organizationId: sub.organizationId, accountId: sub.accountId, eventId: null, capability: "content.view", source: "subscription",
        startsAt: event.periodStart.getTime(), expiresAt: event.periodEnd.getTime(), sourceKind: "subscription", sourceId: sub.id
      });
      return { outcome: "subscription_renewed", organizationId: sub.organizationId };
    }
    case "invoice_payment_failed": {
      const sub = await lockSubscription(tx, provider, event);
      if (!sub) return { outcome: "subscription_not_found", organizationId: null };
      if (sub.status !== "active") return { outcome: "ignored", organizationId: sub.organizationId };
      await transition(tx, sub, "past_due", "invoice_payment_failed");
      return { outcome: "subscription_past_due", organizationId: sub.organizationId };
    }
    case "subscription_ended": {
      const sub = await lockSubscription(tx, provider, event);
      if (!sub) return { outcome: "subscription_not_found", organizationId: null };
      if (sub.status === "cancelled" || sub.status === "expired") return { outcome: "ignored", organizationId: sub.organizationId };
      await transition(tx, sub, endedStatus(sub.status), "provider_ended");
      await truncateGrantsForSource(tx, sub.organizationId, "subscription", sub.id, Date.now());
      return { outcome: "subscription_ended", organizationId: sub.organizationId };
    }
    default:
      return { outcome: "unhandled", organizationId: null };
  }
}

export const subscriptionHooks: PaymentHooks = {
  async onOtherEvent(tx, provider, event, hooks) {
    return applySubscriptionEvent(tx, provider, event, hooks);
  },
  async onRefunded(tx, order, _refund, fullyRefunded) {
    // A fully refunded subscription payment ends the access it bought.
    if (order.purpose === "subscription" && fullyRefunded && order.subjectId) {
      await endGrantsForSource(tx, order.organizationId, "subscription", order.subjectId, "refunded");
    }
  }
};

/**
 * Cancel at period end (default; access continues until the paid period ends)
 * or immediately (access revoked now). The provider is told first; local state
 * changes only after it accepts.
 */
export async function cancelSubscription(
  organizationId: string,
  subscriptionId: string,
  options: { atPeriodEnd: boolean; actorAccountId: string },
  provider: PaymentProvider
): Promise<Subscription> {
  const sub = await getSubscription(organizationId, subscriptionId);
  if (!sub) throw new DomainError("subscription_not_found");
  if (sub.status === "cancelled" || sub.status === "expired") return sub;
  if (sub.providerSubscriptionId) {
    if (sub.provider !== provider.name) throw new DomainError("invalid_state_provider_mismatch");
    await provider.cancelSubscription({
      providerSubscriptionId: sub.providerSubscriptionId, atPeriodEnd: options.atPeriodEnd,
      idempotencyKey: `cancel:${sub.id}:${options.atPeriodEnd ? "period_end" : "now"}`
    });
  }
  return getSqlClient().begin(async tx => {
    const [row] = await tx<Row[]>`SELECT * FROM subscriptions WHERE organization_id = ${organizationId} AND id = ${subscriptionId} FOR UPDATE`;
    const current = mapSubscription(row!);
    if (current.status === "cancelled" || current.status === "expired") return current;
    let result: Subscription;
    if (options.atPeriodEnd && current.status !== "incomplete" && current.providerSubscriptionId) {
      const [updated] = await tx<Row[]>`
        UPDATE subscriptions SET cancel_at_period_end = true, revision = revision + 1, updated_at = now()
        WHERE id = ${subscriptionId} RETURNING *
      `;
      result = mapSubscription(updated!);
    } else {
      result = await transition(tx, current, current.status === "incomplete" ? "expired" : "cancelled", "cancelled_immediately");
      await truncateGrantsForSource(tx, organizationId, "subscription", subscriptionId, Date.now());
    }
    await recordAudit(tx, {
      organizationId, actorAccountId: options.actorAccountId, action: "subscription.cancel_requested", subjectType: "subscription", subjectId: subscriptionId,
      details: { atPeriodEnd: options.atPeriodEnd }
    });
    return result;
  });
}

/** Account is a current supporter of the plan: live subscription, inside a paid period, with an active grant. */
export async function hasActiveSubscription(organizationId: string, accountId: string, planId: string, now = Date.now(), sql: Sql = getSqlClient()): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM subscriptions
    WHERE organization_id = ${organizationId} AND account_id = ${accountId} AND plan_id = ${planId}
      AND status IN ('active', 'past_due') AND current_period_end > ${new Date(now)}
  `;
  if (rows.length === 0) return false;
  return hasActiveGrant(organizationId, accountId, "content.view", null, now, sql, "subscription", rows.map(r => r.id));
}

/** Safety net when provider deletion events never arrive: expire long-lapsed subscriptions. */
export async function expireLapsedSubscriptions(now = new Date(), graceDays = 7, organizationId?: string): Promise<number> {
  const sql = getSqlClient();
  const cutoff = new Date(now.getTime() - graceDays * 86_400_000);
  const rows = await sql<{ organization_id: string; id: string }[]>`
    SELECT organization_id, id FROM subscriptions
    WHERE status IN ('active', 'past_due') AND current_period_end < ${cutoff}
      ${organizationId ? sql`AND organization_id = ${organizationId}` : sql``}
    LIMIT 500
  `;
  let expired = 0;
  for (const row of rows) {
    await sql.begin(async tx => {
      const [locked] = await tx<Row[]>`SELECT * FROM subscriptions WHERE id = ${row.id} FOR UPDATE`;
      const sub = mapSubscription(locked!);
      if ((sub.status === "active" || sub.status === "past_due") && sub.currentPeriodEnd && sub.currentPeriodEnd < cutoff) {
        await transition(tx, sub, "expired", "lapsed_without_renewal");
        expired += 1;
      }
    });
  }
  return expired;
}
