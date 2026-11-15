import { describe, expect, it } from "vitest";
import {
  assertInvitationUsable, assertInviteToken, assertJudgeMayScore, assertJudgeMayView, assertJudgeTransition, holdsJudgeRole,
  judgeStatuses, normalizeEmail, parseInviteLifetimeHours, parseJudgeName, parseRecusalReason, type JudgeStatus
} from "./judges";

const code = (c: string) => expect.objectContaining({ code: c });

describe("judge invitations", () => {
  it("normalizes and bounds emails", () => {
    expect(normalizeEmail("  Judge@Example.COM ")).toBe("judge@example.com");
    for (const bad of ["", "no-at", "a@b", "a b@c.de", 5, `${"x".repeat(320)}@e.com`]) expect(() => normalizeEmail(bad)).toThrowError(code("invalid_email"));
  });

  it("bounds invitation lifetime", () => {
    expect(parseInviteLifetimeHours(undefined)).toBe(72);
    expect(parseInviteLifetimeHours(1)).toBe(1);
    for (const bad of [0, 721, 1.5, "2"]) expect(() => parseInviteLifetimeHours(bad)).toThrowError(code("invalid_invitation_lifetime"));
  });

  it("validates token shape without revealing anything", () => {
    expect(assertInviteToken("a".repeat(43))).toHaveLength(43);
    expect(() => assertInviteToken("short")).toThrowError(code("invitation_not_found"));
  });

  it("is single use, revocable and expiring", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const fresh = { acceptedAt: null, revokedAt: null, expiresAt: new Date("2026-01-02T00:00:00Z") };
    expect(() => assertInvitationUsable(fresh, now)).not.toThrow();
    expect(() => assertInvitationUsable({ ...fresh, acceptedAt: now, expiresAt: new Date(0) }, now)).toThrowError(code("invitation_used_conflict"));
    expect(() => assertInvitationUsable({ ...fresh, revokedAt: now }, now)).toThrowError(code("invitation_revoked"));
    expect(() => assertInvitationUsable({ ...fresh, expiresAt: now }, now)).toThrowError(code("invitation_expired"));
  });

  it("validates names and recusal reasons", () => {
    expect(parseJudgeName(" Pat ")).toBe("Pat");
    expect(() => parseJudgeName("a\nb")).toThrowError(code("invalid_display_name"));
    expect(parseRecusalReason(" Family member ")).toBe("Family member");
    expect(() => parseRecusalReason("  ")).toThrowError(code("invalid_recusal_reason"));
  });
});

describe("judge lifecycle", () => {
  const allowed = new Set(["active>verified", "active>suspended", "active>removed", "verified>suspended", "verified>removed", "suspended>active", "suspended>removed"]);
  it("allows exactly the documented transitions", () => {
    for (const from of judgeStatuses) for (const to of judgeStatuses) {
      const run = () => assertJudgeTransition(from, to);
      if (allowed.has(`${from}>${to}`)) expect(run).not.toThrow();
      else expect(run).toThrowError(code("invalid_state_transition"));
    }
  });

  it("derives role and access from status", () => {
    const view: Record<JudgeStatus, string | null> = { active: null, verified: null, suspended: "judge_inactive", removed: "judge_inactive" };
    const score: Record<JudgeStatus, string | null> = { active: "judge_not_verified", verified: null, suspended: "judge_inactive", removed: "judge_inactive" };
    for (const status of judgeStatuses) {
      expect(holdsJudgeRole(status)).toBe(view[status] === null);
      if (view[status]) expect(() => assertJudgeMayView(status)).toThrowError(code(view[status]!)); else expect(() => assertJudgeMayView(status)).not.toThrow();
      if (score[status]) expect(() => assertJudgeMayScore(status)).toThrowError(code(score[status]!)); else expect(() => assertJudgeMayScore(status)).not.toThrow();
    }
  });
});
