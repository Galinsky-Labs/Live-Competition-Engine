import { describe, expect, it } from "vitest";
import { canApplyTemplate, parseTemplateConfig, parseTemplateName, TemplateConfigError } from "./contest-templates.ts";

export const validConfig = {
  format: { participation: "individual", matchup: "none" },
  eligibility: { requiresApplication: true, age: { min: 16, max: 99 }, maxEntriesPerParticipant: 1, customRules: [] },
  scoring: { configRef: "rubric.default-v1", scaleMin: 0, scaleMax: 10, precision: 1, aggregation: "trimmed_mean" },
  judging: { mode: "hybrid", panelSize: { min: 3, max: 5 }, audienceWeight: 0.3, blind: false },
  duration: { performanceSeconds: { min: 60, max: 300 }, overtimePolicy: "warn" },
  phases: [
    { key: "open", label: "Open round", kind: "audition", timed: false },
    { key: "final", label: "Final", kind: "final", timed: true, durationSeconds: 3600 }
  ]
};

const clone = () => structuredClone(validConfig) as Record<string, any>;

function issuesOf(config: unknown): string[] {
  try {
    parseTemplateConfig(config);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateConfigError);
    return (error as TemplateConfigError).issues.map(issue => issue.path);
  }
}

describe("contest template config", () => {
  it("accepts a complete hybrid configuration", () => {
    expect(parseTemplateConfig(validConfig).judging.mode).toBe("hybrid");
  });

  it("enforces judging-mode specific fields", () => {
    const audience = clone();
    audience.judging = { mode: "audience", blind: false };
    expect(issuesOf(audience)).toEqual([]);
    audience.judging.panelSize = { min: 1, max: 2 };
    expect(issuesOf(audience)).toContain("judging.panelSize");
    const panel = clone();
    panel.judging = { mode: "panel", panelSize: { min: 3, max: 3 }, audienceWeight: 0.5, blind: true };
    expect(issuesOf(panel)).toContain("judging.audienceWeight");
    const hybrid = clone();
    hybrid.judging.audienceWeight = 1;
    expect(issuesOf(hybrid)).toContain("judging.audienceWeight");
  });

  it("rejects unknown keys, inverted ranges, duplicate phases and timing mismatches", () => {
    const extra = clone();
    extra.payments = { fee: 10 };
    expect(issuesOf(extra).length).toBeGreaterThan(0);
    const inverted = clone();
    inverted.duration.performanceSeconds = { min: 400, max: 300 };
    expect(issuesOf(inverted)).toContain("duration.performanceSeconds");
    const scale = clone();
    scale.scoring.scaleMax = 0;
    expect(issuesOf(scale)).toContain("scoring");
    const dupes = clone();
    dupes.phases[1].key = "open";
    expect(issuesOf(dupes)).toContain("phases");
    const timing = clone();
    timing.phases[0].durationSeconds = 30;
    expect(issuesOf(timing)).toContain("phases.0.durationSeconds");
    const custom = clone();
    custom.phases[0].kind = "custom";
    expect(issuesOf(custom)).toContain("phases.0.customKind");
    const group = clone();
    group.format.participation = "group";
    expect(issuesOf(group)).toContain("format.groupSize");
    expect(issuesOf({ ...clone(), phases: [] })).toContain("phases");
  });

  it("validates names and when templates may be applied", () => {
    expect(parseTemplateName("Standard format")).toBe("Standard format");
    expect(() => parseTemplateName("  ")).toThrow("invalid_template_name");
    expect(canApplyTemplate("draft")).toBe(true);
    expect(canApplyTemplate("published")).toBe(true);
    expect(canApplyTemplate("live")).toBe(false);
  });
});
