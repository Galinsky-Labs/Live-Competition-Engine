import { createHash, randomUUID } from "node:crypto";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  evaluateConsent,
  defaultPreference,
  notificationCategories,
  notificationChannels,
  parseCategory,
  parseChannel,
  parseNotificationInput,
  parsePreferences,
  type ConsentDecision,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationInput
} from "@live-competition-engine/domain/notifications";
import { recordAudit, type Sql } from "./audit.ts";
import { isFeatureEnabled } from "./feature-guard.ts";
import { getSqlClient } from "./index.ts";
import { enqueueJob, PermanentJobError, type Job, type JobHandler } from "./jobs.ts";
import { EmailSendError, type EmailProvider } from "./providers/email.ts";

/**
 * LC-47 notifications. In-app notifications are rows scoped to (tenant, account); every
 * read filters by both, so an account never sees another tenant's notifications.
 * Email goes through an outbox row + durable job; the worker re-checks consent and
 * suppression right before sending.
 */

export const EMAIL_JOB_KIND = "notification.email";

const emailHash = (email: string) => createHash("sha256").update(email.toLowerCase(), "utf8").digest("hex");

async function gatherConsentFacts(sql: Sql, organizationId: string, accountId: string, category: NotificationCategory, channel: NotificationChannel) {
  const [row] = await sql<{ status: string | null; email: string | null; preference: boolean | null; suppressed: boolean }[]>`
    SELECT m.status, a.email,
      (SELECT enabled FROM notification_preferences p WHERE p.organization_id = ${organizationId} AND p.account_id = ${accountId}
        AND p.category = ${category} AND p.channel = ${channel}) AS preference,
      EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email = a.email) AS suppressed
    FROM accounts a
    LEFT JOIN organization_memberships m ON m.organization_id = ${organizationId} AND m.account_id = a.id
    WHERE a.id = ${accountId} AND a.disabled_at IS NULL
  `;
  return row ?? null;
}

/**
 * The single consent gate for every notification. Requires an active membership, the
 * `notifications` (in-app) or `email` (email) feature, the account's preference (default:
 * on, except marketing which is opt-in), and for email a non-suppressed address.
 */
export async function canNotify(
  organizationId: string, accountId: string, categoryInput: unknown, channelInput: unknown, sql: Sql = getSqlClient()
): Promise<ConsentDecision> {
  const category = parseCategory(categoryInput);
  const channel = parseChannel(channelInput);
  if (!isUuid(organizationId) || !isUuid(accountId)) return { allowed: false, reason: "not_member" };
  const facts = await gatherConsentFacts(sql, organizationId, accountId, category, channel);
  const activeMember = facts?.status === "active";
  const featureEnabled = activeMember
    ? await isFeatureEnabled(channel === "email" ? "email" : "notifications", { organizationId })
    : false;
  return evaluateConsent({
    activeMember, featureEnabled, preference: facts?.preference ?? null, category, channel,
    hasEmail: Boolean(facts?.email), suppressed: facts?.suppressed ?? false
  });
}

export async function getPreferences(organizationId: string, accountId: string) {
  const rows = await getSqlClient()<{ category: NotificationCategory; channel: NotificationChannel; enabled: boolean }[]>`
    SELECT category, channel, enabled FROM notification_preferences WHERE organization_id = ${organizationId} AND account_id = ${accountId}
  `;
  const stored = new Map(rows.map(row => [`${row.category}:${row.channel}`, row.enabled]));
  return notificationCategories.flatMap(category => notificationChannels.map(channel => {
    const value = stored.get(`${category}:${channel}`);
    return { category, channel, enabled: value ?? defaultPreference(category, channel), explicit: value !== undefined };
  }));
}

export async function setPreferences(
  organizationId: string, accountId: string, input: unknown, source: "preferences" | "unsubscribe_link" = "preferences", sql?: Sql
): Promise<void> {
  const preferences = parsePreferences(input);
  const run = async (tx: Sql) => {
    const member = await tx`SELECT 1 FROM organization_memberships WHERE organization_id = ${organizationId} AND account_id = ${accountId}`;
    if (member.length !== 1) throw new DomainError("member_not_found");
    for (const preference of preferences) {
      await tx`
        INSERT INTO notification_preferences (organization_id, account_id, category, channel, enabled, source)
        VALUES (${organizationId}, ${accountId}, ${preference.category}, ${preference.channel}, ${preference.enabled}, ${source})
        ON CONFLICT (organization_id, account_id, category, channel) DO UPDATE SET enabled = EXCLUDED.enabled, source = EXCLUDED.source, updated_at = now()
      `;
    }
    await recordAudit(tx, {
      organizationId, actorAccountId: accountId, action: "notification.preferences_updated", subjectType: "account", subjectId: accountId,
      details: { source, preferences: preferences.map(p => `${p.category}:${p.channel}:${p.enabled ? "on" : "off"}`) }
    });
  };
  if (sql) await run(sql); else await getSqlClient().begin(run);
}

