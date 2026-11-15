import { z } from "zod";
import { DomainError } from "./index.ts";
import { advancementContractSchema } from "./advancement.ts";

/**
 * LC-14 contest template configuration: a validated, domain-neutral description of
 * format, eligibility, scoring, judging mode, duration limits and phase rules.
 * Pure; the database stores the parsed JSON and enforces version immutability.
 */
export const STAGE_KINDS = ["audition", "qualifier", "heat", "semifinal", "final", "custom"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), "invalid text");
const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const range = (min: number, max: number) => z.strictObject({ min: z.int().min(min).max(max), max: z.int().min(min).max(max) })
  .refine(value => value.min <= value.max, "min must not exceed max");

export const phaseRuleSchema = z.strictObject({
  key: identifier,
  label: text(100),
  kind: z.enum(STAGE_KINDS),
  /** Only meaningful for kind "custom": a tenant-chosen display label. */
  customKind: text(60).optional(),
  timed: z.boolean(),
  durationSeconds: z.int().min(1).max(7 * 24 * 3600).optional(),
  /** LC-15 advancement contract: top-N, score threshold, manual or bracket. */
  advancement: advancementContractSchema.optional()
}).superRefine((phase, ctx) => {
  if (phase.timed !== (phase.durationSeconds !== undefined)) {
    ctx.addIssue({ code: "custom", message: "timed phases need durationSeconds; untimed must omit it", path: ["durationSeconds"] });
  }
  if ((phase.kind === "custom") !== (phase.customKind !== undefined)) {
    ctx.addIssue({ code: "custom", message: "customKind is required for, and only for, kind custom", path: ["customKind"] });
  }
});

export const templateConfigSchema = z.strictObject({
  format: z.strictObject({
    participation: z.enum(["individual", "group", "mixed"]),
    matchup: z.enum(["none", "head_to_head", "multi_side"]),
    groupSize: range(1, 100).optional()
  }),
  eligibility: z.strictObject({
    requiresApplication: z.boolean(),
    age: range(0, 130).optional(),
    maxEntriesPerParticipant: z.int().min(1).max(100),
    regions: z.array(z.string().regex(/^[A-Z]{2}$/)).max(250).optional(),
    customRules: z.array(z.strictObject({ key: identifier, description: text(500) })).max(50)
  }),
  scoring: z.strictObject({
    /** Reference to a scoring rubric/config owned by the scoring milestone. */
    configRef: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
    scaleMin: z.number().finite(),
    scaleMax: z.number().finite(),
    precision: z.int().min(0).max(4),
    aggregation: z.enum(["mean", "median", "sum", "trimmed_mean"])
  }).refine(value => value.scaleMin < value.scaleMax, "scaleMin must be below scaleMax"),
  judging: z.strictObject({
    mode: z.enum(["panel", "audience", "hybrid"]),
    panelSize: range(1, 50).optional(),
    /** Hybrid only: share of the final score from the audience, exclusive (0, 1). */
    audienceWeight: z.number().gt(0).lt(1).optional(),
    blind: z.boolean()
  }),
  duration: z.strictObject({
    performanceSeconds: range(0, 24 * 3600),
    overtimePolicy: z.enum(["none", "warn", "penalize", "disqualify"])
  }),
  phases: z.array(phaseRuleSchema).min(1).max(20)
}).superRefine((config, ctx) => {
  const { judging, format, phases } = config;
  if ((judging.mode === "audience") === (judging.panelSize !== undefined)) {
    ctx.addIssue({ code: "custom", message: "panelSize is required for panel/hybrid judging and forbidden for audience", path: ["judging", "panelSize"] });
  }
  if ((judging.mode === "hybrid") !== (judging.audienceWeight !== undefined)) {
    ctx.addIssue({ code: "custom", message: "audienceWeight is required for, and only for, hybrid judging", path: ["judging", "audienceWeight"] });
  }
  if ((format.participation !== "individual") !== (format.groupSize !== undefined)) {
    ctx.addIssue({ code: "custom", message: "groupSize is required for group/mixed participation only", path: ["format", "groupSize"] });
  }
  const keys = phases.map(phase => phase.key);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: "custom", message: "phase keys must be unique", path: ["phases"] });
  }
});

export type TemplateConfig = z.infer<typeof templateConfigSchema>;

export class TemplateConfigError extends DomainError {
  readonly issues: ReadonlyArray<{ path: string; message: string }>;
  constructor(issues: ReadonlyArray<{ path: string; message: string }>) {
    super("invalid_template_config");
    this.issues = issues;
  }
}

/** Validate untrusted JSON. Bounded: callers must cap body size before parsing. */
export function parseTemplateConfig(input: unknown): TemplateConfig {
  const result = templateConfigSchema.safeParse(input);
  if (!result.success) {
    throw new TemplateConfigError(result.error.issues.slice(0, 20).map(issue => ({
      path: issue.path.map(String).join("."), message: issue.message
    })));
  }
  return result.data;
}

export function parseTemplateName(value: unknown): string {
  const parsed = text(200).safeParse(value);
  if (!parsed.success) throw new DomainError("invalid_template_name");
  return parsed.data;
}

/** Events may adopt a template only before they go live. */
export function canApplyTemplate(status: string): boolean {
  return status === "draft" || status === "published";
}
