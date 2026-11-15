import { createHash, randomUUID } from "node:crypto";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  assertBalanced,
  compactLines,
  ledgerAccountKind,
  normalizeCurrency,
  requireMinorAmount,
  type LedgerLine
} from "@live-competition-engine/domain/money";
import {
  assertOrderTransition,
  canTransitionOrder,
  isIdempotencyKey,
  refundableAmount,
  settlementAfterRefund,
  type PaymentOrderStatus,
  type PaymentPurpose,
  type RefundStatus,
  type SettlementStatus
} from "@live-competition-engine/domain/payments";
import { canonicalJson, recordAudit, type Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";
import type { PaymentEvent, PaymentProvider, PaymentProviderName } from "./providers/payments.ts";

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

export type LedgerTransactionKind = "payment" | "split" | "refund" | "adjustment";

export interface LedgerPosting {
  organizationId: string;
  currency: string;
  kind: LedgerTransactionKind;
  idempotencyKey: string;
  sourceType: string;
  sourceId?: string | null;
  memo?: string;
  postedByAccountId?: string | null;
  lines: readonly LedgerLine[];
}

export async function ensureLedgerAccount(tx: Sql, organizationId: string, code: string, currency: string): Promise<string> {
  await tx`
    INSERT INTO ledger_accounts (organization_id, code, currency, kind)
    VALUES (${organizationId}, ${code}, ${currency}, ${ledgerAccountKind(code)})
    ON CONFLICT (organization_id, code, currency) DO NOTHING
  `;
  const [row] = await tx<{ id: string }[]>`
    SELECT id FROM ledger_accounts WHERE organization_id = ${organizationId} AND code = ${code} AND currency = ${currency}
  `;
  if (!row) throw new DomainError("ledger_account_not_found");
  return row.id;
}

const ledgerError = (error: unknown): never => {
  const message = (error as { message?: unknown })?.message;
  if (typeof message === "string" && message.startsWith("ledger_unbalanced")) throw new DomainError("ledger_unbalanced");
  if (typeof message === "string" && message.startsWith("ledger_currency_mismatch")) throw new DomainError("ledger_currency_mismatch");
  throw error;
};

/** Run the deferred balance triggers now so violations surface at the posting call. */
async function checkBalanceNow(tx: Sql): Promise<void> {
  try {
    await tx`SET CONSTRAINTS ledger_entries_balanced, ledger_transactions_balanced IMMEDIATE`;
    await tx`SET CONSTRAINTS ledger_entries_balanced, ledger_transactions_balanced DEFERRED`;
  } catch (error) {
    ledgerError(error);
  }
}

/**
 * Append one balanced journal transaction (idempotent on idempotencyKey).
 * Must run inside a transaction; the database independently rejects any
 * transaction whose entries do not sum to zero in one currency.
 */
export async function postLedgerTransaction(tx: Sql, posting: LedgerPosting): Promise<{ id: string; created: boolean }> {
  const currency = normalizeCurrency(posting.currency);
  const lines = compactLines(posting.lines);
  assertBalanced(lines);
  const id = randomUUID();
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO ledger_transactions (id, organization_id, currency, kind, idempotency_key, source_type, source_id, memo, posted_by_account_id)
    VALUES (${id}, ${posting.organizationId}, ${currency}, ${posting.kind}, ${posting.idempotencyKey}, ${posting.sourceType},
      ${posting.sourceId ?? null}, ${posting.memo ?? null}, ${posting.postedByAccountId ?? null})
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING
    RETURNING id
  `;
  if (inserted.length === 0) {
    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM ledger_transactions WHERE organization_id = ${posting.organizationId} AND idempotency_key = ${posting.idempotencyKey}
    `;
    if (!existing) throw new DomainError("ledger_conflict");
    return { id: existing.id, created: false };
  }
  for (const line of lines) {
    const accountId = await ensureLedgerAccount(tx, posting.organizationId, line.accountCode, currency);
    await tx`
      INSERT INTO ledger_entries (organization_id, transaction_id, ledger_account_id, currency, amount_minor)
      VALUES (${posting.organizationId}, ${id}, ${accountId}, ${currency}, ${line.amountMinor})
    `;
  }
  await checkBalanceNow(tx);
  return { id, created: true };
}

export interface LedgerEntryView { accountCode: string; amountMinor: number }

export async function ledgerTransactionLines(tx: Sql, organizationId: string, transactionId: string): Promise<LedgerEntryView[]> {
  const rows = await tx<{ code: string; amount: string }[]>`
    SELECT a.code, e.amount_minor::text AS amount
    FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.ledger_account_id
    WHERE e.organization_id = ${organizationId} AND e.transaction_id = ${transactionId}
    ORDER BY e.id
  `;
  return rows.map(row => ({ accountCode: row.code, amountMinor: Number(row.amount) }));
}

