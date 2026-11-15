import { describe, expect, it } from "vitest";
import {
  assertQuestionTransition,
  canSeePollResults,
  findBlockedTerm,
  isReactionKind,
  nextChatStatus,
  nextPollStatus,
  normalizeBlockedTerm,
  normalizeChatBody,
  normalizeQuestionBody,
  normalizeReason,
  pollAcceptsVotes,
  slowModeWaitMs,
  validateAudienceSettings,
  validateMuteSeconds,
  validatePollDefinition
} from "./audience";

const now = new Date("2026-11-15T12:00:00.000Z");
const later = (ms: number) => new Date(now.getTime() + ms);

describe("audience reactions and text bounds", () => {
  it("accepts only the fixed reaction set", () => {
    expect(isReactionKind("applause")).toBe(true);
    expect(isReactionKind("boo")).toBe(false);
    expect(isReactionKind(1)).toBe(false);
  });

  it("bounds chat messages by the configured length and rejects control characters", () => {
    expect(normalizeChatBody("  hello  ", 10)).toBe("hello");
    expect(() => normalizeChatBody("", 10)).toThrow("invalid_message");
    expect(() => normalizeChatBody("   ", 10)).toThrow("invalid_message");
    expect(() => normalizeChatBody("x".repeat(11), 10)).toThrow("invalid_message");
    expect(() => normalizeChatBody("x".repeat(1001), 5000)).toThrow("invalid_message");
    expect(() => normalizeChatBody("bad\u0007", 10)).toThrow("invalid_message");
    expect(() => normalizeChatBody(42, 10)).toThrow("invalid_message");
  });

  it("bounds questions", () => {
    expect(normalizeQuestionBody(" Why? ")).toBe("Why?");
    expect(() => normalizeQuestionBody("ab")).toThrow("invalid_question");
    expect(() => normalizeQuestionBody("x".repeat(301))).toThrow("invalid_question");
  });
});

describe("blocked terms", () => {
  it("matches whole normalized tokens, including diacritic and case variants", () => {
    const terms = [normalizeBlockedTerm("Badword"), normalizeBlockedTerm("two  words")];
    expect(findBlockedTerm("this has a BÁDWORD in it", terms)).toBe("badword");
    expect(findBlockedTerm("punctuated:badword!", terms)).toBe("badword");
    expect(findBlockedTerm("two-words here", terms)).toBe("two words");
    expect(findBlockedTerm("notabadwordatall", terms)).toBeNull();
    expect(findBlockedTerm("clean message", terms)).toBeNull();
  });

  it("rejects empty or oversized terms", () => {
    expect(() => normalizeBlockedTerm("!!!")).toThrow("invalid_term");
    expect(() => normalizeBlockedTerm("x".repeat(65))).toThrow("invalid_term");
    expect(() => normalizeBlockedTerm(null)).toThrow("invalid_term");
  });
});

describe("slow mode", () => {
  it("computes remaining wait deterministically", () => {
    expect(slowModeWaitMs(null, now, 30)).toBe(0);
    expect(slowModeWaitMs(now, later(10_000), 0)).toBe(0);
    expect(slowModeWaitMs(now, later(10_000), 30)).toBe(20_000);
    expect(slowModeWaitMs(now, later(30_000), 30)).toBe(0);
  });
});

describe("settings validation", () => {
  it("validates terms version, slow mode and max length", () => {
    expect(validateAudienceSettings({ termsVersion: "2026-01" })).toEqual({ termsVersion: "2026-01", slowModeSeconds: 0, chatMaxLength: 500 });
    expect(() => validateAudienceSettings({ termsVersion: "has space" })).toThrow("invalid_terms_version");
    expect(() => validateAudienceSettings({ termsVersion: "v1", slowModeSeconds: -1 })).toThrow("invalid_slow_mode");
    expect(() => validateAudienceSettings({ termsVersion: "v1", slowModeSeconds: 3601 })).toThrow("invalid_slow_mode");
    expect(() => validateAudienceSettings({ termsVersion: "v1", chatMaxLength: 0 })).toThrow("invalid_chat_max_length");
    expect(() => validateAudienceSettings({ termsVersion: "v1", chatMaxLength: 1.5 })).toThrow("invalid_chat_max_length");
  });
});

