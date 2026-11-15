import type { Metadata } from "next";
import styles from "../../../signup/signup.module.css";
import { OperatorGate } from "../operator";
import { PlatformAuditLog } from "./PlatformAuditLog";

export const metadata: Metadata = { title: "Platform audit", robots: { index: false, follow: false } };

export default function PlatformAuditPage() {
  return (
    <main className={styles.page} id="main">
      <h1>Platform audit log</h1>
      <p><a className={styles.link} href="/platform/tenants">Back to tenants</a></p>
      <OperatorGate>
        <PlatformAuditLog />
      </OperatorGate>
    </main>
  );
}