/** Post the exact negation of a transaction. A transaction can be reversed once. */
export async function reverseLedgerTransaction(
  tx: Sql,
  organizationId: string,
  transactionId: string,
  options: { idempotencyKey: string; memo?: string; postedByAccountId?: string | null }
): Promise<{ id: string; created: boolean }> {
  const [original] = await tx<{ id: string; currency: string; kind: string; source_type: string; source_id: string | null }[]>`
    SELECT id, currency, kind, source_type, source_id FROM ledger_transactions
    WHERE organization_id = ${organizationId} AND id = ${transactionId}
  `;
  if (!original) throw new DomainError("ledger_transaction_not_found");
  if (original.kind === "reversal") throw new DomainError("invalid_state_reversal_of_reversal");
  const [already] = await tx<{ id: string }[]>`
    SELECT id FROM ledger_transactions WHERE organization_id = ${organizationId} AND reverses_transaction_id = ${transactionId}
  `;
  if (already) return { id: already.id, created: false };
  const lines = await ledgerTransactionLines(tx, organizationId, transactionId);
  const id = randomUUID();
  await tx`
    INSERT INTO ledger_transactions (id, organization_id, currency, kind, idempotency_key, reverses_transaction_id,
      source_type, source_id, memo, posted_by_account_id)
    VALUES (${id}, ${organizationId}, ${original.currency}, 'reversal', ${options.idempotencyKey}, ${transactionId},
      ${original.source_type}, ${original.source_id}, ${options.memo ?? null}, ${options.postedByAccountId ?? null})
  `;
  for (const line of lines) {
    const accountId = await ensureLedgerAccount(tx, organizationId, line.accountCode, original.currency);
    await tx`
      INSERT INTO ledger_entries (organization_id, transaction_id, ledger_account_id, currency, amount_minor)
      VALUES (${organizationId}, ${id}, ${accountId}, ${original.currency}, ${-line.amountMinor})
    `;
  }
  await checkBalanceNow(tx);
  return { id, created: true };
}

export interface LedgerBalance { code: string; currency: string; kind: string; balanceMinor: number }

/** Balances per ledger account (debits positive). Liabilities owed to parties are negative. */
export async function ledgerBalances(organizationId: string, sql: Sql = getSqlClient()): Promise<LedgerBalance[]> {
  const rows = await sql<{ code: string; currency: string; kind: string; balance: string }[]>`
    SELECT a.code, a.currency, a.kind, coalesce(sum(e.amount_minor), 0)::text AS balance
    FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.ledger_account_id = a.id AND e.organization_id = a.organization_id
    WHERE a.organization_id = ${organizationId}
    GROUP BY a.code, a.currency, a.kind
    ORDER BY a.currency, a.code
  `;
  return rows.map(row => ({ code: row.code, currency: row.currency, kind: row.kind, balanceMinor: Number(row.balance) }));
}

/** Trial balance per currency must be zero; exposed for tests and operator checks. */
export async function ledgerTrialBalance(organizationId: string, sql: Sql = getSqlClient()): Promise<Record<string, number>> {
  const rows = await sql<{ currency: string; total: string }[]>`
    SELECT currency, sum(amount_minor)::text AS total FROM ledger_entries WHERE organization_id = ${organizationId} GROUP BY currency
  `;
  return Object.fromEntries(rows.map(row => [row.currency, Number(row.total)]));
}

/* ------------------------------------------------------------------ */
/* Payment orders                                                      */
/* ------------------------------------------------------------------ */

export interface PaymentOrder {
  id: string;
  organizationId: string;
  accountId: string;
  eventId: string | null;
  purpose: PaymentPurpose;
  subjectId: string | null;
  payeeType: "participant" | "account" | null;
  payeeId: string | null;
  description: string;
  amountMinor: number;
  currency: string;
  status: PaymentOrderStatus;
  settlementStatus: SettlementStatus;
  refundedMinor: number;
  provider: PaymentProviderName | "none";
  providerCheckoutReference: string | null;
  providerPaymentReference: string | null;
  failureCode: string | null;
  revision: number;
  createdAt: Date;
  succeededAt: Date | null;
}

type OrderRow = Record<string, unknown>;

export function mapOrder(row: OrderRow): PaymentOrder {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    accountId: row.account_id as string,
    eventId: (row.event_id as string | null) ?? null,
    purpose: row.purpose as PaymentPurpose,
    subjectId: (row.subject_id as string | null) ?? null,
    payeeType: (row.payee_type as PaymentOrder["payeeType"]) ?? null,
    payeeId: (row.payee_id as string | null) ?? null,
    description: row.description as string,
    amountMinor: Number(row.amount_minor),
    currency: row.currency as string,
    status: row.status as PaymentOrderStatus,
    settlementStatus: row.settlement_status as SettlementStatus,
    refundedMinor: Number(row.refunded_minor),
    provider: row.provider as PaymentOrder["provider"],
    providerCheckoutReference: (row.provider_checkout_reference as string | null) ?? null,
    providerPaymentReference: (row.provider_payment_reference as string | null) ?? null,
    failureCode: (row.failure_code as string | null) ?? null,
    revision: Number(row.revision),
    createdAt: row.created_at as Date,
    succeededAt: (row.succeeded_at as Date | null) ?? null
  };
}

export interface CreateOrderInput {
  organizationId: string;
  accountId: string;
  eventId?: string | null;
  purpose: PaymentPurpose;
  subjectId?: string | null;
  payeeType?: "participant" | "account" | null;
  payeeId?: string | null;
  description: string;
  amountMinor: number;
  currency: string;
  provider: PaymentProviderName;
  idempotencyKey: string;
}

