import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";

/** Reproducible fixture: two tenants, an operator per tenant and a plain member. */
export async function seedTenants(sql: Sql) {
  const orgA = randomUUID(), orgB = randomUUID();
  const operatorA = randomUUID(), operatorB = randomUUID(), member = randomUUID(), outsider = randomUUID();
  await sql`INSERT INTO accounts (id, email) VALUES
    (${operatorA}, ${`opa-${operatorA}@example.test`}), (${operatorB}, ${`opb-${operatorB}@example.test`}),
    (${member}, ${`member-${member}@example.test`}), (${outsider}, ${`out-${outsider}@example.test`})`;
  await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgA}, 'Tenant A', ${`a-${orgA.slice(0, 8)}`}), (${orgB}, 'Tenant B', ${`b-${orgB.slice(0, 8)}`})`;
  await sql`INSERT INTO organization_memberships (organization_id, account_id) VALUES (${orgA}, ${operatorA}), (${orgB}, ${operatorB}), (${orgA}, ${member})`;
  await sql`INSERT INTO role_grants (account_id, role, organization_id, granted_by_account_id) VALUES
    (${operatorA}, 'tenant_operator', ${orgA}, ${operatorA}), (${operatorB}, 'tenant_operator', ${orgB}, ${operatorB})`;
  return { orgA, orgB, operatorA, operatorB, member, outsider };
}
