/**
 * LC-27 audience interaction: pure validation and policy helpers.
 * No I/O; the clock is always passed in.
 */
import { DomainError, isBoundedText } from "./index.ts";

/** Fixed, neutral reaction set. Products may relabel these in their UI; codes never change. */
export const reactionKinds = ["applause", "heart", "star", "wow", "laugh"] as const;
export type ReactionKind = (typeof reactionKinds)[number];

export function isReactionKind(value: unknown): value is ReactionKind {
  return typeof value === "string" && (reactionKinds as readonly string[]).includes(value);
}

export const AUDIENCE_LIMITS = {
  chatMaxLengthCeiling: 1000,
  chatDefaultMaxLength: 500,
  slowModeMaxSeconds: 3600,
  questionMinLength: 3,
  questionMaxLength: 300,
  pollQuestionMaxLength: 200,
  pollOptionMaxLength: 100,
  pollMinOptions: 2,
  pollMaxOptions: 10,
  blockedTermMaxLength: 64,
  blockedTermsPerTenant: 500,
  termsVersionMaxLength: 64,
  muteMaxSeconds: 30 * 24 * 60 * 60,
  reasonMaxLength: 500
} as const;

/** Trim and validate a chat message body against the competition's configured maximum. */
export function normalizeChatBody(value: unknown, maxLength: number): string {
  if (typeof value !== "string") throw new DomainError("invalid_message");
  const body = value.normalize("NFC").trim();
  if (!isBoundedText(body, Math.min(maxLength, AUDIENCE_LIMITS.chatMaxLengthCeiling), 1)) {
    throw new DomainError("invalid_message");
  }
  return body;
}

export function normalizeQuestionBody(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("invalid_question");
  const body = value.normalize("NFC").trim();
  if (!isBoundedText(body, AUDIENCE_LIMITS.questionMaxLength, AUDIENCE_LIMITS.questionMinLength)) {
    throw new DomainError("invalid_question");
  }
  return body;
}

/**
 * Normalize text for blocked-term matching: compatibility-normalize, strip
 * diacritics, lowercase, and collapse every run of non letters/digits to one space.
 */
