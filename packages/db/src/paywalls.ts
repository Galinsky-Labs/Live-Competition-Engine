import { DomainError, isUuid } from "@live-competition-engine/domain";
import { decideContentAccess, type AccessRule, type ContentAccess, type ContentInput } from "@live-competition-engine/domain/paywalls";
import { recordAudit, type Sql } from "./audit.ts";
import { endGrantsForSource, hasActiveGrant, issueGrant } from "./entitlement-grants.ts";
import { isFeatureEnabled, requireEnabledFeature } from "./feature-guard.ts";
import { getSqlClient } from "./index.ts";
import { createPaymentOrder, startCheckout, type PaymentHooks } from "./payments.ts";
import type { PaymentProvider } from "./providers/payments.ts";
import { hasActiveSubscription } from "./subscriptions.ts";
import type { PurchaseResult } from "./ticketing.ts";

export interface ContentItem {
  id: string;
  organizationId: string;
  creatorType: "tenant" | "participant" | "account";
  creatorId: string | null;
  eventId: string | null;
  kind: "text" | "media";
  mediaId: string | null;
  title: string;
  teaser: string;
  body: string | null;
  accessRule: AccessRule;
  planId: string | null;
  priceMinor: number | null;
  currency: string | null;
  status: "draft" | "published" | "archived";
  createdAt: Date;
}

export interface ContentViewer { accountId: string | null; isManager: boolean }

/** What the API returns: full content or a teaser, plus an offer only when paywalls are enabled. */
export interface ContentView {
  id: string;
  title: string;
  teaser: string;
  kind: "text" | "media";
  creatorType: string;
  creatorId: string | null;
  eventId: string | null;
  access: Exclude<ContentAccess, "hidden">;
  body?: string;
  mediaId?: string;
  offer?: { type: "members" } | { type: "plan"; planId: string } | { type: "purchase"; priceMinor: number; currency: string };
}

type Row = Record<string, unknown>;
const mapItem = (row: Row): ContentItem => ({
  id: row.id as string,
  organizationId: row.organization_id as string,
  creatorType: row.creator_type as ContentItem["creatorType"],
  creatorId: (row.creator_id as string | null) ?? null,
  eventId: (row.event_id as string | null) ?? null,
  kind: row.kind as ContentItem["kind"],
  mediaId: (row.media_id as string | null) ?? null,
  title: row.title as string,
  teaser: row.teaser as string,
  body: (row.body as string | null) ?? null,
  accessRule: row.access_rule as AccessRule,
  planId: (row.plan_id as string | null) ?? null,
  priceMinor: row.price_minor === null ? null : Number(row.price_minor),
  currency: (row.currency as string | null) ?? null,
  status: row.status as ContentItem["status"],
  createdAt: row.created_at as Date
});

/** Fail closed: any evaluation error counts as disabled. */
async function featureOn(context: { organizationId: string; eventId?: string; accountId?: string }): Promise<boolean> {
  try {
    return await isFeatureEnabled("content_paywalls", context);
  } catch {
    return false;
  }
}

/** Paywalls apply only when enabled for the tenant/event and neither the viewer nor the creator account opted out. */
async function paywallsEnabled(item: ContentItem, viewerAccountId: string | null): Promise<boolean> {
  const base = { organizationId: item.organizationId, ...(item.eventId ? { eventId: item.eventId } : {}) };
  if (!(await featureOn({ ...base, ...(viewerAccountId ? { accountId: viewerAccountId } : {}) }))) return false;
  if (item.creatorType === "account" && item.creatorId && item.creatorId !== viewerAccountId) {
    return featureOn({ ...base, accountId: item.creatorId });
  }
  return true;
}

/**
 * Publish an item. Public items need no feature at all (free publishing is
 * always possible); gated items require content_paywalls for the tenant/event/creator.
 */