/**
 * Insert an order (idempotent per tenant+account+key). Reusing a key with a
 * different request is a conflict, never a silent substitution. Free orders
 * (amount 0) are recorded with provider "none" and never reach a provider.
 */
export async function createPaymentOrder(tx: Sql, input: CreateOrderInput): Promise<{ order: PaymentOrder; created: boolean }> {
  if (!isIdempotencyKey(input.idempotencyKey)) throw new DomainError("invalid_idempotency_key");
  const amountMinor = requireMinorAmount(input.amountMinor);
  const currency = normalizeCurrency(input.currency);
  const description = input.description.trim().slice(0, 200) || input.purpose;
  const provider = amountMinor === 0 ? "none" : input.provider;
  const fingerprint = createHash("sha256").update(canonicalJson({
    eventId: input.eventId ?? null, purpose: input.purpose, subjectId: input.subjectId ?? null,
    payeeType: input.payeeType ?? null, payeeId: input.payeeId ?? null, amountMinor, currency
  })).digest("hex");
  const rows = await tx<OrderRow[]>`
    INSERT INTO payment_orders (organization_id, account_id, event_id, purpose, subject_id, payee_type, payee_id,
      description, amount_minor, currency, provider, idempotency_key, request_fingerprint)
    VALUES (${input.organizationId}, ${input.accountId}, ${input.eventId ?? null}, ${input.purpose}, ${input.subjectId ?? null},
      ${input.payeeType ?? null}, ${input.payeeId ?? null}, ${description}, ${amountMinor}, ${currency}, ${provider},
      ${input.idempotencyKey}, ${fingerprint})
    ON CONFLICT (organization_id, account_id, idempotency_key) DO NOTHING
    RETURNING *
  `;
  if (rows[0]) {
    const order = mapOrder(rows[0]);
    await tx`INSERT INTO payment_order_history (organization_id, order_id, from_status, to_status, reason)
      VALUES (${order.organizationId}, ${order.id}, NULL, 'requires_payment', 'created')`;
    await recordAudit(tx, {
      organizationId: order.organizationId, actorAccountId: order.accountId, action: "payment.order_created",
      subjectType: "payment_order", subjectId: order.id,
      details: { purpose: order.purpose, amountMinor, currency, eventId: order.eventId }
    });
    return { order, created: true };
  }
  const [existing] = await tx<OrderRow[]>`
    SELECT * FROM payment_orders
    WHERE organization_id = ${input.organizationId} AND account_id = ${input.accountId} AND idempotency_key = ${input.idempotencyKey}
  `;
  if (!existing || existing.request_fingerprint !== fingerprint) throw new DomainError("idempotency_conflict");
  return { order: mapOrder(existing), created: false };
}

export async function lockOrder(tx: Sql, organizationId: string, orderId: string): Promise<PaymentOrder | null> {
  if (!isUuid(organizationId) || !isUuid(orderId)) return null;
  const [row] = await tx<OrderRow[]>`SELECT * FROM payment_orders WHERE organization_id = ${organizationId} AND id = ${orderId} FOR UPDATE`;
  return row ? mapOrder(row) : null;
}

export async function getPaymentOrder(organizationId: string, orderId: string, sql: Sql = getSqlClient()): Promise<PaymentOrder | null> {
  if (!isUuid(organizationId) || !isUuid(orderId)) return null;
  const [row] = await sql<OrderRow[]>`SELECT * FROM payment_orders WHERE organization_id = ${organizationId} AND id = ${orderId}`;
  return row ? mapOrder(row) : null;
}

async function transitionOrder(
  tx: Sql,
  order: PaymentOrder,
  to: PaymentOrderStatus,
  reason: string,
  patch: { providerPaymentReference?: string; providerCheckoutReference?: string; failureCode?: string } = {}
): Promise<PaymentOrder> {
  assertOrderTransition(order.status, to);
  const [row] = await tx<OrderRow[]>`
    UPDATE payment_orders SET
      status = ${to},
      settlement_status = ${to === "succeeded" ? "settled" : "unsettled"},
      succeeded_at = ${to === "succeeded" ? new Date() : null},
      provider_payment_reference = coalesce(${patch.providerPaymentReference ?? null}, provider_payment_reference),
      provider_checkout_reference = coalesce(${patch.providerCheckoutReference ?? null}, provider_checkout_reference),
      failure_code = ${patch.failureCode ?? null},
      revision = revision + 1,
      updated_at = now()
    WHERE organization_id = ${order.organizationId} AND id = ${order.id} AND revision = ${order.revision}
    RETURNING *
  `;
  if (!row) throw new DomainError("order_revision_conflict");
  await tx`INSERT INTO payment_order_history (organization_id, order_id, from_status, to_status, reason)
    VALUES (${order.organizationId}, ${order.id}, ${order.status}, ${to}, ${reason})`;
  return mapOrder(row);
}

/* ------------------------------------------------------------------ */
/* Hooks for downstream modules (splits, ticketing, subscriptions...)  */
/* ------------------------------------------------------------------ */

