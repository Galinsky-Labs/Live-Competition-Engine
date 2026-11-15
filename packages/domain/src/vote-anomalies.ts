/**
 * LC-29 pure anomaly detectors for ballots. They only produce flags for human
 * review; nothing here (or in the service) deletes or voids ballots.
 * Timestamps are epoch milliseconds.
 */
import { DomainError } from "./index.ts";

export interface BurstOptions {
  bucketMs: number;
  /** A bucket must hold at least this many ballots to be flagged. */
  minCount: number;
  /** ...and exceed `factor` × the median of non-empty buckets. */
  factor: number;
}

export interface Burst {
  bucketStart: number;
  count: number;
  median: number;
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const positive = (value: number) => Number.isFinite(value) && value > 0;

/** Buckets whose ballot count is far above the typical (median) non-empty bucket. */
export function detectBursts(timestamps: readonly number[], options: BurstOptions): Burst[] {
  if (!positive(options.bucketMs) || !Number.isInteger(options.minCount) || options.minCount < 1 || !positive(options.factor)) {
    throw new DomainError("invalid_detector_options");
  }
  const buckets = new Map<number, number>();
  for (const at of timestamps) {
    const start = Math.floor(at / options.bucketMs) * options.bucketMs;
    buckets.set(start, (buckets.get(start) ?? 0) + 1);
  }
  const typical = median([...buckets.values()]);
  return [...buckets.entries()]
    .filter(([, count]) => count >= options.minCount && count > options.factor * typical)
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, count]) => ({ bucketStart, count, median: typical }));
}

export interface NewAccountOptions {
  /** Accounts created less than this long before the reference time (or after it) are "new". */
  newAccountMs: number;
  maxRatio: number;
  minBallots: number;
}

export interface NewAccountRatio {
  total: number;
  newCount: number;
  ratio: number;
  flagged: boolean;
}

export function newAccountRatio(accountCreatedAt: readonly number[], referenceTime: number, options: NewAccountOptions): NewAccountRatio {
  if (!positive(options.newAccountMs) || !(options.maxRatio >= 0 && options.maxRatio <= 1) || !Number.isInteger(options.minBallots) || options.minBallots < 1) {
    throw new DomainError("invalid_detector_options");
  }
  const total = accountCreatedAt.length;
  const newCount = accountCreatedAt.filter(created => created > referenceTime - options.newAccountMs).length;
  const ratio = total === 0 ? 0 : newCount / total;
  return { total, newCount, ratio, flagged: total >= options.minBallots && ratio > options.maxRatio };
}

export interface TimingOptions {
  /** Consecutive ballots no further apart than this are chained into one cluster. */
  toleranceMs: number;
  minClusterSize: number;
}

export interface TimingCluster {
  ids: string[];
  start: number;
  end: number;
}

/** Groups of ballots cast at (near-)identical instants, a common scripted-voting signature. */
export function identicalTimingClusters(items: readonly { id: string; at: number }[], options: TimingOptions): TimingCluster[] {
  if (!(options.toleranceMs >= 0) || !Number.isInteger(options.minClusterSize) || options.minClusterSize < 2) {
    throw new DomainError("invalid_detector_options");
  }
  const sorted = [...items].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const clusters: TimingCluster[] = [];
  let current: { id: string; at: number }[] = [];
  const flush = () => {
    if (current.length >= options.minClusterSize) {
      clusters.push({ ids: current.map(item => item.id), start: current[0]!.at, end: current[current.length - 1]!.at });
    }
    current = [];
  };
  for (const item of sorted) {
    if (current.length > 0 && item.at - current[current.length - 1]!.at > options.toleranceMs) flush();
    current.push(item);
  }
  flush();
  return clusters;
}

export const defaultDetectorOptions = {
  burst: { bucketMs: 10_000, minCount: 20, factor: 5 },
  newAccounts: { newAccountMs: 24 * 60 * 60 * 1000, maxRatio: 0.5, minBallots: 20 },
  timing: { toleranceMs: 50, minClusterSize: 5 }
} as const;
