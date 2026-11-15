import { ConsoleShell } from "../console-shell";
import { ScoresSection } from "./scores-section";

export const dynamic = "force-dynamic";

export default async function ModerationPage({ params }: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await params;
  return (
    <ConsoleShell organizationId={organizationId} competitionId={competitionId} current="moderation"
      title="Scores and critiques" intro="Manage rubric versions, approve score corrections, review standings and moderate critiques.">
      <ScoresSection organizationId={organizationId} competitionId={competitionId} />
    </ConsoleShell>
  );
}
