import { DomainError, isUuid } from "@live-competition-engine/domain";
import { normalizeCurrency, requireMinorAmount } from "@live-competition-engine/domain/money";
import {
  CHECKOUT_EXPIRY_MINUTES,
  HOLD_MINUTES,
  remainingCapacity,
  salesOpen,
  type TicketKind,
  type TicketTypeInput
} from "@live-competition-engine/domain/ticketing";
import { recordAudit, type Sql } from "./audit.ts";
import { endGrantsForSource, hasActiveGrant, issueGrant } from "./entitlement-grants.ts";
import { isFeatureEnabled, requireEnabledFeature } from "./feature-guard.ts";
import { getSqlClient } from "./index.ts";
import {
  cancelOrderInTransaction,
  completeFreeOrder,
  createPaymentOrder,
  startCheckout,
  type PaymentHooks,
  type PaymentOrder
} from "./payments.ts";
import type { PaymentProvider } from "./providers/payments.ts";

export interface TicketType {
  id: string;
  organizationId: string;
  eventId: string;
  kind: TicketKind;
  name: string;
  priceMinor: number;
  currency: string;
  capacity: number | null;
  reserved: number;
  salesStartsAt: Date | null;
  salesEndsAt: Date | null;
  status: "on_sale" | "paused" | "archived";
  revision: number;
}

type Row = Record<string, unknown>;
const mapType = (row: Row): TicketType => ({
  id: row.id as string,
  organizationId: row.organization_id as string,
  eventId: row.event_id as string,
  kind: row.kind as TicketKind,
  name: row.name as string,
  priceMinor: Number(row.price_minor),
  currency: row.currency as string,
  capacity: row.capacity === null ? null : Number(row.capacity),
  reserved: Number(row.reserved),
  salesStartsAt: (row.sales_starts_at as Date | null) ?? null,
  salesEndsAt: (row.sales_ends_at as Date | null) ?? null,
  status: row.status as TicketType["status"],
  revision: Number(row.revision)
});

const featureFor = (kind: TicketKind) => (kind === "ppv" ? "ppv" : "ticketing") as "ppv" | "ticketing";

/** Public projection: price and remaining capacity, never internal counters. */
export function ticketTypeView(type: TicketType, now = new Date()) {
  return {
    id: type.id, eventId: type.eventId, kind: type.kind, name: type.name, priceMinor: type.priceMinor, currency: type.currency,
    remaining: remainingCapacity(type), salesStartsAt: type.salesStartsAt, salesEndsAt: type.salesEndsAt,
    status: type.status, onSale: salesOpen(type, now)
  };
}

export async function createTicketType(organizationId: string, eventId: string, input: TicketTypeInput, actorAccountId: string): Promise<TicketType> {
  await requireEnabledFeature(featureFor(input.kind), { organizationId, eventId });
  return getSqlClient().begin(async tx => {
    const [row] = await tx<Row[]>`
      INSERT INTO ticket_types (organization_id, event_id, kind, name, price_minor, currency, capacity, sales_starts_at, sales_ends_at, created_by_account_id)
      VALUES (${organizationId}, ${eventId}, ${input.kind}, ${input.name}, ${input.priceMinor}, ${input.currency}, ${input.capacity},
        ${input.salesStartsAt}, ${input.salesEndsAt}, ${actorAccountId})
      RETURNING *
    `;
    const type = mapType(row!);
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "ticketing.type_created", subjectType: "ticket_type", subjectId: type.id,
      details: { eventId, kind: input.kind, priceMinor: input.priceMinor, currency: input.currency, capacity: input.capacity }
    });
    return type;
  });
}

