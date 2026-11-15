import { DomainError, isBoundedText, isUuid } from "./index.ts";
import { STAGE_KINDS, type StageKind } from "./contest-templates.ts";
import { parseAdvancementContract, type AdvancementContract } from "./advancement.ts";

export { advancementContractSchema, parseAdvancementContract, type AdvancementContract } from "./advancement.ts";

/**
 * LC-15 generic stage builder: stage definitions and advancement contracts, plus a
 * pure, deterministic function that computes who advances from ranked standings.
 */
export interface StageDefinition {
  label: string;
  kind: StageKind;
  customLabel: string | null;
  timed: boolean;
  durationSeconds: number | null;
  advancement: AdvancementContract | null;
}

const STAGE_KEYS = new Set(["label", "kind", "customLabel", "timed", "durationSeconds", "advancement"]);

/** Validate a full definition (create) or a partial one merged onto `current` (update). */
export function parseStageDefinition(body: Record<string, unknown>, current?: StageDefinition): StageDefinition {
  for (const key of Object.keys(body)) if (!STAGE_KEYS.has(key)) throw new DomainError("invalid_stage_field");
  const merged = { ...current, ...body } as Record<string, unknown>;
  const { label, kind, timed } = merged;
  const customLabel = merged.customLabel ?? null;
  const durationSeconds = merged.durationSeconds ?? null;
  if (!isBoundedText(label, 100, 1) || !label.trim()) throw new DomainError("invalid_stage_label");
  if (typeof kind !== "string" || !(STAGE_KINDS as readonly string[]).includes(kind)) throw new DomainError("invalid_stage_kind");
  if ((kind === "custom") !== (customLabel !== null) ||
    (customLabel !== null && (!isBoundedText(customLabel, 60, 1) || !customLabel.trim()))) {
    throw new DomainError("invalid_stage_custom_label");
  }
  if (typeof timed !== "boolean") throw new DomainError("invalid_stage_timing");
  if (timed !== (durationSeconds !== null) ||
    (durationSeconds !== null && (!Number.isInteger(durationSeconds) || (durationSeconds as number) < 1 || (durationSeconds as number) > 7 * 24 * 3600))) {
    throw new DomainError("invalid_stage_timing");
  }
  const advancement = merged.advancement === undefined || merged.advancement === null ? null : parseAdvancementContract(merged.advancement);
  return { label, kind: kind as StageKind, customLabel: customLabel as string | null, timed, durationSeconds: durationSeconds as number | null, advancement };
}

/** Validate a reorder request: a permutation of the existing stage ids. */
export function assertPermutation(existing: readonly string[], requested: unknown): string[] {
  if (!Array.isArray(requested) || requested.length !== existing.length || !requested.every(isUuid)) {
    throw new DomainError("invalid_stage_order");
  }
  const normalized = requested.map(id => id.toLowerCase());
  const want = new Set(existing.map(id => id.toLowerCase()));
  if (new Set(normalized).size !== normalized.length || !normalized.every(id => want.has(id))) {
    throw new DomainError("invalid_stage_order");
  }
  return normalized;
}

export interface Standing {
  entryId: string;
  /** 1 = best. null = unranked (sorted last). */
  rank: number | null;
  score: number | null;
  /** Lower seed is better; used only by the "seed" tie policy. */
  seed?: number | null;
}

export interface AdvancementOutcome {
  advancing: string[];
  eliminated: string[];
  /** True when a tie at the cut was resolved by seed/entry id. */
  tieBroken: boolean;
  /** Entries tied at the cut (empty when no tie at the boundary). */
  tiedAtCut: string[];
}

const nullsLast = (a: number | null | undefined, b: number | null | undefined, direction: 1 | -1) => {
  const an = a === null || a === undefined, bn = b === null || b === undefined;
  if (an || bn) return an === bn ? 0 : an ? 1 : -1;
  return a === b ? 0 : (a < b ? -1 : 1) * direction;
};

