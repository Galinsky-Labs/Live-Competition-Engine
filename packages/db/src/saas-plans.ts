import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { featureKeySchema, type FeatureKey } from "@live-competition-engine/config/features";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  addInterval,
  assertSubscriptionTransition,
  classifyPlanChange,
  computeProration,
  evaluateLimit,
  isPlanLimitKey,
  limitViolations,
  nextSubscriptionStep,
  PLAN_LIMIT_KEYS,
  usagePeriodStart,
  validatePlanDefinition,
  type BillingInterval,
  type LimitDecision,
  type LimitViolation,
  type PlanLimitKey,
  type PlanLimits,
  type PlanUsage,
  type SubscriptionStatus
} from "@live-competition-engine/domain/saas-plans";
import { recordAudit, type Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";

/**
 * LC-49 SaaS plan management. Plans are platform-defined and versioned; a published
 * version is immutable (DB trigger). Tenants hold at most one open subscription.
 * Billing collection is LC-51: this module only computes and records amounts.
 */
export interface SaasPlan {
  id: string;
  planKey: string;
  version: number;
  name: string;
  status: "draft" | "published" | "retired";
  currency: string;
  billingInterval: BillingInterval;
  priceMinor: number;
  trialDays: number;
  features: FeatureKey[];
  limits: PlanLimits;
  createdAt: Date;
  publishedAt: Date | null;
  retiredAt: Date | null;
}

export interface TenantSubscription {
  id: string;
  organizationId: string;
  planId: string;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  pendingPlanId: string | null;
  pendingChangeAt: Date | null;
  pendingOverageFlagged: boolean;
  revision: number;
  cancelledAt: Date | null;
}

export interface SubscriptionChange {
  id: string;
  kind: string;
  fromPlanId: string | null;
  toPlanId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  currency: string | null;
  chargeMinor: number;
  creditMinor: number;
  netMinor: number;
  details: Record<string, unknown>;
  createdAt: Date;
}

interface PlanRow {
  id: string; plan_key: string; version: number; name: string; status: SaasPlan["status"];
  currency: string; billing_interval: BillingInterval; price_minor: string; trial_days: number;
  features: FeatureKey[]; limits: PlanLimits; created_at: Date; published_at: Date | null; retired_at: Date | null;
}

interface SubscriptionRow {
  id: string; organization_id: string; plan_id: string; status: SubscriptionStatus; trial_ends_at: Date | null;
  current_period_start: Date; current_period_end: Date; pending_plan_id: string | null;
  pending_change_at: Date | null; pending_overage_flagged: boolean; revision: number; cancelled_at: Date | null;
}

interface ChangeRow {
  id: string; kind: string; from_plan_id: string | null; to_plan_id: string | null; from_status: string | null;
  to_status: string | null; currency: string | null; charge_minor: string; credit_minor: string; net_minor: string;
  details: Record<string, unknown>; created_at: Date;
}

const toPlan = (r: PlanRow): SaasPlan => ({
  id: r.id, planKey: r.plan_key, version: r.version, name: r.name, status: r.status, currency: r.currency,
  billingInterval: r.billing_interval, priceMinor: Number(r.price_minor), trialDays: r.trial_days,
  features: r.features, limits: r.limits, createdAt: r.created_at, publishedAt: r.published_at, retiredAt: r.retired_at
});

const toSubscription = (r: SubscriptionRow): TenantSubscription => ({
  id: r.id, organizationId: r.organization_id, planId: r.plan_id, status: r.status, trialEndsAt: r.trial_ends_at,
  currentPeriodStart: r.current_period_start, currentPeriodEnd: r.current_period_end,
  pendingPlanId: r.pending_plan_id, pendingChangeAt: r.pending_change_at,
  pendingOverageFlagged: r.pending_overage_flagged, revision: r.revision, cancelledAt: r.cancelled_at
});

const toChange = (r: ChangeRow): SubscriptionChange => ({
  id: r.id, kind: r.kind, fromPlanId: r.from_plan_id, toPlanId: r.to_plan_id, fromStatus: r.from_status,
  toStatus: r.to_status, currency: r.currency, chargeMinor: Number(r.charge_minor),
  creditMinor: Number(r.credit_minor), netMinor: Number(r.net_minor), details: r.details, createdAt: r.created_at
});

const PLAN_COLUMNS = (sql: Sql) => sql`
  id, plan_key, version, name, status, currency, billing_interval, price_minor::text AS price_minor,
  trial_days, features, limits, created_at, published_at, retired_at
`;

const isFeatureKey = (value: string) => featureKeySchema.safeParse(value).success;
const IDEMPOTENCY = /^[A-Za-z0-9_.:-]{8,128}$/;

export function assertIdempotencyKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !IDEMPOTENCY.test(value)) throw new DomainError("invalid_idempotency_key");
}

