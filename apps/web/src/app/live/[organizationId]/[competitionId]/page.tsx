import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isUuid } from "@live-competition-engine/domain";
import { LiveParticipation } from "./LiveParticipation";
import styles from "./live.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live participation",
  robots: { index: false }
};

/**
 * Audience-facing participation page. It renders no tenant data on the server:
 * every read and write goes through the authenticated audience/voting APIs
 * with a bearer token supplied by the host product.
 */
export default async function LivePage({ params }: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await params;
  if (!isUuid(organizationId) || !isUuid(competitionId)) notFound();
  return (
    <main className={styles.page}>
      <header>
        <p className={styles.eyebrow}>Live participation</p>
        <h1 className={styles.title}>Join in</h1>
        <p className={styles.lede}>
          React, chat, ask questions and vote. Participation requires accepting this event&apos;s audience terms.
        </p>
      </header>
      <LiveParticipation organizationId={organizationId} competitionId={competitionId} />
    </main>
  );
}
