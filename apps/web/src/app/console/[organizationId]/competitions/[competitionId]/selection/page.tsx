import { ConsoleShell } from "../console-shell";
import { SelectionConsole } from "./selection-console";

export const dynamic = "force-dynamic";

export default async function SelectionPage({ params }: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await params;
  return (
    <ConsoleShell organizationId={organizationId} competitionId={competitionId} current="selection"
      title="Selection console" intro="Review submitted applications, record decisions, build round running orders and assign judge panels.">
      <SelectionConsole organizationId={organizationId} competitionId={competitionId} />
    </ConsoleShell>
  );
}
