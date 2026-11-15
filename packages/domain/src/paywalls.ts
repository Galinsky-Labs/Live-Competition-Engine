import { DomainError, isBoundedText, isUuid } from "./index.ts";
import { normalizeCurrency, requireMinorAmount } from "./money.ts";

export const accessRules = ["public", "members", "plan", "purchase"] as const;
export type AccessRule = (typeof accessRules)[number];
export type ContentAccess = "full" | "teaser" | "hidden";

export interface ContentInput {
  creatorType: "tenant" | "participant" | "account";
  creatorId: string | null;
  eventId: string | null;
  kind: "text" | "media";
  mediaId: string | null;
  title: string;
  teaser: string;
  body: string | null;
  accessRule: AccessRule;
  planId: string | null;
  priceMinor: number | null;
  currency: string | null;
}

export function validateContentInput(body: Record<string, unknown>): ContentInput {
  const creatorType = body.creatorType ?? "tenant";
  if (creatorType !== "tenant" && creatorType !== "participant" && creatorType !== "account") throw new DomainError("invalid_creator");
  const creatorId = body.creatorId ?? null;
  if (creatorType === "tenant" ? creatorId !== null : !isUuid(creatorId)) throw new DomainError("invalid_creator");
  const eventId = body.eventId ?? null;
  if (eventId !== null && !isUuid(eventId)) throw new DomainError("invalid_event");
  const kind = body.kind ?? "text";
  if (kind !== "text" && kind !== "media") throw new DomainError("invalid_kind");
  const mediaId = body.mediaId ?? null;
  if (kind === "media" ? !isUuid(mediaId) : mediaId !== null) throw new DomainError("invalid_media");
  if (!isBoundedText(body.title, 200, 1) || !body.title.trim()) throw new DomainError("invalid_title");
  const teaser = body.teaser ?? "";
  if (!isBoundedText(teaser, 2000)) throw new DomainError("invalid_teaser");
  const text = body.body ?? null;
  if (kind === "text" ? !isBoundedText(text, 100_000, 1) : text !== null) throw new DomainError("invalid_body");
  const accessRule = body.accessRule ?? "public";
  if (!accessRules.includes(accessRule as AccessRule)) throw new DomainError("invalid_access_rule");
  const planId = body.planId ?? null;
  if (accessRule === "plan" ? !isUuid(planId) : planId !== null) throw new DomainError("invalid_plan");
  let priceMinor: number | null = null;
  let currency: string | null = null;
  if (accessRule === "purchase") {
    priceMinor = requireMinorAmount(body.priceMinor, { allowZero: false });
    currency = normalizeCurrency(body.currency);
  } else if (body.priceMinor !== undefined && body.priceMinor !== null) {
    throw new DomainError("invalid_amount");
  }
  return {
    creatorType, creatorId: creatorId as string | null, eventId: eventId as string | null, kind, mediaId: mediaId as string | null,
    title: body.title.trim(), teaser, body: text as string | null, accessRule: accessRule as AccessRule, planId: planId as string | null, priceMinor, currency
  };
}

/**
 * Decide what a viewer sees. Public items are always full (a creator can
 * always publish free). With content_paywalls disabled, gated items are hidden
 * entirely (fail closed, and no price or purchase gate is surfaced). Owners and
 * tenant managers always see their content.
 */
export function decideContentAccess(input: {
  rule: AccessRule;
  paywallsEnabled: boolean;
  isOwnerOrManager: boolean;
  isSupporter: boolean;
  hasPlan: boolean;
  hasPurchase: boolean;
}): ContentAccess {
  if (input.rule === "public" || input.isOwnerOrManager) return "full";
  if (!input.paywallsEnabled) return "hidden";
  if (input.rule === "members") return input.isSupporter ? "full" : "teaser";
  if (input.rule === "plan") return input.hasPlan ? "full" : "teaser";
  return input.hasPurchase ? "full" : "teaser";
}
