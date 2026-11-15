import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isUuid } from "@live-competition-engine/domain";
import { ControlRoomClient } from "./ControlRoomClient";
import styles from "./control.module.css";

export const metadata: Metadata = {
  title: "Control room · Live Competition Engine",
  robots: { index: false, follow: false }
};

/**
 * Producer control room. The server renders only a shell (no private data); all
 * data is fetched client-side with the producer's bearer token from the
 * event.manage-protected APIs.
 */
export default async function ControlRoomPage({ params }: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await params;
  if (!isUuid(organizationId) || !isUuid(competitionId)) notFound();
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Control room</h1>
      <p className={styles.small}>Competition <code>{competitionId}</code></p>
      <ControlRoomClient organizationId={organizationId} competitionId={competitionId} />
    </main>
  );
}
