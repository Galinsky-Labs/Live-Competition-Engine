import { z } from "zod";
import { DomainError } from "./errors.ts";

/** LC-15 generic stages: timed or untimed, any kind, with an explicit advancement contract. */
export const stageKinds = ["audition", "qualifier", "heat", "round", "semifinal", "final", "showcase", "custom"] as const;
export const stageFormats = ["lineup", "head_to_head", "round_robin", "group"] as const;

export const advancementRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("top_n"), count: z.number().int().positive().max(10000), tiesAdvance: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal("threshold"), minScore: z.number() }).strict(),
  z.object({ type: z.literal("manual") }).strict(),
  z.object({ type: z.literal("bracket_winners") }).strict()
]);
export type AdvancementRule = z.infer<typeof advancementRuleSchema>;

export const stageInputSchema = z.object({
  label: z.string().trim().min(1).max(120),
  kind: z.enum(stageKinds).default("round"),
  format: z.enum(stageFormats).default("lineup"),
  timed: z.boolean().default(false),
  durationSeconds: z.number().int().positive().max(24 * 3600).nullable().optional(),
  scheduledAt: z.iso.datetime().nullable().optional(),
  advancement: advancementRuleSchema.default({ type: "none" })
}).strict().refine(s => !s.timed || (s.durationSeconds ?? 0) > 0, { message: "timed stages need durationSeconds", path: ["durationSeconds"] })
  .refine(s => s.advancement.type !== "bracket_winners" || s.format === "head_to_head", { message: "bracket_winners requires head_to_head format", path: ["advancement"] });
export type StageInput = z.infer<typeof stageInputSchema>;

export type StageStatus = "scheduled" | "live" | "completed" | "cancelled";
const stageTransitions: Record<StageStatus, StageStatus[]> = {
  scheduled: ["live", "cancelled"],
  live: ["completed", "cancelled"],
  completed: [],
  cancelled: []
};
export function assertStageTransition(from: StageStatus, to: StageStatus) {
  if (!stageTransitions[from].includes(to)) throw new DomainError(409, "invalid_stage_transition", `cannot move stage from ${from} to ${to}`);
}

export interface Standing {
  entryId: string;
  score: number | null;
  /** 1-based rank; tied entries share a rank. */
  rank: number;
}

/**
 * Applies an advancement rule to standings. Manual rules use the explicit selection
 * (which must be a subset of the standings); bracket rules are resolved by the bracket.
 */
export function selectAdvancing(rule: AdvancementRule, standings: Standing[], manualSelection: string[] = []): string[] {
  const known = new Set(standings.map(s => s.entryId));
  switch (rule.type) {
    case "none":
      return [];
    case "manual": {
      const unique = [...new Set(manualSelection)];
      if (unique.some(id => !known.has(id))) throw new DomainError(400, "manual_selection_not_in_stage");
      return unique;
    }
    case "threshold":
      return standings.filter(s => s.score !== null && s.score >= rule.minScore).map(s => s.entryId);
    case "top_n": {
      const sorted = [...standings].sort((a, b) => a.rank - b.rank);
      if (sorted.length <= rule.count) return sorted.map(s => s.entryId);
      const cutRank = sorted[rule.count - 1]!.rank;
      return rule.tiesAdvance
        ? sorted.filter(s => s.rank <= cutRank).map(s => s.entryId)
        : sorted.slice(0, rule.count).map(s => s.entryId);
    }
    case "bracket_winners":
      throw new DomainError(400, "bracket_advancement_uses_bracket");
  }
}