// ---------------------------------------------------------------- plans (platform)

export async function createPlanVersion(actorAccountId: string, input: unknown): Promise<SaasPlan> {
  const plan = validatePlanDefinition(input, isFeatureKey);
  return getSqlClient().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"saas_plan:" + plan.planKey}, 0))`;
    const [versionRow] = await tx<{ next: number }[]>`
      SELECT COALESCE(MAX(version), 0) + 1 AS next FROM saas_plans WHERE plan_key = ${plan.planKey}
    `;
    const next = versionRow!.next;
    const id = randomUUID();
    const [row] = await tx<PlanRow[]>`
      INSERT INTO saas_plans (id, plan_key, version, name, currency, billing_interval, price_minor,
        trial_days, features, limits, created_by_account_id)
      VALUES (${id}, ${plan.planKey}, ${next}, ${plan.name}, ${plan.currency}, ${plan.billingInterval},
        ${plan.priceMinor}, ${plan.trialDays}, ${tx.json(plan.features)}, ${tx.json(plan.limits as postgres.JSONValue)},
        ${actorAccountId})
      RETURNING ${PLAN_COLUMNS(tx)}
    `;
    await recordAudit(tx, {
      organizationId: null, actorAccountId, action: "saas_plan.created", subjectType: "saas_plan", subjectId: id,
      details: { planKey: plan.planKey, version: next, priceMinor: plan.priceMinor, currency: plan.currency }
    });
    return toPlan(row!);
  });
}

async function transitionPlan(actorAccountId: string, planId: string, to: "published" | "retired"): Promise<SaasPlan> {
  if (!isUuid(planId)) throw new DomainError("plan_not_found");
  return getSqlClient().begin(async tx => {
    const [current] = await tx<{ status: string }[]>`SELECT status FROM saas_plans WHERE id = ${planId} FOR UPDATE`;
    if (!current) throw new DomainError("plan_not_found");
    const allowed = to === "published" ? current.status === "draft" : current.status === "published";
    if (!allowed) throw new DomainError("invalid_state_plan_transition");
    const [row] = to === "published"
      ? await tx<PlanRow[]>`UPDATE saas_plans SET status = 'published', published_at = now() WHERE id = ${planId} RETURNING ${PLAN_COLUMNS(tx)}`
      : await tx<PlanRow[]>`UPDATE saas_plans SET status = 'retired', retired_at = now() WHERE id = ${planId} RETURNING ${PLAN_COLUMNS(tx)}`;
    await recordAudit(tx, {
      organizationId: null, actorAccountId, action: `saas_plan.${to}`, subjectType: "saas_plan", subjectId: planId,
      details: { planKey: row!.plan_key, version: row!.version }
    });
    return toPlan(row!);
  });
}

export const publishPlan = (actorAccountId: string, planId: string) => transitionPlan(actorAccountId, planId, "published");
/** Retired versions accept no new subscriptions; existing subscribers keep their version (grandfathered). */
export const retirePlan = (actorAccountId: string, planId: string) => transitionPlan(actorAccountId, planId, "retired");

export async function listPlans(filter: { status?: SaasPlan["status"] } = {}): Promise<SaasPlan[]> {
  const sql = getSqlClient();
  const rows = await sql<PlanRow[]>`
    SELECT ${PLAN_COLUMNS(sql)} FROM saas_plans
    ${filter.status ? sql`WHERE status = ${filter.status}` : sql``}
    ORDER BY plan_key, version DESC LIMIT 500
  `;
  return rows.map(toPlan);
}

export async function getPlan(planId: string, sql: Sql = getSqlClient()): Promise<SaasPlan | null> {
  if (!isUuid(planId)) return null;
  const [row] = await sql<PlanRow[]>`SELECT ${PLAN_COLUMNS(sql)} FROM saas_plans WHERE id = ${planId}`;
  return row ? toPlan(row) : null;
}

/** Latest published version of a plan key (used by signup to start a trial). */
export async function getPublishedPlanByKey(planKey: string, sql: Sql = getSqlClient()): Promise<SaasPlan | null> {
  const [row] = await sql<PlanRow[]>`
    SELECT ${PLAN_COLUMNS(sql)} FROM saas_plans WHERE plan_key = ${planKey} AND status = 'published'
    ORDER BY version DESC LIMIT 1
  `;
  return row ? toPlan(row) : null;
}

// ---------------------------------------------------------------- usage

/** Current usage for every limit key. Gauges are read from authoritative tables. */
export async function measureUsage(organizationId: string, sql: Sql = getSqlClient(), now = new Date()): Promise<Required<PlanUsage>> {
  const monthStart = usagePeriodStart(now);
  const [row] = await sql<{ events: string; members: string; domains: string; storage: string }[]>`
    SELECT
      (SELECT count(*) FROM competitions WHERE organization_id = ${organizationId} AND created_at >= ${monthStart})::text AS events,
      (SELECT count(*) FROM organization_memberships WHERE organization_id = ${organizationId} AND status = 'active')::text AS members,
      (SELECT count(*) FROM organization_domains WHERE organization_id = ${organizationId} AND status <> 'disabled')::text AS domains,
      (SELECT COALESCE(SUM(quantity), 0) FROM usage_records WHERE organization_id = ${organizationId} AND metric = 'storage_bytes')::text AS storage
  `;
  return {
    max_events_per_month: Number(row!.events),
    max_members: Number(row!.members),
    max_custom_domains: Number(row!.domains),
    max_storage_bytes: Math.max(Number(row!.storage), 0)
  };
}

export interface UsageInput {
  metric: string;
  quantity: number;
  idempotencyKey: string;
  source: string;
  occurredAt?: Date;
}

/** Append a usage record. Replays with the same key and payload are no-ops; a different payload conflicts. */
export async function recordUsage(organizationId: string, input: UsageInput, sql: Sql = getSqlClient()): Promise<{ id: string; recorded: boolean }> {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(input.metric)) throw new DomainError("invalid_usage_metric");
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(input.source)) throw new DomainError("invalid_usage_source");
  if (!Number.isSafeInteger(input.quantity) || input.quantity === 0) throw new DomainError("invalid_usage_quantity");
  assertIdempotencyKey(input.idempotencyKey);
  const occurredAt = input.occurredAt ?? new Date();
  const period = usagePeriodStart(occurredAt).toISOString().slice(0, 10);
  const id = randomUUID();
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO usage_records (id, organization_id, metric, quantity, occurred_at, period_start, source, idempotency_key)
    VALUES (${id}, ${organizationId}, ${input.metric}, ${input.quantity}, ${occurredAt}, ${period}, ${input.source}, ${input.idempotencyKey})
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING
    RETURNING id
  `;
  if (inserted.length === 1) return { id, recorded: true };
  const [existing] = await sql<{ id: string; metric: string; quantity: string }[]>`
    SELECT id, metric, quantity::text FROM usage_records
    WHERE organization_id = ${organizationId} AND idempotency_key = ${input.idempotencyKey}
  `;
  if (!existing || existing.metric !== input.metric || Number(existing.quantity) !== input.quantity) {
    throw new DomainError("usage_idempotency_conflict");
  }
  return { id: existing.id, recorded: false };
}

