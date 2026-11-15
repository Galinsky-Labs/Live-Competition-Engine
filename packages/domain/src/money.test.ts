import { describe, expect, it } from "vitest";
import {
  allocateProportionally,
  assertBalanced,
  compactLines,
  isLedgerAccountCode,
  ledgerAccountKind,
  normalizeCurrency,
  requireMinorAmount
} from "./money.ts";
import {
  assertOrderTransition,
  canTransitionOrder,
  isIdempotencyKey,
  refundableAmount,
  settlementAfterRefund
} from "./payments.ts";

const payee = "payable:participant:11111111-1111-4111-8111-111111111111";

describe("money primitives", () => {
  it("normalizes currencies and bounds minor amounts", () => {
    expect(normalizeCurrency("usd")).toBe("USD");
    expect(() => normalizeCurrency("US")).toThrow("invalid_currency");
    expect(requireMinorAmount(0)).toBe(0);
    expect(() => requireMinorAmount(0, { allowZero: false })).toThrow("invalid_amount");
    expect(() => requireMinorAmount(1.5)).toThrow("invalid_amount");
    expect(() => requireMinorAmount(-1)).toThrow("invalid_amount");
  });

  it("accepts only known ledger account codes", () => {
    expect(isLedgerAccountCode("provider_clearing")).toBe(true);
    expect(isLedgerAccountCode(payee)).toBe(true);
    expect(isLedgerAccountCode("payable:tenant:x")).toBe(false);
    expect(ledgerAccountKind(payee)).toBe("liability");
    expect(ledgerAccountKind("provider_clearing")).toBe("asset");
  });

  it("rejects imbalanced, single-line and zero-amount postings", () => {
    expect(() => assertBalanced([{ accountCode: "provider_clearing", amountMinor: 100 }, { accountCode: "sales_clearing", amountMinor: -100 }])).not.toThrow();
    expect(() => assertBalanced([{ accountCode: "provider_clearing", amountMinor: 100 }, { accountCode: "sales_clearing", amountMinor: -99 }])).toThrow("ledger_unbalanced");
    expect(() => assertBalanced([{ accountCode: "provider_clearing", amountMinor: 0 }, { accountCode: "sales_clearing", amountMinor: 0 }])).toThrow("invalid_amount");
    expect(() => assertBalanced([{ accountCode: "provider_clearing", amountMinor: 1 }])).toThrow("ledger_unbalanced");
    expect(() => assertBalanced([{ accountCode: "bogus", amountMinor: 1 }, { accountCode: "sales_clearing", amountMinor: -1 }])).toThrow("invalid_ledger_account");
  });

  it("compacts lines per account", () => {
    expect(compactLines([
      { accountCode: "sales_clearing", amountMinor: 5 },
      { accountCode: "sales_clearing", amountMinor: -5 },
      { accountCode: "tenant_revenue", amountMinor: 3 }
    ])).toEqual([{ accountCode: "tenant_revenue", amountMinor: 3 }]);
  });

  it("allocates proportionally with exact sums (property style)", () => {
    let seed = 42;
    const rand = (max: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % max; };
    for (let i = 0; i < 2000; i += 1) {
      const total = rand(1_000_000);
      const weights = Array.from({ length: 1 + rand(6) }, () => rand(10_000));
      if (!weights.some(w => w > 0)) weights[0] = 1;
      const parts = allocateProportionally(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      parts.forEach((part, index) => {
        expect(part).toBeGreaterThanOrEqual(0);
        if (weights[index] === 0) expect(part).toBe(0);
      });
    }
    expect(allocateProportionally(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(() => allocateProportionally(5, [0, 0])).toThrow("invalid_weights");
  });
});

describe("payment state machine", () => {
  it("allows only explicit transitions", () => {
    expect(canTransitionOrder("requires_payment", "processing")).toBe(true);
    expect(canTransitionOrder("processing", "succeeded")).toBe(true);
    expect(canTransitionOrder("succeeded", "failed")).toBe(false);
    expect(() => assertOrderTransition("cancelled", "succeeded")).toThrow("invalid_state_transition");
  });

  it("reserves pending refunds and computes settlement", () => {
    expect(refundableAmount(1000, [{ amountMinor: 300, status: "succeeded" }, { amountMinor: 200, status: "pending" }, { amountMinor: 999, status: "failed" }])).toBe(500);
    expect(settlementAfterRefund(1000, 0)).toBe("settled");
    expect(settlementAfterRefund(1000, 10)).toBe("partially_refunded");
    expect(settlementAfterRefund(1000, 1000)).toBe("refunded");
    expect(isIdempotencyKey("order-12345678")).toBe(true);
    expect(isIdempotencyKey("short")).toBe(false);
  });
});
