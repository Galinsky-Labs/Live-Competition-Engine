import { DomainError, isBoundedText } from "./index.ts";

/**
 * LC-19 judge invitations, lifecycle and recusal rules. Pure: the clock is injected.
 */

export const judgeStatuses = ["active", "verified", "suspended", "removed"] as const;
export type JudgeStatus = (typeof judgeStatuses)[number];

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;
export const MIN_INVITE_HOURS = 1;
export const MAX_INVITE_HOURS = 24 * 30;
export const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("invalid_email");
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !EMAIL.test(email)) throw new DomainError("invalid_email");
  return email;
}

export function parseInviteLifetimeHours(value: unknown): number {
  if (value === undefined) return 72;
  if (!Number.isSafeInteger(value) || (value as number) < MIN_INVITE_HOURS || (value as number) > MAX_INVITE_HOURS) {
    throw new DomainError("invalid_invitation_lifetime");
  }
  return value as number;
}

export function parseJudgeName(value: unknown): string {
  if (!isBoundedText(value, 120, 1) || /[\n\t]/.test(value) || value.trim() === "") throw new DomainError("invalid_display_name");
  return value.trim();
}

export function assertInviteToken(value: unknown): string {
  if (typeof value !== "string" || !INVITE_TOKEN.test(value)) throw new DomainError("invitation_not_found");
  return value;
}

export interface InvitationState { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date; }

/** Single use, revocable, expiring. Order matters: a used invitation reports "used" even after expiry. */
export function assertInvitationUsable(invitation: InvitationState, now: Date): void {
  if (invitation.acceptedAt) throw new DomainError("invitation_used_conflict");
  if (invitation.revokedAt) throw new DomainError("invitation_revoked");
  if (invitation.expiresAt.getTime() <= now.getTime()) throw new DomainError("invitation_expired");
}

const transitions: Readonly<Record<JudgeStatus, readonly JudgeStatus[]>> = {
  active: ["verified", "suspended", "removed"],
  verified: ["suspended", "removed"],
  suspended: ["active", "removed"],
  removed: []
};

export function isJudgeStatus(value: unknown): value is JudgeStatus {
  return typeof value === "string" && (judgeStatuses as readonly string[]).includes(value);
}

export function assertJudgeTransition(from: JudgeStatus, to: JudgeStatus): void {
  if (!transitions[from].includes(to)) throw new DomainError("invalid_state_transition");
}

/** Whether the competition role grant should exist for a judge in this status. */
export function holdsJudgeRole(status: JudgeStatus): boolean {
  return status === "active" || status === "verified";
}

/** Judges may view assigned work while active or verified; only verified judges may submit scores. */
export function assertJudgeMayView(status: JudgeStatus): void {
  if (!holdsJudgeRole(status)) throw new DomainError("judge_inactive");
}

export function assertJudgeMayScore(status: JudgeStatus): void {
  assertJudgeMayView(status);
  if (status !== "verified") throw new DomainError("judge_not_verified");
}

export function parseRecusalReason(value: unknown): string {
  if (!isBoundedText(value, 1000, 1) || value.trim() === "") throw new DomainError("invalid_recusal_reason");
  return value.trim();
}
