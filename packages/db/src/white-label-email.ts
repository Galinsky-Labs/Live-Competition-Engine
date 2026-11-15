import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DomainError, isBoundedText, isUuid } from "@live-competition-engine/domain";
import {
  DEFAULT_NOTIFICATION_TEMPLATE,
  formatFromAddress,
  parseTemplateDefinition,
  renderEmailTemplate,
  type TemplateDefinition,
  type TemplateVariable
} from "@live-competition-engine/domain/email-templates";
import { notificationCategories, parseCategory, type NotificationCategory } from "@live-competition-engine/domain/notifications";
import { recordAudit, type Sql } from "./audit.ts";
import { requireEnabledFeature } from "./feature-guard.ts";
import { getSqlClient } from "./index.ts";
import { setPreferences, type EmailComposer } from "./notifications.ts";

/**
 * LC-52 white-label email: tenant sender identities on LC-07 verified domains, versioned
 * tenant templates, signed one-click unsubscribe and delivery tracking/source trace.
 * Admin functions require tenant.manage (checked by the caller) and the `email` feature.
 */

// ---------------------------------------------------------------- sender identities

export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveCname(hostname: string): Promise<string[]>;
}

/** Postmark's return-path CNAME target. */
export const DEFAULT_RETURN_PATH_TARGET = "pm.mtasv.net";

