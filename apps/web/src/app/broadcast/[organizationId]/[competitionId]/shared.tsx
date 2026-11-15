import { notFound } from "next/navigation";
import { getPublicOverlay, getPublicScoreboard } from "@live-competition-engine/db/broadcast";
import { BroadcastClient } from "./BroadcastClient";
import styles from "./broadcast.module.css";

export type BroadcastPageProps = {
  params: Promise<{ organizationId: string; competitionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Server-rendered public broadcast page (suitable as an OBS browser source).
 * Renders only public projections; `?transparent=1` removes the page background.
 */
export async function renderBroadcastPage(mode: "overlay" | "captions" | "scoreboard", { params, searchParams }: BroadcastPageProps) {
  const { organizationId, competitionId } = await params;
  const query = await searchParams;
  const transparent = query.transparent === "1" || query.transparent === "true";
  const initial = mode === "scoreboard"
    ? await getPublicScoreboard(organizationId, competitionId)
    : await getPublicOverlay(organizationId, competitionId);
  if (!initial) notFound();
  const path = mode === "scoreboard" ? "scoreboard" : "overlay";
  const endpoint = `/api/public/organizations/${organizationId}/competitions/${competitionId}/broadcast/${path}`;
  return (
    <main className={styles.root}>
      {transparent ? <style>{"html,body{background:transparent!important}"}</style> : null}
      {mode === "scoreboard" ? null : <h1 className={styles.sr}>{initial.competition.title}: {mode}</h1>}
      <BroadcastClient mode={mode} endpoint={endpoint} initial={initial} initialServerNow={Date.now()} />
    </main>
  );
}
