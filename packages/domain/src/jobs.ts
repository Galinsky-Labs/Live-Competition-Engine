/** Pure retry policy for the durable job queue. Randomness is injected. */

export const JOB_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

/**
 * Exponential backoff with "equal jitter": half the exponential delay is fixed,
 * the other half random. attempt is 1-based (the attempt that just failed).
 */
export function computeBackoffMs(attempt: number, baseMs: number, random: () => number = Math.random, capMs = JOB_BACKOFF_CAP_MS): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError("attempt must be >= 1");
  if (!Number.isSafeInteger(baseMs) || baseMs < 1) throw new RangeError("baseMs must be >= 1");
  const exponential = Math.min(capMs, baseMs * 2 ** Math.min(attempt - 1, 30));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(exponential / 2 + (exponential / 2) * r);
}

export type FailureOutcome = { status: "queued"; delayMs: number } | { status: "dead" };

export function outcomeAfterFailure(
  attempts: number, maxAttempts: number, baseMs: number, permanent: boolean, random: () => number = Math.random
): FailureOutcome {
  if (permanent || attempts >= maxAttempts) return { status: "dead" };
  return { status: "queued", delayMs: computeBackoffMs(attempts, baseMs, random) };
}

/** Bounded, single-line error text for storage. */
export function summarizeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw.replace(/[\r\n\t]+/g, " ").slice(0, 2000);
}
