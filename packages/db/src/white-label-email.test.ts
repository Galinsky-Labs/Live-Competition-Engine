import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createTenant, enableFeature } from "./test-fixtures.ts";
import { runJobs } from "./jobs.ts";
import { applyProviderEvent, canNotify, createEmailJobHandler, EMAIL_JOB_KIND, notify, parsePostmarkEvent } from "./notifications.ts";
import { createFakeEmailProvider } from "./providers/email.ts";
import {
  activateTemplateVersion,
  addTemplateVersion,
  applyUnsubscribe,
  checkSenderIdentityDns,
  createBrandedEmailComposer,
  createSenderIdentity,
  createTemplate,
  createUnsubscribeToken,
  deliverabilitySummary,
  getEmailTrace,
  previewTemplate,
  setDefaultSender,
  verifyUnsubscribeToken
} from "./white-label-email.ts";

after(closeDatabaseConnection);

const code = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as { code?: string }).code; }
  return "no_error";
};

const dkimKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA".padEnd(120, "A");

async function emailTenant() {
  const org = await createTenant("Bright Lights Org");
  const operator = await createAccount(org);
  await enableFeature("email", org, operator);
  await enableFeature("notifications", org, operator);
  const domain = `mail-${randomUUID().slice(0, 8)}.customer.com`;
  const domainId = randomUUID();
  await getSqlClient()`
    INSERT INTO organization_domains (id, organization_id, domain, status, verification_token_hash, claimed_by_account_id, verified_by_account_id, verified_at)
    VALUES (${domainId}, ${org}, ${domain}, 'verified', ${"a".repeat(64)}, ${operator}, ${operator}, now())`;
  return { org, operator, domain, domainId };
}

const resolver = (txt: Record<string, string[][]>, cname: Record<string, string[]>) => ({
  resolveTxt: async (host: string) => { if (!txt[host]) throw new Error("ENOTFOUND"); return txt[host]!; },
  resolveCname: async (host: string) => { if (!cname[host]) throw new Error("ENOTFOUND"); return cname[host]!; }
});

test("sender identities require a verified tenant domain and pass DKIM + return-path DNS checks", async () => {
  const { org, operator, domain, domainId } = await emailTenant();
  const other = await emailTenant();
  assert.equal(await code(createSenderIdentity(other.org, other.operator, { domainId, localPart: "news", fromName: "X", dkimSelector: "pm", returnPathHost: `pm-bounces.${domain}` })), "domain_not_found");
  assert.equal(await code(createSenderIdentity(org, operator, { domainId, localPart: "news", fromName: "X", dkimSelector: "pm", returnPathHost: "pm-bounces.elsewhere.com" })), "invalid_return_path_host");
  assert.equal(await code(createSenderIdentity(org, operator, { domainId, localPart: "news", fromName: "Bad\r\nName", dkimSelector: "pm", returnPathHost: `pm-bounces.${domain}` })), "invalid_from_name");
  const sender = await createSenderIdentity(org, operator, { domainId, localPart: "News", fromName: "Bright Lights", dkimSelector: "pm2026", returnPathHost: `pm-bounces.${domain}` });
  assert.equal(sender.fromAddress, `news@${domain}`);
  assert.equal(await code(setDefaultSender(org, operator, sender.id)), "invalid_state_sender_unverified");

  const failing = await checkSenderIdentityDns(org, operator, sender.id, resolver({}, {}));
  assert.deepEqual(failing, { dkim: "failed", returnPath: "failed", status: "pending" });
  const ok = await checkSenderIdentityDns(org, operator, sender.id, resolver(
    { [`pm2026._domainkey.${domain}`]: [["k=rsa;p=", dkimKey]] },
    { [`pm-bounces.${domain}`]: ["pm.mtasv.net."] }
  ));
  assert.deepEqual(ok, { dkim: "verified", returnPath: "verified", status: "verified" });
  await setDefaultSender(org, operator, sender.id);
  assert.equal(await code(checkSenderIdentityDns(other.org, other.operator, sender.id, resolver({}, {}))), "sender_not_found");
});

test("templates are versioned, whitelisted and immutable", async () => {
  const { org, operator } = await emailTenant();
  const { id } = await createTemplate(org, operator, { key: "notification.results" });
  assert.equal(await code(createTemplate(org, operator, { key: "notification.results" })), "template_key_conflict");
  assert.equal(await code(addTemplateVersion(org, operator, id, { subject: "{{secret}}", body: "", allowedVariables: ["secret"] })), "template_variable_not_allowed");
  assert.deepEqual(await addTemplateVersion(org, operator, id, { subject: "Results: {{title}}", body: "{{body}}", allowedVariables: ["title", "body"] }), { version: 1, active: true });
  assert.deepEqual(await addTemplateVersion(org, operator, id, { subject: "v2 {{title}}", body: "{{body}}", allowedVariables: ["title", "body"], activate: false }), { version: 2, active: false });
  const preview = await previewTemplate(org, id, { variables: { title: "<b>", body: "x" } });
  assert.equal(preview.subject, "Results: <b>");
  assert.ok(preview.html.includes("&lt;b&gt;") || preview.html.includes("x"));
  await assert.rejects(getSqlClient()`UPDATE email_template_versions SET subject_template = 'x' WHERE template_id = ${id}`, /immutable/);
  await activateTemplateVersion(org, operator, id, 2);
  assert.equal(await code(activateTemplateVersion(org, operator, id, 9)), "template_version_not_found");
  const other = await emailTenant();
  assert.equal(await code(addTemplateVersion(other.org, other.operator, id, { subject: "x", body: "", allowedVariables: [] })), "template_not_found");
});

