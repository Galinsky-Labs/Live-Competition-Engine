# LC-52 White-label email/communications

Tenant-branded email: verified sender identities, versioned templates, one-click unsubscribe,
deliverability tracking and a source trace for every message. Gated by the `email` feature.

## Storage (migration `0065_white_label_email.sql`)

| Table | Notes |
| --- | --- |
| `email_sender_identities` | `local_part@<LC-07 verified domain>` + display name, DKIM selector, return-path host (must be a subdomain of the domain). `dkim_status`/`return_path_status` (`unknown`, `verified`, `failed`) and `status` (`pending`, `verified`, `disabled`); a CHECK makes `verified` require both DNS checks. One default per tenant. Composite FK to `organization_domains (organization_id, id)` (unique index added here). |
| `email_templates` / `email_template_versions` | Per-tenant key (e.g. `notification.results`), immutable versions (trigger), `active_version` pointer. |
| `email_unsubscribe_keys` | Random 32-byte HMAC key per tenant, created on first use. |
| `email_messages` (+columns) | `template_id`, `template_version`, `sender_identity_id` (composite FKs) — with LC-47's `job_id` and `notification_id` this is the source trace. |
| `email_delivery_events` | Every provider webhook event for a known message (Delivery, Bounce, SpamComplaint, …). |

## Sender identity verification

`checkSenderIdentityDns` (admin action, `POST .../email/senders/{senderId}/verify`) resolves with `node:dns`:

* DKIM: TXT `<selector>._domainkey.<domain>` must contain a `p=` public key.
* Return path: CNAME `<return_path_host>` must point to `pm.mtasv.net` (Postmark).

Lookup failures record `failed` (fail closed). Only a `verified` identity can become the default; a later failed
check clears the default flag.

## Templates

Pure renderer in `packages/domain/src/email-templates.ts`:

* Body uses the LC-45 restricted Markdown subset; `{{variable}}` placeholders only from the whitelist
  `recipient_email, organization_name, title, body, link, unsubscribe_url, event_name, category`, and each version
  must declare the variables it uses (validated at save).
* HTML: Markdown is rendered with opaque sentinels first, then values are HTML-escaped into the output — a value can
  never inject HTML or Markdown. A value used as a link target must pass the same safe-link rules, else `#`.
* Subject: CR/LF removed (no header injection). Missing variables fail the render.
* Branding wrapper: tenant name header and an unsubscribe footer.

`createBrandedEmailComposer` (used by LC-47 `notify` in the web layer) picks the tenant's default verified sender
(else `EMAIL_FROM_DEFAULT`), the active template `notification.<category>` (else a built-in default), adds
`List-Unsubscribe: <url>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and records the trace.

## Unsubscribe

Token = `base64url(JSON {o: tenant, a: account, c: category|"all"}) . base64url(HMAC-SHA256(tenant key, payload))`.
Tokens are tenant-bound and tamper-evident; they do not expire (unsubscribe links must keep working).

`/api/public/organizations/{org}/unsubscribe?token=…`

* GET — HTML confirmation page with a POST form (link scanners do not unsubscribe anyone).
* POST — applies it; accepts RFC 8058 one-click (`List-Unsubscribe=One-Click` form body from mailbox providers).
  Sets the email preference for that category (or all) to off with `source = 'unsubscribe_link'` (audited).

## Deliverability and trace

The Postmark webhook (LC-47) stores each event in `email_delivery_events`, updates message status and suppresses
hard-bounced/complaining addresses. `GET .../email/deliverability` reports 30-day counts by status and bounce/complaint
rates per sender identity. `GET .../email/messages/{messageId}` returns the trace: job (status, attempts),
notification, template key+version, sender identity, provider id and events.

## HTTP (`/api/organizations/{org}/email/...`, `tenant.manage`)

`GET/POST senders`, `POST senders/{senderId}/verify`, `POST senders/{senderId}/default`, `GET/POST templates`,
`POST templates/{templateId}/versions` `{subject, body, allowedVariables, activate?}`, `POST templates/{templateId}/activate`
`{version}`, `POST templates/{templateId}/preview` `{variables, version?}`, `GET deliverability`, `GET messages/{messageId}`.

Page: `/admin/{org}/email` (senders, templates, deliverability; read-only).

## Not claimed

* DNS checks verify records exist as expected; they do not prove Postmark has accepted the sender signature —
  the sender domain must also be added in Postmark (not automated here).
* Tests use a fake DNS resolver and the fake email provider.
* No per-tenant theme colours in emails yet (organization name only).