describe("moderation and question state machines", () => {
  it("allows only explicit chat transitions", () => {
    expect(nextChatStatus("visible", "hide")).toBe("hidden");
    expect(nextChatStatus("hidden", "unhide")).toBe("visible");
    expect(nextChatStatus("hidden", "delete")).toBe("deleted");
    expect(() => nextChatStatus("deleted", "unhide")).toThrow("invalid_state_transition");
    expect(() => nextChatStatus("visible", "unhide")).toThrow("invalid_state_transition");
  });

  it("makes answered/dismissed terminal", () => {
    expect(() => assertQuestionTransition("open", "answered")).not.toThrow();
    expect(() => assertQuestionTransition("open", "dismissed")).not.toThrow();
    expect(() => assertQuestionTransition("answered", "dismissed")).toThrow("invalid_state_transition");
    expect(() => assertQuestionTransition("open", "open")).toThrow("invalid_state_transition");
  });

  it("validates mute durations and reasons", () => {
    expect(validateMuteSeconds(60)).toBe(60);
    expect(() => validateMuteSeconds(0)).toThrow("invalid_mute_duration");
    expect(() => validateMuteSeconds(31 * 24 * 3600)).toThrow("invalid_mute_duration");
    expect(normalizeReason(" spam ")).toBe("spam");
    expect(() => normalizeReason("")).toThrow("invalid_reason");
    expect(normalizeReason(undefined, false)).toBeNull();
  });
});

describe("polls", () => {
  it("validates 2-10 unique bounded options", () => {
    const poll = validatePollDefinition({ question: "Pick", options: ["A", "B"] }, now);
    expect(poll.resultsVisibility).toBe("after_close");
    expect(poll.closesAt).toBeNull();
    expect(() => validatePollDefinition({ question: "Pick", options: ["A"] }, now)).toThrow("invalid_poll_options");
    expect(() => validatePollDefinition({ question: "Pick", options: Array.from({ length: 11 }, (_, i) => `o${i}`) }, now)).toThrow("invalid_poll_options");
    expect(() => validatePollDefinition({ question: "Pick", options: ["A", "a"] }, now)).toThrow("invalid_poll_options");
    expect(() => validatePollDefinition({ question: "", options: ["A", "B"] }, now)).toThrow("invalid_poll_question");
    expect(() => validatePollDefinition({ question: "Q", options: ["A", "B"], resultsVisibility: "sometimes" }, now)).toThrow("invalid_results_visibility");
    expect(() => validatePollDefinition({ question: "Q", options: ["A", "B"], closesAt: now.toISOString() }, now)).toThrow("invalid_closes_at");
    expect(validatePollDefinition({ question: "Q", options: ["A", "B"], closesAt: later(1000).toISOString() }, now).closesAt).toEqual(later(1000));
  });

  it("enforces open/close transitions and scheduled close", () => {
    expect(nextPollStatus("draft", "open")).toBe("open");
    expect(nextPollStatus("open", "close")).toBe("closed");
    expect(() => nextPollStatus("closed", "open")).toThrow("invalid_state_transition");
    expect(() => nextPollStatus("draft", "close")).toThrow("invalid_state_transition");
    expect(pollAcceptsVotes("open", null, now)).toBe(true);
    expect(pollAcceptsVotes("open", later(1), now)).toBe(true);
    expect(pollAcceptsVotes("open", now, now)).toBe(false);
    expect(pollAcceptsVotes("draft", null, now)).toBe(false);
  });

  it("applies the results visibility rule", () => {
    expect(canSeePollResults("live", "open", null, now, false)).toBe(true);
    expect(canSeePollResults("live", "draft", null, now, false)).toBe(false);
    expect(canSeePollResults("after_close", "open", null, now, false)).toBe(false);
    expect(canSeePollResults("after_close", "open", now, now, false)).toBe(true);
    expect(canSeePollResults("after_close", "closed", null, now, false)).toBe(true);
    expect(canSeePollResults("never", "closed", null, now, false)).toBe(false);
    expect(canSeePollResults("never", "open", null, now, true)).toBe(true);
  });
});