test("branded notification email: tenant sender, template, unsubscribe headers and full source trace", async () => {
  const { org, operator, domain, domainId } = await emailTenant();
  const sender = await createSenderIdentity(org, operator, { domainId, localPart: "hello", fromName: "Bright Lights", dkimSelector: "pm", returnPathHost: `pm-bounces.${domain}` });
  await checkSenderIdentityDns(org, operator, sender.id, resolver({ [`pm._domainkey.${domain}`]: [[`p=${dkimKey}`]] }, { [`pm-bounces.${domain}`]: ["pm.mtasv.net"] }));
  await setDefaultSender(org, operator, sender.id);
  const template = await createTemplate(org, operator, { key: "notification.results" });
  await addTemplateVersion(org, operator, template.id, { subject: "[{{organization_name}}] {{title}}", body: "{{body}}\n\n[See results]({{link}})", allowedVariables: ["organization_name", "title", "body", "link"] });

  const member = await createAccount(org);
  const composer = createBrandedEmailComposer({ appUrl: "https://app.example", defaultFrom: "platform@example.org" });
  const { emailMessageId, notificationId } = await notify(org, { accountId: member, category: "results", title: "Final standings", body: "You placed <first>!", link: "/results/1", idempotencyKey: "r1" }, { composer });
  const provider = createFakeEmailProvider();
  await runJobs({ [EMAIL_JOB_KIND]: createEmailJobHandler(provider) }, { organizationIds: [org] });
  const sent = provider.sent[0]!;
  assert.equal(sent.from, `"Bright Lights" <hello@${domain}>`);
  assert.equal(sent.subject, "[Bright Lights Org] Final standings");
  assert.ok(sent.htmlBody?.includes("You placed &lt;first&gt;!"));
  assert.ok(sent.htmlBody?.includes('href="https://app.example/results/1"'));
  assert.match(sent.headers!["List-Unsubscribe"]!, /^<https:\/\/app\.example\/api\/public\/organizations\/.+\/unsubscribe\?token=.+>$/);
  assert.equal(sent.headers!["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

  const trace = await getEmailTrace(org, emailMessageId!);
  assert.equal(trace?.source.template?.version, 1);
  assert.equal(trace?.source.senderIdentityId, sender.id);
  assert.equal(trace?.source.notificationId, notificationId);
  assert.equal(trace?.source.job?.status, "succeeded");

  const providerId = trace!.provider.messageId!;
  await applyProviderEvent(parsePostmarkEvent({ RecordType: "Delivery", MessageID: providerId, Recipient: sent.to, DeliveredAt: new Date().toISOString() })!);
  const after = await getEmailTrace(org, emailMessageId!);
  assert.equal(after?.status, "delivered");
  assert.deepEqual(after?.events.map(event => event.record_type), ["Delivery"]);
  const summary = await deliverabilitySummary(org);
  assert.equal(summary.byStatus.delivered, 1);
  assert.equal((await getEmailTrace((await emailTenant()).org, emailMessageId!)), null, "trace is tenant scoped");

  // One-click unsubscribe from the header URL turns the category off for email only.
  const token = decodeURIComponent(/token=([^>]+)>/.exec(sent.headers!["List-Unsubscribe"]!)![1]!);
  assert.deepEqual(await applyUnsubscribe(org, token), { ok: true, scope: "results" });
  assert.deepEqual(await canNotify(org, member, "results", "email"), { allowed: false, reason: "preference_off" });
  assert.deepEqual(await canNotify(org, member, "results", "in_app"), { allowed: true });
});

test("unsubscribe tokens are signed per tenant and tamper-evident", async () => {
  const { org, operator } = await emailTenant();
  const other = await emailTenant();
  const token = await createUnsubscribeToken(org, operator, "all");
  assert.deepEqual(await verifyUnsubscribeToken(org, token), { accountId: operator, scope: "all" });
  assert.equal(await verifyUnsubscribeToken(other.org, token), null);
  const [payload, signature] = token.split(".");
  const forged = `${Buffer.from(JSON.stringify({ o: org, a: randomUUID(), c: "all" })).toString("base64url")}.${signature}`;
  assert.equal(await verifyUnsubscribeToken(org, forged), null);
  assert.equal(await verifyUnsubscribeToken(org, `${payload}.${"A".repeat(43)}`), null);
  assert.deepEqual(await applyUnsubscribe(org, "garbage"), { ok: false });
  await applyUnsubscribe(org, token);
  assert.deepEqual(await canNotify(org, operator, "account", "email"), { allowed: false, reason: "preference_off" });
});
