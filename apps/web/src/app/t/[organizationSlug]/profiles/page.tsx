import { notFound } from "next/navigation";
import { isFeatureEnabled } from "@live-competition-engine/db/feature-guard";
import { listProfiles } from "@live-competition-engine/db/profiles";
import { findTenantBySlug } from "@live-competition-engine/db/public-tenant";
import { isUuid } from "@live-competition-engine/domain";
import styles from "../../public.module.css";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ organizationSlug: string }>;
  searchParams: Promise<{ after?: string }>;
};

/** Anonymous directory of public profiles (keyset paginated). */
export default async function PublicProfilesPage({ params, searchParams }: Props) {
  const { organizationSlug } = await params;
  const { after } = await searchParams;
  const tenant = await findTenantBySlug(organizationSlug);
  if (!tenant) notFound();
  if (!(await isFeatureEnabled("public_profiles", { organizationId: tenant.id }))) notFound();
  const page = await listProfiles(tenant.id, null, { limit: 50, ...(isUuid(after) ? { after } : {}) });

  return (
    <main className={styles.page}>
      <h1>{tenant.name}: profiles</h1>
      {page.profiles.length === 0 ? (
        <p className={styles.meta}>No public profiles yet.</p>
      ) : (
        <ul className={styles.list} aria-label="Public profiles">
          {page.profiles.map(profile => (
            <li key={profile.id}>
              <a href={`/t/${tenant.slug}/profiles/${profile.id}`}>{profile.displayName}</a>
              {profile.roles.length > 0 && <span className={styles.meta}> ({profile.roles.join(", ")})</span>}
            </li>
          ))}
        </ul>
      )}
      {page.next && (
        <p><a href={`/t/${tenant.slug}/profiles?after=${page.next}`} rel="next">Next page</a></p>
      )}
    </main>
  );
}
