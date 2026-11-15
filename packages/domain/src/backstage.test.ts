import { describe, expect, it } from "vitest";
import {
  assertCanPost,
  assertReadiness,
  assertWithinRate,
  backstageKinds,
  backstageRoles,
  canViewMessage,
  normalizeBody,
  parseCursor
} from "./backstage.ts";

const me = "me", other = "other", myEntry = "entry-me", otherEntry = "entry-other";
const performer = { role: "performer" as const, accountId: me, linkedEntryIds: new Set([myEntry]) };
const judge = { role: "judge" as const, accountId: me, linkedEntryIds: new Set<string>() };
const producer = { role: "producer" as const, accountId: me, linkedEntryIds: new Set<string>() };

describe("backstage visibility", () => {
  it("lets performers see only their own cues, check-ins and acks", () => {
    expect(canViewMessage(performer, { kind: "cue", authorAccountId: other, entryId: myEntry })).toBe(true);
    expect(canViewMessage(performer, { kind: "cue", authorAccountId: other, entryId: otherEntry })).toBe(false);
    expect(canViewMessage(performer, { kind: "cue", authorAccountId: other, entryId: null })).toBe(false);
    expect(canViewMessage(performer, { kind: "checkin", authorAccountId: me, entryId: myEntry })).toBe(true);
    expect(canViewMessage(performer, { kind: "checkin", authorAccountId: other, entryId: myEntry })).toBe(false);
    expect(canViewMessage(performer, { kind: "cue_ack", authorAccountId: other, entryId: myEntry })).toBe(false);
    expect(canViewMessage(performer, { kind: "judge_message", authorAccountId: other, entryId: null })).toBe(false);
  });

  it("lets judges see only the judge channel and producers everything", () => {
    for (const kind of backstageKinds) {
      expect(canViewMessage(judge, { kind, authorAccountId: other, entryId: myEntry })).toBe(kind === "judge_message");
      expect(canViewMessage(producer, { kind, authorAccountId: other, entryId: otherEntry })).toBe(true);
    }
  });

  it("restricts who can post each kind", () => {
    const allowed = backstageRoles.flatMap(role => backstageKinds.filter(kind => {
      try { assertCanPost(role, kind); return true; } catch { return false; }
    }).map(kind => `${role}:${kind}`));
    expect(allowed.sort()).toEqual(["judge:judge_message", "performer:checkin", "performer:cue_ack", "producer:cue", "producer:judge_message"]);
  });
});

describe("backstage input bounds", () => {
  it("validates readiness, bodies, cursors and rate", () => {
    expect(() => assertReadiness("ready")).not.toThrow();
    expect(() => assertReadiness("sleepy")).toThrow(/invalid_readiness/);
    expect(normalizeBody("  go now  ", 10)).toBe("go now");
    expect(normalizeBody(undefined, 10, 0)).toBe("");
    expect(() => normalizeBody("   ", 10)).toThrow(/invalid_body/);
    expect(() => normalizeBody("x".repeat(11), 10)).toThrow(/invalid_body/);
    expect(() => normalizeBody("bell\u0007", 10)).toThrow(/invalid_body/);
    expect(() => normalizeBody(5, 10)).toThrow(/invalid_body/);
    expect(parseCursor(null)).toBe(0);
    expect(parseCursor("42")).toBe(42);
    expect(() => parseCursor("-1")).toThrow(/invalid_cursor/);
    expect(() => parseCursor("1e9")).toThrow(/invalid_cursor/);
    expect(() => assertWithinRate(19)).not.toThrow();
    expect(() => assertWithinRate(20)).toThrow(/rate_limited/);
  });
});
