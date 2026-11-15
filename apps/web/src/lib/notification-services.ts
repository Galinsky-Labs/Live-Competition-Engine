import { parseProviderEnv, requirePostmark } from "@live-competition-engine/config/providers";
import { runDueScheduledPublications } from "@live-competition-engine/db/cms";
import { runJobs } from "@live-competition-engine/db/jobs";
import * as notifications from "@live-competition-engine/db/notifications";
import { createPostmarkProvider, type EmailProvider } from "@live-competition-engine/db/providers/email";
import { createJobRunHandler } from "../app/api/jobs/run/handler";
import { createNotificationHandlers, type NotificationService } from "../app/api/organizations/[organizationId]/notifications/handlers";
import { createPostmarkWebhookHandler } from "../app/api/webhooks/postmark/handler";
import { authService } from "./services";

/** Invalid provider configuration is treated as absent (fail closed), never as a crash at import. */
function providerEnv() {
  try {
    return parseProviderEnv();
  } catch {
    return {} as ReturnType<typeof parseProviderEnv>;
  }
}

/**
 * POSTMARK_WEBHOOK_SECRET is not (yet) part of packages/config/src/providers.ts; it is read
 * here with the same rules (optional, fail closed, >= 32 characters).
 */
export function postmarkWebhookSecret(source: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = source.POSTMARK_WEBHOOK_SECRET;
  return typeof value === "string" && value.length >= 32 ? value : undefined;
}

/** Resolved lazily per send so a missing token fails that job (and it retries) instead of the process. */
export function emailProvider(): EmailProvider {
  return createPostmarkProvider(requirePostmark());
}

let composer: notifications.EmailComposer | undefined;

/** Overridable so LC-52 can install the tenant-branded composer. */
export function setNotificationEmailComposer(next: notifications.EmailComposer): void {
  composer = next;
}

export function notificationEmailComposer(): notifications.EmailComposer {
  return composer ?? notifications.createPlainEmailComposer(providerEnv().EMAIL_FROM_DEFAULT);
}

export const notificationService: NotificationService = {
  listInbox: notifications.listInbox,
  markRead: notifications.markRead,
  markAllRead: notifications.markAllRead,
  getPreferences: notifications.getPreferences,
  setPreferences: (org, account, preferences) => notifications.setPreferences(org, account, preferences),
  notify: (org, input) => notifications.notify(org, input, { composer: notificationEmailComposer() })
};

/** Job kinds this deployment's worker handles. */
export function jobHandlers() {
  return { [notifications.EMAIL_JOB_KIND]: notifications.createEmailJobHandler(emailProvider) };
}

export async function runWorkerTick(options: { limit: number }) {
  const cms = await runDueScheduledPublications(new Date(), options.limit);
  const jobs = await runJobs(jobHandlers(), { limit: options.limit });
  return { cms, jobs };
}

let inbox: ReturnType<typeof createNotificationHandlers> | undefined;
export function notificationHandlers() {
  inbox ??= createNotificationHandlers(authService(), notificationService);
  return inbox;
}

let worker: ReturnType<typeof createJobRunHandler> | undefined;
export function jobRunHandler() {
  worker ??= createJobRunHandler(() => providerEnv().JOB_WORKER_SECRET, runWorkerTick);
  return worker;
}

let webhook: ReturnType<typeof createPostmarkWebhookHandler> | undefined;
export function postmarkWebhookHandler() {
  webhook ??= createPostmarkWebhookHandler(() => postmarkWebhookSecret(), notifications.parsePostmarkEvent, notifications.applyProviderEvent);
  return webhook;
}
