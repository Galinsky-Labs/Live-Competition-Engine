import { DomainError } from "./index.ts";

export interface TipPolicy {
  minMinor: number;
  maxMinor: number;
  windowSeconds: number;
  maxCountPerWindow: number;
  maxAmountPerWindowMinor: number;
}

/** Conservative defaults used until a tenant configures its own policy. */
export const DEFAULT_TIP_POLICY: TipPolicy = {
  minMinor: 100,
  maxMinor: 50_000,
  windowSeconds: 3600,
  maxCountPerWindow: 10,
  maxAmountPerWindowMinor: 100_000
};

export function validateTipPolicy(input: Record<string, unknown>): TipPolicy {
  const n = (key: keyof TipPolicy, min: number, max: number) => {
    const value = input[key];
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new DomainError("invalid_tip_policy");
    return value as number;
  };
  const policy = {
    minMinor: n("minMinor", 1, 1_000_000_000),
    maxMinor: n("maxMinor", 1, 1_000_000_000),
    windowSeconds: n("windowSeconds", 60, 86_400 * 7),
    maxCountPerWindow: n("maxCountPerWindow", 1, 10_000),
    maxAmountPerWindowMinor: n("maxAmountPerWindowMinor", 1, 1_000_000_000_000)
  };
  if (policy.maxMinor < policy.minMinor || policy.maxAmountPerWindowMinor < policy.maxMinor) throw new DomainError("invalid_tip_policy");
  return policy;
}

export function assertTipAmount(amountMinor: number, policy: TipPolicy): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < policy.minMinor || amountMinor > policy.maxMinor) {
    throw new DomainError("tip_amount_out_of_range");
  }
}

/** Per-sender velocity: count and amount within the rolling window, including the new tip. */
export function assertVelocity(recent: { count: number; amountMinor: number }, amountMinor: number, policy: TipPolicy): void {
  if (recent.count + 1 > policy.maxCountPerWindow || recent.amountMinor + amountMinor > policy.maxAmountPerWindowMinor) {
    throw new DomainError("rate_limited");
  }
}

export interface FeeLine { partyType: string; partyId: string | null; amountMinor: number }
export interface FeeBreakdown { grossMinor: number; payeeMinor: number; fees: FeeLine[] }

/** Split the allocation into what the payee receives and every fee, shown before confirmation. */
export function feeBreakdown(grossMinor: number, allocations: readonly FeeLine[]): FeeBreakdown {
  const payeeMinor = allocations.filter(a => a.partyType === "payee").reduce((s, a) => s + a.amountMinor, 0);
  const fees = allocations.filter(a => a.partyType !== "payee" && a.amountMinor > 0);
  if (payeeMinor + fees.reduce((s, f) => s + f.amountMinor, 0) !== grossMinor) throw new DomainError("ledger_unbalanced");
  return { grossMinor, payeeMinor, fees };
}

/** The sender confirmed a specific quote; reject if price or fees changed since. */
export function assertQuoteAccepted(quote: FeeBreakdown, expected: { grossMinor: unknown; payeeMinor: unknown }): void {
  if (expected.grossMinor !== quote.grossMinor || expected.payeeMinor !== quote.payeeMinor) throw new DomainError("quote_changed");
}
