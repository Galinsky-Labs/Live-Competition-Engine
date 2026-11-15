import { ConsoleShell } from "../console-shell";
import { FeedbackView } from "./feedback-view";

export const dynamic = "force-dynamic";

export default async function FeedbackPage({ params }: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await params;
  return (
    <ConsoleShell organizationId={organizationId} competitionId={competitionId} current="feedback"
      title="My feedback" intro="Critiques judges shared with you for this event. You can ask for a correction or appeal.">
      <FeedbackView organizationId={organizationId} competitionId={competitionId} />
    </ConsoleShell>
  );
}
