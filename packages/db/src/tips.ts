import { DomainError, isBoundedText, isUuid } from "@live-competition-engine/domain";
import { normalizeCurrency } from "@live-competition-engine/domain/money";
import { isIdempotencyKey } from "@live-competition-engine/domain/payments";
import {
  assertQuoteAccepted,
  assertTipAmount,
  assertVelocity,
  DEFAULT_TIP_POLICY,
  feeBreakdown,
  type FeeBreakdown,
  type TipPolicy
} from "@live-competition-engine/domain/tips";
import { recordAudit, type Sql } from "./audit.ts";
import { isFeatureEnabled, requireEnabledFeature } from "./feature-guard.ts";
import { getSqlClient } from "./index.ts";
import { createPaymentOrder, startCheckout } from "./payments.ts";
import type { PaymentProvider } from "./providers/payments.ts";
import { quoteSplit } from "./revenue-splits.ts";
import type { PurchaseResult } from "./ticketing.ts";

export interface Gift { id: string; name: string; priceMinor: number; currency: string; active: boolean; revision: number }

type Row = Record<string, unknown>;
const mapGift = (row: Row): Gift => ({
  id: row.id as string, name: row.name as string, priceMinor: Number(row.price_minor), currency: row.currency as string,
  active: row.active as boolean, revision: Number(row.revision)
});

export async function createGift(organizationId: string, input: { name: unknown; priceMinor: unknown; currency: unknown }, actorAccountId: string): Promise<Gift> {
  await requireEnabledFeature("tips_gifts", { organizationId });
  if (!isBoundedText(input.name, 80, 1) || !input.name.trim()) throw new DomainError("invalid_name");
  if (!Number.isSafeInteger(input.priceMinor) || (input.priceMinor as number) <= 0) throw new DomainError("invalid_amount");
  const currency = normalizeCurrency(input.currency);
  return getSqlClient().begin(async tx => {
    const [row] = await tx<Row[]>`
      INSERT INTO gift_catalog (organization_id, name, price_minor, currency, created_by_account_id)
      VALUES (${organizationId}, ${input.name as string}, ${input.priceMinor as number}, ${currency}, ${actorAccountId}) RETURNING *
    `;
    await recordAudit(tx, { organizationId, actorAccountId, action: "tips.gift_created", subjectType: "gift", subjectId: row!.id as string, details: { priceMinor: input.priceMinor, currency } });
    return mapGift(row!);
  });
}

/** Catalog for a viewer; empty (no prices) when tips_gifts is disabled for the tenant/event/account. */
export async function listGifts(organizationId: string, context: { eventId?: string; accountId?: string } = {}): Promise<Gift[]> {
  if (!(await isFeatureEnabled("tips_gifts", { organizationId, ...context }))) return [];
  const rows = await getSqlClient()<Row[]>`SELECT * FROM gift_catalog WHERE organization_id = ${organizationId} AND active ORDER BY price_minor, name LIMIT 100`;
  return rows.map(mapGift);
}

export async function getTipPolicy(organizationId: string, sql: Sql = getSqlClient()): Promise<TipPolicy> {
  const [row] = await sql<Row[]>`SELECT * FROM tip_policies WHERE organization_id = ${organizationId}`;
  if (!row) return DEFAULT_TIP_POLICY;
  return {
    minMinor: Number(row.min_minor), maxMinor: Number(row.max_minor), windowSeconds: Number(row.window_seconds),
    maxCountPerWindow: Number(row.max_count_per_window), maxAmountPerWindowMinor: Number(row.max_amount_per_window_minor)
  };
}

export async function setTipPolicy(organizationId: string, policy: TipPolicy, actorAccountId: string): Promise<TipPolicy> {
  return getSqlClient().begin(async tx => {
    await tx`
      INSERT INTO tip_policies (organization_id, min_minor, max_minor, window_seconds, max_count_per_window, max_amount_per_window_minor, updated_by_account_id)
      VALUES (${organizationId}, ${policy.minMinor}, ${policy.maxMinor}, ${policy.windowSeconds}, ${policy.maxCountPerWindow}, ${policy.maxAmountPerWindowMinor}, ${actorAccountId})
      ON CONFLICT (organization_id) DO UPDATE SET min_minor = EXCLUDED.min_minor, max_minor = EXCLUDED.max_minor,
        window_seconds = EXCLUDED.window_seconds, max_count_per_window = EXCLUDED.max_count_per_window,
        max_amount_per_window_minor = EXCLUDED.max_amount_per_window_minor, revision = tip_policies.revision + 1,
        updated_by_account_id = EXCLUDED.updated_by_account_id, updated_at = now()
    `;
    await recordAudit(tx, { organizationId, actorAccountId, action: "tips.policy_updated", subjectType: "tip_policy", subjectId: organizationId, details: { ...policy } });
    return policy;
  });
}

