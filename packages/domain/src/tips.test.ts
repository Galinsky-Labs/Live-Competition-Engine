import { describe, expect, it } from "vitest";
import { assertQuoteAccepted, assertTipAmount, assertVelocity, DEFAULT_TIP_POLICY, feeBreakdown, validateTipPolicy } from "./tips.ts";

describe("tip rules", () => {
  it("enforces amount bounds and velocity", () => {
    expect(() => assertTipAmount(99, DEFAULT_TIP_POLICY)).toThrow("tip_amount_out_of_range");
    expect(() => assertTipAmount(100, DEFAULT_TIP_POLICY)).not.toThrow();
    expect(() => assertVelocity({ count: 9, amountMinor: 0 }, 100, DEFAULT_TIP_POLICY)).not.toThrow();
    expect(() => assertVelocity({ count: 10, amountMinor: 0 }, 100, DEFAULT_TIP_POLICY)).toThrow("rate_limited");
    expect(() => assertVelocity({ count: 0, amountMinor: 99_950 }, 100, DEFAULT_TIP_POLICY)).toThrow("rate_limited");
  });

  it("validates tenant policies", () => {
    expect(validateTipPolicy({ ...DEFAULT_TIP_POLICY }).maxMinor).toBe(50_000);
    expect(() => validateTipPolicy({ ...DEFAULT_TIP_POLICY, maxMinor: 1 })).toThrow("invalid_tip_policy");
    expect(() => validateTipPolicy({ ...DEFAULT_TIP_POLICY, windowSeconds: 1 })).toThrow("invalid_tip_policy");
  });

  it("produces a balanced fee breakdown and detects changed quotes", () => {
    const breakdown = feeBreakdown(1000, [
      { partyType: "platform", partyId: null, amountMinor: 50 },
      { partyType: "payee", partyId: "p", amountMinor: 950 },
      { partyType: "tenant", partyId: null, amountMinor: 0 }
    ]);
    expect(breakdown).toEqual({ grossMinor: 1000, payeeMinor: 950, fees: [{ partyType: "platform", partyId: null, amountMinor: 50 }] });
    expect(() => assertQuoteAccepted(breakdown, { grossMinor: 1000, payeeMinor: 950 })).not.toThrow();
    expect(() => assertQuoteAccepted(breakdown, { grossMinor: 1000, payeeMinor: 951 })).toThrow("quote_changed");
    expect(() => feeBreakdown(1000, [{ partyType: "payee", partyId: "p", amountMinor: 999 }])).toThrow("ledger_unbalanced");
  });
});
