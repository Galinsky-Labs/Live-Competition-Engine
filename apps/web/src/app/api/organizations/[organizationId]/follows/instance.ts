import {
  follow,
  followerCount,
  listMyFollows,
  parseFollowTarget,
  setNotificationConsent,
  unfollow
} from "@live-competition-engine/db/follows";
import { authService } from "../../../../../lib/services";
import { createFollowHandlers } from "./handler";

export const followHandlers = createFollowHandlers(authService(), {
  parseTarget: parseFollowTarget,
  follow,
  unfollow,
  setConsent: setNotificationConsent,
  listMine: listMyFollows,
  count: followerCount
});
