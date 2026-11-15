import { describe, expect, it } from "vitest";
import { blockedTermsFromRules, foldForMatching, moderateCaption, publicTimerRemaining, shouldApplyUpdate } from "./broadcast.ts";

describe("caption moderation", () => {
  it("normalizes whitespace and accepts plain text", () => {
    expect(moderateCaption("  Next up:   Entrant  A  ")).toBe("Next up: Entrant A");
    expect(moderateCaption("Café — round 2 (final)")).toBe("Café — round 2 (final)");
  });

  it("rejects unsafe or out-of-bounds text", () => {
    const reject = (value: unknown, code: string, terms: string[] = []) => expect(() => moderateCaption(value, terms)).toThrow(new RegExp(code));
    reject("", "caption_rejected_length");
    reject("x".repeat(121), "caption_rejected_length");
    reject(42, "caption_rejected_type");
    reject("line\u0007bell", "caption_rejected_control_characters");
    reject("rtl‮override", "caption_rejected_control_characters");
    reject("<b>bold</b>", "caption_rejected_markup");
    reject("visit https://evil.example", "caption_rejected_link");
    reject("go to evil.com now", "caption_rejected_link");
    reject("mail me@example.org", "caption_rejected_link");
    reject("call +1 555 123 4567", "caption_rejected_contact_details");
    reject("this is BADWORD here", "caption_rejected_blocked_term", ["badword"]);
    reject("this is b4dw0rd here", "caption_rejected_blocked_term", ["badword"]);
    reject("this is b a d w o r d", "caption_rejected_blocked_term", ["badword"]);
  });

  it("does not over-match short terms inside longer words", () => {
    expect(moderateCaption("Class act", ["ass"])).toBe("Class act");
    expect(() => moderateCaption("what an ass", ["ass"])).toThrow(/blocked_term/);
  });

  it("reads bounded blocked terms from rules", () => {
    expect(blockedTermsFromRules({ broadcast: { blockedTerms: ["a", 5, "x".repeat(61), "b"] } })).toEqual(["a", "b"]);
    expect(blockedTermsFromRules(null)).toEqual([]);
    expect(blockedTermsFromRules({ broadcast: { blockedTerms: "nope" } })).toEqual([]);
    expect(foldForMatching("Ünïcödé 1337")).toBe("unicode ieet");
  });
});

describe("latency helpers", () => {
  it("ignores stale updates", () => {
    expect(shouldApplyUpdate(null, 1)).toBe(true);
    expect(shouldApplyUpdate(5, 5)).toBe(true);
    expect(shouldApplyUpdate(5, 6)).toBe(true);
    expect(shouldApplyUpdate(5, 4)).toBe(false);
  });

  it("computes remaining time from a cacheable timer description", () => {
    const timer = { status: "running" as const, durationMs: 60_000, extendedMs: 10_000, elapsedBeforeMs: 5_000, runningSince: 1_000, sequence: 3 };
    expect(publicTimerRemaining(timer, 11_000)).toBe(55_000);
    expect(publicTimerRemaining(timer, 500)).toBe(65_000);
    expect(publicTimerRemaining({ ...timer, status: "paused", runningSince: null }, 99_999)).toBe(65_000);
  });
});