/** Link a participant to the member account that receives their payouts. */
export async function linkParticipantPayoutAccount(organizationId: string, participantId: string, accountId: string, actorAccountId: string): Promise<void> {
  await getSqlClient().begin(async tx => {
    await tx`
      INSERT INTO participant_payout_accounts (organization_id, participant_id, account_id, linked_by_account_id)
      VALUES (${organizationId}, ${participantId}, ${accountId}, ${actorAccountId})
      ON CONFLICT (organization_id, participant_id) DO UPDATE SET account_id = EXCLUDED.account_id,
        linked_by_account_id = EXCLUDED.linked_by_account_id, linked_at = now()
    `;
    await recordAudit(tx, { organizationId, actorAccountId, action: "tips.payout_account_linked", subjectType: "participant", subjectId: participantId, details: { accountId } });
  });
}

export interface TipRequest {
  eventId: string;
  payeeType: "participant" | "account";
  payeeId: string;
  giftId?: string | null;
  quantity?: number;
  amountMinor?: number;
  currency?: string;
}

export interface TipQuote extends FeeBreakdown {
  currency: string;
  ruleVersion: number | null;
  giftId: string | null;
  quantity: number;
}

/** Validate payee and sender; blocks self-tipping (direct or via a participant's payout account). */
async function assertPayee(sql: Sql, organizationId: string, request: TipRequest, senderAccountId: string): Promise<void> {
  if (!isUuid(request.eventId) || !isUuid(request.payeeId)) throw new DomainError("payee_not_found");
  if (request.payeeType === "account") {
    if (request.payeeId === senderAccountId) throw new DomainError("self_tip_forbidden");
    const member = await sql`SELECT 1 FROM organization_memberships WHERE organization_id = ${organizationId} AND account_id = ${request.payeeId} AND status = 'active'`;
    if (member.length !== 1) throw new DomainError("payee_not_found");
    return;
  }
  if (request.payeeType !== "participant") throw new DomainError("payee_not_found");
  const entry = await sql`
    SELECT 1 FROM entries WHERE organization_id = ${organizationId} AND competition_id = ${request.eventId} AND participant_id = ${request.payeeId} LIMIT 1
  `;
  if (entry.length !== 1) throw new DomainError("payee_not_found");
  const [payout] = await sql<{ account_id: string }[]>`
    SELECT account_id FROM participant_payout_accounts WHERE organization_id = ${organizationId} AND participant_id = ${request.payeeId}
  `;
  if (payout?.account_id === senderAccountId) throw new DomainError("self_tip_forbidden");
}

/**
 * Fee-transparent quote: gross amount, what the payee receives and each fee,
 * computed from the same split rule that will post the ledger entries.
 */
export async function quoteTip(organizationId: string, request: TipRequest, senderAccountId: string): Promise<TipQuote> {
  if (!isUuid(request.eventId)) throw new DomainError("payee_not_found");
  await requireEnabledFeature("tips_gifts", { organizationId, eventId: request.eventId, accountId: senderAccountId });
  return computeQuote(getSqlClient(), organizationId, request, senderAccountId);
}

/** Quote without the feature check (callers check it first, outside any open transaction). */
async function computeQuote(sql: Sql, organizationId: string, request: TipRequest, senderAccountId: string): Promise<TipQuote> {
  await assertPayee(sql, organizationId, request, senderAccountId);
  const quantity = request.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) throw new DomainError("invalid_quantity");
  let grossMinor: number;
  let currency: string;
  let giftId: string | null = null;
  if (request.giftId) {
    if (!isUuid(request.giftId)) throw new DomainError("gift_not_found");
    const [gift] = await sql<Row[]>`SELECT * FROM gift_catalog WHERE organization_id = ${organizationId} AND id = ${request.giftId} AND active`;
    if (!gift) throw new DomainError("gift_not_found");
    grossMinor = Number(gift.price_minor) * quantity;
    currency = gift.currency as string;
    giftId = gift.id as string;
  } else {
    if (quantity !== 1) throw new DomainError("invalid_quantity");
    grossMinor = request.amountMinor ?? NaN;
    currency = normalizeCurrency(request.currency);
  }
  assertTipAmount(grossMinor, await getTipPolicy(organizationId, sql));
  const split = await quoteSplit(sql, organizationId, {
    eventId: request.eventId, purpose: giftId ? "gift" : "tip", grossMinor, payee: { type: request.payeeType, id: request.payeeId }
  });
  const breakdown = feeBreakdown(grossMinor, split.allocations.map(a => ({ partyType: a.partyType, partyId: a.partyId, amountMinor: a.amountMinor })));
  return { ...breakdown, currency, ruleVersion: split.ruleVersion, giftId, quantity };
}

/**
 * Send a tip/gift the sender has seen a quote for. Velocity limits are
 * enforced under a per-sender advisory lock so parallel requests cannot
 * exceed the window caps. Money moves only on the verified provider event;
 * the split hook then credits the payee's payable account.
 */
