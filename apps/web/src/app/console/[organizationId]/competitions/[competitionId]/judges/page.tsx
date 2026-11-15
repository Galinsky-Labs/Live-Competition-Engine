import { ConsoleShell } from "../console-shell";
import { JudgesConsole } from "./judges-console";

export const dynamic = "force-dynamic";

export default async function JudgesPage({ params }: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await params;
  return (
    <ConsoleShell organizationId={organizationId} competitionId={competitionId} current="judges"
      title="Judges" intro="Invite judges, verify or suspend them, and manage conflicts of interest.">
      <JudgesConsole organizationId={organizationId} competitionId={competitionId} />
    </ConsoleShell>
  );
}
