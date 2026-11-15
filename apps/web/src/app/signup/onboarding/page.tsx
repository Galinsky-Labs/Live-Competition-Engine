import type { Metadata } from "next";
import styles from "../signup.module.css";
import { OnboardingChecklist } from "./OnboardingChecklist";

export const metadata: Metadata = { title: "Set up your organization" };

export default function OnboardingPage() {
  return (
    <main className={styles.page} id="main">
      <h1>Set up your organization</h1>
      <p className={styles.hint}>
        Progress is computed from your organization’s real configuration. Payment setup is handled
        by tenant billing and shows as pending until that is connected.
      </p>
      <OnboardingChecklist />
    </main>
  );
}
