/**
 * LC-26 broadcast presentation rules. Pure.
 *
 * On-air text is producer-authored but still moderated: it is shown to every
 * viewer of the stream, so it is bounded, single-line, markup-free, link-free and
 * checked against the tenant's blocked-terms list (the engine ships none: terms
 * are product/tenant policy, configured in competitions.rules.broadcast.blockedTerms).
 */
import { DomainError } from "./index.ts";

export const CAPTION_LIMITS = { text: 120, subtitle: 120, blockedTerms: 200, blockedTermLength: 60 } as const;
export const captionKinds = ["lower_third", "caption"] as const;
export type CaptionKind = (typeof captionKinds)[number];

/** Fold case, accents and common character substitutions for term matching. */
export function foldForMatching(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[0@]/g, "o").replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/[5$]/g, "s").replace(/7/g, "t")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|tv|gg|co|me|ly|app|xyz|info|biz)\b)/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /(\+?\d[\d\s().-]{7,}\d)/;

/**
 * Validate and normalize a caption string. Throws DomainError("caption_rejected_<reason>").
 */
export function moderateCaption(input: unknown, blockedTerms: readonly string[] = [], max: number = CAPTION_LIMITS.text): string {
  if (typeof input !== "string") throw new DomainError("caption_rejected_type");
  const text = input.normalize("NFC").replace(/\s+/g, " ").trim();
  if (text.length === 0 || text.length > max) throw new DomainError("caption_rejected_length");
  if (/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/.test(input.replace(/[ \t]/g, ""))) {
    throw new DomainError("caption_rejected_control_characters");
  }
  if (/[<>{}`]/.test(text)) throw new DomainError("caption_rejected_markup");
  if (LINK.test(text) || EMAIL.test(text)) throw new DomainError("caption_rejected_link");
  if (PHONE.test(text)) throw new DomainError("caption_rejected_contact_details");
  const folded = ` ${foldForMatching(text)} `;
  const compact = folded.replace(/\s/g, "");
  for (const term of blockedTerms) {
    const needle = foldForMatching(term);
    if (!needle) continue;
    if (folded.includes(` ${needle} `) || (needle.length >= 4 && compact.includes(needle.replace(/\s/g, "")))) {
      throw new DomainError("caption_rejected_blocked_term");
    }
  }
  return text;
}

/** Read a bounded blocked-terms list from untrusted competition rules JSON. */
export function blockedTermsFromRules(rules: unknown): string[] {
  const list = (rules as { broadcast?: { blockedTerms?: unknown } } | null)?.broadcast?.blockedTerms;
  if (!Array.isArray(list)) return [];
  return list
    .filter((term): term is string => typeof term === "string" && term.length > 0 && term.length <= CAPTION_LIMITS.blockedTermLength)
    .slice(0, CAPTION_LIMITS.blockedTerms);
}

/**
 * Client-side staleness rule for overlays: apply an update only if its sequence is
 * not older than the one already displayed.
 */
export function shouldApplyUpdate(displayedSequence: number | null, incomingSequence: number): boolean {
  return displayedSequence === null || incomingSequence >= displayedSequence;
}

export interface PublicTimer {
  status: "idle" | "running" | "paused";
  durationMs: number;
  extendedMs: number;
  elapsedBeforeMs: number;
  /** Server epoch ms when the current running segment began; null unless running. */
  runningSince: number | null;
  sequence: number;
}

/** Remaining ms at a server time estimate, from the cacheable public timer description. */
export function publicTimerRemaining(timer: PublicTimer, serverNow: number): number {
  const elapsed = timer.elapsedBeforeMs + (timer.status === "running" && timer.runningSince !== null ? Math.max(0, serverNow - timer.runningSince) : 0);
  return timer.durationMs + timer.extendedMs - elapsed;
}
