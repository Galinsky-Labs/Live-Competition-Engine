import { DomainError, isBoundedText } from "./index.ts";

/**
 * LC-20 configurable scoring. Everything here is pure and deterministic:
 * rubric validation, score validation, per-sheet scores, aggregation across judges,
 * optional per-judge z-score normalization, tie-breaking and ranking.
 *
 * Definitions
 *  - Sheet score (one judge, one performance): weighted mean of criterion values
 *    Σ wᵢvᵢ / Σ wᵢ, except for the `sum` method where it is the weighted sum Σ wᵢvᵢ.
 *  - Performance score: the sheet scores (optionally z-normalized per judge) aggregated by
 *    `weighted_mean` (arithmetic mean of sheet scores, which are criterion-weighted),
 *    `sum`, `median`, or `trimmed_mean` (drop `trim` highest and `trim` lowest; when fewer than
 *    2·trim+1 sheets exist, nothing is dropped and `trimApplied` is false).
 *  - Entry score: the sum of its performance scores in scope (one per performance; a single
 *    round normally has one performance per entry).
 */

export const aggregationMethods = ["weighted_mean", "sum", "median", "trimmed_mean"] as const;
export type AggregationMethod = (typeof aggregationMethods)[number];
export type Normalization = "none" | "z_score";
export type TieBreaker = { type: "criterion"; key: string } | { type: "judge_count" } | { type: "head_judge" };

export interface Criterion { key: string; label: string; min: number; max: number; step: number; weight: number; }
export interface Rubric {
  criteria: Criterion[];
  aggregation: { method: AggregationMethod; trim: number };
  normalization: Normalization;
  tieBreakers: TieBreaker[];
}

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const EPS = 1e-9;
const bad = (): never => { throw new DomainError("invalid_rubric"); };
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const onGrid = (value: number, min: number, step: number) => {
  const steps = (value - min) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-7;
};
/** Quantize to avoid floating-point noise deciding ranks. */
export const quantize = (x: number) => Math.round(x * 1e9) / 1e9;

export function parseRubric(raw: unknown): Rubric {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad();
  const input = raw as Record<string, unknown>;
  if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > 20) return bad();
  const criteria = input.criteria.map((c): Criterion => {
    if (!c || typeof c !== "object") return bad();
    const o = c as Record<string, unknown>;
    if (typeof o.key !== "string" || !KEY.test(o.key) || !isBoundedText(o.label, 200, 1)) return bad();
    const weight = o.weight ?? 1;
    if (!finite(o.min) || !finite(o.max) || !finite(o.step) || !finite(weight)) return bad();
    if (o.min < -1e6 || o.max > 1e6 || o.min >= o.max || o.step <= 0 || weight <= 0 || weight > 100) return bad();
    const steps = (o.max - o.min) / o.step;
    if (steps > 10000 || !onGrid(o.max, o.min, o.step)) return bad();
    return { key: o.key, label: o.label, min: o.min, max: o.max, step: o.step, weight };
  });
  if (new Set(criteria.map(c => c.key)).size !== criteria.length) return bad();
  const agg = (input.aggregation ?? { method: "weighted_mean" }) as Record<string, unknown>;
  if (!agg || typeof agg !== "object" || !(aggregationMethods as readonly unknown[]).includes(agg.method)) return bad();
  const method = agg.method as AggregationMethod;
  let trim = 0;
  if (method === "trimmed_mean") {
    if (!Number.isSafeInteger(agg.trim) || (agg.trim as number) < 1 || (agg.trim as number) > 5) return bad();
    trim = agg.trim as number;
  } else if (agg.trim !== undefined && agg.trim !== 0) return bad();
  const normalization = input.normalization ?? "none";
  if (normalization !== "none" && normalization !== "z_score") return bad();
  const rawTies = input.tieBreakers ?? [];
  if (!Array.isArray(rawTies) || rawTies.length > 10) return bad();
  const tieBreakers = rawTies.map((t): TieBreaker => {
    const o = (t ?? {}) as Record<string, unknown>;
    if (o.type === "criterion") {
      if (typeof o.key !== "string" || !criteria.some(c => c.key === o.key)) return bad();
      return { type: "criterion", key: o.key };
    }
    if (o.type === "judge_count" || o.type === "head_judge") return { type: o.type };
    return bad();
  });
  const signature = tieBreakers.map(t => (t.type === "criterion" ? `c:${t.key}` : t.type));
  if (new Set(signature).size !== signature.length) return bad();
  return { criteria, aggregation: { method, trim }, normalization, tieBreakers };
}

