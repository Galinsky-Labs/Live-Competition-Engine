import { describe, expect, it } from "vitest";
import { formatClock, remainingAt } from "./live-view";

describe("broadcast clock", () => {
  const timer = { status: "running", remainingMs: 0, overtimeMs: 0, inGrace: false, runningSince: 10_000, durationMs: 60_000, extendedMs: 5_000, accumulatedMs: 0, serverNow: 10_000 };
  it("derives remaining time from server time using the measured offset", () => {
    // Client clock runs 3s behind the server.
    expect(remainingAt(timer, 27_000, 3_000).remainingMs).toBe(45_000);
    expect(remainingAt(timer, 100_000, 0).overtimeMs).toBe(25_000);
    expect(remainingAt({ ...timer, status: "paused", accumulatedMs: 20_000 }, 999_999, 0).remainingMs).toBe(45_000);
  });
  it("formats minutes and seconds", () => {
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(400)).toBe("0:01");
  });
});
