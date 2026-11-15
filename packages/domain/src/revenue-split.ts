import { DomainError, isUuid } from "./index.ts";
import { MAX_MINOR_AMOUNT } from "./money.ts";

/**
 * Revenue split rules. A rule is an ordered list of lines; each line takes an
 * optional fixed amount and/or a percentage (basis points). Allocation order:
 *
 * 1. Fixed amounts in line order, each capped at what is still unallocated
 *    (small payments never go negative; earlier lines win).
 * 2. Percentages apply to the amount left after fixed amounts:
 *    floor(net * bps / 10000) per line.
 * 3. Everything left (rounding dust and unallocated percentage) goes to the
 *    rule's remainder line.
 *
 * The result is deterministic and always sums exactly to the gross amount.
 */
export const splitPartyTypes = ["platform", "tenant", "promoter", "performer", "rights_owner", "payee"] as const;
export type SplitPartyType = (typeof splitPartyTypes)[number];

export interface SplitLine {
  partyType: SplitPartyType;
  /** Required for promoter/performer/rights_owner; null for platform, tenant and payee. */
  partyId: string | null;
  bps: number;
  fixedMinor: number;
}

export interface SplitRuleDefinition {
  lines: SplitLine[];
  remainderLine: number;
}

const NAMED_PARTY: readonly SplitPartyType[] = ["promoter", "performer", "rights_owner"];

export function validateSplitRule(input: unknown): SplitRuleDefinition {
  const raw = input as { lines?: unknown; remainderLine?: unknown } | null;
  if (!raw || !Array.isArray(raw.lines) || raw.lines.length < 1 || raw.lines.length > 20) throw new DomainError("invalid_split_rule");
  const seen = new Set<string>();
  let bpsTotal = 0;
  const lines = raw.lines.map((value): SplitLine => {
    const line = value as Partial<SplitLine> | null;
    if (!line || !splitPartyTypes.includes(line.partyType as SplitPartyType)) throw new DomainError("invalid_split_party");
    const partyType = line.partyType as SplitPartyType;
    const named = NAMED_PARTY.includes(partyType);
    const partyId = line.partyId ?? null;
    if (named ? !isUuid(partyId) : partyId !== null) throw new DomainError("invalid_split_party");
    const bps = line.bps ?? 0;
    const fixedMinor = line.fixedMinor ?? 0;
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) throw new DomainError("invalid_split_bps");
    if (!Number.isSafeInteger(fixedMinor) || fixedMinor < 0 || fixedMinor > MAX_MINOR_AMOUNT) throw new DomainError("invalid_split_fixed");
    const key = `${partyType}:${partyId ?? ""}`;
    if (seen.has(key)) throw new DomainError("duplicate_split_party");
    seen.add(key);
    bpsTotal += bps;
    return { partyType, partyId: partyId as string | null, bps, fixedMinor };
  });
  if (bpsTotal > 10_000) throw new DomainError("invalid_split_bps");
  const remainderLine = raw.remainderLine ?? lines.findIndex(l => l.partyType === "tenant");
  if (!Number.isSafeInteger(remainderLine) || (remainderLine as number) < 0 || (remainderLine as number) >= lines.length) {
    throw new DomainError("invalid_split_remainder");
  }
  return { lines, remainderLine: remainderLine as number };
}

/** Allocate a gross amount across the rule's lines (see module doc). */
export function allocateSplit(grossMinor: number, rule: SplitRuleDefinition): number[] {
  if (!Number.isSafeInteger(grossMinor) || grossMinor < 0 || grossMinor > MAX_MINOR_AMOUNT) throw new DomainError("invalid_amount");
  const amounts = rule.lines.map(() => 0);
  let left = grossMinor;
  rule.lines.forEach((line, index) => {
    const fixed = Math.min(line.fixedMinor, left);
    amounts[index]! += fixed;
    left -= fixed;
  });
  const net = left;
  rule.lines.forEach((line, index) => {
    const share = Number((BigInt(net) * BigInt(line.bps)) / 10_000n);
    amounts[index]! += share;
    left -= share;
  });
  amounts[rule.remainderLine]! += left;
  return amounts;
}

/**
 * Cumulative proportional refund: how much of the refunded total (before+now)
 * each original allocation bears, minus what it already bore. Floors per line
 * with the remainder line absorbing rounding, so a full refund returns every
 * allocation exactly and successive partial refunds never drift.
 */
export function refundAllocationDelta(
  allocations: readonly number[],
  remainderLine: number,
  refundedBeforeMinor: number,
  refundNowMinor: number
): number[] {
  const gross = allocations.reduce((a, b) => a + b, 0);
  if (refundNowMinor <= 0 || refundedBeforeMinor < 0 || refundedBeforeMinor + refundNowMinor > gross) throw new DomainError("invalid_amount");
  const target = (refunded: number) => {
    const parts = allocations.map((a, index) => (index === remainderLine ? 0 : Number((BigInt(refunded) * BigInt(a)) / BigInt(gross))));
    parts[remainderLine] = refunded - parts.reduce((x, y) => x + y, 0);
    return parts;
  };
  const before = target(refundedBeforeMinor);
  const after = target(refundedBeforeMinor + refundNowMinor);
  return after.map((value, index) => value - before[index]!);
}

/** Default when a tenant has configured nothing: everything to the payee if any, else the tenant. */
export function defaultSplitRule(hasPayee: boolean): SplitRuleDefinition {
  return { lines: [{ partyType: hasPayee ? "payee" : "tenant", partyId: null, bps: 0, fixedMinor: 0 }], remainderLine: 0 };
}