export async function createSenderIdentity(
  organizationId: string, actorAccountId: string,
  input: { domainId?: unknown; localPart?: unknown; fromName?: unknown; dkimSelector?: unknown; returnPathHost?: unknown }
): Promise<{ id: string; fromAddress: string }> {
  if (!isUuid(input.domainId)) throw new DomainError("domain_not_found");
  const localPart = typeof input.localPart === "string" ? input.localPart.toLowerCase() : "";
  if (!/^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$/.test(localPart)) throw new DomainError("invalid_local_part");
  if (!isBoundedText(input.fromName, 100, 1) || /[\r\n<>"\\]/.test(input.fromName as string)) throw new DomainError("invalid_from_name");
  const selector = input.dkimSelector;
  if (typeof selector !== "string" || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(selector)) throw new DomainError("invalid_dkim_selector");
  const returnPathHost = typeof input.returnPathHost === "string" ? input.returnPathHost.toLowerCase() : "";
  await requireEnabledFeature("email", { organizationId });
  return getSqlClient().begin(async tx => {
    const [domain] = await tx<{ domain: string; status: string }[]>`
      SELECT domain, status FROM organization_domains WHERE organization_id = ${organizationId} AND id = ${input.domainId as string}
    `;
    if (!domain) throw new DomainError("domain_not_found");
    if (domain.status !== "verified") throw new DomainError("invalid_state_domain_unverified");
    if (!returnPathHost.endsWith(`.${domain.domain}`) || !/^[a-z0-9.-]{4,253}$/.test(returnPathHost)) throw new DomainError("invalid_return_path_host");
    try {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO email_sender_identities (organization_id, domain_id, local_part, from_name, dkim_selector, return_path_host, created_by_account_id)
        VALUES (${organizationId}, ${input.domainId as string}, ${localPart}, ${input.fromName as string}, ${selector}, ${returnPathHost}, ${actorAccountId})
        RETURNING id
      `;
      await recordAudit(tx, {
        organizationId, actorAccountId, action: "email.sender_created", subjectType: "email_sender_identity", subjectId: row!.id,
        details: { address: `${localPart}@${domain.domain}` }
      });
      return { id: row!.id, fromAddress: `${localPart}@${domain.domain}` };
    } catch (error) {
      if ((error as { code?: string })?.code === "23505") throw new DomainError("sender_conflict");
      throw error;
    }
  });
}

/**
 * Admin action: check DKIM (TXT `<selector>._domainkey.<domain>` with a `p=` public key) and the
 * return-path CNAME, then store the statuses. DNS failures record `failed` (fail closed).
 */
export async function checkSenderIdentityDns(
  organizationId: string, actorAccountId: string, identityId: string, resolver: DnsResolver,
  expectedReturnPathTarget = DEFAULT_RETURN_PATH_TARGET, now = new Date()
): Promise<{ dkim: "verified" | "failed"; returnPath: "verified" | "failed"; status: "verified" | "pending" }> {
  if (!isUuid(identityId)) throw new DomainError("sender_not_found");
  const [identity] = await getSqlClient()<{ domain: string; domain_status: string; dkim_selector: string; return_path_host: string; status: string }[]>`
    SELECT d.domain, d.status AS domain_status, s.dkim_selector, s.return_path_host, s.status
    FROM email_sender_identities s JOIN organization_domains d ON d.organization_id = s.organization_id AND d.id = s.domain_id
    WHERE s.organization_id = ${organizationId} AND s.id = ${identityId}
  `;
  if (!identity) throw new DomainError("sender_not_found");
  if (identity.status === "disabled") throw new DomainError("invalid_state_sender_disabled");
  let dkim: "verified" | "failed" = "failed";
  try {
    const records = await resolver.resolveTxt(`${identity.dkim_selector}._domainkey.${identity.domain}`);
    dkim = records.map(parts => parts.join("")).some(value => /(^|;)\s*p=[A-Za-z0-9+/=]{64,}/.test(value)) ? "verified" : "failed";
  } catch {
    dkim = "failed";
  }
  let returnPath: "verified" | "failed" = "failed";
  try {
    const targets = await resolver.resolveCname(identity.return_path_host);
    returnPath = targets.some(target => target.toLowerCase().replace(/\.$/, "") === expectedReturnPathTarget) ? "verified" : "failed";
  } catch {
    returnPath = "failed";
  }
  const status = dkim === "verified" && returnPath === "verified" && identity.domain_status === "verified" ? "verified" : "pending";
  await getSqlClient().begin(async tx => {
    await tx`
      UPDATE email_sender_identities SET dkim_status = ${dkim}, return_path_status = ${returnPath}, status = ${status},
        is_default = CASE WHEN ${status} = 'verified' THEN is_default ELSE false END,
        last_checked_at = ${now}, updated_at = ${now}
      WHERE organization_id = ${organizationId} AND id = ${identityId}
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "email.sender_dns_checked", subjectType: "email_sender_identity", subjectId: identityId,
      details: { dkim, returnPath, status }
    });
  });
  return { dkim, returnPath, status };
}

export async function setDefaultSender(organizationId: string, actorAccountId: string, identityId: string): Promise<void> {
  if (!isUuid(identityId)) throw new DomainError("sender_not_found");
  await requireEnabledFeature("email", { organizationId });
  await getSqlClient().begin(async tx => {
    const [row] = await tx<{ status: string }[]>`
      SELECT status FROM email_sender_identities WHERE organization_id = ${organizationId} AND id = ${identityId} FOR UPDATE`;
    if (!row) throw new DomainError("sender_not_found");
    if (row.status !== "verified") throw new DomainError("invalid_state_sender_unverified");
    await tx`UPDATE email_sender_identities SET is_default = false, updated_at = now() WHERE organization_id = ${organizationId} AND is_default`;
    await tx`UPDATE email_sender_identities SET is_default = true, updated_at = now() WHERE organization_id = ${organizationId} AND id = ${identityId}`;
    await recordAudit(tx, { organizationId, actorAccountId, action: "email.sender_default_set", subjectType: "email_sender_identity", subjectId: identityId });
  });
}

export async function listSenderIdentities(organizationId: string) {
  return getSqlClient()<{
    id: string; local_part: string; domain: string; from_name: string; status: string; dkim_status: string;
    return_path_status: string; is_default: boolean; last_checked_at: Date | null; dkim_selector: string; return_path_host: string;
  }[]>`
    SELECT s.id, s.local_part, d.domain, s.from_name, s.status, s.dkim_status, s.return_path_status, s.is_default,
      s.last_checked_at, s.dkim_selector, s.return_path_host
    FROM email_sender_identities s JOIN organization_domains d ON d.organization_id = s.organization_id AND d.id = s.domain_id
    WHERE s.organization_id = ${organizationId} ORDER BY d.domain, s.local_part
  `;
}

// ---------------------------------------------------------------- templates

export async function createTemplate(organizationId: string, actorAccountId: string, input: { key?: unknown; description?: unknown }): Promise<{ id: string }> {
  const key = input.key;
  if (typeof key !== "string" || key.length > 80 || !/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(key)) throw new DomainError("invalid_template_key");
  const description = input.description ?? null;
  if (description !== null && !isBoundedText(description, 500)) throw new DomainError("invalid_description");
  await requireEnabledFeature("email", { organizationId });
  try {
    return await getSqlClient().begin(async tx => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO email_templates (organization_id, key, description, created_by_account_id)
        VALUES (${organizationId}, ${key}, ${description as string | null}, ${actorAccountId}) RETURNING id
      `;
      await recordAudit(tx, { organizationId, actorAccountId, action: "email.template_created", subjectType: "email_template", subjectId: row!.id, details: { key } });
      return { id: row!.id };
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") throw new DomainError("template_key_conflict");
    throw error;
  }
}

/** Versions are immutable; a new version optionally becomes active in the same transaction. */
export async function addTemplateVersion(
  organizationId: string, actorAccountId: string, templateId: string,
  input: { subject?: unknown; body?: unknown; allowedVariables?: unknown; activate?: unknown }
): Promise<{ version: number; active: boolean }> {
  if (!isUuid(templateId)) throw new DomainError("template_not_found");
  const definition = parseTemplateDefinition(input);
  const activate = input.activate !== false;
  await requireEnabledFeature("email", { organizationId });
  return getSqlClient().begin(async tx => {
    const template = await tx`SELECT 1 FROM email_templates WHERE organization_id = ${organizationId} AND id = ${templateId} FOR UPDATE`;
    if (template.length !== 1) throw new DomainError("template_not_found");
    const [next] = await tx<{ version: number }[]>`SELECT COALESCE(max(version), 0) + 1 AS version FROM email_template_versions WHERE template_id = ${templateId}`;
    const version = next!.version;
    await tx`
      INSERT INTO email_template_versions (organization_id, template_id, version, subject_template, body_template, allowed_variables, created_by_account_id)
      VALUES (${organizationId}, ${templateId}, ${version}, ${definition.subject}, ${definition.body}, ${definition.allowedVariables}::text[], ${actorAccountId})
    `;
    if (activate) {
      await tx`UPDATE email_templates SET active_version = ${version}, updated_at = now() WHERE organization_id = ${organizationId} AND id = ${templateId}`;
    }
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "email.template_version_added", subjectType: "email_template", subjectId: templateId,
      details: { version, activated: activate, allowedVariables: definition.allowedVariables }
    });
    return { version, active: activate };
  });
}

export async function activateTemplateVersion(organizationId: string, actorAccountId: string, templateId: string, versionInput: unknown): Promise<void> {
  if (!isUuid(templateId)) throw new DomainError("template_not_found");
  if (typeof versionInput !== "number" || !Number.isSafeInteger(versionInput) || versionInput < 1) throw new DomainError("invalid_version");
  await requireEnabledFeature("email", { organizationId });
  await getSqlClient().begin(async tx => {
    const exists = await tx`SELECT 1 FROM email_template_versions WHERE organization_id = ${organizationId} AND template_id = ${templateId} AND version = ${versionInput}`;
    if (exists.length !== 1) throw new DomainError("template_version_not_found");
    await tx`UPDATE email_templates SET active_version = ${versionInput}, updated_at = now() WHERE organization_id = ${organizationId} AND id = ${templateId}`;
    await recordAudit(tx, { organizationId, actorAccountId, action: "email.template_activated", subjectType: "email_template", subjectId: templateId, details: { version: versionInput } });
  });
}

export async function listTemplates(organizationId: string) {
  return getSqlClient()<{ id: string; key: string; description: string | null; active_version: number | null; versions: number }[]>`
    SELECT t.id, t.key, t.description, t.active_version,
      (SELECT count(*)::int FROM email_template_versions v WHERE v.template_id = t.id) AS versions
    FROM email_templates t WHERE t.organization_id = ${organizationId} ORDER BY t.key
  `;
}

async function loadVersion(sql: Sql, organizationId: string, templateId: string, version: number | null) {
  const [row] = await sql<{ version: number; subject_template: string; body_template: string; allowed_variables: string[] }[]>`
    SELECT v.version, v.subject_template, v.body_template, v.allowed_variables
    FROM email_templates t JOIN email_template_versions v ON v.template_id = t.id
      AND v.version = COALESCE(${version}::int, t.active_version)
    WHERE t.organization_id = ${organizationId} AND t.id = ${templateId}
  `;
  return row ?? null;
}

const toDefinition = (row: { subject_template: string; body_template: string; allowed_variables: string[] }): TemplateDefinition => ({
  subject: row.subject_template, body: row.body_template, allowedVariables: row.allowed_variables as TemplateVariable[]
});

export async function previewTemplate(
  organizationId: string, templateId: string, input: { version?: unknown; variables?: unknown }
) {
  if (!isUuid(templateId)) throw new DomainError("template_not_found");
  const version = input.version === undefined ? null : input.version;
  if (version !== null && (typeof version !== "number" || !Number.isSafeInteger(version))) throw new DomainError("invalid_version");
  const variables = input.variables ?? {};
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) throw new DomainError("invalid_variables");
  const row = await loadVersion(getSqlClient(), organizationId, templateId, version as number | null);
  if (!row) throw new DomainError("template_version_not_found");
  const [org] = await getSqlClient()<{ name: string }[]>`SELECT name FROM organizations WHERE id = ${organizationId}`;
  return renderEmailTemplate(toDefinition(row), variables as Record<string, string>, { organizationName: org!.name, unsubscribeUrl: "https://example.invalid/unsubscribe-preview" });
}

// ---------------------------------------------------------------- unsubscribe

async function unsubscribeKey(sql: Sql, organizationId: string): Promise<Buffer> {
  await sql`
    INSERT INTO email_unsubscribe_keys (organization_id, secret) VALUES (${organizationId}, ${randomBytes(32)})
    ON CONFLICT (organization_id) DO NOTHING
  `;
  const [row] = await sql<{ secret: Buffer }[]>`SELECT secret FROM email_unsubscribe_keys WHERE organization_id = ${organizationId}`;
  return row!.secret;
}

export type UnsubscribeScope = NotificationCategory | "all";

/** Signed token: base64url(JSON payload) "." base64url(HMAC-SHA256(tenant key, payload)). Never expires. */
export async function createUnsubscribeToken(organizationId: string, accountId: string, scope: UnsubscribeScope, sql: Sql = getSqlClient()): Promise<string> {
  const key = await unsubscribeKey(sql, organizationId);
  const payload = Buffer.from(JSON.stringify({ o: organizationId, a: accountId, c: scope })).toString("base64url");
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export async function verifyUnsubscribeToken(organizationId: string, token: unknown): Promise<{ accountId: string; scope: UnsubscribeScope } | null> {
  if (!isUuid(organizationId) || typeof token !== "string" || token.length > 600) return null;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const [row] = await getSqlClient()<{ secret: Buffer }[]>`SELECT secret FROM email_unsubscribe_keys WHERE organization_id = ${organizationId}`;
  if (!row) return null;
  const expected = createHmac("sha256", row.secret).update(match[1]!).digest();
  const provided = Buffer.from(match[2]!, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let payload: { o?: unknown; a?: unknown; c?: unknown };
  try {
    payload = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as typeof payload;
  } catch {
    return null;
  }
  if (payload.o !== organizationId || !isUuid(payload.a)) return null;
  if (payload.c !== "all" && !(notificationCategories as readonly unknown[]).includes(payload.c)) return null;
  return { accountId: payload.a, scope: payload.c as UnsubscribeScope };
}

/** Apply an unsubscribe (idempotent). Returns false for an invalid token. */
export async function applyUnsubscribe(organizationId: string, token: unknown): Promise<{ ok: boolean; scope?: UnsubscribeScope }> {
  const verified = await verifyUnsubscribeToken(organizationId, token);
  if (!verified) return { ok: false };
  const categories = verified.scope === "all" ? [...notificationCategories] : [parseCategory(verified.scope)];
  try {
    await setPreferences(organizationId, verified.accountId, categories.map(category => ({ category, channel: "email", enabled: false })), "unsubscribe_link");
  } catch (error) {
    // A former member has nothing left to unsubscribe from; treat as done.
    if ((error as { code?: string })?.code !== "member_not_found") throw error;
  }
  return { ok: true, scope: verified.scope };
}

export function unsubscribeUrl(appUrl: string, organizationId: string, token: string): string {
  return `${appUrl.replace(/\/$/, "")}/api/public/organizations/${organizationId}/unsubscribe?token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------- branded composer

/**
 * Notification email composer with tenant branding: the tenant's default verified sender
 * (else the platform default), the tenant template `notification.<category>` (else the
 * built-in default), one-click List-Unsubscribe headers and a source trace.
 */
export function createBrandedEmailComposer(options: { appUrl: string; defaultFrom: string | undefined }): EmailComposer {
  return async (tx, context) => {
    const { organizationId, accountId, toEmail, notification } = context;
    const [org] = await tx<{ name: string }[]>`SELECT name FROM organizations WHERE id = ${organizationId}`;
    const [sender] = await tx<{ id: string; local_part: string; domain: string; from_name: string }[]>`
      SELECT s.id, s.local_part, d.domain, s.from_name
      FROM email_sender_identities s JOIN organization_domains d ON d.organization_id = s.organization_id AND d.id = s.domain_id
      WHERE s.organization_id = ${organizationId} AND s.is_default AND s.status = 'verified' AND d.status = 'verified'
    `;
    const [template] = await tx<{ id: string; version: number; subject_template: string; body_template: string; allowed_variables: string[] }[]>`
      SELECT t.id, v.version, v.subject_template, v.body_template, v.allowed_variables
      FROM email_templates t JOIN email_template_versions v ON v.template_id = t.id AND v.version = t.active_version
      WHERE t.organization_id = ${organizationId} AND t.key = ${`notification.${notification.category}`}
    `;
    const token = await createUnsubscribeToken(organizationId, accountId, notification.category, tx);
    const unsubscribe = unsubscribeUrl(options.appUrl, organizationId, token);
    const link = notification.link ? `${options.appUrl.replace(/\/$/, "")}${notification.link}` : options.appUrl;
    const rendered = renderEmailTemplate(template ? toDefinition(template) : DEFAULT_NOTIFICATION_TEMPLATE, {
      recipient_email: toEmail, organization_name: org!.name, title: notification.title, body: notification.body,
      link, unsubscribe_url: unsubscribe, category: notification.category, event_name: ""
    }, { organizationName: org!.name, unsubscribeUrl: unsubscribe });
    return {
      from: sender ? formatFromAddress(sender.from_name, `${sender.local_part}@${sender.domain}`) : (options.defaultFrom ?? "not-configured@invalid.invalid"),
      subject: rendered.subject,
      textBody: rendered.text,
      htmlBody: rendered.html,
      headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      trace: { templateId: template?.id ?? null, templateVersion: template?.version ?? null, senderIdentityId: sender?.id ?? null }
    };
  };
}

// ---------------------------------------------------------------- deliverability and trace

export async function deliverabilitySummary(organizationId: string, days = 30) {
  const since = new Date(Date.now() - Math.min(Math.max(days, 1), 365) * 24 * 3600 * 1000);
  const sql = getSqlClient();
  const [byStatus, bySender] = await Promise.all([
    sql<{ status: string; count: number }[]>`
      SELECT status, count(*)::int AS count FROM email_messages
      WHERE organization_id = ${organizationId} AND created_at >= ${since} GROUP BY status`,
    sql<{ sender_identity_id: string | null; sent: number; bounced: number; complained: number }[]>`
      SELECT sender_identity_id,
        count(*) FILTER (WHERE status IN ('sent', 'delivered', 'bounced', 'complained'))::int AS sent,
        count(*) FILTER (WHERE status = 'bounced')::int AS bounced,
        count(*) FILTER (WHERE status = 'complained')::int AS complained
      FROM email_messages WHERE organization_id = ${organizationId} AND created_at >= ${since}
      GROUP BY sender_identity_id`
  ]);
  return {
    since,
    byStatus: Object.fromEntries(byStatus.map(row => [row.status, row.count])),
    bySender: bySender.map(row => ({
      senderIdentityId: row.sender_identity_id, sent: row.sent, bounced: row.bounced, complained: row.complained,
      bounceRate: row.sent ? row.bounced / row.sent : 0, complaintRate: row.sent ? row.complained / row.sent : 0
    }))
  };
}

/** Everything that produced a sent email: job, notification, template version, sender, provider events. */
export async function getEmailTrace(organizationId: string, messageId: string) {
  if (!isUuid(messageId)) return null;
  const sql = getSqlClient();
  const [message] = await sql<{
    id: string; status: string; category: string; to_email: string; from_email: string; subject: string; created_at: Date; sent_at: Date | null;
    provider: string | null; provider_message_id: string | null; job_id: string | null; notification_id: string | null;
    template_id: string | null; template_version: number | null; sender_identity_id: string | null; template_key: string | null;
    job_status: string | null; job_attempts: number | null;
  }[]>`
    SELECT m.id, m.status, m.category, m.to_email, m.from_email, m.subject, m.created_at, m.sent_at, m.provider, m.provider_message_id,
      m.job_id, m.notification_id, m.template_id, m.template_version, m.sender_identity_id, t.key AS template_key,
      j.status AS job_status, j.attempts AS job_attempts
    FROM email_messages m
    LEFT JOIN email_templates t ON t.organization_id = m.organization_id AND t.id = m.template_id
    LEFT JOIN jobs j ON j.id = m.job_id
    WHERE m.organization_id = ${organizationId} AND m.id = ${messageId}
  `;
  if (!message) return null;
  const events = await sql<{ record_type: string; detail_type: string | null; occurred_at: Date | null; received_at: Date }[]>`
    SELECT record_type, detail_type, occurred_at, received_at FROM email_delivery_events
    WHERE organization_id = ${organizationId} AND email_message_id = ${messageId} ORDER BY id
  `;
  return {
    id: message.id, status: message.status, category: message.category, to: message.to_email, from: message.from_email, subject: message.subject,
    createdAt: message.created_at, sentAt: message.sent_at,
    provider: { name: message.provider, messageId: message.provider_message_id },
    source: {
      job: message.job_id ? { id: message.job_id, status: message.job_status, attempts: message.job_attempts } : null,
      notificationId: message.notification_id,
      template: message.template_id ? { id: message.template_id, key: message.template_key, version: message.template_version } : null,
      senderIdentityId: message.sender_identity_id
    },
    events
  };
}
