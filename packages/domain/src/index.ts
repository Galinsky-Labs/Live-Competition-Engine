/**
 * Pure, dependency-free domain logic for the Live Competition Engine.
 * Modules here never touch the database, network, clock or randomness unless
 * those are injected; they are imported via "@live-competition-engine/domain/<module>".
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Bounded plain text with no control characters other than tab/newline. */
export function isBoundedText(value: unknown, max: number, min = 0): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}