export interface RefundView {
  id: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  status: RefundStatus;
  reason: string;
  providerRefundReference: string | null;
  failureCode: string | null;
}

export interface PaymentHooks {
  /** Runs in the same transaction after the order is succeeded and the payment is posted. */
  onSucceeded?(tx: Sql, order: PaymentOrder, paymentTransactionId: string | null): Promise<void>;
  /** Runs after an order fails or is cancelled (release reservations). */
  onFailed?(tx: Sql, order: PaymentOrder): Promise<void>;
  /** Ledger lines for a refund; defaults to reversing out of sales_clearing. */
  refundLines?(tx: Sql, order: PaymentOrder, amountMinor: number, previouslyRefundedMinor: number): Promise<LedgerLine[]>;
  /** Runs after a refund succeeded (revoke grants, release capacity). */
  onRefunded?(tx: Sql, order: PaymentOrder, refund: RefundView, fullyRefunded: boolean): Promise<void>;
  /** Events other than one-off payments (subscriptions); returns an outcome. */
  onOtherEvent?(tx: Sql, provider: PaymentProviderName, event: PaymentEvent, hooks: PaymentHooks): Promise<EventOutcome>;
}

export interface EventOutcome { outcome: string; organizationId: string | null }

/**
 * Complete a zero-amount order without any provider call or ledger posting
 * (there is no money to record). Fulfillment hooks still run.
 */
export async function completeFreeOrder(tx: Sql, order: PaymentOrder, hooks: PaymentHooks = {}): Promise<PaymentOrder> {
  if (order.amountMinor !== 0 || order.provider !== "none") throw new DomainError("invalid_state_not_free");
  if (order.status === "succeeded") return order;
  const done = await transitionOrder(tx, order, "succeeded", "free_order");
  await recordAudit(tx, {
    organizationId: done.organizationId, actorAccountId: done.accountId, action: "payment.free_order_completed",
    subjectType: "payment_order", subjectId: done.id, details: { purpose: done.purpose }
  });
  await hooks.onSucceeded?.(tx, done, null);
  return done;
}

/** Mark the provider payment as succeeded: ledger posting + fulfillment in one transaction. */
async function settleSucceeded(
  tx: Sql,
  order: PaymentOrder,
  paymentReference: string,
  hooks: PaymentHooks,
  reason: string
): Promise<PaymentOrder> {
  const done = await transitionOrder(tx, order, "succeeded", reason, { providerPaymentReference: paymentReference });
  const posted = await postLedgerTransaction(tx, {
    organizationId: done.organizationId,
    currency: done.currency,
    kind: "payment",
    idempotencyKey: `payment:${done.id}`,
    sourceType: "payment_order",
    sourceId: done.id,
    memo: `Captured ${done.purpose}`,
    lines: [
      { accountCode: "provider_clearing", amountMinor: done.amountMinor },
      { accountCode: "sales_clearing", amountMinor: -done.amountMinor }
    ]
  });
  await recordAudit(tx, {
    organizationId: done.organizationId, actorAccountId: null, action: "payment.succeeded",
    subjectType: "payment_order", subjectId: done.id,
    details: { amountMinor: done.amountMinor, currency: done.currency, provider: done.provider, ledgerTransactionId: posted.id }
  });
  await hooks.onSucceeded?.(tx, done, posted.id);
  return done;
}

/**
 * Record a payment the provider already captured on its own schedule (e.g. a
 * subscription invoice): order + ledger + hooks in the caller's transaction.
 * Idempotent through the order idempotency key.
 */
export async function recordCapturedPayment(
  tx: Sql,
  input: CreateOrderInput,
  paymentReference: string,
  hooks: PaymentHooks = {}
): Promise<{ order: PaymentOrder; created: boolean }> {
  const { order, created } = await createPaymentOrder(tx, input);
  if (!created) return { order, created };
  if (order.amountMinor === 0) return { order: await completeFreeOrder(tx, order, hooks), created };
  return { order: await settleSucceeded(tx, order, paymentReference, hooks, "provider_captured"), created };
}

/** Create a hosted checkout for an order and move it to processing. */
export async function startCheckout(
  organizationId: string,
  orderId: string,
  provider: PaymentProvider,
  urls: { successUrl: string; cancelUrl: string },
  expiresAt?: Date
): Promise<{ order: PaymentOrder; redirectUrl: string }> {
  const order = await getPaymentOrder(organizationId, orderId);
  if (!order) throw new DomainError("order_not_found");
  if (order.provider !== provider.name) throw new DomainError("invalid_state_provider_mismatch");
  if (order.status !== "requires_payment" && order.status !== "processing") throw new DomainError("invalid_state_order_closed");
  // Provider idempotency key is stable per order: retries return the same session.
  const session = await provider.createCheckout({
    organizationId, orderId, amountMinor: order.amountMinor, currency: order.currency,
    description: order.description, successUrl: urls.successUrl, cancelUrl: urls.cancelUrl,
    idempotencyKey: `checkout:${order.id}`, ...(expiresAt ? { expiresAt } : {})
  });
  const updated = await getSqlClient().begin(async tx => {
    const locked = await lockOrder(tx, organizationId, orderId);
    if (!locked) throw new DomainError("order_not_found");
    if (locked.status === "requires_payment") {
      return transitionOrder(tx, locked, "processing", "checkout_started", { providerCheckoutReference: session.reference });
    }
    return locked;
  });
  return { order: updated, redirectUrl: session.redirectUrl };
}

