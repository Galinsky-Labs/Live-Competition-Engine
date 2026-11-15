import type { Metadata } from "next";
import styles from "../../../signup/signup.module.css";
import { OperatorGate, StepUpPanel } from "../operator";
import { TenantDetail } from "./TenantDetail";

export const metadata: Metadata = { title: "Tenant administration", robots: { index: false, follow: false } };

export default async function TenantPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return (
    <main className={styles.page} id="main">
      <h1>Tenant administration</h1>
      <p><a className={styles.link} href="/platform/tenants">Back to tenants</a></p>
      <p className={styles.hint}>
        Impersonation is not available by design: operators act only through these audited platform actions.
      </p>
      <OperatorGate>
        <StepUpPanel />
        <TenantDetail organizationId={organizationId} />
      </OperatorGate>
    </main>
  );
}