export async function setTicketTypeStatus(
  organizationId: string, eventId: string, ticketTypeId: string, status: TicketType["status"], expectedRevision: number, actorAccountId: string
): Promise<TicketType> {
  if (!isUuid(ticketTypeId)) throw new DomainError("ticket_type_not_found");
  return getSqlClient().begin(async tx => {
    const [row] = await tx<Row[]>`
      UPDATE ticket_types SET status = ${status}, revision = revision + 1, updated_at = now()
      WHERE organization_id = ${organizationId} AND event_id = ${eventId} AND id = ${ticketTypeId} AND revision = ${expectedRevision}
        AND status <> 'archived'
      RETURNING *
    `;
    if (!row) {
      const exists = await tx`SELECT 1 FROM ticket_types WHERE organization_id = ${organizationId} AND event_id = ${eventId} AND id = ${ticketTypeId}`;
      throw new DomainError(exists.length ? "ticket_type_revision_conflict" : "ticket_type_not_found");
    }
    await recordAudit(tx, { organizationId, actorAccountId, action: "ticketing.type_status", subjectType: "ticket_type", subjectId: ticketTypeId, details: { status } });
    return mapType(row);
  });
}

/**
 * Ticket types an event offers, filtered to families enabled for this
 * event/account. A disabled family contributes nothing (no price surfaces).
 */
export async function listTicketTypes(organizationId: string, eventId: string, accountId?: string): Promise<TicketType[]> {
  const enabled: TicketKind[] = [];
  for (const kind of ["ticket", "ppv"] as const) {
    if (await isFeatureEnabled(featureFor(kind), { organizationId, eventId, ...(accountId ? { accountId } : {}) })) enabled.push(kind);
  }
  if (enabled.length === 0) return [];
  const rows = await getSqlClient()<Row[]>`
    SELECT * FROM ticket_types
    WHERE organization_id = ${organizationId} AND event_id = ${eventId} AND kind = ANY(${enabled}) AND status <> 'archived'
    ORDER BY price_minor, name LIMIT 100
  `;
  return rows.map(mapType);
}

export interface PurchaseResult {
  order: PaymentOrder;
  redirectUrl: string | null;
}

/**
 * Buy one ticket/PPV pass. Capacity is reserved atomically in the same
 * transaction as the order (conditional UPDATE + CHECK constraint), so
 * concurrent buyers can never oversell. Free tickets complete immediately
 * without any provider call. Retrying with the same idempotency key resumes
 * the same order.
 */
export async function purchaseTicket(
  organizationId: string,
  input: { eventId: string; ticketTypeId: string; accountId: string; idempotencyKey: string },
  provider: PaymentProvider,
  urls: (orderId: string) => { successUrl: string; cancelUrl: string },
  hooks: PaymentHooks,
  now = new Date()
): Promise<PurchaseResult> {
  if (!isUuid(input.ticketTypeId) || !isUuid(input.eventId)) throw new DomainError("ticket_type_not_found");
  const sql = getSqlClient();
  const [typeRow] = await sql<Row[]>`
    SELECT * FROM ticket_types WHERE organization_id = ${organizationId} AND event_id = ${input.eventId} AND id = ${input.ticketTypeId}
  `;
  if (!typeRow) throw new DomainError("ticket_type_not_found");
  const type = mapType(typeRow);
  await requireEnabledFeature(featureFor(type.kind), { organizationId, eventId: type.eventId, accountId: input.accountId });

  const order = await sql.begin(async tx => {
    const { order, created } = await createPaymentOrder(tx, {
      organizationId, accountId: input.accountId, eventId: type.eventId, purpose: type.kind, subjectId: type.id,
      description: type.name, amountMinor: type.priceMinor, currency: type.currency, provider: provider.name,
      idempotencyKey: input.idempotencyKey
    });
    if (!created) return order;
    if (!salesOpen(type, now)) throw new DomainError("sales_closed");
    const reserved = await tx`
      UPDATE ticket_types SET reserved = reserved + 1, updated_at = now()
      WHERE organization_id = ${organizationId} AND id = ${type.id} AND status = 'on_sale'
        AND (capacity IS NULL OR reserved < capacity)
      RETURNING id
    `;
    if (reserved.length !== 1) throw new DomainError("sold_out");
    const live = await tx`
      SELECT 1 FROM ticket_reservations
      WHERE organization_id = ${organizationId} AND ticket_type_id = ${type.id} AND account_id = ${input.accountId} AND status IN ('held', 'issued')
    `;
    if (live.length > 0) throw new DomainError("ticket_conflict_already_held");
    await tx`
      INSERT INTO ticket_reservations (organization_id, ticket_type_id, order_id, account_id, expires_at)
      VALUES (${organizationId}, ${type.id}, ${order.id}, ${input.accountId}, ${new Date(now.getTime() + HOLD_MINUTES * 60_000)})
    `;
    if (order.amountMinor === 0) return completeFreeOrder(tx, order, hooks);
    return order;
  }).catch((error: unknown) => {
    // A concurrent second purchase by the same account trips the partial unique index.
    if ((error as { code?: string }).code === "23505") throw new DomainError("ticket_conflict_already_held");
    throw error;
  });

  if (order.amountMinor === 0 || order.status === "succeeded") return { order, redirectUrl: null };
  if (order.status !== "requires_payment" && order.status !== "processing") return { order, redirectUrl: null };
  const checkout = await startCheckout(organizationId, order.id, provider, urls(order.id), new Date(now.getTime() + CHECKOUT_EXPIRY_MINUTES * 60_000));
  return { order: checkout.order, redirectUrl: checkout.redirectUrl };
}

