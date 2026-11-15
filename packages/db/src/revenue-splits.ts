import { DomainError, isUuid } from "@live-competition-engine/domain";
import { normalizeCurrency, type LedgerLine } from "@live-competition-engine/domain/money";
import { paymentPurposes, type PaymentPurpose } from "@live-competition-engine/domain/payments";
import {
  allocateSplit,
  defaultSplitRule,
  refundAllocationDelta,
  validateSplitRule,
  type SplitLine,
  type SplitRuleDefinition
} from "@live-competition-engine/domain/revenue-split";
import { recordAudit, type Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";
import {
  lockOrder,
  postLedgerTransaction,
  reverseLedgerTransaction,
  type PaymentHooks,
  type PaymentOrder
} from "./payments.ts";

export interface SplitRule extends SplitRuleDefinition {
  id: string;
  organizationId: string;
  eventId: string | null;
  purpose: PaymentPurpose | null;
  version: number;
  createdAt: Date;
}

export interface Allocation {
  partyType: SplitLine["partyType"];
  partyId: string | null;
  accountCode: string;
  amountMinor: number;
}

type Row = Record<string, unknown>;
const mapRule = (row: Row): SplitRule => ({
  id: row.id as string,
  organizationId: row.organization_id as string,
  eventId: (row.event_id as string | null) ?? null,
  purpose: (row.purpose as PaymentPurpose | null) ?? null,
  version: Number(row.version),
  lines: row.lines as SplitLine[],
  remainderLine: Number(row.remainder_line),
  createdAt: row.created_at as Date
});

/** Publish a new immutable version of the rule for (tenant, event?, purpose?). */
export async function createSplitRule(
  organizationId: string,
  input: { eventId?: string | null; purpose?: PaymentPurpose | null; lines: unknown; remainderLine?: unknown },
  actorAccountId: string
): Promise<SplitRule> {
  const definition = validateSplitRule({ lines: input.lines, remainderLine: input.remainderLine });
  const eventId = input.eventId ?? null;
  const purpose = input.purpose ?? null;
  if (eventId !== null && !isUuid(eventId)) throw new DomainError("event_not_found");
  if (purpose !== null && !paymentPurposes.includes(purpose)) throw new DomainError("invalid_purpose");
  return getSqlClient().begin(async tx => {
    if (eventId) {
      const event = await tx`SELECT 1 FROM competitions WHERE organization_id = ${organizationId} AND id = ${eventId}`;
      if (event.length !== 1) throw new DomainError("event_not_found");
    }
    const scopeKey = `${eventId ?? "*"}:${purpose ?? "*"}`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`split:${organizationId}:${scopeKey}`}, 0))`;
    const [last] = await tx<{ version: number }[]>`
      SELECT coalesce(max(version), 0)::int AS version FROM revenue_split_rules
      WHERE organization_id = ${organizationId} AND scope_key = ${scopeKey}
    `;
    const [row] = await tx<Row[]>`
      INSERT INTO revenue_split_rules (organization_id, event_id, purpose, version, lines, remainder_line, created_by_account_id)
      VALUES (${organizationId}, ${eventId}, ${purpose}, ${(last?.version ?? 0) + 1},
        ${tx.json(definition.lines as unknown as Parameters<typeof tx.json>[0])}, ${definition.remainderLine}, ${actorAccountId})
      RETURNING *
    `;
    const rule = mapRule(row!);
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "split.rule_published", subjectType: "revenue_split_rule", subjectId: rule.id,
      details: { eventId, purpose, version: rule.version, lines: definition.lines, remainderLine: definition.remainderLine }
    });
    return rule;
  });
}

export async function listSplitRules(organizationId: string, eventId?: string): Promise<SplitRule[]> {
  const sql = getSqlClient();
  const rows = await sql<Row[]>`
    SELECT * FROM revenue_split_rules WHERE organization_id = ${organizationId}
      ${eventId ? sql`AND event_id = ${eventId}` : sql``}
    ORDER BY scope_key, version DESC LIMIT 200
  `;
  return rows.map(mapRule);
}

export async function getSplitRule(sql: Sql, organizationId: string, ruleId: string): Promise<SplitRule | null> {
  if (!isUuid(ruleId)) return null;
  const [row] = await sql<Row[]>`SELECT * FROM revenue_split_rules WHERE organization_id = ${organizationId} AND id = ${ruleId}`;
  return row ? mapRule(row) : null;
}

/**
 * Latest version in precedence order: (event, purpose) → (event, any) →
 * (tenant, purpose) → (tenant, any). Null means the default rule applies.
 */
export async function resolveSplitRule(sql: Sql, organizationId: string, eventId: string | null, purpose: PaymentPurpose): Promise<SplitRule | null> {
  const keys = [
    ...(eventId ? [`${eventId}:${purpose}`, `${eventId}:*`] : []),
    `*:${purpose}`, "*:*"
  ];
  const rows = await sql<Row[]>`
    SELECT DISTINCT ON (scope_key) * FROM revenue_split_rules
    WHERE organization_id = ${organizationId} AND scope_key = ANY(${keys})
    ORDER BY scope_key, version DESC
  `;
  const byKey = new Map(rows.map(row => [row.scope_key as string, mapRule(row)]));
  for (const key of keys) if (byKey.has(key)) return byKey.get(key)!;
  return null;
}

function accountFor(line: SplitLine, payee: { type: string; id: string } | null): string {
  switch (line.partyType) {
    case "platform": return "platform_revenue";
    case "tenant": return "tenant_revenue";
    case "payee": return payee ? `payable:${payee.type}:${payee.id}` : "tenant_revenue";
    default: return `payable:${line.partyType}:${line.partyId}`;
  }
}

/** Pure projection of a rule onto an amount (used for fee transparency quotes too). */
export function computeAllocations(
  grossMinor: number,
  rule: SplitRuleDefinition,
  payee: { type: string; id: string } | null
): Allocation[] {
  const amounts = allocateSplit(grossMinor, rule);
  return rule.lines.map((line, index) => ({
    partyType: line.partyType,
    partyId: line.partyType === "payee" ? payee?.id ?? null : line.partyId,
    accountCode: accountFor(line, payee),
    amountMinor: amounts[index]!
  }));
}

export async function quoteSplit(
  sql: Sql,
  organizationId: string,
  input: { eventId: string | null; purpose: PaymentPurpose; grossMinor: number; payee: { type: string; id: string } | null }
): Promise<{ ruleId: string | null; ruleVersion: number | null; allocations: Allocation[] }> {
  const rule = await resolveSplitRule(sql, organizationId, input.eventId, input.purpose);
  const definition = rule ?? defaultSplitRule(input.payee !== null);
  return { ruleId: rule?.id ?? null, ruleVersion: rule?.version ?? null, allocations: computeAllocations(input.grossMinor, definition, input.payee) };
}

/** Move a settled payment out of sales_clearing into party accounts (one split transaction). */
export async function applySplit(tx: Sql, order: PaymentOrder, rule?: SplitRule | null, actorAccountId: string | null = null): Promise<string | null> {
  if (order.amountMinor === 0 || order.status !== "succeeded") return null;
  const resolved = rule === undefined ? await resolveSplitRule(tx, order.organizationId, order.eventId, order.purpose) : rule;
  const definition = resolved ?? defaultSplitRule(order.payeeId !== null);
  const payee = order.payeeType && order.payeeId ? { type: order.payeeType, id: order.payeeId } : null;
  const allocations = computeAllocations(order.amountMinor, definition, payee);
  const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM payment_allocations WHERE organization_id = ${order.organizationId} AND order_id = ${order.id}`;
  const lines: LedgerLine[] = [
    { accountCode: "sales_clearing", amountMinor: order.amountMinor },
    ...allocations.filter(a => a.amountMinor > 0).map(a => ({ accountCode: a.accountCode, amountMinor: -a.amountMinor }))
  ];
  const posted = await postLedgerTransaction(tx, {
    organizationId: order.organizationId, currency: order.currency, kind: "split",
    idempotencyKey: `split:${order.id}:${(count?.n ?? 0) + 1}`, sourceType: "payment_order", sourceId: order.id,
    memo: resolved ? `Split rule v${resolved.version}` : "Default split", postedByAccountId: actorAccountId, lines
  });
  await tx`
    INSERT INTO payment_allocations (organization_id, order_id, rule_id, ledger_transaction_id, gross_minor, remainder_line, allocations)
    VALUES (${order.organizationId}, ${order.id}, ${resolved?.id ?? null}, ${posted.id}, ${order.amountMinor}, ${definition.remainderLine},
      ${tx.json(allocations as unknown as Parameters<typeof tx.json>[0])})
  `;
  await recordAudit(tx, {
    organizationId: order.organizationId, actorAccountId, action: "split.applied", subjectType: "payment_order", subjectId: order.id,
    details: { ruleId: resolved?.id ?? null, ruleVersion: resolved?.version ?? null, ledgerTransactionId: posted.id, allocations }
  });
  return posted.id;
}