/** Performance order: rank asc, score desc (nulls last). Equal under this = tied. */
function performanceCompare(a: Standing, b: Standing): number {
  return nullsLast(a.rank, b.rank, 1) || nullsLast(a.score, b.score, -1);
}

/** Total deterministic order: performance, then seed asc, then entry id. */
export function orderStandings(standings: readonly Standing[]): Standing[] {
  return [...standings].sort((a, b) => performanceCompare(a, b) || nullsLast(a.seed, b.seed, 1) ||
    (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
}

function validateStandings(standings: readonly Standing[]): void {
  const ids = new Set<string>();
  for (const standing of standings) {
    if (!isUuid(standing.entryId) || ids.has(standing.entryId) ||
      (standing.rank !== null && (!Number.isInteger(standing.rank) || standing.rank < 1)) ||
      (standing.score !== null && !Number.isFinite(standing.score))) {
      throw new DomainError("invalid_standings");
    }
    ids.add(standing.entryId);
  }
}

function fromSelection(ordered: Standing[], selection: readonly string[] | undefined, max: number | undefined): AdvancementOutcome {
  if (!selection) throw new DomainError("advancement_selection_required");
  const chosen = new Set(selection);
  if (chosen.size !== selection.length || (max !== undefined && chosen.size > max) ||
    !selection.every(id => ordered.some(standing => standing.entryId === id))) {
    throw new DomainError("invalid_advancement_selection");
  }
  return {
    advancing: ordered.filter(s => chosen.has(s.entryId)).map(s => s.entryId),
    eliminated: ordered.filter(s => !chosen.has(s.entryId)).map(s => s.entryId),
    tieBroken: false,
    tiedAtCut: []
  };
}

/**
 * Compute advancing entries from standings under a contract. Deterministic: the
 * same inputs always give the same, identically ordered output regardless of the
 * input order. `selection` carries manual choices or bracket winners.
 */
export function computeAdvancement(
  contract: AdvancementContract,
  standings: readonly Standing[],
  selection?: readonly string[]
): AdvancementOutcome {
  validateStandings(standings);
  const ordered = orderStandings(standings);
  switch (contract.type) {
    case "manual":
      return fromSelection(ordered, selection, contract.maxSelections);
    case "bracket":
      return fromSelection(ordered, selection, undefined);
    case "score_threshold": {
      const passes = (s: Standing) => s.score !== null &&
        (contract.inclusive ? s.score >= contract.minScore : s.score > contract.minScore);
      return {
        advancing: ordered.filter(passes).map(s => s.entryId),
        eliminated: ordered.filter(s => !passes(s)).map(s => s.entryId),
        tieBroken: false,
        tiedAtCut: []
      };
    }
    case "top_n": {
      const n = contract.count;
      if (ordered.length <= n) return { advancing: ordered.map(s => s.entryId), eliminated: [], tieBroken: false, tiedAtCut: [] };
      const last = ordered[n - 1]!, next = ordered[n]!;
      // Unranked/unscored entries never form a tie group that can advance by tie.
      if (performanceCompare(last, next) !== 0 || (last.rank === null && last.score === null)) {
        return { advancing: ordered.slice(0, n).map(s => s.entryId), eliminated: ordered.slice(n).map(s => s.entryId), tieBroken: false, tiedAtCut: [] };
      }
      const groupStart = ordered.findIndex(s => performanceCompare(s, last) === 0);
      let groupEnd = groupStart;
      while (groupEnd < ordered.length && performanceCompare(ordered[groupEnd]!, last) === 0) groupEnd += 1;
      const tiedAtCut = ordered.slice(groupStart, groupEnd).map(s => s.entryId);
      const cut = contract.ties === "include" ? groupEnd : contract.ties === "exclude" ? groupStart : n;
      return {
        advancing: ordered.slice(0, cut).map(s => s.entryId),
        eliminated: ordered.slice(cut).map(s => s.entryId),
        tieBroken: contract.ties === "seed",
        tiedAtCut
      };
    }
  }
}