export function normalizeForMatching(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function normalizeBlockedTerm(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("invalid_term");
  const term = normalizeForMatching(value);
  if (term.length < 1 || term.length > AUDIENCE_LIMITS.blockedTermMaxLength) throw new DomainError("invalid_term");
  return term;
}

/**
 * Whole-token match of normalized terms (a term may span several tokens).
 * Returns the first matching term or null. Substrings inside other words do not match.
 */
export function findBlockedTerm(text: string, normalizedTerms: readonly string[]): string | null {
  const haystack = ` ${normalizeForMatching(text)} `;
  for (const term of [...normalizedTerms].sort()) {
    if (term && haystack.includes(` ${term} `)) return term;
  }
  return null;
}

/** Milliseconds the account must still wait under slow mode (0 = may post now). */
export function slowModeWaitMs(lastMessageAt: Date | null, now: Date, slowModeSeconds: number): number {
  if (!lastMessageAt || slowModeSeconds <= 0) return 0;
  const nextAllowed = lastMessageAt.getTime() + slowModeSeconds * 1000;
  return Math.max(0, nextAllowed - now.getTime());
}

export interface AudienceSettingsInput {
  termsVersion: string;
  slowModeSeconds: number;
  chatMaxLength: number;
}

export function validateAudienceSettings(input: Record<string, unknown>): AudienceSettingsInput {
  const termsVersion = input.termsVersion;
  const slowModeSeconds = input.slowModeSeconds ?? 0;
  const chatMaxLength = input.chatMaxLength ?? AUDIENCE_LIMITS.chatDefaultMaxLength;
  if (typeof termsVersion !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(termsVersion)) {
    throw new DomainError("invalid_terms_version");
  }
  if (!Number.isInteger(slowModeSeconds) || (slowModeSeconds as number) < 0 ||
    (slowModeSeconds as number) > AUDIENCE_LIMITS.slowModeMaxSeconds) {
    throw new DomainError("invalid_slow_mode");
  }
  if (!Number.isInteger(chatMaxLength) || (chatMaxLength as number) < 1 ||
    (chatMaxLength as number) > AUDIENCE_LIMITS.chatMaxLengthCeiling) {
    throw new DomainError("invalid_chat_max_length");
  }
  return { termsVersion, slowModeSeconds: slowModeSeconds as number, chatMaxLength: chatMaxLength as number };
}

export type ChatModerationAction = "hide" | "unhide" | "delete";
export type ChatMessageStatus = "visible" | "hidden" | "deleted";

const chatTransitions: Readonly<Record<ChatMessageStatus, Partial<Record<ChatModerationAction, ChatMessageStatus>>>> = {
  visible: { hide: "hidden", delete: "deleted" },
  hidden: { unhide: "visible", delete: "deleted" },
  deleted: {}
};

export function nextChatStatus(current: ChatMessageStatus, action: ChatModerationAction): ChatMessageStatus {
  const next = chatTransitions[current]?.[action];
  if (!next) throw new DomainError("invalid_state_transition");
  return next;
}

export type QuestionStatus = "open" | "answered" | "dismissed";
const questionTransitions: Readonly<Record<QuestionStatus, readonly QuestionStatus[]>> = {
  open: ["answered", "dismissed"],
  answered: [],
  dismissed: []
};

export function assertQuestionTransition(current: QuestionStatus, next: QuestionStatus): void {
  if (!questionTransitions[current]?.includes(next)) throw new DomainError("invalid_state_transition");
}

export type PollStatus = "draft" | "open" | "closed";
export type PollResultsVisibility = "live" | "after_close" | "never";
export const pollResultsVisibilities: readonly PollResultsVisibility[] = ["live", "after_close", "never"];

export function nextPollStatus(current: PollStatus, action: "open" | "close"): PollStatus {
  if (action === "open" && current === "draft") return "open";
  if (action === "close" && current === "open") return "closed";
  throw new DomainError("invalid_state_transition");
}

/** Whether a poll accepts votes right now (explicit close or scheduled close both end it). */
export function pollAcceptsVotes(status: PollStatus, closesAt: Date | null, now: Date): boolean {
  return status === "open" && (closesAt === null || now.getTime() < closesAt.getTime());
}

/** Results visibility rule. Managers (event.manage) always see results. */
export function canSeePollResults(
  visibility: PollResultsVisibility,
  status: PollStatus,
  closesAt: Date | null,
  now: Date,
  isManager: boolean
): boolean {
  if (isManager) return true;
  const ended = status === "closed" || (status === "open" && closesAt !== null && now.getTime() >= closesAt.getTime());
  if (visibility === "live") return status !== "draft";
  if (visibility === "after_close") return ended;
  return false;
}

export interface PollDefinition {
  question: string;
  options: string[];
  resultsVisibility: PollResultsVisibility;
  closesAt: Date | null;
}

export function validatePollDefinition(input: Record<string, unknown>, now: Date): PollDefinition {
  const question = typeof input.question === "string" ? input.question.normalize("NFC").trim() : null;
  if (!question || !isBoundedText(question, AUDIENCE_LIMITS.pollQuestionMaxLength, 1)) throw new DomainError("invalid_poll_question");
  const raw = input.options;
  if (!Array.isArray(raw) || raw.length < AUDIENCE_LIMITS.pollMinOptions || raw.length > AUDIENCE_LIMITS.pollMaxOptions) {
    throw new DomainError("invalid_poll_options");
  }
  const options = raw.map(option => (typeof option === "string" ? option.normalize("NFC").trim() : ""));
  if (options.some(option => !isBoundedText(option, AUDIENCE_LIMITS.pollOptionMaxLength, 1))) {
    throw new DomainError("invalid_poll_options");
  }
  if (new Set(options.map(option => option.toLowerCase())).size !== options.length) throw new DomainError("invalid_poll_options");
  const resultsVisibility = input.resultsVisibility ?? "after_close";
  if (!pollResultsVisibilities.includes(resultsVisibility as PollResultsVisibility)) {
    throw new DomainError("invalid_results_visibility");
  }
  let closesAt: Date | null = null;
  if (input.closesAt !== undefined && input.closesAt !== null) {
    closesAt = typeof input.closesAt === "string" ? new Date(input.closesAt) : new Date(Number.NaN);
    if (Number.isNaN(closesAt.getTime()) || closesAt.getTime() <= now.getTime()) throw new DomainError("invalid_closes_at");
  }
  return { question, options, resultsVisibility: resultsVisibility as PollResultsVisibility, closesAt };
}

/** Mute duration in whole seconds, bounded to 30 days. */
export function validateMuteSeconds(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > AUDIENCE_LIMITS.muteMaxSeconds) {
    throw new DomainError("invalid_mute_duration");
  }
  return value as number;
}

export function normalizeReason(value: unknown, required = true): string | null {
  if (value === undefined || value === null) {
    if (required) throw new DomainError("invalid_reason");
    return null;
  }
  if (typeof value !== "string") throw new DomainError("invalid_reason");
  const reason = value.trim();
  if (!isBoundedText(reason, AUDIENCE_LIMITS.reasonMaxLength, required ? 1 : 0)) throw new DomainError("invalid_reason");
  return reason || null;
}
