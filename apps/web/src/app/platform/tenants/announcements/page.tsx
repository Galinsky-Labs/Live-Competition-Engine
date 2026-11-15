import type { Metadata } from "next";
import styles from "../../../signup/signup.module.css";
import { OperatorGate } from "../operator";
import { AnnouncementsAdmin } from "./AnnouncementsAdmin";

export const metadata: Metadata = { title: "Platform announcements", robots: { index: false, follow: false } };

export default function AnnouncementsPage() {
  return (
    <main className={styles.page} id="main">
      <h1>Announcements and release notes</h1>
      <p><a className={styles.link} href="/platform/tenants">Back to tenants</a></p>
      <p className={styles.hint}>Published versions are immutable. Editing creates a new draft version; publishing it replaces what tenants see.</p>
      <OperatorGate>
        <AnnouncementsAdmin />
      </OperatorGate>
    </main>
  );
}