async function releaseReservation(tx: Sql, order: PaymentOrder, to: "released" | "refunded" | "revoked"): Promise<boolean> {
  const from = to === "released" ? ["held"] : ["issued", "held"];
  const [reservation] = await tx<{ id: string; ticket_type_id: string }[]>`
    UPDATE ticket_reservations SET status = ${to}, updated_at = now()
    WHERE organization_id = ${order.organizationId} AND order_id = ${order.id} AND status = ANY(${from})
    RETURNING id, ticket_type_id
  `;
  if (!reservation) return false;
  await tx`
    UPDATE ticket_types SET reserved = reserved - 1, updated_at = now()
    WHERE organization_id = ${order.organizationId} AND id = ${reservation.ticket_type_id}
  `;
  return true;
}

/** Payment hooks: issue grants on success, release holds on failure, refund grants on full refund. */
export const ticketingHooks: PaymentHooks = {
  async onSucceeded(tx, order) {
    if (order.purpose !== "ticket" && order.purpose !== "ppv") return;
    const issued = await tx`
      UPDATE ticket_reservations SET status = 'issued', updated_at = now()
      WHERE organization_id = ${order.organizationId} AND order_id = ${order.id} AND status = 'held'
      RETURNING id
    `;
    if (issued.length !== 1) {
      // No live hold (should be unreachable: expired holds cancel the order first). Never
      // issue without capacity; record it so reconciliation/operators refund.
      await recordAudit(tx, {
        organizationId: order.organizationId, actorAccountId: null, action: "ticketing.paid_without_hold",
        subjectType: "payment_order", subjectId: order.id, details: {}
      });
      return;
    }
    await issueGrant(tx, {
      organizationId: order.organizationId, accountId: order.accountId, eventId: order.eventId,
      capability: order.purpose === "ppv" ? "event.view" : "event.enter", source: "ticket",
      startsAt: Date.now(), expiresAt: null, sourceKind: "payment_order", sourceId: order.id
    });
  },
  async onFailed(tx, order) {
    if (order.purpose === "ticket" || order.purpose === "ppv") await releaseReservation(tx, order, "released");
  },
  async onRefunded(tx, order, _refund, fullyRefunded) {
    if (!fullyRefunded) return;
    if (order.purpose === "ticket" || order.purpose === "ppv") await releaseReservation(tx, order, "refunded");
    if (order.purpose === "ticket" || order.purpose === "ppv") {
      await endGrantsForSource(tx, order.organizationId, "payment_order", order.id, "refunded");
    }
  }
};

