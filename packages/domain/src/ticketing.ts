import { DomainError, isBoundedText } from "./index.ts";
import { normalizeCurrency, requireMinorAmount } from "./money.ts";

/** Capacity hold length; checkout sessions expire 5 minutes earlier so a late payment cannot outlive its hold. */
export const HOLD_MINUTES = 40;
export const CHECKOUT_EXPIRY_MINUTES = 35;

export type TicketKind = "ticket" | "ppv";

export interface TicketTypeInput {
  kind: TicketKind;
  name: string;
  priceMinor: number;
  currency: string;
  capacity: number | null;
  salesStartsAt: Date | null;
  salesEndsAt: Date | null;
}

const date = (value: unknown): Date | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new DomainError("invalid_sales_window");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new DomainError("invalid_sales_window");
  return parsed;
};

export function validateTicketTypeInput(body: Record<string, unknown>): TicketTypeInput {
  const kind = body.kind ?? "ticket";
  if (kind !== "ticket" && kind !== "ppv") throw new DomainError("invalid_ticket_kind");
  if (!isBoundedText(body.name, 120, 1) || body.name.trim().length === 0) throw new DomainError("invalid_name");
  const priceMinor = requireMinorAmount(body.priceMinor);
  const currency = normalizeCurrency(body.currency);
  const capacity = body.capacity ?? null;
  if (capacity !== null && (!Number.isSafeInteger(capacity) || (capacity as number) < 1 || (capacity as number) > 10_000_000)) {
    throw new DomainError("invalid_capacity");
  }
  const salesStartsAt = date(body.salesStartsAt);
  const salesEndsAt = date(body.salesEndsAt);
  if (salesStartsAt && salesEndsAt && salesEndsAt <= salesStartsAt) throw new DomainError("invalid_sales_window");
  return { kind, name: body.name.trim(), priceMinor, currency, capacity: capacity as number | null, salesStartsAt, salesEndsAt };
}

export function salesOpen(type: { status: string; salesStartsAt: Date | null; salesEndsAt: Date | null }, now: Date): boolean {
  if (type.status !== "on_sale") return false;
  if (type.salesStartsAt && now < type.salesStartsAt) return false;
  if (type.salesEndsAt && now >= type.salesEndsAt) return false;
  return true;
}

export function remainingCapacity(type: { capacity: number | null; reserved: number }): number | null {
  return type.capacity === null ? null : Math.max(0, type.capacity - type.reserved);
}