export async function createContent(organizationId: string, input: ContentInput, actorAccountId: string, status: "draft" | "published" = "published"): Promise<ContentItem> {
  if (input.accessRule !== "public") {
    await requireEnabledFeature("content_paywalls", {
      organizationId, ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.creatorType === "account" ? { accountId: input.creatorId! } : {})
    });
  }
  return getSqlClient().begin(async tx => {
    if (input.creatorType === "participant") {
      const found = await tx`SELECT 1 FROM participants WHERE organization_id = ${organizationId} AND id = ${input.creatorId}`;
      if (found.length !== 1) throw new DomainError("creator_not_found");
    }
    if (input.planId) {
      const [plan] = await tx<{ creator_type: string; creator_id: string | null }[]>`
        SELECT creator_type, creator_id FROM membership_plans WHERE organization_id = ${organizationId} AND id = ${input.planId}`;
      if (!plan) throw new DomainError("plan_not_found");
      if (plan.creator_type !== input.creatorType || plan.creator_id !== input.creatorId) throw new DomainError("forbidden");
    }
    if (input.mediaId) {
      const media = await tx`SELECT 1 FROM media_library WHERE organization_id = ${organizationId} AND id = ${input.mediaId} AND revoked_at IS NULL`;
      if (media.length !== 1) throw new DomainError("media_not_found");
    }
    const [row] = await tx<Row[]>`
      INSERT INTO gated_content (organization_id, creator_type, creator_id, event_id, kind, media_id, title, teaser, body,
        access_rule, plan_id, price_minor, currency, status, created_by_account_id)
      VALUES (${organizationId}, ${input.creatorType}, ${input.creatorId}, ${input.eventId}, ${input.kind}, ${input.mediaId}, ${input.title},
        ${input.teaser}, ${input.body}, ${input.accessRule}, ${input.planId}, ${input.priceMinor}, ${input.currency}, ${status}, ${actorAccountId})
      RETURNING *
    `;
    const item = mapItem(row!);
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "content.published", subjectType: "gated_content", subjectId: item.id,
      details: { accessRule: item.accessRule, planId: item.planId, priceMinor: item.priceMinor, currency: item.currency, status }
    });
    return item;
  }).catch((error: unknown) => {
    if ((error as { code?: string }).code === "23503") throw new DomainError("event_not_found");
    throw error;
  });
}

async function getItem(sql: Sql, organizationId: string, itemId: string): Promise<ContentItem | null> {
  if (!isUuid(organizationId) || !isUuid(itemId)) return null;
  const [row] = await sql<Row[]>`SELECT * FROM gated_content WHERE organization_id = ${organizationId} AND id = ${itemId}`;
  return row ? mapItem(row) : null;
}

async function purchasedOrderIds(sql: Sql, organizationId: string, accountId: string, itemId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM payment_orders
    WHERE organization_id = ${organizationId} AND account_id = ${accountId} AND purpose = 'content' AND subject_id = ${itemId}
      AND status = 'succeeded' AND settlement_status <> 'refunded'
  `;
  return rows.map(r => r.id);
}

async function isSupporterOfCreator(sql: Sql, item: ContentItem, accountId: string, now: number): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    SELECT s.id FROM subscriptions s
    JOIN membership_plans p ON p.organization_id = s.organization_id AND p.id = s.plan_id
    WHERE s.organization_id = ${item.organizationId} AND s.account_id = ${accountId}
      AND s.status IN ('active', 'past_due') AND s.current_period_end > ${new Date(now)}
      AND p.creator_type = ${item.creatorType} AND p.creator_id IS NOT DISTINCT FROM ${item.creatorId}
  `;
  if (rows.length === 0) return false;
  return hasActiveGrant(item.organizationId, accountId, "content.view", null, now, sql, "subscription", rows.map(r => r.id));
}

/** Entitlement-backed access decision for one viewer. */
export async function resolveContentAccess(item: ContentItem, viewer: ContentViewer, now = Date.now()): Promise<{ access: ContentAccess; paywallsEnabled: boolean }> {
  const sql = getSqlClient();
  const enabled = item.accessRule === "public" ? true : await paywallsEnabled(item, viewer.accountId);
  const isOwnerOrManager = viewer.isManager || (item.creatorType === "account" && item.creatorId !== null && item.creatorId === viewer.accountId);
  let isSupporter = false;
  let hasPlan = false;
  let hasPurchase = false;
  if (enabled && viewer.accountId && item.accessRule !== "public" && !isOwnerOrManager) {
    if (item.accessRule === "members") isSupporter = await isSupporterOfCreator(sql, item, viewer.accountId, now);
    if (item.accessRule === "plan") hasPlan = await hasActiveSubscription(item.organizationId, viewer.accountId, item.planId!, now);
    if (item.accessRule === "purchase") {
      const orders = await purchasedOrderIds(sql, item.organizationId, viewer.accountId, item.id);
      hasPurchase = orders.length > 0 && await hasActiveGrant(item.organizationId, viewer.accountId, "content.view", null, now, sql, "payment_order", orders);
    }
  }
  return { access: decideContentAccess({ rule: item.accessRule, paywallsEnabled: enabled, isOwnerOrManager, isSupporter, hasPlan, hasPurchase }), paywallsEnabled: enabled };
}