/** Cancel an unpaid order inside the caller's transaction (runs onFailed hooks). */
export async function cancelOrderInTransaction(
  tx: Sql,
  organizationId: string,
  orderId: string,
  reason: string,
  hooks: PaymentHooks = {}
): Promise<PaymentOrder> {
  const order = await lockOrder(tx, organizationId, orderId);
  if (!order) throw new DomainError("order_not_found");
  if (order.status === "cancelled") return order;
  if (!canTransitionOrder(order.status, "cancelled")) throw new DomainError("invalid_state_order_closed");
  const done = await transitionOrder(tx, order, "cancelled", reason);
  await hooks.onFailed?.(tx, done);
  return done;
}

/** Buyer- or operator-initiated cancellation of an unpaid order. */
export async function cancelPaymentOrder(organizationId: string, orderId: string, hooks: PaymentHooks = {}): Promise<PaymentOrder> {
  return getSqlClient().begin(tx => cancelOrderInTransaction(tx, organizationId, orderId, "cancelled_by_request", hooks));
}

/* ------------------------------------------------------------------ */
/* Provider events                                                     */
/* ------------------------------------------------------------------ */

/** Apply one verified provider event inside the caller's transaction. */
export async function applyPaymentEvent(
  tx: Sql,
  provider: PaymentProviderName,
  event: PaymentEvent,
  hooks: PaymentHooks = {}
): Promise<EventOutcome> {
  switch (event.kind) {
    case "payment_succeeded": {
      const order = await lockOrder(tx, event.organizationId, event.orderId);
      if (!order || order.provider !== provider) return { outcome: "order_not_found", organizationId: null };
      const organizationId = order.organizationId;
      if (order.status === "succeeded") return { outcome: "already_succeeded", organizationId };
      if (!canTransitionOrder(order.status, "succeeded")) return { outcome: "invalid_state", organizationId };
      if (event.amountMinor !== order.amountMinor || event.currency !== order.currency) {
        const failed = await transitionOrder(tx, order, "failed", "amount_mismatch", { failureCode: "amount_mismatch", providerPaymentReference: event.paymentReference });
        await hooks.onFailed?.(tx, failed);
        await recordAudit(tx, {
          organizationId, actorAccountId: null, action: "payment.amount_mismatch", subjectType: "payment_order", subjectId: order.id,
          details: { expected: order.amountMinor, received: event.amountMinor, currency: event.currency }
        });
        return { outcome: "amount_mismatch", organizationId };
      }
      await settleSucceeded(tx, order, event.paymentReference, hooks, "provider_succeeded");
      return { outcome: "succeeded", organizationId };
    }
    case "payment_failed":
    case "payment_cancelled": {
      const order = await lockOrder(tx, event.organizationId, event.orderId);
      if (!order || order.provider !== provider) return { outcome: "order_not_found", organizationId: null };
      const to = event.kind === "payment_failed" ? "failed" : "cancelled";
      if (!canTransitionOrder(order.status, to)) return { outcome: "ignored_terminal", organizationId: order.organizationId };
      const done = await transitionOrder(tx, order, to, event.kind, event.kind === "payment_failed" ? { failureCode: event.failureCode } : {});
      await hooks.onFailed?.(tx, done);
      return { outcome: to, organizationId: order.organizationId };
    }
    case "refund_updated": {
      if (!isUuid(event.organizationId) || !isUuid(event.refundId)) return { outcome: "refund_not_found", organizationId: null };
      const [refund] = await tx<{ order_id: string }[]>`
        SELECT order_id FROM payment_refunds WHERE organization_id = ${event.organizationId} AND id = ${event.refundId}
      `;
      if (!refund) return { outcome: "refund_not_found", organizationId: null };
      if (event.status === "pending") return { outcome: "refund_pending", organizationId: event.organizationId };
      const result = await completeRefund(tx, event.organizationId, event.refundId, event.status, event.providerRefundReference, hooks);
      return { outcome: `refund_${result.status}`, organizationId: event.organizationId };
    }
    case "chargeback": {
      const [row] = await tx<OrderRow[]>`
        SELECT * FROM payment_orders WHERE provider = ${provider} AND provider_payment_reference = ${event.paymentReference} FOR UPDATE
      `;
      if (!row) return { outcome: "order_not_found", organizationId: null };
      const order = mapOrder(row);
      const refunds = await orderRefunds(tx, order);
      const remaining = refundableAmount(order.amountMinor, refunds);
      if (event.currency !== order.currency) return { outcome: "currency_mismatch", organizationId: order.organizationId };
      const amount = Math.min(event.amountMinor, remaining);
      if (amount <= 0) return { outcome: "nothing_to_reverse", organizationId: order.organizationId };
      const refund = await insertRefund(tx, order, amount, "chargeback", `chargeback:${event.disputeId}`, null);
      if (refund.status !== "pending") return { outcome: "duplicate_chargeback", organizationId: order.organizationId };
      await completeRefund(tx, order.organizationId, refund.id, "succeeded", event.disputeId, hooks);
      return { outcome: "chargeback_reversed", organizationId: order.organizationId };
    }
    default:
      if (hooks.onOtherEvent) return hooks.onOtherEvent(tx, provider, event, hooks);
      return { outcome: "unhandled", organizationId: null };
  }
}