export type ScoreValues = Record<string, number>;

/** Validate criterion values (range + step grid). Submission requires every criterion. */
export function validateScoreValues(rubric: Rubric, raw: unknown, options: { complete: boolean }): ScoreValues {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DomainError("invalid_score_values");
  const input = raw as Record<string, unknown>;
  const byKey = new Map(rubric.criteria.map(c => [c.key, c]));
  for (const key of Object.keys(input)) if (!byKey.has(key)) throw new DomainError("invalid_score_values");
  const values: ScoreValues = {};
  for (const criterion of rubric.criteria) {
    const value = input[criterion.key];
    if (value === undefined || value === null) {
      if (options.complete) throw new DomainError("score_incomplete");
      continue;
    }
    if (!finite(value) || value < criterion.min - EPS || value > criterion.max + EPS || !onGrid(value, criterion.min, criterion.step)) {
      throw new DomainError("invalid_score_values");
    }
    values[criterion.key] = quantize(value);
  }
  return values;
}

export function sameValues(a: ScoreValues, b: ScoreValues): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] === undefined || b[key] === undefined || quantize(a[key]!) !== quantize(b[key]!)) return false;
  return true;
}

export function sheetScore(rubric: Rubric, values: ScoreValues): number {
  let total = 0;
  let weights = 0;
  for (const c of rubric.criteria) {
    const v = values[c.key];
    if (v === undefined) throw new DomainError("score_incomplete");
    total += c.weight * v;
    weights += c.weight;
  }
  return rubric.aggregation.method === "sum" ? total : total / weights;
}

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Aggregate one performance's sheet scores. Returns null for no sheets. */
export function aggregate(scores: readonly number[], aggregation: Rubric["aggregation"]): { value: number; trimApplied: boolean } | null {
  if (scores.length === 0) return null;
  switch (aggregation.method) {
    case "sum": return { value: scores.reduce((s, x) => s + x, 0), trimApplied: false };
    case "median": return { value: median(scores), trimApplied: false };
    case "weighted_mean": return { value: mean(scores), trimApplied: false };
    case "trimmed_mean": {
      if (scores.length < 2 * aggregation.trim + 1) return { value: mean(scores), trimApplied: false };
      const sorted = [...scores].sort((a, b) => a - b);
      return { value: mean(sorted.slice(aggregation.trim, sorted.length - aggregation.trim)), trimApplied: true };
    }
  }
}

/**
 * Per-judge z-scores over the given sheets: z = (s − μⱼ) / σⱼ with the population standard
 * deviation. A judge with fewer than two sheets or no spread contributes 0 (neutral).
 */
export function zScores(items: readonly { judgeId: string; score: number }[]): number[] {
  const byJudge = new Map<string, number[]>();
  for (const item of items) byJudge.set(item.judgeId, [...(byJudge.get(item.judgeId) ?? []), item.score]);
  const stats = new Map([...byJudge].map(([judge, xs]) => {
    const m = mean(xs);
    const sd = Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
    return [judge, { m, sd, n: xs.length }] as const;
  }));
  return items.map(item => {
    const s = stats.get(item.judgeId)!;
    return s.n < 2 || s.sd < EPS ? 0 : (item.score - s.m) / s.sd;
  });
}

export interface StandingSheet { judgeId: string; entryId: string; performanceId: string; values: ScoreValues; headJudge: boolean; }
export interface StandingsInput { rubric: Rubric; sheets: readonly StandingSheet[]; entryIds: readonly string[]; }
export interface Standing {
  entryId: string;
  rank: number | null;
  score: number | null;
  /** Score before normalization (equals `score` when normalization is "none"). */
  rawScore: number | null;
  judgeCount: number;
  criterionMeans: Record<string, number>;
  headJudgeScore: number | null;
  trimApplied: boolean;
  /** The first tie-breaker that separated this entry from an entry with an equal score. */
  tieBreak: string | null;
  /** True when the entry remains tied after all tie-breakers (shares its rank). */
  tied: boolean;
}

/**
 * Rank entries for a round or a whole competition. Deterministic for a given input, regardless
 * of input order. Entries without submitted sheets are listed last with rank null.
 * Ties after all tie-breakers share a rank (standard competition ranking: 1, 1, 3).
 */
