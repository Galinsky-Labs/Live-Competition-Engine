import type { Metadata } from "next";
import { listPlans, type SaasPlan } from "@live-competition-engine/db/saas-plans";
import styles from "./signup.module.css";
import { SignupForm, type PlanOption } from "./SignupForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create your organization" };

function latestPublished(plans: SaasPlan[]): PlanOption[] {
  const byKey = new Map<string, SaasPlan>();
  for (const plan of plans) {
    const current = byKey.get(plan.planKey);
    if (!current || plan.version > current.version) byKey.set(plan.planKey, plan);
  }
  return [...byKey.values()]
    .sort((a, b) => a.priceMinor - b.priceMinor)
    .slice(0, 12)
    .map(plan => ({
      planKey: plan.planKey,
      name: plan.name,
      price: `${(plan.priceMinor / 100).toFixed(2)} ${plan.currency} / ${plan.billingInterval}`,
      trialDays: plan.trialDays
    }));
}

export default async function SignupPage() {
  let plans: PlanOption[] = [];
  try {
    plans = latestPublished(await listPlans({ status: "published" }));
  } catch {
    plans = [];
  }
  return (
    <main className={styles.page} id="main">
      <h1>Create your organization</h1>
      <p className={styles.hint}>
        You will become the operator of a new tenant. We create your account with an unverified
        email address and send a verification link; you can start setting up right away.
      </p>
      <SignupForm plans={plans} />
    </main>
  );
}