/**
 * Store a provider event id and apply it atomically. A replayed delivery hits
 * the primary key and is ignored; if processing throws, nothing is stored and
 * the provider's retry is processed again.
 */
export async function ingestPaymentEvent(
  provider: PaymentProviderName,
  input: { eventId: string; eventType: string; rawBody: string; event: PaymentEvent | null },
  hooks: PaymentHooks = {}
): Promise<{ duplicate: boolean; outcome: string }> {
  const payloadHash = createHash("sha256").update(input.rawBody, "utf8").digest("hex");
  return getSqlClient().begin(async tx => {
    const inserted = await tx`
      INSERT INTO payment_webhook_events (provider, event_id, event_type, payload_sha256, outcome)
      VALUES (${provider}, ${input.eventId}, ${input.eventType.slice(0, 120)}, ${payloadHash}, 'processing')
      ON CONFLICT (provider, event_id) DO NOTHING
      RETURNING event_id
    `;
    if (inserted.length === 0) return { duplicate: true, outcome: "duplicate" };
    const result = input.event ? await applyPaymentEvent(tx, provider, input.event, hooks) : { outcome: "ignored", organizationId: null };
    await tx`
      UPDATE payment_webhook_events SET outcome = ${result.outcome.slice(0, 64)}, organization_id = ${result.organizationId}
      WHERE provider = ${provider} AND event_id = ${input.eventId}
    `;
    return { duplicate: false, outcome: result.outcome };
  });
}

/* ------------------------------------------------------------------ */
/* Refunds                                                             */
/* ------------------------------------------------------------------ */

type RefundRow = Record<string, unknown>;
const mapRefund = (row: RefundRow): RefundView => ({
  id: row.id as string,
  orderId: row.order_id as string,
  amountMinor: Number(row.amount_minor),
  currency: row.currency as string,
  status: row.status as RefundStatus,
  reason: row.reason as string,
  providerRefundReference: (row.provider_refund_reference as string | null) ?? null,
  failureCode: (row.failure_code as string | null) ?? null
});

async function orderRefunds(tx: Sql, order: PaymentOrder): Promise<RefundView[]> {
  const rows = await tx<RefundRow[]>`SELECT * FROM payment_refunds WHERE organization_id = ${order.organizationId} AND order_id = ${order.id}`;
  return rows.map(mapRefund);
}

export async function listOrderRefunds(organizationId: string, orderId: string): Promise<RefundView[]> {
  const rows = await getSqlClient()<RefundRow[]>`
    SELECT * FROM payment_refunds WHERE organization_id = ${organizationId} AND order_id = ${orderId} ORDER BY created_at
  `;
  return rows.map(mapRefund);
}

async function insertRefund(
  tx: Sql,
  order: PaymentOrder,
  amountMinor: number,
  reason: string,
  idempotencyKey: string,
  actorAccountId: string | null
): Promise<RefundView> {
  const rows = await tx<RefundRow[]>`
    INSERT INTO payment_refunds (organization_id, order_id, amount_minor, currency, reason, idempotency_key, requested_by_account_id)
    VALUES (${order.organizationId}, ${order.id}, ${amountMinor}, ${order.currency}, ${reason}, ${idempotencyKey}, ${actorAccountId})
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING
    RETURNING *
  `;
  if (rows[0]) {
    await recordAudit(tx, {
      organizationId: order.organizationId, actorAccountId, action: "payment.refund_requested",
      subjectType: "payment_refund", subjectId: rows[0].id as string, details: { orderId: order.id, amountMinor, reason }
    });
    return mapRefund(rows[0]);
  }
  const [existing] = await tx<RefundRow[]>`
    SELECT * FROM payment_refunds WHERE organization_id = ${order.organizationId} AND idempotency_key = ${idempotencyKey}
  `;
  if (!existing || existing.order_id !== order.id || Number(existing.amount_minor) !== amountMinor) throw new DomainError("idempotency_conflict");
  return mapRefund(existing);
}

