import type { FeatureKey } from "@live-competition-engine/config/features";
import { DomainError } from "@live-competition-engine/domain";
import { evaluateStoredFeature } from "./feature-flags.ts";

/**
 * Evaluate an LC-08 feature flag (audited) and throw DomainError("feature_disabled")
 * when it is off. Call BEFORE any side effect of an optional capability
 * (payments, voting, chat, ...). eventId is a competition id in the same tenant.
 */
export async function requireEnabledFeature(
  feature: FeatureKey,
  context: { organizationId: string; eventId?: string; accountId?: string }
): Promise<void> {
  const decision = await evaluateStoredFeature(feature, {
    organizationId: context.organizationId,
    ...(context.eventId ? { eventId: context.eventId } : {}),
    ...(context.accountId ? { accountId: context.accountId } : {})
  });
  if (!decision.enabled) throw new DomainError("feature_disabled");
}

export async function isFeatureEnabled(
  feature: FeatureKey,
  context: { organizationId: string; eventId?: string; accountId?: string }
): Promise<boolean> {
  try {
    await requireEnabledFeature(feature, context);
    return true;
  } catch (error) {
    if (error instanceof DomainError && error.code === "feature_disabled") return false;
    throw error;
  }
}
