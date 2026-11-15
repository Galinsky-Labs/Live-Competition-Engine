import { describe, expect, it } from "vitest";
import { detectBursts, identicalTimingClusters, newAccountRatio } from "./vote-anomalies";

describe("burst detection", () => {
  const options = { bucketMs: 1000, minCount: 5, factor: 3 };
  it("flags buckets far above the median", () => {
    const steady = [0, 1000, 2000, 3000, 4000, 4500].map(at => at + 10);
    const spike = Array.from({ length: 12 }, (_, i) => 5000 + i * 10);
    expect(detectBursts([...steady, ...spike], options)).toEqual([{ bucketStart: 5000, count: 12, median: 1 }]);
  });
  it("does not flag uniform traffic or small buckets", () => {
    const uniform = Array.from({ length: 50 }, (_, i) => i * 200);
    expect(detectBursts(uniform, options)).toEqual([]);
    expect(detectBursts([1, 2, 3], options)).toEqual([]);
    expect(detectBursts([], options)).toEqual([]);
  });
  it("validates options", () => {
    expect(() => detectBursts([], { bucketMs: 0, minCount: 1, factor: 1 })).toThrow("invalid_detector_options");
  });
});

describe("new account ratio", () => {
  const day = 86_400_000;
  const options = { newAccountMs: day, maxRatio: 0.5, minBallots: 4 };
  it("flags windows dominated by freshly created accounts", () => {
    const reference = 10 * day;
    const created = [reference - 5 * day, reference - 2 * 3_600_000, reference + 1000, reference - 1000];
    expect(newAccountRatio(created, reference, options)).toEqual({ total: 4, newCount: 3, ratio: 0.75, flagged: true });
  });
  it("needs a minimum sample and respects the threshold", () => {
    expect(newAccountRatio([1, 2], 3, options).flagged).toBe(false);
    expect(newAccountRatio([0, 0, 0, 10 * 86_400_000], 10 * 86_400_000, options).flagged).toBe(false);
    expect(newAccountRatio([], 0, options)).toEqual({ total: 0, newCount: 0, ratio: 0, flagged: false });
    expect(() => newAccountRatio([], 0, { ...options, maxRatio: 2 })).toThrow("invalid_detector_options");
  });
});

describe("identical timing clusters", () => {
  const options = { toleranceMs: 5, minClusterSize: 3 };
  it("chains near-simultaneous ballots and ignores spread ones", () => {
    const items = [
      { id: "a", at: 100 }, { id: "b", at: 102 }, { id: "c", at: 104 }, { id: "d", at: 106 },
      { id: "e", at: 500 }, { id: "f", at: 900 }, { id: "g", at: 901 }
    ];
    expect(identicalTimingClusters(items, options)).toEqual([{ ids: ["a", "b", "c", "d"], start: 100, end: 106 }]);
  });
  it("is deterministic regardless of input order and breaks equal timestamps by id", () => {
    const items = [{ id: "z", at: 1 }, { id: "y", at: 1 }, { id: "x", at: 1 }];
    expect(identicalTimingClusters(items, options)).toEqual([{ ids: ["x", "y", "z"], start: 1, end: 1 }]);
    expect(identicalTimingClusters([...items].reverse(), options)).toEqual(identicalTimingClusters(items, options));
  });
  it("validates options", () => {
    expect(() => identicalTimingClusters([], { toleranceMs: 1, minClusterSize: 1 })).toThrow("invalid_detector_options");
  });
});