async function activeAllocation(tx: Sql, order: PaymentOrder) {
  const [row] = await tx<{ id: string; ledger_transaction_id: string; remainder_line: number; allocations: Allocation[] }[]>`
    SELECT id, ledger_transaction_id, remainder_line, allocations FROM payment_allocations
    WHERE organization_id = ${order.organizationId} AND order_id = ${order.id} AND active
  `;
  return row ?? null;
}

export async function getOrderAllocations(organizationId: string, orderId: string): Promise<Allocation[] | null> {
  const [row] = await getSqlClient()<{ allocations: Allocation[] }[]>`
    SELECT allocations FROM payment_allocations WHERE organization_id = ${organizationId} AND order_id = ${orderId} AND active
  `;
  return row?.allocations ?? null;
}

/** Hooks: split on success; refunds come back out of each party proportionally. */
export const splitHooks: PaymentHooks = {
  async onSucceeded(tx, order) {
    await applySplit(tx, order);
  },
  async refundLines(tx, order, amountMinor, previouslyRefundedMinor) {
    const allocation = await activeAllocation(tx, order);
    if (!allocation) {
      return [{ accountCode: "sales_clearing", amountMinor }, { accountCode: "provider_clearing", amountMinor: -amountMinor }];
    }
    const delta = refundAllocationDelta(allocation.allocations.map(a => a.amountMinor), allocation.remainder_line, previouslyRefundedMinor, amountMinor);
    return [
      ...allocation.allocations.map((a, index) => ({ accountCode: a.accountCode, amountMinor: delta[index]! })).filter(l => l.amountMinor !== 0),
      { accountCode: "provider_clearing", amountMinor: -amountMinor }
    ];
  }
};

