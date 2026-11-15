import { isFeatureEnabled } from "@live-competition-engine/db/feature-guard";
import {
  editProfile,
  linkParticipantAccount,
  listProfiles,
  moderateProfile,
  parseProfilePatch,
  readProfile
} from "@live-competition-engine/db/profiles";
import { authService } from "../../../../../lib/services";
import { createProfileHandlers } from "./handler";

export const profileHandlers = createProfileHandlers(authService(), {
  read: readProfile,
  list: listProfiles,
  parsePatch: parseProfilePatch,
  edit: editProfile,
  moderate: moderateProfile,
  linkParticipant: linkParticipantAccount,
  publicEnabled: organizationId => isFeatureEnabled("public_profiles", { organizationId })
});