/** Finalize a pending refund: ledger posting, order totals and fulfillment reversal. */
export async function completeRefund(
  tx: Sql,
  organizationId: string,
  refundId: string,
  status: "succeeded" | "failed",
  providerRefundReference: string | null,
  hooks: PaymentHooks = {}
): Promise<RefundView> {
  const [head] = await tx<{ order_id: string }[]>`SELECT order_id FROM payment_refunds WHERE organization_id = ${organizationId} AND id = ${refundId}`;
  if (!head) throw new DomainError("refund_not_found");
  // Lock order before refund: a single lock order across all writers avoids deadlocks.
  const order = await lockOrder(tx, organizationId, head.order_id);
  if (!order) throw new DomainError("order_not_found");
  const [row] = await tx<RefundRow[]>`SELECT * FROM payment_refunds WHERE organization_id = ${organizationId} AND id = ${refundId} FOR UPDATE`;
  const refund = mapRefund(row!);
  if (refund.status !== "pending") return refund;
  if (status === "failed") {
    const [failed] = await tx<RefundRow[]>`
      UPDATE payment_refunds SET status = 'failed', failure_code = 'provider_failed', completed_at = now(),
        provider_refund_reference = coalesce(${providerRefundReference}, provider_refund_reference)
      WHERE id = ${refundId} RETURNING *
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId: null, action: "payment.refund_failed", subjectType: "payment_refund", subjectId: refundId,
      details: { orderId: order.id }
    });
    return mapRefund(failed!);
  }
  const lines = hooks.refundLines
    ? await hooks.refundLines(tx, order, refund.amountMinor, order.refundedMinor)
    : [{ accountCode: "sales_clearing", amountMinor: refund.amountMinor }, { accountCode: "provider_clearing", amountMinor: -refund.amountMinor }];
  const posted = await postLedgerTransaction(tx, {
    organizationId, currency: order.currency, kind: "refund", idempotencyKey: `refund:${refund.id}`,
    sourceType: "payment_order", sourceId: order.id, memo: `Refund (${refund.reason})`, lines
  });
  const [done] = await tx<RefundRow[]>`
    UPDATE payment_refunds SET status = 'succeeded', ledger_transaction_id = ${posted.id}, completed_at = now(),
      provider_refund_reference = coalesce(${providerRefundReference}, provider_refund_reference)
    WHERE id = ${refundId} RETURNING *
  `;
  const refundedMinor = order.refundedMinor + refund.amountMinor;
  const [updatedRow] = await tx<OrderRow[]>`
    UPDATE payment_orders SET refunded_minor = ${refundedMinor},
      settlement_status = ${settlementAfterRefund(order.amountMinor, refundedMinor)},
      revision = revision + 1, updated_at = now()
    WHERE id = ${order.id} RETURNING *
  `;
  const view = mapRefund(done!);
  await recordAudit(tx, {
    organizationId, actorAccountId: null, action: "payment.refunded", subjectType: "payment_refund", subjectId: refundId,
    details: { orderId: order.id, amountMinor: refund.amountMinor, refundedMinor, reason: refund.reason, ledgerTransactionId: posted.id }
  });
  await hooks.onRefunded?.(tx, mapOrder(updatedRow!), view, refundedMinor >= order.amountMinor);
  return view;
}

export const refundReasons = ["requested_by_customer", "operator", "event_cancelled", "fraud"] as const;
export type RefundReason = (typeof refundReasons)[number];

/**
 * Request a (partial or full) refund. The pending row reserves the amount
 * under the order lock, so concurrent refunds can never exceed the capture.
 * Provider outages leave the refund pending for the webhook to resolve.
 */
export async function requestRefund(
  input: { organizationId: string; orderId: string; amountMinor?: number; reason: RefundReason; actorAccountId: string; idempotencyKey: string },
  provider: PaymentProvider,
  hooks: PaymentHooks = {}
): Promise<RefundView> {
  if (!isIdempotencyKey(input.idempotencyKey)) throw new DomainError("invalid_idempotency_key");
  if (!refundReasons.includes(input.reason)) throw new DomainError("invalid_refund_reason");
  const sql = getSqlClient();
  const { refund, order } = await sql.begin(async tx => {
    const order = await lockOrder(tx, input.organizationId, input.orderId);
    if (!order) throw new DomainError("order_not_found");
    if (order.status !== "succeeded") throw new DomainError("invalid_state_not_paid");
    if (order.provider !== provider.name || !order.providerPaymentReference) throw new DomainError("invalid_state_not_refundable");
    const key = `request:${input.idempotencyKey}`;
    const [prior] = await tx<RefundRow[]>`SELECT * FROM payment_refunds WHERE organization_id = ${input.organizationId} AND idempotency_key = ${key}`;
    if (prior) {
      if (prior.order_id !== order.id) throw new DomainError("idempotency_conflict");
      return { refund: mapRefund(prior), order };
    }
    const remaining = refundableAmount(order.amountMinor, await orderRefunds(tx, order));
    const amount = input.amountMinor ?? remaining;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new DomainError("invalid_amount");
    if (amount > remaining) throw new DomainError("refund_exceeds_remaining");
    return { refund: await insertRefund(tx, order, amount, input.reason, key, input.actorAccountId), order };
  });
  if (refund.status !== "pending" || refund.providerRefundReference) return refund;
  let outcome: { reference: string; status: "pending" | "succeeded" | "failed" };
  try {
    outcome = await provider.refund({
      organizationId: order.organizationId, refundId: refund.id, paymentReference: order.providerPaymentReference!,
      amountMinor: refund.amountMinor, idempotencyKey: `refund:${refund.id}`
    });
  } catch (error) {
    if ((error as { code?: string }).code === "provider_rejected") {
      return sql.begin(tx => completeRefund(tx, order.organizationId, refund.id, "failed", null, hooks));
    }
    return refund; // unknown outcome: stays pending until the provider webhook arrives
  }
  if (outcome.status === "pending") {
    await sql`UPDATE payment_refunds SET provider_refund_reference = ${outcome.reference}
      WHERE organization_id = ${order.organizationId} AND id = ${refund.id} AND status = 'pending'`;
    return { ...refund, providerRefundReference: outcome.reference };
  }
  return sql.begin(tx => completeRefund(tx, order.organizationId, refund.id, outcome.status as "succeeded" | "failed", outcome.reference, hooks));
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

export interface ReconciliationMismatch {
  type: "amount_mismatch" | "currency_mismatch" | "charge_without_settled_order" | "missing_at_provider";
  orderId: string | null;
  chargeId: string | null;
  providerNetMinor: number | null;
  ledgerNetMinor: number | null;
}

export interface ReconciliationReport {
  id: string;
  checkedCount: number;
  unattributedChargeCount: number;
  mismatches: ReconciliationMismatch[];
}

/**
 * Compare the provider's captured-minus-refunded amount per charge with the
 * ledger's provider_clearing net per order for a time window. Mismatches are
 * reported and stored; nothing is auto-corrected.
 */
export async function reconcilePayments(
  organizationId: string,
  provider: PaymentProvider,
  window: { since: Date; until: Date; actorAccountId: string | null }
): Promise<ReconciliationReport> {
  if (!(window.until > window.since) || window.until.getTime() - window.since.getTime() > 1000 * 60 * 60 * 24 * 92) {
    throw new DomainError("invalid_window");
  }
  const charges = await provider.listCharges({ since: window.since, until: window.until });
  const sql = getSqlClient();
  const references = charges.map(c => c.paymentReference).filter((r): r is string => r !== null);
  const orders = (await sql<OrderRow[]>`
    SELECT * FROM payment_orders
    WHERE organization_id = ${organizationId} AND provider = ${provider.name}
      AND (provider_payment_reference = ANY(${references}) OR (succeeded_at >= ${window.since} AND succeeded_at < ${window.until}))
  `).map(mapOrder);
  const orderIds = orders.map(o => o.id);
  const nets = await sql<{ source_id: string; net: string }[]>`
    SELECT t.source_id, sum(e.amount_minor)::text AS net
    FROM ledger_entries e
    JOIN ledger_transactions t ON t.id = e.transaction_id
    JOIN ledger_accounts a ON a.id = e.ledger_account_id
    WHERE t.organization_id = ${organizationId} AND t.source_type = 'payment_order' AND a.code = 'provider_clearing'
      AND t.source_id = ANY(${orderIds})
    GROUP BY t.source_id
  `;
  const ledgerNet = new Map(nets.map(row => [row.source_id, Number(row.net)]));
  const byReference = new Map(orders.filter(o => o.providerPaymentReference).map(o => [o.providerPaymentReference!, o]));
  const mismatches: ReconciliationMismatch[] = [];
  const matched = new Set<string>();
  let unattributed = 0;
  for (const charge of charges) {
    const order = charge.paymentReference ? byReference.get(charge.paymentReference) : undefined;
    if (!order) { unattributed += 1; continue; }
    matched.add(order.id);
    const providerNet = charge.amountCapturedMinor - charge.amountRefundedMinor;
    const net = ledgerNet.get(order.id) ?? 0;
    if (charge.currency !== order.currency) {
      mismatches.push({ type: "currency_mismatch", orderId: order.id, chargeId: charge.chargeId, providerNetMinor: providerNet, ledgerNetMinor: net });
    } else if (order.status !== "succeeded") {
      mismatches.push({ type: "charge_without_settled_order", orderId: order.id, chargeId: charge.chargeId, providerNetMinor: providerNet, ledgerNetMinor: net });
    } else if (providerNet !== net) {
      mismatches.push({ type: "amount_mismatch", orderId: order.id, chargeId: charge.chargeId, providerNetMinor: providerNet, ledgerNetMinor: net });
    }
  }
  for (const order of orders) {
    if (order.status === "succeeded" && order.amountMinor > 0 && !matched.has(order.id) &&
      order.succeededAt && order.succeededAt >= window.since && order.succeededAt < window.until) {
      mismatches.push({ type: "missing_at_provider", orderId: order.id, chargeId: null, providerNetMinor: null, ledgerNetMinor: ledgerNet.get(order.id) ?? 0 });
    }
  }
  const id = randomUUID();
  await sql.begin(async tx => {
    await tx`
      INSERT INTO payment_reconciliation_reports (id, organization_id, provider, window_start, window_end, checked_count, mismatch_count, mismatches, created_by_account_id)
      VALUES (${id}, ${organizationId}, ${provider.name}, ${window.since}, ${window.until}, ${charges.length - unattributed},
        ${mismatches.length}, ${tx.json(mismatches as unknown as Parameters<typeof tx.json>[0])}, ${window.actorAccountId})
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId: window.actorAccountId, action: "payment.reconciled", subjectType: "reconciliation_report",
      subjectId: id, details: { checked: charges.length - unattributed, mismatches: mismatches.length }
    });
  });
  return { id, checkedCount: charges.length - unattributed, unattributedChargeCount: unattributed, mismatches };
}
