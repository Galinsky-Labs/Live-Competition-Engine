import { parseServerEnv } from "@live-competition-engine/config";
import { parseProviderEnv } from "@live-competition-engine/config/providers";
import * as signup from "@live-competition-engine/db/tenant-signup";
import { authService } from "./services";
import { tenantGuard } from "./saas-services";

let sender: signup.VerificationSender | undefined;

/** Postmark when configured; otherwise the non-delivering default (token returned only in NODE_ENV=test). */
export function verificationSender(): signup.VerificationSender {
  if (!sender) {
    const providers = parseProviderEnv();
    sender = providers.POSTMARK_SERVER_TOKEN && providers.EMAIL_FROM_DEFAULT
      ? signup.createPostmarkVerificationSender(parseServerEnv().APP_URL)
      : signup.createDefaultVerificationSender();
  }
  return sender;
}

export const signupDeps = {
  signup: (input: unknown, ipHash: string) => signup.signupTenant(input, ipHash, {
    issueSession: (accountId, now) => authService().issueSession(accountId, now),
    sender: verificationSender()
  }),
  checkSlug: signup.checkSlugAvailability,
  verifyEmail: (accountId: unknown, token: unknown) => signup.verifyEmail(accountId, token),
  resend: (accountId: string) => signup.resendVerification(accountId, verificationSender()),
  hashIp: (ip: string) => signup.hashClientIp(ip)
};

export const onboardingDeps = {
  checklist: signup.getOnboardingChecklist,
  setSkipped: signup.setOnboardingStepSkipped,
  createFirstEvent: (organizationId: string, actorAccountId: string, input: unknown) =>
    signup.createFirstEvent(organizationId, actorAccountId, input),
  guard: tenantGuard
};

export { authService };