/**
 * Correct a split: reverse the active split transaction and repost with the
 * given rule version. Only allowed before any refund touched the order.
 */
export async function adjustSplit(organizationId: string, orderId: string, ruleId: string, actorAccountId: string): Promise<{ ledgerTransactionId: string; allocations: Allocation[] }> {
  return getSqlClient().begin(async tx => {
    const order = await lockOrder(tx, organizationId, orderId);
    if (!order) throw new DomainError("order_not_found");
    if (order.status !== "succeeded" || order.amountMinor === 0) throw new DomainError("invalid_state_not_paid");
    if (order.refundedMinor > 0) throw new DomainError("invalid_state_refunded");
    const pending = await tx`SELECT 1 FROM payment_refunds WHERE organization_id = ${organizationId} AND order_id = ${orderId} AND status = 'pending'`;
    if (pending.length > 0) throw new DomainError("invalid_state_refund_pending");
    const rule = await getSplitRule(tx, organizationId, ruleId);
    if (!rule) throw new DomainError("split_rule_not_found");
    const current = await activeAllocation(tx, order);
    if (current) {
      await reverseLedgerTransaction(tx, organizationId, current.ledger_transaction_id, {
        idempotencyKey: `split-reversal:${current.id}`, memo: "Split adjustment", postedByAccountId: actorAccountId
      });
      await tx`UPDATE payment_allocations SET active = false, superseded_at = now() WHERE id = ${current.id}`;
    }
    const ledgerTransactionId = await applySplit(tx, order, rule, actorAccountId);
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "split.adjusted", subjectType: "payment_order", subjectId: orderId,
      details: { ruleId, ruleVersion: rule.version, reversedTransactionId: current?.ledger_transaction_id ?? null }
    });
    return { ledgerTransactionId: ledgerTransactionId!, allocations: (await activeAllocation(tx, order))!.allocations };
  });
}

export interface StatementLine { transactionId: string; kind: string; postedAt: Date; amountMinor: number; memo: string | null; sourceId: string | null }
export interface PayoutStatement {
  accountCode: string;
  currency: string;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  /** Amount owed to the party (liability/revenue balances are credits, i.e. negative). */
  owedMinor: number;
  lines: StatementLine[];
}

export function partyAccountCode(partyType: string, partyId: string | null): string {
  if (partyType === "platform") return "platform_revenue";
  if (partyType === "tenant") return "tenant_revenue";
  if (["promoter", "performer", "rights_owner", "participant", "account"].includes(partyType) && isUuid(partyId)) return `payable:${partyType}:${partyId}`;
  throw new DomainError("invalid_split_party");
}

/** Ledger statement for one party account and currency over a window. */
export async function payoutStatement(
  organizationId: string,
  input: { accountCode: string; currency: string; from: Date; to: Date }
): Promise<PayoutStatement> {
  const currency = normalizeCurrency(input.currency);
  if (!(input.to > input.from)) throw new DomainError("invalid_window");
  const sql = getSqlClient();
  const [opening] = await sql<{ total: string }[]>`
    SELECT coalesce(sum(e.amount_minor), 0)::text AS total
    FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.ledger_account_id JOIN ledger_transactions t ON t.id = e.transaction_id
    WHERE a.organization_id = ${organizationId} AND a.code = ${input.accountCode} AND a.currency = ${currency} AND t.posted_at < ${input.from}
  `;
  const rows = await sql<{ id: string; kind: string; posted_at: Date; amount: string; memo: string | null; source_id: string | null }[]>`
    SELECT t.id, t.kind, t.posted_at, e.amount_minor::text AS amount, t.memo, t.source_id
    FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.ledger_account_id JOIN ledger_transactions t ON t.id = e.transaction_id
    WHERE a.organization_id = ${organizationId} AND a.code = ${input.accountCode} AND a.currency = ${currency}
      AND t.posted_at >= ${input.from} AND t.posted_at < ${input.to}
    ORDER BY e.id LIMIT 5000
  `;
  const lines = rows.map(row => ({ transactionId: row.id, kind: row.kind, postedAt: row.posted_at, amountMinor: Number(row.amount), memo: row.memo, sourceId: row.source_id }));
  const openingBalanceMinor = Number(opening?.total ?? 0);
  const closingBalanceMinor = openingBalanceMinor + lines.reduce((sum, line) => sum + line.amountMinor, 0);
  return { accountCode: input.accountCode, currency, openingBalanceMinor, closingBalanceMinor, owedMinor: -closingBalanceMinor, lines };
}
