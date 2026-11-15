import { DomainError, isBoundedText } from "./index.ts";

/**
 * LC-21 critiques and appeals: state machines and input bounds. Pure.
 *
 * Critique lifecycle
 *   draft ─submit(judge)→ delivered            (private: visible to the entrant immediately)
 *   draft ─submit(judge)→ pending_moderation   (public: needs producer approval)
 *   pending_moderation ─producer→ published | rejected (reason)
 *   rejected ─judge edits→ draft
 *   draft | pending_moderation ─judge→ withdrawn
 *   delivered | published ─producer→ retracted (reason; e.g. an upheld appeal)
 */
export const critiqueStatuses = ["draft", "delivered", "pending_moderation", "published", "rejected", "withdrawn", "retracted"] as const;
export type CritiqueStatus = (typeof critiqueStatuses)[number];
export type CritiqueVisibility = "private" | "public";
export type CritiqueActor = "judge" | "producer";

const critiqueTransitions: Readonly<Record<CritiqueStatus, Partial<Record<CritiqueStatus, CritiqueActor>>>> = {
  draft: { delivered: "judge", pending_moderation: "judge", withdrawn: "judge" },
  pending_moderation: { published: "producer", rejected: "producer", withdrawn: "judge" },
  rejected: { draft: "judge" },
  delivered: { retracted: "producer" },
  published: { retracted: "producer" },
  withdrawn: {},
  retracted: {}
};

export function assertCritiqueTransition(from: CritiqueStatus, to: CritiqueStatus, actor: CritiqueActor): void {
  if (critiqueTransitions[from][to] !== actor) throw new DomainError("invalid_state_transition");
}

export function canCritiqueTransition(from: CritiqueStatus, to: CritiqueStatus, actor: CritiqueActor): boolean {
  return critiqueTransitions[from][to] === actor;
}

/** Where a submitted critique goes: private ones are delivered, public ones wait for moderation. */
export function submissionTarget(visibility: CritiqueVisibility): CritiqueStatus {
  return visibility === "private" ? "delivered" : "pending_moderation";
}

/** The entrant sees delivered and published critiques of their own entries. */
export const visibleToEntrant = (status: CritiqueStatus) => status === "delivered" || status === "published";
/** The public sees only published public critiques. */
export const visibleToPublic = (status: CritiqueStatus, visibility: CritiqueVisibility) => status === "published" && visibility === "public";

export function parseVisibility(value: unknown): CritiqueVisibility {
  if (value !== "private" && value !== "public") throw new DomainError("invalid_visibility");
  return value;
}

export function parseCritiqueBody(value: unknown): string {
  if (!isBoundedText(value, 5000, 1) || value.trim() === "") throw new DomainError("invalid_critique_body");
  return value.trim();
}

/**
 * Appeal / correction-request lifecycle
 *   open ─producer→ under_review ─producer→ upheld | dismissed
 *   open ─producer→ upheld | dismissed
 *   open | under_review ─entrant→ withdrawn
 */
export const appealStatuses = ["open", "under_review", "upheld", "dismissed", "withdrawn"] as const;
export type AppealStatus = (typeof appealStatuses)[number];
export type AppealKind = "appeal" | "correction";
export type AppealActor = "entrant" | "producer";

const appealTransitions: Readonly<Record<AppealStatus, Partial<Record<AppealStatus, AppealActor>>>> = {
  open: { under_review: "producer", upheld: "producer", dismissed: "producer", withdrawn: "entrant" },
  under_review: { upheld: "producer", dismissed: "producer", withdrawn: "entrant" },
  upheld: {},
  dismissed: {},
  withdrawn: {}
};

export function assertAppealTransition(from: AppealStatus, to: AppealStatus, actor: AppealActor): void {
  if (appealTransitions[from][to] !== actor) throw new DomainError("invalid_state_transition");
}

export function isAppealStatus(value: unknown): value is AppealStatus {
  return typeof value === "string" && (appealStatuses as readonly string[]).includes(value);
}

export function parseAppealKind(value: unknown): AppealKind {
  if (value !== "appeal" && value !== "correction") throw new DomainError("invalid_appeal_kind");
  return value;
}

export function parseAppealBody(value: unknown): string {
  if (!isBoundedText(value, 2000, 1) || value.trim() === "") throw new DomainError("invalid_appeal_body");
  return value.trim();
}

/** Resolutions (upheld/dismissed) need a written reason that the entrant can read. */
export function appealResolutionNeedsReason(to: AppealStatus): boolean {
  return to === "upheld" || to === "dismissed";
}
