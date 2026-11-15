import { z } from "zod";

/**
 * Versioned, domain-neutral contest configuration (LC-14). Products supply their own
 * vocabulary through labels; the engine only knows formats, criteria and rules.
 */
const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

export const criterionSchema = z.object({
  key,
  label: z.string().min(1).max(80),
  weight: z.number().positive().max(100).default(1),
  min: z.number().default(0),
  max: z.number().default(10),
  step: z.number().positive().default(0.5)
}).strict().refine(c => c.max > c.min, { message: "criterion max must exceed min" });

export const tieBreakSchema = z.enum(["highest_criterion_first", "audience_vote", "fewest_low_scores", "earliest_performance", "shared_rank"]);

export const contestConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  format: z.enum(["solo", "head_to_head", "group"]).default("solo"),
  labels: z.object({
    entrant: z.string().min(1).max(40).default("Entrant"),
    performance: z.string().min(1).max(40).default("Performance"),
    stage: z.string().min(1).max(40).default("Stage")
  }).strict().default({ entrant: "Entrant", performance: "Performance", stage: "Stage" }),
  eligibility: z.object({
    requiresApplication: z.boolean().default(true),
    maxEntrants: z.number().int().positive().max(10000).optional(),
    minimumAge: z.number().int().min(0).max(120).optional(),
    groupSize: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).strict().optional()
  }).strict().default({ requiresApplication: true }),
  registration: z.object({
    opensAt: z.iso.datetime().optional(),
    closesAt: z.iso.datetime().optional(),
    waitlist: z.boolean().default(true),
    consentVersion: z.string().min(1).max(40).default("v1")
  }).strict().default({ waitlist: true, consentVersion: "v1" }),
  judging: z.object({
    panelSize: z.number().int().min(0).max(50).default(3),
    blind: z.boolean().default(false),
    requireAllJudges: z.boolean().default(true)
  }).strict().default({ panelSize: 3, blind: false, requireAllJudges: true }),
  scoring: z.object({
    criteria: z.array(criterionSchema).min(1).max(20).default([{ key: "overall", label: "Overall", weight: 1, min: 0, max: 10, step: 0.5 }]),
    aggregation: z.enum(["mean", "median", "trimmed_mean", "sum"]).default("mean"),
    normalization: z.enum(["none", "judge_zscore", "judge_minmax"]).default("none"),
    judgeWeight: z.number().min(0).max(1).default(1),
    audienceWeight: z.number().min(0).max(1).default(0),
    tieBreaks: z.array(tieBreakSchema).max(5).default(["highest_criterion_first", "shared_rank"]),
    decimals: z.number().int().min(0).max(4).default(2)
  }).strict().default({
    criteria: [{ key: "overall", label: "Overall", weight: 1, min: 0, max: 10, step: 0.5 }],
    aggregation: "mean", normalization: "none", judgeWeight: 1, audienceWeight: 0,
    tieBreaks: ["highest_criterion_first", "shared_rank"], decimals: 2
  }),
  timing: z.object({
    performanceSeconds: z.number().int().min(0).max(4 * 3600).default(0),
    overtimeGraceSeconds: z.number().int().min(0).max(3600).default(0),
    maxExtensionSeconds: z.number().int().min(0).max(3600).default(300)
  }).strict().default({ performanceSeconds: 0, overtimeGraceSeconds: 0, maxExtensionSeconds: 300 }),
  audience: z.object({
    reactions: z.array(z.string().regex(/^[a-z_]{1,24}$/)).max(12).default(["applause", "fire", "heart", "wow"]),
    questions: z.boolean().default(false),
    reactionsPerMinute: z.number().int().min(1).max(600).default(30)
  }).strict().default({ reactions: ["applause", "fire", "heart", "wow"], questions: false, reactionsPerMinute: 30 }),
  critiques: z.object({
    enabled: z.boolean().default(false),
    defaultVisibility: z.enum(["private", "contestant", "public"]).default("contestant")
  }).strict().default({ enabled: false, defaultVisibility: "contestant" })
}).strict().superRefine((config, ctx) => {
  const keys = config.scoring.criteria.map(c => c.key);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "criterion keys must be unique", path: ["scoring", "criteria"] });
  if (config.scoring.judgeWeight + config.scoring.audienceWeight <= 0) ctx.addIssue({ code: "custom", message: "judge and audience weights cannot both be zero", path: ["scoring"] });
  const { opensAt, closesAt } = config.registration;
  if (opensAt && closesAt && Date.parse(closesAt) <= Date.parse(opensAt)) ctx.addIssue({ code: "custom", message: "registration must close after it opens", path: ["registration"] });
  const g = config.eligibility.groupSize;
  if (g && g.max < g.min) ctx.addIssue({ code: "custom", message: "group size max < min", path: ["eligibility", "groupSize"] });
  if (config.format === "group" && !g) ctx.addIssue({ code: "custom", message: "group format requires groupSize", path: ["eligibility"] });
});

export type ContestConfig = z.infer<typeof contestConfigSchema>;
export type Criterion = ContestConfig["scoring"]["criteria"][number];

export function parseContestConfig(input: unknown): ContestConfig {
  return contestConfigSchema.parse(input ?? {});
}

export function safeParseContestConfig(input: unknown) {
  const result = contestConfigSchema.safeParse(input ?? {});
  return result.success
    ? { ok: true as const, config: result.data }
    : { ok: false as const, issues: result.error.issues.map(i => `${i.path.join(".") || "config"}: ${i.message}`) };
}

/** Registration window check, using the event config and the server clock. */
export function registrationState(config: ContestConfig, now: Date): "not_open" | "open" | "closed" {
  const { opensAt, closesAt } = config.registration;
  if (opensAt && now.getTime() < Date.parse(opensAt)) return "not_open";
  if (closesAt && now.getTime() >= Date.parse(closesAt)) return "closed";
  return "open";
}
