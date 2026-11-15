import { getSqlClient } from "./index.ts";

export interface PublicTenant {
  id: string;
  name: string;
  slug: string;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

/** Resolve a tenant for public pages by its slug. Returns only non-sensitive fields. */
export async function findTenantBySlug(slug: string): Promise<PublicTenant | null> {
  if (typeof slug !== "string" || !SLUG.test(slug)) return null;
  const [row] = await getSqlClient()<PublicTenant[]>`SELECT id, name, slug FROM organizations WHERE slug = ${slug}`;
  return row ?? null;
}
