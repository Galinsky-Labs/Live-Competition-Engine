import { DomainError, isBoundedText } from "./index.ts";

export const moderationSubjectTypes = ["profile", "chat_message", "media", "critique", "page", "event"] as const;
export type ModerationSubjectType = (typeof moderationSubjectTypes)[number];

export const reportReasons = [
  "spam", "harassment", "hate", "violence", "sexual_content", "self_harm", "copyright", "privacy", "impersonation", "other"
] as const;
export type ReportReason = (typeof reportReasons)[number];

export type ReportStatus = "open" | "triaged" | "actioned" | "dismissed";

/** Explicit report state machine. actioned and dismissed are terminal. */
const transitions: Record<ReportStatus, readonly ReportStatus[]> = {
  open: ["triaged", "actioned", "dismissed"],
  triaged: ["actioned", "dismissed"],
  actioned: [],
  dismissed: []
};

export function assertReportTransition(from: ReportStatus, to: ReportStatus): void {
  if (!transitions[from].includes(to)) throw new DomainError("invalid_state_report_transition");
}

export function isTerminalReportStatus(status: ReportStatus): boolean {
  return transitions[status].length === 0;
}

export function parseReportStatus(value: unknown): ReportStatus {
  if (value === "open" || value === "triaged" || value === "actioned" || value === "dismissed") return value;
  throw new DomainError("invalid_report_status");
}

export interface SubjectRef { subjectType: ModerationSubjectType; subjectId: string }

export function parseSubject(input: { subjectType?: unknown; subjectId?: unknown }): SubjectRef {
  if (typeof input.subjectType !== "string" || !(moderationSubjectTypes as readonly string[]).includes(input.subjectType)) {
    throw new DomainError("invalid_subject_type");
  }
  if (typeof input.subjectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}$/.test(input.subjectId)) {
    throw new DomainError("invalid_subject_id");
  }
  return { subjectType: input.subjectType as ModerationSubjectType, subjectId: input.subjectId };
}

export interface ReportInput extends SubjectRef { reason: ReportReason; details: string | null }

export function parseReportInput(input: Record<string, unknown>): ReportInput {
  const subject = parseSubject(input);
  if (typeof input.reason !== "string" || !(reportReasons as readonly string[]).includes(input.reason)) {
    throw new DomainError("invalid_report_reason");
  }
  const details = input.details ?? null;
  if (details !== null && !isBoundedText(details, 2000)) throw new DomainError("invalid_report_details");
  return { ...subject, reason: input.reason as ReportReason, details: details as string | null };
}

export function requireNote(value: unknown, code: string, max = 2000, min = 1): string {
  if (!isBoundedText(value, max, min) || (value as string).trim().length < min) throw new DomainError(code);
  return value as string;
}

export function optionalNote(value: unknown, code: string, max = 2000): string | null {
  if (value === undefined || value === null) return null;
  return requireNote(value, code, max);
}

export type AppealDecision = "upheld" | "overturned";

export function parseAppealDecision(value: unknown): AppealDecision {
  if (value === "upheld" || value === "overturned") return value;
  throw new DomainError("invalid_appeal_decision");
}

/** Rate limits for report submission (fixed windows). Anonymous reporters get less. */
export const REPORT_RATE_LIMITS = {
  member: { limit: 20, windowMs: 60 * 60 * 1000 },
  anonymous: { limit: 5, windowMs: 60 * 60 * 1000 }
} as const;

/** Start of the fixed window that contains `now`. */
export function windowStart(now: Date, windowMs: number): Date {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new DomainError("invalid_rate_window");
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}
