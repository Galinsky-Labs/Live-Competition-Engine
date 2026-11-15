import type { CredentialStore } from "@live-competition-engine/auth/credentials";
import { getSqlClient } from "./index.ts";

export function createPostgresCredentialStore(): CredentialStore {
  const sql = getSqlClient();
  return {
    async findCredentialByEmail(email) {
      const [row] = await sql<{ account_id: string; password_hash: string }[]>`
        SELECT c.account_id, c.password_hash
        FROM account_credentials c JOIN accounts a ON a.id = c.account_id
        WHERE a.email = ${email} AND a.disabled_at IS NULL
      `;
      return row ? { accountId: row.account_id, passwordHash: row.password_hash } : null;
    },
    async createAccountWithCredential(email, passwordHash) {
      return sql.begin(async tx => {
        const [account] = await tx<{ id: string }[]>`
          INSERT INTO accounts (email) VALUES (${email})
          ON CONFLICT (email) DO NOTHING
          RETURNING id
        `;
        if (!account) return null;
        await tx`INSERT INTO account_credentials (account_id, password_hash) VALUES (${account.id}, ${passwordHash})`;
        await tx`
          INSERT INTO engine_audit_log (organization_id, actor_account_id, action, subject_type, subject_id)
          VALUES (NULL, ${account.id}, 'account.signed_up', 'account', ${account.id})
        `;
        return account.id;
      });
    },
    async countFailedAttempts(emailHash, since) {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM login_attempts
        WHERE email_hash = ${emailHash} AND succeeded = false AND attempted_at >= ${since}
      `;
      return row?.n ?? 0;
    },
    async recordAttempt(emailHash, succeeded, at) {
      await sql`INSERT INTO login_attempts (email_hash, succeeded, attempted_at) VALUES (${emailHash}, ${succeeded}, ${at})`;
    }
  };
}

export async function accountSummary(accountId: string) {
  const sql = getSqlClient();
  const [account] = await sql<{ id: string; email: string | null }[]>`SELECT id, email FROM accounts WHERE id = ${accountId} AND disabled_at IS NULL`;
  if (!account) return null;
  const organizations = await sql<{ id: string; name: string; slug: string; roles: string[] }[]>`
    SELECT o.id, o.name, o.slug,
      COALESCE(array_agg(DISTINCT g.role::text) FILTER (WHERE g.role IS NOT NULL), '{}') AS roles
    FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id
    LEFT JOIN role_grants g ON g.account_id = m.account_id AND g.organization_id = o.id
      AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
    WHERE m.account_id = ${accountId} AND m.status = 'active' AND m.suspended_at IS NULL
    GROUP BY o.id ORDER BY o.name
  `;
  return { id: account.id, email: account.email, organizations };
}
