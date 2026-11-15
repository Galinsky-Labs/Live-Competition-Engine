import { describe, expect, it } from "vitest";
import {
  appealResolutionNeedsReason, appealStatuses, assertAppealTransition, assertCritiqueTransition, canCritiqueTransition,
  critiqueStatuses, isAppealStatus, parseAppealBody, parseAppealKind, parseCritiqueBody, parseVisibility, submissionTarget,
  visibleToEntrant, visibleToPublic, type AppealActor, type CritiqueActor
} from "./critiques";

const code = (c: string) => expect.objectContaining({ code: c });

describe("critique lifecycle", () => {
  const allowed = new Set([
    "draft>delivered>judge", "draft>pending_moderation>judge", "draft>withdrawn>judge",
    "pending_moderation>published>producer", "pending_moderation>rejected>producer", "pending_moderation>withdrawn>judge",
    "rejected>draft>judge", "delivered>retracted>producer", "published>retracted>producer"
  ]);
  it("allows exactly the documented transitions", () => {
    for (const from of critiqueStatuses) for (const to of critiqueStatuses) for (const actor of ["judge", "producer"] as CritiqueActor[]) {
      const key = `${from}>${to}>${actor}`;
      expect(canCritiqueTransition(from, to, actor), key).toBe(allowed.has(key));
      if (!allowed.has(key)) expect(() => assertCritiqueTransition(from, to, actor)).toThrowError(code("invalid_state_transition"));
    }
  });

  it("routes submissions by visibility and limits who can read", () => {
    expect(submissionTarget("private")).toBe("delivered");
    expect(submissionTarget("public")).toBe("pending_moderation");
    expect(critiqueStatuses.filter(visibleToEntrant)).toEqual(["delivered", "published"]);
    expect(critiqueStatuses.filter(s => visibleToPublic(s, "public"))).toEqual(["published"]);
    expect(critiqueStatuses.filter(s => visibleToPublic(s, "private"))).toEqual([]);
  });

  it("bounds inputs", () => {
    expect(parseVisibility("public")).toBe("public");
    expect(() => parseVisibility("internal")).toThrowError(code("invalid_visibility"));
    expect(parseCritiqueBody("  Strong opening. ")).toBe("Strong opening.");
    for (const bad of ["", "   ", "x".repeat(5001), "a\u0000", 3]) expect(() => parseCritiqueBody(bad)).toThrowError(code("invalid_critique_body"));
  });
});

describe("appeal lifecycle", () => {
  const allowed = new Set([
    "open>under_review>producer", "open>upheld>producer", "open>dismissed>producer", "open>withdrawn>entrant",
    "under_review>upheld>producer", "under_review>dismissed>producer", "under_review>withdrawn>entrant"
  ]);
  it("allows exactly the documented transitions", () => {
    for (const from of appealStatuses) for (const to of appealStatuses) for (const actor of ["entrant", "producer"] as AppealActor[]) {
      const run = () => assertAppealTransition(from, to, actor);
      if (allowed.has(`${from}>${to}>${actor}`)) expect(run).not.toThrow(); else expect(run).toThrowError(code("invalid_state_transition"));
    }
  });

  it("bounds inputs and requires reasons for resolutions", () => {
    expect(parseAppealKind("correction")).toBe("correction");
    expect(() => parseAppealKind("complaint")).toThrowError(code("invalid_appeal_kind"));
    expect(parseAppealBody(" Wrong name ")).toBe("Wrong name");
    expect(() => parseAppealBody("x".repeat(2001))).toThrowError(code("invalid_appeal_body"));
    expect(isAppealStatus("open")).toBe(true);
    expect(isAppealStatus("closed")).toBe(false);
    expect(appealStatuses.filter(appealResolutionNeedsReason)).toEqual(["upheld", "dismissed"]);
  });
});
