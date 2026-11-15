/**
 * LC-23 backstage visibility and message rules. Pure.
 *
 * Least privilege:
 * - producer: sees everything in the competition's backstage feed.
 * - judge: sees only the producer<->judge channel.
 * - performer: sees cues addressed to entries they are linked to, and their own check-ins/acks.
 */
import { DomainError, isBoundedText } from "./index.ts";

export const backstageRoles = ["producer", "judge", "performer"] as const;
export type BackstageRole = (typeof backstageRoles)[number];

export const readinessStatuses = ["ready", "not_ready", "need_help"] as const;
export type Readiness = (typeof readinessStatuses)[number];

export const backstageKinds = ["checkin", "cue", "cue_ack", "judge_message"] as const;
export type BackstageKind = (typeof backstageKinds)[number];

export const BACKSTAGE_LIMITS = {
  cueBody: 280,
  checkinNote: 280,
  judgeMessage: 500,
  /** Messages an author may post per competition per window. */
  ratePerWindow: 20,
  rateWindowMs: 60_000,
  pageSize: 100
} as const;

export interface BackstageMessageLike {
  kind: BackstageKind;
  authorAccountId: string;
  entryId: string | null;
}

export interface BackstageViewer {
  role: BackstageRole;
  accountId: string;
  linkedEntryIds: ReadonlySet<string>;
}

export function canViewMessage(viewer: BackstageViewer, message: BackstageMessageLike): boolean {
  switch (viewer.role) {
    case "producer":
      return true;
    case "judge":
      return message.kind === "judge_message";
    case "performer":
      if (message.kind === "cue") return message.entryId !== null && viewer.linkedEntryIds.has(message.entryId);
      if (message.kind === "checkin" || message.kind === "cue_ack") return message.authorAccountId === viewer.accountId;
      return false;
  }
}

const posters: Readonly<Record<BackstageKind, readonly BackstageRole[]>> = {
  checkin: ["performer"],
  cue: ["producer"],
  cue_ack: ["performer"],
  judge_message: ["producer", "judge"]
};

export function assertCanPost(role: BackstageRole, kind: BackstageKind): void {
  if (!posters[kind].includes(role)) throw new DomainError("forbidden");
}

export function assertReadiness(value: unknown): asserts value is Readiness {
  if (!(readinessStatuses as readonly unknown[]).includes(value)) throw new DomainError("invalid_readiness");
}

/** Trim and bound a message body. Empty is allowed only when `min` is 0. */
export function normalizeBody(value: unknown, max: number, min = 1): string {
  if (value === undefined && min === 0) return "";
  if (typeof value !== "string") throw new DomainError("invalid_body");
  const trimmed = value.trim();
  if (!isBoundedText(trimmed, max, min)) throw new DomainError("invalid_body");
  return trimmed;
}

/** Parse a `since` cursor from a query string: non-negative safe integer, default 0. */
export function parseCursor(value: string | null): number {
  if (value === null || value === "") return 0;
  if (!/^\d{1,15}$/.test(value)) throw new DomainError("invalid_cursor");
  return Number(value);
}

export function assertWithinRate(recentCount: number): void {
  if (recentCount >= BACKSTAGE_LIMITS.ratePerWindow) throw new DomainError("rate_limited");
}
