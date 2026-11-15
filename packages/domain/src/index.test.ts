import { describe, expect, it } from "vitest";
import { DomainError, isBoundedText, isUuid } from "./index";

describe("domain primitives", () => {
  it("validates identifiers and bounded text", () => {
    expect(isUuid("00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isUuid("nope")).toBe(false);
    expect(isBoundedText("hello", 10)).toBe(true);
    expect(isBoundedText("bad\u0000", 10)).toBe(false);
    expect(isBoundedText("", 10, 1)).toBe(false);
    expect(new DomainError("x").code).toBe("x");
  });
});
