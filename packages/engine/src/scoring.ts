import { DomainError } from "./errors.ts";
import type { ContestConfig, Criterion } from "./contest-config.ts";

/** LC-20 configurable scoring: validation, weighting, normalization, aggregation and tie rules. */

export type CriterionScores = Record<string, number>;

/** Validates a judge's sheet against the configured criteria (presence, range and step). */
export function validateScores(criteria: Criterion[], scores: unknown): CriterionScores {
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) throw new DomainError(400, "invalid_scores");
  const input = scores as Record<string, unknown>;
  const allowed = new Set(criteria.map(c => c.key));
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new DomainError(400, "unknown_criterion");
  const out: CriterionScores = {};
  for (const c of criteria) {
    const value = input[c.key];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new DomainError(400, "missing_criterion_score");
    if (value < c.min || value > c.max) throw new DomainError(400, "score_out_of_range");
    const steps = (value - c.min) / c.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) throw new DomainError(400, "score_not_on_step");
    out[c.key] = value;
  }
  return out;
}

/** Weighted sheet total on a 0..100 scale (each criterion is first scaled to 0..1). */
export function sheetTotal(criteria: Criterion[], scores: CriterionScores): number {
  let weighted = 0, weights = 0;
  for (const c of criteria) {
    weighted += ((scores[c.key]! - c.min) / (c.max - c.min)) * c.weight;
    weights += c.weight;
  }
  return (weighted / weights) * 100;
}

export interface SheetInput { entryId: string; judgeId: string; scores: CriterionScores; performanceOrdinal: number }
export interface StandingRow {
  entryId: string;
  rank: number;
  score: number;
  judgeScore: number | null;
  audienceScore: number | null;
  judgeCount: number;
  complete: boolean;
  criterionAverages: Record<string, number>;
  tieBrokenBy: string | null;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
/** Drops the single highest and lowest when there are at least three values. */
const trimmedMean = (xs: number[]) => {
  if (xs.length < 3) return mean(xs);
  const s = [...xs].sort((a, b) => a - b);
  return mean(s.slice(1, -1));
};

export function aggregate(method: ContestConfig["scoring"]["aggregation"], xs: number[]): number {
  if (!xs.length) return 0;
  if (method === "median") return median(xs);
  if (method === "trimmed_mean") return trimmedMean(xs);
  if (method === "sum") return xs.reduce((a, b) => a + b, 0);
  return mean(xs);
}

/** Per-judge normalization removes harsh/lenient judge bias before aggregation. */
function normalizeTotals(method: ContestConfig["scoring"]["normalization"], sheets: Array<SheetInput & { total: number }>) {
  if (method === "none") return sheets;
  const byJudge = new Map<string, number[]>();
  for (const s of sheets) byJudge.set(s.judgeId, [...(byJudge.get(s.judgeId) ?? []), s.total]);
  return sheets.map(s => {
    const totals = byJudge.get(s.judgeId)!;
    if (method === "judge_minmax") {
      const lo = Math.min(...totals), hi = Math.max(...totals);
      return { ...s, total: hi === lo ? 50 : ((s.total - lo) / (hi - lo)) * 100 };
    }
    const mu = mean(totals);
    const sd = Math.sqrt(mean(totals.map(t => (t - mu) ** 2)));
    // z-score mapped back onto a 0..100-like scale centred on 50.
    return { ...s, total: sd === 0 ? 50 : 50 + (s.total - mu) / sd * 10 };
  });
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Computes deterministic standings for a stage.
 * `expectedJudges` maps entryId → number of judges who must score it (panel minus recusals).
 * `audience` maps entryId → audience share on 0..100 (LC-28), used when audienceWeight > 0.
 */
export function computeStandings(config: ContestConfig, sheets: SheetInput[], entrants: string[], expectedJudges: Map<string, number>, audience: Map<string, number> = new Map()): StandingRow[] {
  const { criteria, aggregation, normalization, judgeWeight, audienceWeight, tieBreaks, decimals } = config.scoring;
  const totals = normalizeTotals(normalization, sheets.map(s => ({ ...s, total: sheetTotal(criteria, s.scores) })));
  const rows = entrants.map(entryId => {
    const mine = totals.filter(s => s.entryId === entryId);
    const judges = new Set(mine.map(s => s.judgeId));
    const judgeScore = mine.length ? aggregate(aggregation, mine.map(s => s.total)) : null;
    const audienceScore = audience.has(entryId) ? audience.get(entryId)! : null;
    const parts: Array<[number, number]> = [];
    if (judgeWeight > 0) parts.push([judgeScore ?? 0, judgeWeight]);
    if (audienceWeight > 0) parts.push([audienceScore ?? 0, audienceWeight]);
    const score = parts.reduce((a, [v, w]) => a + v * w, 0) / parts.reduce((a, [, w]) => a + w, 0);
    const criterionAverages: Record<string, number> = {};
    for (const c of criteria) criterionAverages[c.key] = mine.length ? round(mean(mine.map(s => s.scores[c.key]!)), decimals) : 0;
    const lowScores = mine.filter(s => s.total < 50).length;
    const firstOrdinal = mine.length ? Math.min(...mine.map(s => s.performanceOrdinal)) : Number.MAX_SAFE_INTEGER;
    return {
      entryId, score: round(score, decimals), judgeScore: judgeScore === null ? null : round(judgeScore, decimals),
      audienceScore: audienceScore === null ? null : round(audienceScore, decimals), judgeCount: judges.size,
      complete: !config.judging.requireAllJudges || judges.size >= (expectedJudges.get(entryId) ?? 0),
      criterionAverages, lowScores, firstOrdinal, rank: 0, tieBrokenBy: null as string | null
    };
  });
  const firstCriterion = criteria[0]!.key;
  const compareBy = (rule: string, a: (typeof rows)[number], b: (typeof rows)[number]): number => {
    switch (rule) {
      case "highest_criterion_first": return b.criterionAverages[firstCriterion]! - a.criterionAverages[firstCriterion]!;
      case "audience_vote": return (b.audienceScore ?? -1) - (a.audienceScore ?? -1);
      case "fewest_low_scores": return a.lowScores - b.lowScores;
      case "earliest_performance": return a.firstOrdinal - b.firstOrdinal;
      default: return 0;
    }
  };
  const decisive = tieBreaks.slice(0, tieBreaks.includes("shared_rank") ? tieBreaks.indexOf("shared_rank") : tieBreaks.length);
  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    for (const rule of decisive) {
      const r = compareBy(rule, a, b);
      if (r !== 0) return r;
    }
    return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
  });
  // Standard competition ranking ("1224"); entries still tied after the decisive rules share a rank.
  rows.forEach((row, i) => {
    if (i === 0) { row.rank = 1; return; }
    const prev = rows[i - 1]!;
    if (prev.score !== row.score) { row.rank = i + 1; return; }
    const breaker = decisive.find(rule => compareBy(rule, prev, row) !== 0);
    if (breaker) { row.rank = i + 1; row.tieBrokenBy = breaker; prev.tieBrokenBy ??= breaker; }
    else row.rank = prev.rank;
  });
  return rows.map(({ lowScores: _l, firstOrdinal: _f, ...rest }) => rest);
}
