import { AuthenticationService } from "@live-competition-engine/auth";
import { createPostgresAuthStore } from "@live-competition-engine/db/auth-store";
import { evaluateStoredFeature } from "@live-competition-engine/db/feature-flags";
import { setPlatformFeature, setTenantScopedFeature } from "@live-competition-engine/db/feature-control";
import { createFeatureHandlers } from "./handler";

// LC-44: writes go through the ceiling-aware, audited wrapper around LC-08 setFeatureFlag.
const handlers = createFeatureHandlers(
  new AuthenticationService(createPostgresAuthStore()),
  async update => update.scope === "platform"
    ? (await setPlatformFeature(update.actorAccountId, update)).revision
    : (await setTenantScopedFeature(update.organizationId!, update.actorAccountId, update)).revision,
  evaluateStoredFeature
);

export const POST = handlers.post;
export const GET = handlers.get;