/** Operator revocation without refund (e.g. policy violation): grant revoked, seat released. */
export async function revokeTicket(organizationId: string, orderId: string, actorAccountId: string): Promise<number> {
  return getSqlClient().begin(async tx => {
    const [row] = await tx<Row[]>`SELECT * FROM payment_orders WHERE organization_id = ${organizationId} AND id = ${orderId} AND purpose IN ('ticket','ppv') FOR UPDATE`;
    if (!row) throw new DomainError("order_not_found");
    await releaseReservation(tx, { organizationId, id: orderId } as PaymentOrder, "revoked");
    return endGrantsForSource(tx, organizationId, "payment_order", orderId, "revoked", actorAccountId);
  });
}

/** Cancel unpaid orders whose capacity hold expired, freeing the seat. Run periodically. */
export async function releaseExpiredHolds(
  now = new Date(),
  options: { organizationId?: string; hooks?: PaymentHooks; limit?: number } = {}
): Promise<number> {
  const sql = getSqlClient();
  const hooks = options.hooks ?? ticketingHooks;
  const expired = await sql<{ organization_id: string; order_id: string }[]>`
    SELECT organization_id, order_id FROM ticket_reservations
    WHERE status = 'held' AND expires_at < ${now}
      ${options.organizationId ? sql`AND organization_id = ${options.organizationId}` : sql``}
    ORDER BY expires_at LIMIT ${Math.min(Math.max(options.limit ?? 200, 1), 1000)}
  `;
  let released = 0;
  for (const hold of expired) {
    await sql.begin(async tx => {
      try {
        await cancelOrderInTransaction(tx, hold.organization_id, hold.order_id, "hold_expired", hooks);
        released += 1;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
      }
    });
  }
  return released;
}

/* ------------------------------------------------------------------ */
/* Access gate                                                         */
/* ------------------------------------------------------------------ */

export interface AccessGate {
  /** False when the family is disabled or the event sells nothing of that kind: no paywall exists. */
  gated: boolean;
  allowed: boolean;
}

/**
 * Event access for entry ("enter", tickets) or viewing ("view", PPV). When the
 * family is disabled the gate disappears entirely rather than blocking.
 */
export async function checkEventAccess(
  organizationId: string,
  eventId: string,
  accountId: string | null,
  mode: "enter" | "view",
  now = Date.now()
): Promise<AccessGate> {
  const kind: TicketKind = mode === "view" ? "ppv" : "ticket";
  if (!(await isFeatureEnabled(featureFor(kind), { organizationId, eventId, ...(accountId ? { accountId } : {}) }))) {
    return { gated: false, allowed: true };
  }
  const offered = await getSqlClient()`
    SELECT 1 FROM ticket_types WHERE organization_id = ${organizationId} AND event_id = ${eventId} AND kind = ${kind} AND status <> 'archived' LIMIT 1
  `;
  if (offered.length === 0) return { gated: false, allowed: true };
  if (!accountId) return { gated: true, allowed: false };
  const allowed = await hasActiveGrant(organizationId, accountId, mode === "view" ? "event.view" : "event.enter", eventId, now);
  return { gated: true, allowed };
}

/* ------------------------------------------------------------------ */
/* Entry fees                                                          */
/* ------------------------------------------------------------------ */

export interface EntryFee { competitionId: string; priceMinor: number; currency: string; active: boolean; revision: number }

