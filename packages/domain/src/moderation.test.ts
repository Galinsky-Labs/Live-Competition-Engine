import { describe, expect, it } from "vitest";
import {
  assertReportTransition,
  parseAppealDecision,
  parseReportInput,
  parseSubject,
  windowStart
} from "./moderation";

describe("moderation rules", () => {
  it("enforces the report state machine", () => {
    expect(() => assertReportTransition("open", "triaged")).not.toThrow();
    expect(() => assertReportTransition("triaged", "actioned")).not.toThrow();
    expect(() => assertReportTransition("open", "dismissed")).not.toThrow();
    expect(() => assertReportTransition("dismissed", "open")).toThrow("invalid_state_report_transition");
    expect(() => assertReportTransition("actioned", "dismissed")).toThrow("invalid_state_report_transition");
    expect(() => assertReportTransition("triaged", "open")).toThrow("invalid_state_report_transition");
  });

  it("validates subjects and report input", () => {
    expect(parseSubject({ subjectType: "chat_message", subjectId: "abc-123" })).toEqual({ subjectType: "chat_message", subjectId: "abc-123" });
    expect(() => parseSubject({ subjectType: "database", subjectId: "x" })).toThrow("invalid_subject_type");
    expect(() => parseSubject({ subjectType: "page", subjectId: "../x" })).toThrow("invalid_subject_id");
    expect(() => parseReportInput({ subjectType: "page", subjectId: "p1", reason: "boring" })).toThrow("invalid_report_reason");
    expect(() => parseReportInput({ subjectType: "page", subjectId: "p1", reason: "spam", details: "x".repeat(2001) })).toThrow("invalid_report_details");
    expect(parseReportInput({ subjectType: "page", subjectId: "p1", reason: "spam" }).details).toBeNull();
  });

  it("parses appeal decisions and computes fixed windows", () => {
    expect(parseAppealDecision("overturned")).toBe("overturned");
    expect(() => parseAppealDecision("maybe")).toThrow();
    expect(windowStart(new Date("2026-01-01T10:42:00Z"), 3600_000).toISOString()).toBe("2026-01-01T10:00:00.000Z");
  });
});