export function computeStandings(input: StandingsInput): Standing[] {
  const { rubric } = input;
  const sheets = [...input.sheets].sort((a, b) =>
    a.entryId.localeCompare(b.entryId) || a.performanceId.localeCompare(b.performanceId) || a.judgeId.localeCompare(b.judgeId));
  const raw = sheets.map(s => sheetScore(rubric, s.values));
  const normalized = rubric.normalization === "z_score" ? zScores(sheets.map((s, i) => ({ judgeId: s.judgeId, score: raw[i]! }))) : raw;
  const entryIds = [...new Set([...input.entryIds, ...sheets.map(s => s.entryId)])].sort();

  const rows = entryIds.map(entryId => {
    const idx = sheets.map((s, i) => (s.entryId === entryId ? i : -1)).filter(i => i >= 0);
    if (idx.length === 0) {
      return { entryId, rank: null, score: null, rawScore: null, judgeCount: 0, criterionMeans: {}, headJudgeScore: null, trimApplied: false, tieBreak: null, tied: false } as Standing;
    }
    const performances = [...new Set(idx.map(i => sheets[i]!.performanceId))];
    let score = 0;
    let rawScore = 0;
    let trimApplied = false;
    for (const performanceId of performances) {
      const pi = idx.filter(i => sheets[i]!.performanceId === performanceId);
      const agg = aggregate(pi.map(i => normalized[i]!), rubric.aggregation)!;
      score += agg.value;
      trimApplied ||= agg.trimApplied;
      rawScore += aggregate(pi.map(i => raw[i]!), rubric.aggregation)!.value;
    }
    const criterionMeans = Object.fromEntries(rubric.criteria.map(c => [c.key, quantize(mean(idx.map(i => sheets[i]!.values[c.key]!)))]));
    const head = idx.filter(i => sheets[i]!.headJudge);
    return {
      entryId, rank: null, score: quantize(score), rawScore: quantize(rawScore), judgeCount: idx.length, criterionMeans,
      headJudgeScore: head.length ? quantize(mean(head.map(i => normalized[i]!))) : null, trimApplied, tieBreak: null, tied: false
    } as Standing;
  });

  const label = (t: TieBreaker) => (t.type === "criterion" ? `criterion:${t.key}` : t.type);
  /** Positive when b should rank ahead of a. Returns the deciding rule. */
  const compare = (a: Standing, b: Standing): { order: number; rule: string | null } => {
    if (a.score! !== b.score!) return { order: b.score! - a.score!, rule: null };
    for (const t of rubric.tieBreakers) {
      let x: number; let y: number;
      if (t.type === "criterion") { x = a.criterionMeans[t.key]!; y = b.criterionMeans[t.key]!; }
      else if (t.type === "judge_count") { x = a.judgeCount; y = b.judgeCount; }
      else { x = a.headJudgeScore ?? Number.NEGATIVE_INFINITY; y = b.headJudgeScore ?? Number.NEGATIVE_INFINITY; }
      if (x !== y) return { order: y > x ? 1 : -1, rule: label(t) };
    }
    return { order: 0, rule: null };
  };

  const scored = rows.filter(r => r.score !== null).sort((a, b) => compare(a, b).order || a.entryId.localeCompare(b.entryId));
  for (let i = 0; i < scored.length; i++) {
    const current = scored[i]!;
    const previous = scored[i - 1];
    if (previous && compare(previous, current).order === 0) {
      current.rank = previous.rank;
      current.tied = previous.tied = true;
    } else {
      current.rank = i + 1;
    }
    if (previous && previous.score === current.score) {
      const rule = compare(previous, current).rule;
      if (rule) { previous.tieBreak ??= rule; current.tieBreak ??= rule; }
    }
  }
  return [...scored, ...rows.filter(r => r.score === null)];
}

export const correctionStatuses = ["pending", "approved", "rejected"] as const;
export type CorrectionStatus = (typeof correctionStatuses)[number];

/** A correction must change at least one value; approval must come from someone other than the requester. */
export function assertCorrection(original: ScoreValues, proposed: ScoreValues): void {
  if (sameValues(original, proposed)) throw new DomainError("correction_unchanged");
}

export function assertCorrectionDecision(status: CorrectionStatus, requesterAccountId: string, deciderAccountId: string): void {
  if (status !== "pending") throw new DomainError("invalid_state_correction_decided");
  if (requesterAccountId === deciderAccountId) throw new DomainError("self_approval_forbidden");
}