export async function setEntryFee(
  organizationId: string,
  competitionId: string,
  input: { priceMinor: number; currency: string; active: boolean; expectedRevision: number },
  actorAccountId: string
): Promise<EntryFee> {
  await requireEnabledFeature("entry_fees", { organizationId, eventId: competitionId });
  const priceMinor = requireMinorAmount(input.priceMinor, { allowZero: false });
  const currency = normalizeCurrency(input.currency);
  return getSqlClient().begin(async tx => {
    const rows = input.expectedRevision === 0
      ? await tx<Row[]>`
          INSERT INTO entry_fees (organization_id, competition_id, price_minor, currency, active, updated_by_account_id)
          VALUES (${organizationId}, ${competitionId}, ${priceMinor}, ${currency}, ${input.active}, ${actorAccountId})
          ON CONFLICT DO NOTHING RETURNING *`
      : await tx<Row[]>`
          UPDATE entry_fees SET price_minor = ${priceMinor}, currency = ${currency}, active = ${input.active},
            revision = revision + 1, updated_by_account_id = ${actorAccountId}, updated_at = now()
          WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND revision = ${input.expectedRevision}
          RETURNING *`;
    if (!rows[0]) throw new DomainError("entry_fee_revision_conflict");
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "entry_fee.configured", subjectType: "competition", subjectId: competitionId,
      details: { priceMinor, currency, active: input.active }
    });
    return { competitionId, priceMinor, currency, active: input.active, revision: Number(rows[0].revision) };
  });
}

async function readEntryFee(organizationId: string, competitionId: string): Promise<EntryFee | null> {
  const [row] = await getSqlClient()<Row[]>`SELECT * FROM entry_fees WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}`;
  return row ? { competitionId, priceMinor: Number(row.price_minor), currency: row.currency as string, active: row.active as boolean, revision: Number(row.revision) } : null;
}

/** True when the account holds a succeeded, not fully refunded entry-fee payment for the competition. */
export async function hasPaidEntryFee(organizationId: string, competitionId: string, accountId: string, sql: Sql = getSqlClient()): Promise<boolean> {
  if (!isUuid(organizationId) || !isUuid(competitionId) || !isUuid(accountId)) return false;
  const rows = await sql`
    SELECT 1 FROM payment_orders
    WHERE organization_id = ${organizationId} AND event_id = ${competitionId} AND account_id = ${accountId}
      AND purpose = 'entry_fee' AND status = 'succeeded' AND settlement_status <> 'refunded'
    LIMIT 1
  `;
  return rows.length === 1;
}

export type EntryFeeGate = { required: false } | { required: true; paid: boolean; priceMinor: number; currency: string };

/**
 * What an application flow should enforce. With entry_fees disabled (at any
 * scope) or no active fee, nothing is required and no price is exposed.
 */
export async function entryFeeGate(organizationId: string, competitionId: string, accountId: string): Promise<EntryFeeGate> {
  if (!(await isFeatureEnabled("entry_fees", { organizationId, eventId: competitionId, accountId }))) return { required: false };
  const fee = await readEntryFee(organizationId, competitionId);
  if (!fee || !fee.active) return { required: false };
  return { required: true, paid: await hasPaidEntryFee(organizationId, competitionId, accountId), priceMinor: fee.priceMinor, currency: fee.currency };
}

export async function purchaseEntryFee(
  organizationId: string,
  input: { competitionId: string; accountId: string; idempotencyKey: string },
  provider: PaymentProvider,
  urls: (orderId: string) => { successUrl: string; cancelUrl: string }
): Promise<PurchaseResult> {
  await requireEnabledFeature("entry_fees", { organizationId, eventId: input.competitionId, accountId: input.accountId });
  const fee = await readEntryFee(organizationId, input.competitionId);
  if (!fee || !fee.active) throw new DomainError("entry_fee_not_found");
  if (await hasPaidEntryFee(organizationId, input.competitionId, input.accountId)) throw new DomainError("entry_fee_conflict_already_paid");
  const { order } = await getSqlClient().begin(tx => createPaymentOrder(tx, {
    organizationId, accountId: input.accountId, eventId: input.competitionId, purpose: "entry_fee", subjectId: input.competitionId,
    description: "Entry fee", amountMinor: fee.priceMinor, currency: fee.currency, provider: provider.name, idempotencyKey: input.idempotencyKey
  }));
  if (order.status !== "requires_payment" && order.status !== "processing") return { order, redirectUrl: null };
  const checkout = await startCheckout(organizationId, order.id, provider, urls(order.id));
  return { order: checkout.order, redirectUrl: checkout.redirectUrl };
}