export interface UsageAggregate {
  periodStart: string;
  metrics: Record<string, { total: number; records: number }>;
}

export async function aggregateUsage(organizationId: string, periodStart: Date, sql: Sql = getSqlClient()): Promise<UsageAggregate> {
  const period = usagePeriodStart(periodStart).toISOString().slice(0, 10);
  const rows = await sql<{ metric: string; total: string; records: string }[]>`
    SELECT metric, SUM(quantity)::text AS total, count(*)::text AS records
    FROM usage_records WHERE organization_id = ${organizationId} AND period_start = ${period}
    GROUP BY metric ORDER BY metric
  `;
  return {
    periodStart: period,
    metrics: Object.fromEntries(rows.map(r => [r.metric, { total: Number(r.total), records: Number(r.records) }]))
  };
}

// ---------------------------------------------------------------- entitlement checks

export interface PlanLimitDecision extends LimitDecision {
  limitKey: PlanLimitKey;
  reason: "within_limit" | "limit_exceeded" | "no_active_subscription";
  planId: string | null;
}

async function openSubscriptionWithPlan(organizationId: string, sql: Sql, lock: boolean) {
  const [row] = lock
    ? await sql<(SubscriptionRow & { limits: PlanLimits; features: FeatureKey[] })[]>`
        SELECT s.*, p.limits, p.features FROM tenant_subscriptions s JOIN saas_plans p ON p.id = s.plan_id
        WHERE s.organization_id = ${organizationId} AND s.status <> 'cancelled' FOR UPDATE OF s`
    : await sql<(SubscriptionRow & { limits: PlanLimits; features: FeatureKey[] })[]>`
        SELECT s.*, p.limits, p.features FROM tenant_subscriptions s JOIN saas_plans p ON p.id = s.plan_id
        WHERE s.organization_id = ${organizationId} AND s.status <> 'cancelled'`;
  return row ?? null;
}