export async function sendTip(
  organizationId: string,
  input: TipRequest & { senderAccountId: string; expected: { grossMinor: unknown; payeeMinor: unknown }; message?: string | null; idempotencyKey: string },
  provider: PaymentProvider,
  urls: (orderId: string) => { successUrl: string; cancelUrl: string },
  now = new Date()
): Promise<PurchaseResult & { tipId: string }> {
  if (!isIdempotencyKey(input.idempotencyKey)) throw new DomainError("invalid_idempotency_key");
  if (input.message !== undefined && input.message !== null && !isBoundedText(input.message, 280)) throw new DomainError("invalid_message");
  if (!isUuid(input.eventId)) throw new DomainError("payee_not_found");
  // Feature evaluation uses its own pooled transaction: never call it while holding one.
  await requireEnabledFeature("tips_gifts", { organizationId, eventId: input.eventId, accountId: input.senderAccountId });
  const sql = getSqlClient();
  const { order, tipId } = await sql.begin(async tx => {
    const quote = await computeQuote(tx, organizationId, input, input.senderAccountId);
    assertQuoteAccepted(quote, input.expected);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`tips:${organizationId}:${input.senderAccountId}`}, 0))`;
    const [existingTip] = await tx<{ id: string; order_id: string }[]>`
      SELECT t.id, t.order_id FROM tips t JOIN payment_orders o ON o.organization_id = t.organization_id AND o.id = t.order_id
      WHERE t.organization_id = ${organizationId} AND o.account_id = ${input.senderAccountId} AND o.idempotency_key = ${input.idempotencyKey}
    `;
    const policy = await getTipPolicy(organizationId, tx);
    if (!existingTip) {
      const [recent] = await tx<{ count: number; amount: string }[]>`
        SELECT count(*)::int AS count, coalesce(sum(t.amount_minor), 0)::text AS amount
        FROM tips t JOIN payment_orders o ON o.organization_id = t.organization_id AND o.id = t.order_id
        WHERE t.organization_id = ${organizationId} AND t.sender_account_id = ${input.senderAccountId}
          AND t.created_at > ${new Date(now.getTime() - policy.windowSeconds * 1000)}
          AND o.status NOT IN ('failed', 'cancelled')
      `;
      assertVelocity({ count: recent?.count ?? 0, amountMinor: Number(recent?.amount ?? 0) }, quote.grossMinor, policy);
    }
    const { order, created } = await createPaymentOrder(tx, {
      organizationId, accountId: input.senderAccountId, eventId: input.eventId, purpose: quote.giftId ? "gift" : "tip",
      subjectId: quote.giftId, payeeType: input.payeeType, payeeId: input.payeeId,
      description: quote.giftId ? "Live gift" : "Tip", amountMinor: quote.grossMinor, currency: quote.currency,
      provider: provider.name, idempotencyKey: input.idempotencyKey
    });
    if (!created) return { order, tipId: existingTip?.id ?? "" };
    const [tip] = await tx<{ id: string }[]>`
      INSERT INTO tips (organization_id, event_id, sender_account_id, payee_type, payee_id, gift_id, quantity, amount_minor, currency,
        quoted_payee_minor, message, order_id, created_at)
      VALUES (${organizationId}, ${input.eventId}, ${input.senderAccountId}, ${input.payeeType}, ${input.payeeId}, ${quote.giftId},
        ${quote.quantity}, ${quote.grossMinor}, ${quote.currency}, ${quote.payeeMinor}, ${input.message ?? null}, ${order.id}, ${now})
      RETURNING id
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId: input.senderAccountId, action: "tips.created", subjectType: "tip", subjectId: tip!.id,
      details: { eventId: input.eventId, payeeType: input.payeeType, payeeId: input.payeeId, grossMinor: quote.grossMinor, payeeMinor: quote.payeeMinor, fees: quote.fees }
    });
    return { order, tipId: tip!.id };
  });
  if (order.status !== "requires_payment" && order.status !== "processing") return { order, redirectUrl: null, tipId };
  const checkout = await startCheckout(organizationId, order.id, provider, urls(order.id));
  return { order: checkout.order, redirectUrl: checkout.redirectUrl, tipId };
}

/** Public tip feed for an event: only settled, non-reversed tips; no buyer identities beyond account id. */
export async function listEventTips(organizationId: string, eventId: string, limit = 50) {
  return getSqlClient()<{ id: string; payee_type: string; payee_id: string; gift_id: string | null; quantity: number; amount: string; currency: string; message: string | null; created_at: Date }[]>`
    SELECT t.id, t.payee_type, t.payee_id, t.gift_id, t.quantity, t.amount_minor::text AS amount, t.currency, t.message, t.created_at
    FROM tips t JOIN payment_orders o ON o.organization_id = t.organization_id AND o.id = t.order_id
    WHERE t.organization_id = ${organizationId} AND t.event_id = ${eventId} AND o.status = 'succeeded' AND o.settlement_status <> 'refunded'
    ORDER BY t.created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}
  `;
}