function project(item: ContentItem, access: Exclude<ContentAccess, "hidden">): ContentView {
  const view: ContentView = {
    id: item.id, title: item.title, teaser: item.teaser, kind: item.kind, creatorType: item.creatorType, creatorId: item.creatorId,
    eventId: item.eventId, access
  };
  if (access === "full") {
    if (item.body !== null) view.body = item.body;
    if (item.mediaId !== null) view.mediaId = item.mediaId;
  } else if (item.accessRule === "members") view.offer = { type: "members" };
  else if (item.accessRule === "plan") view.offer = { type: "plan", planId: item.planId! };
  else if (item.accessRule === "purchase") view.offer = { type: "purchase", priceMinor: item.priceMinor!, currency: item.currency! };
  return view;
}

/** Single item for a viewer: full or teaser; null when hidden or unpublished (404, nothing leaks). */
export async function getContentForViewer(organizationId: string, itemId: string, viewer: ContentViewer): Promise<ContentView | null> {
  const item = await getItem(getSqlClient(), organizationId, itemId);
  if (!item) return null;
  const isOwner = viewer.isManager || (item.creatorType === "account" && item.creatorId === viewer.accountId);
  if (item.status !== "published" && !isOwner) return null;
  const { access } = await resolveContentAccess(item, viewer);
  return access === "hidden" ? null : project(item, access);
}

export async function listContentForViewer(organizationId: string, viewer: ContentViewer, options: { eventId?: string } = {}): Promise<ContentView[]> {
  const sql = getSqlClient();
  const rows = await sql<Row[]>`
    SELECT * FROM gated_content WHERE organization_id = ${organizationId} AND status = 'published'
      ${options.eventId ? sql`AND event_id = ${options.eventId}` : sql``}
    ORDER BY created_at DESC LIMIT 100
  `;
  const views: ContentView[] = [];
  for (const item of rows.map(mapItem)) {
    const { access } = await resolveContentAccess(item, viewer);
    if (access !== "hidden") views.push(project(item, access));
  }
  return views;
}

/** One-off purchase of a "purchase" item; access comes from the content.view grant issued on payment success. */
export async function purchaseContent(
  organizationId: string,
  input: { itemId: string; accountId: string; idempotencyKey: string },
  provider: PaymentProvider,
  urls: (orderId: string) => { successUrl: string; cancelUrl: string }
): Promise<PurchaseResult> {
  const sql = getSqlClient();
  const item = await getItem(sql, organizationId, input.itemId);
  if (!item || item.status !== "published") throw new DomainError("content_not_found");
  if (item.accessRule !== "purchase") throw new DomainError("invalid_state_not_for_sale");
  if (!(await paywallsEnabled(item, input.accountId))) throw new DomainError("feature_disabled");
  if (item.creatorType === "account" && item.creatorId === input.accountId) throw new DomainError("forbidden");
  if ((await purchasedOrderIds(sql, organizationId, input.accountId, item.id)).length > 0) throw new DomainError("content_conflict_already_purchased");
  const payee = item.creatorType === "tenant" ? {} : { payeeType: item.creatorType as "participant" | "account", payeeId: item.creatorId! };
  const { order } = await sql.begin(tx => createPaymentOrder(tx, {
    organizationId, accountId: input.accountId, eventId: item.eventId, purpose: "content", subjectId: item.id, ...payee,
    description: item.title, amountMinor: item.priceMinor!, currency: item.currency!, provider: provider.name, idempotencyKey: input.idempotencyKey
  }));
  if (order.status !== "requires_payment" && order.status !== "processing") return { order, redirectUrl: null };
  const checkout = await startCheckout(organizationId, order.id, provider, urls(order.id));
  return { order: checkout.order, redirectUrl: checkout.redirectUrl };
}

export const contentHooks: PaymentHooks = {
  async onSucceeded(tx, order) {
    if (order.purpose !== "content") return;
    // Item-scoped: the generic LC-09 resolver ignores "purchase" grants; provenance is in entitlement_grant_sources.
    await issueGrant(tx, {
      organizationId: order.organizationId, accountId: order.accountId, eventId: null, capability: "content.view", source: "purchase",
      startsAt: Date.now(), expiresAt: null, sourceKind: "payment_order", sourceId: order.id
    });
  },
  async onRefunded(tx, order, _refund, fullyRefunded) {
    if (order.purpose === "content" && fullyRefunded) await endGrantsForSource(tx, order.organizationId, "payment_order", order.id, "refunded");
  }
};