export interface ComposedEmail {
  from: string;
  subject: string;
  textBody: string;
  htmlBody: string | null;
  headers: Record<string, string>;
  /** Source trace for LC-52 (template id/version, sender identity), stored with the message. */
  trace?: { templateId?: string | null; templateVersion?: number | null; senderIdentityId?: string | null };
}

/** Builds the email for a notification. LC-52 supplies a tenant-branded composer. */
export type EmailComposer = (
  tx: Sql, context: { organizationId: string; accountId: string; toEmail: string; emailMessageId: string; notification: NotificationInput }
) => Promise<ComposedEmail>;

/** Plain-text composer from the platform default sender (EMAIL_FROM_DEFAULT, passed in by the web layer). */
export function createPlainEmailComposer(defaultFrom: string | undefined): EmailComposer {
  return async (_tx, { notification }) => ({
    // An unconfigured sender is stored as an undeliverable address; the provider is also unconfigured then.
    from: defaultFrom ?? "not-configured@invalid.invalid",
    subject: notification.title.replace(/[\r\n]+/g, " "),
    textBody: notification.body,
    htmlBody: null,
    headers: {}
  });
}

export interface NotifyResult {
  notificationId: string | null;
  emailMessageId: string | null;
  inApp: ConsentDecision;
  email: ConsentDecision;
}

/**
 * Create an in-app notification and/or queue an email, each only when canNotify allows.
 * Idempotent per (tenant, account, idempotencyKey): retries return the same rows.
 */
