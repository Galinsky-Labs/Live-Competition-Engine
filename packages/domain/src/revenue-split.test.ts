import { describe, expect, it } from "vitest";
import { allocateSplit, defaultSplitRule, refundAllocationDelta, validateSplitRule, type SplitRuleDefinition } from "./revenue-split.ts";

const performer = "11111111-1111-4111-8111-111111111111";
const rights = "22222222-2222-4222-8222-222222222222";

const rule: SplitRuleDefinition = validateSplitRule({
  lines: [
    { partyType: "platform", bps: 500, fixedMinor: 30 },
    { partyType: "tenant", bps: 2000 },
    { partyType: "performer", partyId: performer, bps: 6000 },
    { partyType: "rights_owner", partyId: rights, bps: 1000 }
  ],
  remainderLine: 1
});

let seed = 7;
const rand = (max: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % max; };

describe("revenue split rules", () => {
  it("validates parties, basis points and remainder", () => {
    expect(() => validateSplitRule({ lines: [] })).toThrow("invalid_split_rule");
    expect(() => validateSplitRule({ lines: [{ partyType: "performer", bps: 10 }] })).toThrow("invalid_split_party");
    expect(() => validateSplitRule({ lines: [{ partyType: "tenant", partyId: performer }] })).toThrow("invalid_split_party");
    expect(() => validateSplitRule({ lines: [{ partyType: "tenant", bps: 6000 }, { partyType: "platform", bps: 5000 }] })).toThrow("invalid_split_bps");
    expect(() => validateSplitRule({ lines: [{ partyType: "tenant" }, { partyType: "tenant" }] })).toThrow("duplicate_split_party");
    expect(() => validateSplitRule({ lines: [{ partyType: "platform", bps: 100 }] })).toThrow("invalid_split_remainder");
    expect(validateSplitRule({ lines: [{ partyType: "platform", bps: 100 }, { partyType: "tenant" }] }).remainderLine).toBe(1);
  });

  it("allocates fixed then percentage with remainder to the designated line", () => {
    // gross 1000: fixed 30 -> net 970; 5% = 48, 20% = 194, 60% = 582, 10% = 97; remainder 49 -> tenant.
    expect(allocateSplit(1000, rule)).toEqual([78, 243, 582, 97]);
    // Fixed fees larger than the payment are capped, never negative.
    expect(allocateSplit(10, rule)).toEqual([10, 0, 0, 0]);
    expect(allocateSplit(0, rule)).toEqual([0, 0, 0, 0]);
    expect(allocateSplit(500, defaultSplitRule(true))).toEqual([500]);
  });

  it("always sums to the gross amount and never goes negative (property)", () => {
    for (let i = 0; i < 3000; i += 1) {
      const lineCount = 1 + rand(6);
      let bpsLeft = 10_000;
      const lines = Array.from({ length: lineCount }, (_, index) => {
        const bps = rand(bpsLeft + 1);
        bpsLeft -= bps;
        return { partyType: "performer" as const, partyId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, bps, fixedMinor: rand(3) === 0 ? rand(500) : 0 };
      });
      const r = validateSplitRule({ lines, remainderLine: rand(lineCount) });
      const gross = rand(2_000_000);
      const parts = allocateSplit(gross, r);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(gross);
      parts.forEach(p => expect(p).toBeGreaterThanOrEqual(0));
      expect(allocateSplit(gross, r)).toEqual(parts); // deterministic
    }
  });

  it("cumulative partial refunds return exactly the original allocations", () => {
    for (let i = 0; i < 500; i += 1) {
      const gross = 1 + rand(100_000);
      const allocations = allocateSplit(gross, rule);
      let refunded = 0;
      const returned = allocations.map(() => 0);
      while (refunded < gross) {
        const now = Math.min(gross - refunded, 1 + rand(Math.max(1, Math.floor(gross / 3))));
        const delta = refundAllocationDelta(allocations, rule.remainderLine, refunded, now);
        expect(delta.reduce((a, b) => a + b, 0)).toBe(now);
        delta.forEach((d, index) => { returned[index]! += d; });
        refunded += now;
      }
      expect(returned).toEqual(allocations);
    }
    expect(() => refundAllocationDelta([10, 10], 0, 15, 6)).toThrow("invalid_amount");
  });
});