/**
 * Entitlement check other modules call before consuming a limited resource.
 * Fail closed: no open subscription means nothing is allowed. Pass the caller's
 * transaction as `options.sql` to serialize concurrent consumers of the same limit
 * (a per-tenant, per-limit advisory lock is taken) and insert the resource in that
 * same transaction. `past_due` keeps entitlements during dunning (LC-51 decides cut-off).
 */
export async function checkPlanLimit(
  organizationId: string,
  limitKey: PlanLimitKey,
  increment = 1,
  options: { sql?: Sql; now?: Date } = {}
): Promise<PlanLimitDecision> {
  if (!isPlanLimitKey(limitKey)) throw new DomainError("invalid_limit_key");
  const sql = options.sql ?? getSqlClient();
  if (options.sql) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`plan_limit:${organizationId}:${limitKey}`}, 0))`;
  }
  const subscription = await openSubscriptionWithPlan(organizationId, sql, false);
  const usage = await measureUsage(organizationId, sql, options.now);
  const current = usage[limitKey];
  if (!subscription) {
    return { limitKey, allowed: false, reason: "no_active_subscription", planId: null, limit: 0, current, requested: increment, remaining: 0 };
  }
  const decision = evaluateLimit(subscription.limits, limitKey, current, increment);
  return { ...decision, limitKey, reason: decision.allowed ? "within_limit" : "limit_exceeded", planId: subscription.plan_id };
}

/** Throwing variant: DomainError("plan_limit_exceeded") or ("no_active_subscription"). */
export async function assertPlanLimit(organizationId: string, limitKey: PlanLimitKey, increment = 1, options: { sql?: Sql; now?: Date } = {}) {
  const decision = await checkPlanLimit(organizationId, limitKey, increment, options);
  if (!decision.allowed) throw new DomainError(decision.reason === "no_active_subscription" ? "no_active_subscription" : "plan_limit_exceeded");
  return decision;
}

/** Plan allowance for an LC-08 feature family. LC-08 flags must ALSO be enabled; this never enables a flag. */
export async function planAllowsFeature(organizationId: string, feature: FeatureKey, sql: Sql = getSqlClient()): Promise<boolean> {
  const subscription = await openSubscriptionWithPlan(organizationId, sql, false);
  return Boolean(subscription && subscription.features.includes(feature));
}

// ---------------------------------------------------------------- subscriptions

async function insertChange(tx: Sql, organizationId: string, subscriptionId: string, change: {
  kind: string; fromPlanId?: string | null; toPlanId?: string | null; fromStatus?: string | null; toStatus?: string | null;
  currency?: string | null; chargeMinor?: number; creditMinor?: number; netMinor?: number;
  details?: Record<string, unknown>; actorAccountId: string | null; idempotencyKey?: string | null;
}): Promise<SubscriptionChange> {
  const [row] = await tx<ChangeRow[]>`
    INSERT INTO tenant_subscription_changes (id, organization_id, subscription_id, kind, from_plan_id, to_plan_id,
      from_status, to_status, currency, charge_minor, credit_minor, net_minor, details, actor_account_id, idempotency_key)
    VALUES (${randomUUID()}, ${organizationId}, ${subscriptionId}, ${change.kind}, ${change.fromPlanId ?? null},
      ${change.toPlanId ?? null}, ${change.fromStatus ?? null}, ${change.toStatus ?? null}, ${change.currency ?? null},
      ${change.chargeMinor ?? 0}, ${change.creditMinor ?? 0}, ${change.netMinor ?? 0},
      ${tx.json((change.details ?? {}) as postgres.JSONValue)}, ${change.actorAccountId}, ${change.idempotencyKey ?? null})
    RETURNING id, kind, from_plan_id, to_plan_id, from_status, to_status, currency, charge_minor::text,
      credit_minor::text, net_minor::text, details, created_at
  `;
  return toChange(row!);
}

async function replay(tx: Sql, organizationId: string, idempotencyKey: string) {
  const [row] = await tx<(ChangeRow & { subscription_id: string })[]>`
    SELECT id, subscription_id, kind, from_plan_id, to_plan_id, from_status, to_status, currency, charge_minor::text,
      credit_minor::text, net_minor::text, details, created_at
    FROM tenant_subscription_changes WHERE organization_id = ${organizationId} AND idempotency_key = ${idempotencyKey}
  `;
  if (!row) return null;
  const [sub] = await tx<SubscriptionRow[]>`SELECT * FROM tenant_subscriptions WHERE organization_id = ${organizationId} AND id = ${row.subscription_id}`;
  return { subscription: toSubscription(sub!), change: toChange(row), replayed: true as const };
}

export interface SubscriptionResult {
  subscription: TenantSubscription;
  change: SubscriptionChange;
  replayed: boolean;
}

/**
 * Start a subscription on a published plan. Trial plans start `trialing`; others start
 * `active` with the first period's charge exposed on the change record for LC-51.
 * Pass `tx` to run inside a caller's transaction (signup).
 */
export async function startSubscription(
  organizationId: string,
  actorAccountId: string,
  input: { planId: string; idempotencyKey: string },
  now = new Date(),
  tx?: Sql
): Promise<SubscriptionResult> {
  assertIdempotencyKey(input.idempotencyKey);
  if (!isUuid(input.planId)) throw new DomainError("plan_not_found");
  const run = async (tx: Sql): Promise<SubscriptionResult> => {
    const [org] = await tx`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`;
    if (!org) throw new DomainError("organization_not_found");
    const replayed = await replay(tx, organizationId, input.idempotencyKey);
    if (replayed) return replayed;
    const plan = await getPlan(input.planId, tx);
    if (!plan || plan.status !== "published") throw new DomainError("plan_not_found");
    const [open] = await tx`SELECT id FROM tenant_subscriptions WHERE organization_id = ${organizationId} AND status <> 'cancelled'`;
    if (open) throw new DomainError("subscription_conflict");
    const trialing = plan.trialDays > 0;
    const periodStart = now;
    const periodEnd = trialing ? new Date(now.getTime() + plan.trialDays * 86_400_000) : addInterval(now, plan.billingInterval);
    const id = randomUUID();
    const [row] = await tx<SubscriptionRow[]>`
      INSERT INTO tenant_subscriptions (id, organization_id, plan_id, status, trial_ends_at, current_period_start, current_period_end, created_at, updated_at)
      VALUES (${id}, ${organizationId}, ${plan.id}, ${trialing ? "trialing" : "active"}, ${trialing ? periodEnd : null},
        ${periodStart}, ${periodEnd}, ${now}, ${now})
      RETURNING *
    `;
    const change = await insertChange(tx, organizationId, id, {
      kind: "started", toPlanId: plan.id, toStatus: row!.status, currency: plan.currency,
      chargeMinor: trialing ? 0 : plan.priceMinor, netMinor: trialing ? 0 : plan.priceMinor,
      details: { trialDays: plan.trialDays }, actorAccountId, idempotencyKey: input.idempotencyKey
    });
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "subscription.started", subjectType: "tenant_subscription", subjectId: id,
      details: { planId: plan.id, planKey: plan.planKey, version: plan.version, status: row!.status }
    });
    return { subscription: toSubscription(row!), change, replayed: false };
  };
  return tx ? run(tx) : getSqlClient().begin(run);
}

export async function getSubscription(organizationId: string): Promise<{ subscription: TenantSubscription; plan: SaasPlan; pendingPlan: SaasPlan | null; changes: SubscriptionChange[] } | null> {
  const sql = getSqlClient();
  const [row] = await sql<SubscriptionRow[]>`
    SELECT * FROM tenant_subscriptions WHERE organization_id = ${organizationId}
    ORDER BY (status <> 'cancelled') DESC, created_at DESC LIMIT 1
  `;
  if (!row) return null;
  const changes = await sql<ChangeRow[]>`
    SELECT id, kind, from_plan_id, to_plan_id, from_status, to_status, currency, charge_minor::text,
      credit_minor::text, net_minor::text, details, created_at
    FROM tenant_subscription_changes WHERE organization_id = ${organizationId} AND subscription_id = ${row.id}
    ORDER BY created_at DESC, id LIMIT 50
  `;
  const plan = await getPlan(row.plan_id, sql);
  const pendingPlan = row.pending_plan_id ? await getPlan(row.pending_plan_id, sql) : null;
  return { subscription: toSubscription(row), plan: plan!, pendingPlan, changes: changes.map(toChange) };
}

export type PlanChangeResult =
  | (SubscriptionResult & { outcome: "applied" | "scheduled" })
  | { outcome: "blocked"; violations: LimitViolation[] };

/**
 * Change plan. Upgrades/lateral moves apply immediately with a prorated amount; downgrades
 * are scheduled for period end. Trial subscriptions change immediately with no charge.
 * Any change whose limits current usage exceeds is blocked; a downgrade may instead be
 * scheduled with `acknowledgeOverage` (flagged, re-checked when applied).
 */
export async function changePlan(
  organizationId: string,
  actorAccountId: string,
  input: { planId: string; idempotencyKey: string; acknowledgeOverage?: boolean },
  now = new Date()
): Promise<PlanChangeResult> {
  assertIdempotencyKey(input.idempotencyKey);
  if (!isUuid(input.planId)) throw new DomainError("plan_not_found");
  return getSqlClient().begin(async tx => {
    const current = await openSubscriptionWithPlan(organizationId, tx, true);
    const replayed = await replay(tx, organizationId, input.idempotencyKey);
    if (replayed) return { ...replayed, outcome: replayed.change.kind === "downgrade_scheduled" ? "scheduled" as const : "applied" as const };
    if (!current) throw new DomainError("subscription_not_found");
    if (current.plan_id === input.planId) throw new DomainError("plan_change_noop");
    const from = (await getPlan(current.plan_id, tx))!;
    const to = await getPlan(input.planId, tx);
    if (!to || to.status !== "published") throw new DomainError("plan_not_found");
    const kind = classifyPlanChange(from, to);
    const violations = limitViolations(await measureUsage(organizationId, tx, now), to.limits);
    const immediate = kind !== "downgrade" || current.status === "trialing";

    if (immediate) {
      if (violations.length) return { outcome: "blocked" as const, violations };
      const proration = current.status === "trialing"
        ? { creditMinor: 0, chargeMinor: 0, netMinor: 0 }
        : computeProration({
            fromPriceMinor: from.priceMinor, toPriceMinor: to.priceMinor,
            periodStart: current.current_period_start, periodEnd: current.current_period_end, changeAt: now
          });
      const [row] = await tx<SubscriptionRow[]>`
        UPDATE tenant_subscriptions SET plan_id = ${to.id}, pending_plan_id = NULL, pending_change_at = NULL,
          pending_overage_flagged = false, revision = revision + 1, updated_at = ${now}
        WHERE id = ${current.id} AND organization_id = ${organizationId} AND revision = ${current.revision}
        RETURNING *
      `;
      if (!row) throw new DomainError("subscription_revision_conflict");
      const change = await insertChange(tx, organizationId, current.id, {
        kind: "upgraded", fromPlanId: from.id, toPlanId: to.id, fromStatus: current.status, toStatus: current.status,
        currency: to.currency, chargeMinor: proration.chargeMinor, creditMinor: proration.creditMinor, netMinor: proration.netMinor,
        details: { classification: kind, trial: current.status === "trialing" }, actorAccountId, idempotencyKey: input.idempotencyKey
      });
      await recordAudit(tx, {
        organizationId, actorAccountId, action: "subscription.plan_changed", subjectType: "tenant_subscription", subjectId: current.id,
        details: { fromPlanId: from.id, toPlanId: to.id, netMinor: proration.netMinor, currency: to.currency }
      });
      return { outcome: "applied" as const, subscription: toSubscription(row), change, replayed: false };
    }

    if (violations.length && !input.acknowledgeOverage) return { outcome: "blocked" as const, violations };
    const [row] = await tx<SubscriptionRow[]>`
      UPDATE tenant_subscriptions SET pending_plan_id = ${to.id}, pending_change_at = current_period_end,
        pending_overage_flagged = ${violations.length > 0}, revision = revision + 1, updated_at = ${now}
      WHERE id = ${current.id} AND organization_id = ${organizationId} AND revision = ${current.revision}
      RETURNING *
    `;
    if (!row) throw new DomainError("subscription_revision_conflict");
    const change = await insertChange(tx, organizationId, current.id, {
      kind: "downgrade_scheduled", fromPlanId: from.id, toPlanId: to.id, fromStatus: current.status, toStatus: current.status,
      currency: to.currency, details: { effectiveAt: row.pending_change_at!.toISOString(), overage: violations },
      actorAccountId, idempotencyKey: input.idempotencyKey
    });
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "subscription.downgrade_scheduled", subjectType: "tenant_subscription", subjectId: current.id,
      details: { fromPlanId: from.id, toPlanId: to.id, overageFlagged: violations.length > 0 }
    });
    return { outcome: "scheduled" as const, subscription: toSubscription(row), change, replayed: false };
  });
}

export async function cancelPendingDowngrade(organizationId: string, actorAccountId: string): Promise<TenantSubscription> {
  return getSqlClient().begin(async tx => {
    const current = await openSubscriptionWithPlan(organizationId, tx, true);
    if (!current) throw new DomainError("subscription_not_found");
    if (!current.pending_plan_id) throw new DomainError("invalid_state_no_pending_change");
    const [row] = await tx<SubscriptionRow[]>`
      UPDATE tenant_subscriptions SET pending_plan_id = NULL, pending_change_at = NULL, pending_overage_flagged = false,
        revision = revision + 1, updated_at = now()
      WHERE id = ${current.id} AND organization_id = ${organizationId} RETURNING *
    `;
    await insertChange(tx, organizationId, current.id, {
      kind: "downgrade_cancelled", fromPlanId: current.plan_id, toPlanId: current.pending_plan_id, actorAccountId
    });
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "subscription.downgrade_cancelled", subjectType: "tenant_subscription", subjectId: current.id
    });
    return toSubscription(row!);
  });
}

/** Status transitions driven by billing (LC-51) or platform operators: active / past_due / cancelled. */
export async function setSubscriptionStatus(
  organizationId: string,
  actorAccountId: string | null,
  to: SubscriptionStatus,
  options: { expectedRevision?: number; reason?: string; now?: Date } = {}
): Promise<TenantSubscription> {
  const now = options.now ?? new Date();
  return getSqlClient().begin(async tx => {
    const current = await openSubscriptionWithPlan(organizationId, tx, true);
    if (!current) throw new DomainError("subscription_not_found");
    if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
      throw new DomainError("subscription_revision_conflict");
    }
    assertSubscriptionTransition(current.status, to);
    const [row] = await tx<SubscriptionRow[]>`
      UPDATE tenant_subscriptions SET status = ${to}, revision = revision + 1, updated_at = ${now},
        cancelled_at = ${to === "cancelled" ? now : null},
        pending_plan_id = ${to === "cancelled" ? null : current.pending_plan_id},
        pending_change_at = ${to === "cancelled" ? null : current.pending_change_at}
      WHERE id = ${current.id} AND organization_id = ${organizationId} RETURNING *
    `;
    await insertChange(tx, organizationId, current.id, {
      kind: to === "cancelled" ? "cancelled" : "status_changed", fromStatus: current.status, toStatus: to,
      fromPlanId: current.plan_id, details: options.reason ? { reason: options.reason.slice(0, 500) } : {}, actorAccountId
    });
    await recordAudit(tx, {
      organizationId, actorAccountId, action: to === "cancelled" ? "subscription.cancelled" : "subscription.status_changed",
      subjectType: "tenant_subscription", subjectId: current.id, details: { from: current.status, to }
    });
    return toSubscription(row!);
  });
}

/**
 * Apply every lifecycle step due at `now` (trial end, scheduled downgrade, renewal),
 * bounded to 24 steps per call. Intended for a scheduled worker; safe to run concurrently
 * (row lock) and idempotent (no step is due twice).
 */
export async function advanceSubscription(organizationId: string, now = new Date()): Promise<SubscriptionChange[]> {
  return getSqlClient().begin(async tx => {
    const applied: SubscriptionChange[] = [];
    for (let i = 0; i < 24; i++) {
      const current = await openSubscriptionWithPlan(organizationId, tx, true);
      if (!current) break;
      const plan = (await getPlan(current.plan_id, tx))!;
      const pending = current.pending_plan_id ? await getPlan(current.pending_plan_id, tx) : null;
      const step = nextSubscriptionStep({
        status: current.status, planPriceMinor: plan.priceMinor, billingInterval: plan.billingInterval,
        trialEndsAt: current.trial_ends_at, currentPeriodStart: current.current_period_start,
        currentPeriodEnd: current.current_period_end,
        pendingPlan: pending ? { id: pending.id, priceMinor: pending.priceMinor } : null
      }, now);
      if (!step) break;
      let details: Record<string, unknown> = {};
      if (step.kind === "downgrade_applied") {
        const overage = limitViolations(await measureUsage(organizationId, tx, now), pending!.limits);
        details = { overage };
      }
      const nextPlanId = step.kind === "downgrade_applied" ? step.planId : current.plan_id;
      const nextStatus = step.kind === "trial_ended" ? step.toStatus : current.status;
      if (step.kind === "trial_ended") assertSubscriptionTransition(current.status, nextStatus);
      await tx`
        UPDATE tenant_subscriptions SET plan_id = ${nextPlanId}, status = ${nextStatus},
          current_period_start = ${step.periodStart}, current_period_end = ${step.periodEnd},
          pending_plan_id = NULL, pending_change_at = NULL, pending_overage_flagged = false,
          revision = revision + 1, updated_at = ${now}
        WHERE id = ${current.id} AND organization_id = ${organizationId}
      `;
      const currency = (pending ?? plan).currency;
      const change = await insertChange(tx, organizationId, current.id, {
        kind: step.kind, fromPlanId: current.plan_id, toPlanId: nextPlanId, fromStatus: current.status, toStatus: nextStatus,
        currency, chargeMinor: step.chargeMinor, netMinor: step.chargeMinor,
        details: { ...details, periodStart: step.periodStart.toISOString(), periodEnd: step.periodEnd.toISOString() },
        actorAccountId: null
      });
      await recordAudit(tx, {
        organizationId, actorAccountId: null, action: `subscription.${step.kind}`, subjectType: "tenant_subscription",
        subjectId: current.id, details: { toPlanId: nextPlanId, chargeMinor: step.chargeMinor, currency }
      });
      applied.push(change);
    }
    return applied;
  });
}

export { PLAN_LIMIT_KEYS };
