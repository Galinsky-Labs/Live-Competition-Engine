import { ConsoleShell } from "../console-shell";
import { JudgingConsole } from "./judging-console";

export const dynamic = "force-dynamic";

export default async function JudgingPage({ params }: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await params;
  return (
    <ConsoleShell organizationId={organizationId} competitionId={competitionId} current="judging"
      title="Judging" intro="Your assigned rounds and performances. You only see rounds where you sit on the panel.">
      <JudgingConsole organizationId={organizationId} competitionId={competitionId} />
    </ConsoleShell>
  );
}
