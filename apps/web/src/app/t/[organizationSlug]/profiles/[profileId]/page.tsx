import { notFound } from "next/navigation";
import { isFeatureEnabled } from "@live-competition-engine/db/feature-guard";
import { readProfile } from "@live-competition-engine/db/profiles";
import { findTenantBySlug } from "@live-competition-engine/db/public-tenant";
import { isUuid } from "@live-competition-engine/domain";
import styles from "../../../public.module.css";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationSlug: string; profileId: string }> };

/** Anonymous public profile page: only the public projection, gated by `public_profiles`. */
export default async function PublicProfilePage({ params }: Params) {
  const { organizationSlug, profileId } = await params;
  const tenant = await findTenantBySlug(organizationSlug);
  if (!tenant || !isUuid(profileId)) notFound();
  if (!(await isFeatureEnabled("public_profiles", { organizationId: tenant.id }))) notFound();
  const profile = await readProfile(tenant.id, profileId, null);
  if (!profile) notFound();

  return (
    <main className={styles.page}>
      <nav aria-label="Breadcrumb">
        <a href={`/t/${tenant.slug}/profiles`}>{tenant.name} profiles</a>
      </nav>
      <article aria-labelledby="profile-name">
        <h1 id="profile-name">{profile.displayName}</h1>
        {profile.roles.length > 0 && (
          <p className={styles.meta}>
            <span className={styles.srOnly}>Roles: </span>
            {profile.roles.map(role => <span key={role} className={styles.tag}>{role}</span>)}
          </p>
        )}
        {profile.bio ? <p>{profile.bio}</p> : <p className={styles.meta}>No biography yet.</p>}
        <section aria-labelledby="history-heading">
          <h2 id="history-heading">Event history</h2>
          {profile.history.length === 0 ? (
            <p className={styles.meta}>No published results yet.</p>
          ) : (
            <ul className={styles.list}>
              {profile.history.map(item => <li key={item.eventId}>{item.title}</li>)}
            </ul>
          )}
        </section>
      </article>
    </main>
  );
}
