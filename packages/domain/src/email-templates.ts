import { DomainError } from "./index.ts";
import { escapeHtml, renderMarkdown, safeLinkTarget } from "./markdown.ts";

/**
 * Tenant-branded email templates. Pure functions; no I/O.
 *
 * A template has a subject and a body written in the restricted Markdown subset with
 * `{{variable}}` placeholders. Only whitelisted variable names may appear, and each
 * template version declares the subset it uses. Rendering substitutes values:
 * subject → single line, text body → plain text, HTML body → the Markdown is rendered
 * first with opaque sentinels, then values are HTML-escaped into the output, so a value
 * can never inject markup or Markdown links. A value used as a link target must itself
 * be a safe link (http(s)/mailto/relative), otherwise the link points to "#".
 */

export const TEMPLATE_VARIABLES = [
  "recipient_email", "organization_name", "title", "body", "link", "unsubscribe_url", "event_name", "category"
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;
const SENTINEL_PREFIX = "zzlcevar";

export function placeholdersIn(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map(match => match[1]!))];
}

export interface TemplateDefinition {
  subject: string;
  body: string;
  allowedVariables: TemplateVariable[];
}

export function parseTemplateDefinition(input: { subject?: unknown; body?: unknown; allowedVariables?: unknown }): TemplateDefinition {
  if (typeof input.subject !== "string" || input.subject.length < 1 || input.subject.length > 300 || /[\r\n]/.test(input.subject)) {
    throw new DomainError("invalid_template_subject");
  }
  if (typeof input.body !== "string" || input.body.length > 50_000) throw new DomainError("invalid_template_body");
  if (input.body.includes(SENTINEL_PREFIX) || input.subject.includes(SENTINEL_PREFIX)) throw new DomainError("invalid_template_body");
  const allowed = input.allowedVariables;
  if (!Array.isArray(allowed) || allowed.length > TEMPLATE_VARIABLES.length ||
      !allowed.every(name => (TEMPLATE_VARIABLES as readonly string[]).includes(name as string))) {
    throw new DomainError("template_variable_not_allowed");
  }
  const allowedSet = new Set(allowed as string[]);
  for (const name of [...placeholdersIn(input.subject), ...placeholdersIn(input.body)]) {
    if (!allowedSet.has(name)) throw new DomainError("template_variable_not_allowed");
  }
  try {
    renderMarkdown(input.body);
  } catch {
    throw new DomainError("invalid_template_body");
  }
  return { subject: input.subject, body: input.body, allowedVariables: [...allowedSet] as TemplateVariable[] };
}

export interface RenderedEmail { subject: string; text: string; html: string }

const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

function valueFor(name: string, variables: Partial<Record<TemplateVariable, string>>, allowed: Set<string>): string {
  if (!allowed.has(name)) throw new DomainError("template_variable_not_allowed");
  const value = variables[name as TemplateVariable];
  if (typeof value !== "string") throw new DomainError("missing_template_variable");
  if (value.length > 20_000) throw new DomainError("template_variable_too_long");
  return clean(value);
}

export function renderEmailTemplate(
  template: TemplateDefinition,
  variables: Partial<Record<TemplateVariable, string>>,
  branding: { organizationName: string; unsubscribeUrl?: string | null }
): RenderedEmail {
  const allowed = new Set<string>(template.allowedVariables);
  const subject = template.subject
    .replace(PLACEHOLDER, (_m, name: string) => valueFor(name, variables, allowed))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 300)
    .trim();
  if (!subject) throw new DomainError("invalid_template_subject");

  const textBody = template.body.replace(PLACEHOLDER, (_m, name: string) => valueFor(name, variables, allowed));

  const sentinels: string[] = [];
  const withSentinels = template.body.replace(PLACEHOLDER, (_m, name: string) => {
    sentinels.push(valueFor(name, variables, allowed));
    return `${SENTINEL_PREFIX}${sentinels.length - 1}x`;
  });
  let bodyHtml = renderMarkdown(withSentinels);
  bodyHtml = bodyHtml.replace(new RegExp(`href="${SENTINEL_PREFIX}(\\d+)x"`, "g"), (_m, index: string) => {
    const target = safeLinkTarget(sentinels[Number(index)] ?? "");
    const external = target !== null && /^https?:/i.test(target);
    return `href="${escapeHtml(target ?? "#")}"${external ? ' rel="nofollow noopener noreferrer"' : ""}`;
  });
  bodyHtml = bodyHtml.replace(new RegExp(`${SENTINEL_PREFIX}(\\d+)x`, "g"), (_m, index: string) => escapeHtml(sentinels[Number(index)] ?? ""));

  const unsubscribe = branding.unsubscribeUrl ? safeLinkTarget(branding.unsubscribeUrl) : null;
  const org = escapeHtml(clean(branding.organizationName).slice(0, 200));
  const html = [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>`,
    '<body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111;background:#fff">',
    `<p style="font-weight:bold;margin:0 0 16px">${org}</p>`,
    bodyHtml,
    unsubscribe
      ? `<p style="margin-top:32px;font-size:12px;color:#555">You receive this because of your settings with ${org}. <a href="${escapeHtml(unsubscribe)}">Unsubscribe</a>.</p>`
      : "",
    "</body></html>"
  ].join("\n");
  const text = unsubscribe ? `${textBody}\n\n--\n${clean(branding.organizationName)}\nUnsubscribe: ${unsubscribe}` : textBody;
  return { subject, text, html };
}

/** Default template used when a tenant has none for a notification category. */
export const DEFAULT_NOTIFICATION_TEMPLATE: TemplateDefinition = {
  subject: "{{title}}",
  body: "## {{title}}\n\n{{body}}\n\n[Open]({{link}})",
  allowedVariables: ["title", "body", "link"]
};

/** Single-line RFC 5322 display name + address. The name is quoted; quotes/backslashes are refused upstream. */
export function formatFromAddress(fromName: string, address: string): string {
  const name = fromName.replace(/[\r\n"\\<>]/g, "").trim();
  return name ? `"${name}" <${address}>` : address;
}