export async function notify(
  organizationId: string,
  input: Record<string, unknown> & { accountId: string },
  options: { channels?: NotificationChannel[]; composer?: EmailComposer } = {}
): Promise<NotifyResult> {
  const notification = parseNotificationInput(input);
  const accountId = input.accountId;
  if (!isUuid(accountId)) throw new DomainError("invalid_account");
  const channels = options.channels ?? ["in_app", "email"];
  const inApp: ConsentDecision = channels.includes("in_app") ? await canNotify(organizationId, accountId, notification.category, "in_app") : { allowed: false, reason: "preference_off" };
  const email: ConsentDecision = channels.includes("email") ? await canNotify(organizationId, accountId, notification.category, "email") : { allowed: false, reason: "preference_off" };
  const composer = options.composer ?? createPlainEmailComposer(undefined);
  return getSqlClient().begin(async tx => {
    let notificationId: string | null = null;
    if (inApp.allowed) {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO notifications (organization_id, account_id, category, title, body, link, idempotency_key)
        VALUES (${organizationId}, ${accountId}, ${notification.category}, ${notification.title}, ${notification.body}, ${notification.link}, ${notification.idempotencyKey})
        ON CONFLICT (organization_id, account_id, idempotency_key) DO NOTHING RETURNING id
      `;
      notificationId = inserted[0]?.id ?? (await tx<{ id: string }[]>`
        SELECT id FROM notifications WHERE organization_id = ${organizationId} AND account_id = ${accountId} AND idempotency_key = ${notification.idempotencyKey}
      `)[0]?.id ?? null;
    }
    let emailMessageId: string | null = null;
    if (email.allowed) {
      const messageId = randomUUID();
      const job = await enqueueJob({
        organizationId, kind: EMAIL_JOB_KIND, payload: { emailMessageId: messageId },
        idempotencyKey: `email:${accountId}:${notification.idempotencyKey}`, maxAttempts: 6, backoffBaseMs: 60_000
      }, tx);
      if (job.created) {
        const [account] = await tx<{ email: string }[]>`SELECT email FROM accounts WHERE id = ${accountId}`;
        const composed = await composer(tx, { organizationId, accountId, toEmail: account!.email, emailMessageId: messageId, notification });
        await tx`
          INSERT INTO email_messages (id, organization_id, account_id, notification_id, job_id, category, to_email, from_email, subject,
            text_body, html_body, headers)
          VALUES (${messageId}, ${organizationId}, ${accountId}, ${notificationId}, ${job.id}, ${notification.category}, ${account!.email},
            ${composed.from}, ${composed.subject}, ${composed.textBody}, ${composed.htmlBody}, ${tx.json(composed.headers)})
        `;
        if (composed.trace) await persistTrace(tx, organizationId, messageId, composed.trace);
        emailMessageId = messageId;
      } else {
        emailMessageId = (await tx<{ id: string }[]>`SELECT id FROM email_messages WHERE organization_id = ${organizationId} AND job_id = ${job.id}`)[0]?.id ?? null;
      }
    }
    return { notificationId, emailMessageId, inApp, email };
  });
}

/** Overridden by LC-52 columns; kept as a separate statement so LC-47 works standalone. */
async function persistTrace(tx: Sql, organizationId: string, messageId: string, trace: NonNullable<ComposedEmail["trace"]>): Promise<void> {
  await tx`
    UPDATE email_messages SET template_id = ${trace.templateId ?? null}, template_version = ${trace.templateVersion ?? null},
      sender_identity_id = ${trace.senderIdentityId ?? null}
    WHERE organization_id = ${organizationId} AND id = ${messageId}
  `;
}

export async function listInbox(organizationId: string, accountId: string, options: { unreadOnly?: boolean; limit?: number; before?: Date } = {}) {
  const sql = getSqlClient();
  const rows = await sql<{ id: string; category: string; title: string; body: string; link: string | null; read_at: Date | null; created_at: Date }[]>`
    SELECT id, category, title, body, link, read_at, created_at FROM notifications
    WHERE organization_id = ${organizationId} AND account_id = ${accountId}
      ${options.unreadOnly ? sql`AND read_at IS NULL` : sql``}
      ${options.before ? sql`AND created_at < ${options.before}` : sql``}
    ORDER BY created_at DESC LIMIT ${Math.min(Math.max(options.limit ?? 50, 1), 200)}
  `;
  const [count] = await sql<{ unread: number }[]>`
    SELECT count(*)::int AS unread FROM notifications WHERE organization_id = ${organizationId} AND account_id = ${accountId} AND read_at IS NULL
  `;
  return {
    unread: count!.unread,
    notifications: rows.map(row => ({ id: row.id, category: row.category, title: row.title, body: row.body, link: row.link, readAt: row.read_at, createdAt: row.created_at }))
  };
}

export async function markRead(organizationId: string, accountId: string, notificationId: string): Promise<void> {
  if (!isUuid(notificationId)) throw new DomainError("notification_not_found");
  const rows = await getSqlClient()`
    UPDATE notifications SET read_at = COALESCE(read_at, now())
    WHERE organization_id = ${organizationId} AND account_id = ${accountId} AND id = ${notificationId} RETURNING id
  `;
  if (rows.length !== 1) throw new DomainError("notification_not_found");
}

export async function markAllRead(organizationId: string, accountId: string): Promise<number> {
  const rows = await getSqlClient()`
    UPDATE notifications SET read_at = now() WHERE organization_id = ${organizationId} AND account_id = ${accountId} AND read_at IS NULL RETURNING id
  `;
  return rows.length;
}

export async function suppressEmail(email: string, reason: "hard_bounce" | "spam_complaint" | "manual", providerMessageId: string | null, sql: Sql = getSqlClient()): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 320) return false;
  const rows = await sql`
    INSERT INTO email_suppressions (email, reason, provider_message_id) VALUES (${normalized}, ${reason}, ${providerMessageId})
    ON CONFLICT (email) DO NOTHING RETURNING email
  `;
  if (rows.length === 1) {
    await recordAudit(sql, {
      organizationId: null, actorAccountId: null, action: "email.address_suppressed", subjectType: "email_address",
      subjectId: emailHash(normalized), details: { reason, providerMessageId }
    });
  }
  return rows.length === 1;
}

/**
 * Job handler for `notification.email`. Sends at most once per message: the job lease
 * is the mutual exclusion and the final UPDATE requires status 'queued'. Consent and
 * suppression are re-checked just before sending; withdrawn consent marks the message
 * suppressed instead of sending.
 */
export function createEmailJobHandler(provider: EmailProvider | (() => EmailProvider)): JobHandler {
  return async (job: Job) => {
    const messageId = job.payload.emailMessageId;
    if (!isUuid(messageId) || !job.organizationId) throw new PermanentJobError("invalid email job payload");
    const sql = getSqlClient();
    const [message] = await sql<{
      status: string; account_id: string | null; category: string; to_email: string; from_email: string; subject: string;
      text_body: string; html_body: string | null; headers: Record<string, string>;
    }[]>`
      SELECT status, account_id, category, to_email, from_email, subject, text_body, html_body, headers
      FROM email_messages WHERE organization_id = ${job.organizationId} AND id = ${messageId}
    `;
    if (!message) throw new PermanentJobError("email message not found");
    if (message.status !== "queued") return;
    const consent = message.account_id
      ? await canNotify(job.organizationId, message.account_id, message.category, "email")
      : { allowed: false as const, reason: "not_member" as const };
    if (!consent.allowed) {
      await sql`UPDATE email_messages SET status = 'suppressed', last_error = ${`consent:${consent.reason}`}, updated_at = now()
        WHERE organization_id = ${job.organizationId} AND id = ${messageId} AND status = 'queued'`;
      return;
    }
    const resolved = typeof provider === "function" ? provider() : provider;
    await sql`UPDATE email_messages SET attempts = attempts + 1, provider = ${resolved.name}, updated_at = now() WHERE id = ${messageId}`;
    try {
      const result = await resolved.send({
        from: message.from_email, to: message.to_email, subject: message.subject, textBody: message.text_body,
        htmlBody: message.html_body, headers: message.headers, tag: message.category,
        metadata: { emailMessageId: messageId, organizationId: job.organizationId, jobId: job.id }
      });
      await sql`
        UPDATE email_messages SET status = 'sent', provider_message_id = ${result.providerMessageId}, sent_at = now(), updated_at = now(), last_error = NULL
        WHERE organization_id = ${job.organizationId} AND id = ${messageId} AND status = 'queued'
      `;
    } catch (error) {
      const permanent = error instanceof EmailSendError && error.permanent;
      await sql`UPDATE email_messages SET last_error = ${(error as Error)?.message?.slice(0, 500) ?? "send failed"},
        status = ${permanent ? "failed" : "queued"}, updated_at = now() WHERE id = ${messageId} AND status = 'queued'`;
      if (permanent) throw new PermanentJobError((error as Error).message);
      throw error;
    }
  };
}

export interface ProviderEvent {
  recordType: string;
  messageId: string | null;
  email: string | null;
  type: string | null;
  inactive: boolean;
  occurredAt: Date | null;
}

/** Normalize a Postmark webhook body (Bounce, SpamComplaint, Delivery, ...). */
export function parsePostmarkEvent(body: Record<string, unknown>): ProviderEvent | null {
  const recordType = typeof body.RecordType === "string" ? body.RecordType : null;
  if (!recordType) return null;
  const str = (value: unknown) => typeof value === "string" && value.length <= 400 ? value : null;
  const when = str(body.BouncedAt) ?? str(body.DeliveredAt) ?? str(body.ReceivedAt);
  const occurredAt = when && !Number.isNaN(new Date(when).getTime()) ? new Date(when) : null;
  return {
    recordType,
    messageId: str(body.MessageID),
    email: str(body.Email) ?? str(body.Recipient),
    type: str(body.Type),
    inactive: body.Inactive === true,
    occurredAt
  };
}

const HARD_BOUNCE_TYPES = new Set(["HardBounce", "BadEmailAddress", "ManuallyDeactivated", "SpamNotification", "Blocked", "AddressChange"]);

/** Apply a provider event: suppress hard bounces/complaints and update message status. */
export async function applyProviderEvent(event: ProviderEvent): Promise<{ action: "suppressed" | "status_updated" | "ignored"; organizationId: string | null; emailMessageId: string | null }> {
  return getSqlClient().begin(async tx => {
    const [message] = event.messageId
      ? await tx<{ id: string; organization_id: string; to_email: string }[]>`
          SELECT id, organization_id, to_email FROM email_messages WHERE provider_message_id = ${event.messageId} FOR UPDATE`
      : [];
    const target = event.email ?? message?.to_email ?? null;
    if (event.recordType === "SpamComplaint" || (event.recordType === "Bounce" && (event.inactive || HARD_BOUNCE_TYPES.has(event.type ?? "")))) {
      if (target) await suppressEmail(target, event.recordType === "SpamComplaint" ? "spam_complaint" : "hard_bounce", event.messageId, tx);
      if (message) {
        await tx`UPDATE email_messages SET status = ${event.recordType === "SpamComplaint" ? "complained" : "bounced"}, updated_at = now() WHERE id = ${message.id}`;
      }
      return { action: "suppressed" as const, organizationId: message?.organization_id ?? null, emailMessageId: message?.id ?? null };
    }
    if (event.recordType === "Delivery" && message) {
      await tx`UPDATE email_messages SET status = 'delivered', updated_at = now() WHERE id = ${message.id} AND status = 'sent'`;
      return { action: "status_updated" as const, organizationId: message.organization_id, emailMessageId: message.id };
    }
    return { action: "ignored" as const, organizationId: message?.organization_id ?? null, emailMessageId: message?.id ?? null };
  });
}
