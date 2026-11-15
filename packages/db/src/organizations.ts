import { getSqlClient } from "./index.ts";
import { recordAudit } from "./audit.ts";

export const slugPattern = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
const reservedSlugs = new Set(["api", "admin", "login", "signup", "logout", "dashboard", "platform", "www", "static", "_next"]);

export class OrganizationError extends Error {
  readonly code: "invalid_name" | "invalid_slug" | "slug_taken";
  constructor(code: OrganizationError["code"]) { super(code); this.code = code; }
}

/** Self-service tenant creation: the creator becomes an active member and tenant operator. */
export async function createOrganization(accountId: string, nameInput: unknown, slugInput: unknown) {
  const name = typeof nameInput === "string" ? nameInput.trim() : "";
  if (name.length < 2 || name.length > 120) throw new OrganizationError("invalid_name");
  const slug = typeof slugInput === "string" ? slugInput.trim().toLowerCase() : "";
  if (!slugPattern.test(slug) || reservedSlugs.has(slug)) throw new OrganizationError("invalid_slug");
  const sql = getSqlClient();
  return sql.begin(async tx => {
    const [org] = await tx<{ id: string }[]>`
      INSERT INTO organizations (name, slug) VALUES (${name}, ${slug})
      ON CONFLICT (slug) DO NOTHING RETURNING id
    `;
    if (!org) throw new OrganizationError("slug_taken");
    await tx`INSERT INTO organization_memberships (organization_id, account_id) VALUES (${org.id}, ${accountId})`;
    await tx`
      INSERT INTO role_grants (account_id, role, organization_id, granted_by_account_id)
      VALUES (${accountId}, 'tenant_operator', ${org.id}, ${accountId})
    `;
    await recordAudit(tx, { organizationId: org.id, actorAccountId: accountId, action: "organization.created", subjectType: "organization", subjectId: org.id, details: { slug } });
    return { id: org.id, name, slug };
  });
}

export async function findOrganizationBySlug(slug: string) {
  if (!slugPattern.test(slug)) return null;
  const [row] = await getSqlClient()<{ id: string; name: string; slug: string }[]>`SELECT id, name, slug FROM organizations WHERE slug = ${slug}`;
  return row ?? null;
}

/** Adds an existing account (by email) to a tenant as a member. Caller must hold tenant.manage. */
export async function addMemberByEmail(organizationId: string, actorAccountId: string, email: string) {
  const sql = getSqlClient();
  return sql.begin(async tx => {
    const [account] = await tx<{ id: string }[]>`SELECT id FROM accounts WHERE email = ${email} AND disabled_at IS NULL`;
    if (!account) return null;
    await tx`
      INSERT INTO organization_memberships (organization_id, account_id) VALUES (${organizationId}, ${account.id})
      ON CONFLICT (organization_id, account_id) DO UPDATE SET status = 'active', suspended_at = NULL
    `;
    await recordAudit(tx, { organizationId, actorAccountId, action: "organization.member_added", subjectType: "account", subjectId: account.id });
    return account.id;
  });
}

/**
 * Bootstrap: accounts whose email is listed in PLATFORM_OPERATOR_EMAILS receive the platform_operator
 * role on sign-in (audited, idempotent). Removing an email does not revoke an existing grant.
 */
export async function ensurePlatformOperator(accountId: string, email: string, allowList: string | undefined): Promise<boolean> {
  const allowed = (allowList ?? "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(email.toLowerCase())) return false;
  const sql = getSqlClient();
  return sql.begin(async tx => {
    const [existing] = await tx`SELECT 1 FROM role_grants WHERE account_id = ${accountId} AND role = 'platform_operator' AND revoked_at IS NULL`;
    if (existing) return true;
    await tx`INSERT INTO role_grants (account_id, role, granted_by_account_id) VALUES (${accountId}, 'platform_operator', ${accountId})`;
    await recordAudit(tx, { organizationId: null, actorAccountId: accountId, action: "platform.operator_bootstrapped", subjectType: "account", subjectId: accountId });
    return true;
  });
}
