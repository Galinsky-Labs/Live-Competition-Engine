import type { Metadata } from "next";
import styles from "../signup.module.css";
import { VerifyEmail } from "./VerifyEmail";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Verify your email", referrer: "no-referrer" };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const account = typeof params.account === "string" ? params.account : "";
  const token = typeof params.token === "string" ? params.token : "";
  return (
    <main className={styles.page} id="main">
      <h1>Verify your email</h1>
      {account && token ? (
        <VerifyEmail accountId={account} token={token} />
      ) : (
        <p role="alert" className={styles.error}>This verification link is incomplete. Open the link from your email again.</p>
      )}
    </main>
  );
}
