import { DomainError } from "./index.ts";

/**
 * Money primitives. Amounts are integer minor units (e.g. cents) held in JS
 * numbers bounded well inside Number.MAX_SAFE_INTEGER; currencies are ISO-4217
 * upper-case codes. A transaction or order never mixes currencies.
 */
export const MAX_MINOR_AMOUNT = 1_000_000_000_000;

/** Currencies with zero or three minor digits are accepted as codes; minor units are opaque integers. */
export function normalizeCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value)) throw new DomainError("invalid_currency");
  return value.toUpperCase();
}

export function isMinorAmount(value: unknown, { allowZero = true }: { allowZero?: boolean } = {}): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value <= MAX_MINOR_AMOUNT &&
    (allowZero ? value >= 0 : value > 0);
}

export function requireMinorAmount(value: unknown, { allowZero = true }: { allowZero?: boolean } = {}): number {
  if (!isMinorAmount(value, { allowZero })) throw new DomainError("invalid_amount");
  return value;
}

export interface LedgerLine {
  accountCode: string;
  amountMinor: number;
}

const ACCOUNT_CODE = /^(platform_revenue|tenant_revenue|provider_clearing|sales_clearing|refunds|fees|payable:(promoter|performer|rights_owner|participant|account):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function isLedgerAccountCode(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_CODE.test(value);
}

export type LedgerAccountKind = "asset" | "liability" | "revenue" | "expense";

export function ledgerAccountKind(code: string): LedgerAccountKind {
  if (code === "provider_clearing") return "asset";
  if (code === "platform_revenue" || code === "tenant_revenue") return "revenue";
  if (code === "refunds" || code === "fees") return "expense";
  return "liability";
}

/**
 * Validate a double-entry posting: at least two non-zero integer lines, valid
 * account codes, and a sum of exactly zero (debits positive, credits negative).
 * The database re-checks the same invariant in a deferred constraint trigger.
 */
export function assertBalanced(lines: readonly LedgerLine[]): void {
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > 100) throw new DomainError("ledger_unbalanced");
  let sum = 0;
  for (const line of lines) {
    if (!isLedgerAccountCode(line.accountCode)) throw new DomainError("invalid_ledger_account");
    if (!Number.isSafeInteger(line.amountMinor) || line.amountMinor === 0 || Math.abs(line.amountMinor) > MAX_MINOR_AMOUNT) {
      throw new DomainError("invalid_amount");
    }
    sum += line.amountMinor;
  }
  if (sum !== 0) throw new DomainError("ledger_unbalanced");
}

/** Merge lines on the same account and drop zero results (keeps postings minimal and deterministic). */
export function compactLines(lines: readonly LedgerLine[]): LedgerLine[] {
  const totals = new Map<string, number>();
  for (const line of lines) totals.set(line.accountCode, (totals.get(line.accountCode) ?? 0) + line.amountMinor);
  return [...totals.entries()].filter(([, amount]) => amount !== 0).map(([accountCode, amountMinor]) => ({ accountCode, amountMinor }));
}

/**
 * Split `total` across non-negative integer weights proportionally using the
 * largest-remainder method. Ties are broken by lower index, so the result is
 * deterministic, and the parts always sum exactly to `total`.
 */
export function allocateProportionally(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0) throw new DomainError("invalid_amount");
  if (weights.some(w => !Number.isSafeInteger(w) || w < 0)) throw new DomainError("invalid_weights");
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0 || weightSum === 0) {
    if (total === 0) return weights.map(() => 0);
    throw new DomainError("invalid_weights");
  }
  // BigInt avoids precision loss in total * weight.
  const big = weights.map(w => BigInt(total) * BigInt(w));
  const base = big.map(v => v / BigInt(weightSum));
  const remainders = big.map((v, index) => ({ index, rem: v % BigInt(weightSum) }));
  let left = total - base.reduce((a, b) => a + Number(b), 0);
  remainders.sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  const result = base.map(Number);
  for (const { index } of remainders) {
    if (left <= 0) break;
    result[index]! += 1;
    left -= 1;
  }
  return result;
}
