import type { Metadata } from "next";
import styles from "../../signup/signup.module.css";
import { OperatorGate } from "./operator";
import { TenantList } from "./TenantList";

export const metadata: Metadata = { title: "Platform tenants", robots: { index: false, follow: false } };

export default function PlatformTenantsPage() {
  return (
    <main className={styles.page} id="main">
      <h1>Tenants</h1>
      <nav aria-label="Platform administration">
        <p>
          <a className={styles.link} href="/platform/tenants">Tenants</a> ·{" "}
          <a className={styles.link} href="/platform/tenants/announcements">Announcements</a> ·{" "}
          <a className={styles.link} href="/platform/tenants/audit">Platform audit</a>
        </p>
      </nav>
      <OperatorGate>
        <TenantList />
      </OperatorGate>
    </main>
  );
}
