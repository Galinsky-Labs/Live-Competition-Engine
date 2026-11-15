import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSqlClient } from "@live-competition-engine/db";
import { getEvent } from "@live-competition-engine/db/events";
import { judgeForAccount, listRecusals, listSheets } from "@live-competition-engine/db/judging";
import { findOrganizationBySlug } from "@live-competition-engine/db/organizations";
import { listLineup } from "@live-competition-engine/db/registration";
import { listStages } from "@live-competition-engine/db/stages";
import { parseContestConfig } from "@live-competition-engine/engine";
import { ActionButton, JsonForm } from "@/components/json-form";
import { pageAccount } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export default async function JudgePage({ params }: { params: Promise<{ slug: string; eventId: string }> }) {
  const { slug, eventId } = await params;
  const org = await findOrganizationBySlug(slug);
  if (!org) notFound();
  const account = await pageAccount();
  if (!account) redirect("/login");
  const event = await getEvent(org.id, eventId);
  if (!event) notFound();
  const base = `/api/organizations/${org.id}/events/${event.id}`;
  const [invite] = await getSqlClient()<{ status: string }[]>`
    SELECT cj.status FROM competition_judges cj JOIN judges j ON j.id = cj.judge_id
    WHERE cj.organization_id = ${org.id} AND cj.competition_id = ${event.id} AND j.account_id = ${account.accountId}`;
  if (!invite) notFound();
  if (invite.status === "invited") {
    return (
      <main className="shell">
        <h1>Judging invitation: {event.title}</h1>
        <ActionButton action={`${base}/judges/respond`} body={{ accept: true }} label="Accept" />
        <ActionButton action={`${base}/judges/respond`} body={{ accept: false }} label="Decline" />
      </main>
    );
  }
  if (invite.status !== "accepted") return <main className="shell"><h1>You are not on this panel.</h1></main>;
  const me = await judgeForAccount(getSqlClient(), org.id, event.id, account.accountId);
  const config = parseContestConfig(event.config);
  const stage = (await listStages(org.id, event.id)).find(s => s.status === "live");
  const lineup = stage ? await listLineup(org.id, event.id, stage.id) : [];
  const sheets = stage ? (await listSheets(org.id, event.id, stage.id, me.judgeId)).filter(s => s.current) : [];
  const recused = new Set((await listRecusals(org.id, event.id)).filter(r => r.judge_id === me.judgeId).map(r => r.entry_id));
  const criteriaFields = config.scoring.criteria.map(c => ({ name: c.key, label: `${c.label} (${c.min}–${c.max}, step ${c.step}, weight ${c.weight})`, type: "number" as const, min: c.min, max: c.max, step: c.step, required: true }));
  return (
    <main className="shell">
      <p className="eyebrow"><Link href={`/o/${org.slug}/events/${event.id}`}>{event.title}</Link> · judge console</p>
      <h1>Scoring as {me.displayName}</h1>
      {!stage ? <p>No stage is live. This page refreshes when you reload it.</p> : (
        <section aria-labelledby="perf-h">
          <h2 id="perf-h">{stage.label}</h2>
          {lineup.map(slot => {
            const name = config.judging.blind ? `${config.labels.performance} #${slot.ordinal}` : slot.displayName;
            const sheet = sheets.find(s => s.performanceId === slot.performanceId);
            return (
              <article key={slot.performanceId} className="card">
                <h3>{slot.ordinal}. {name} <span className="badge">{slot.status}</span></h3>
                {recused.has(slot.entryId) ? <p>You are recused from this entry.</p> : sheet ? (
                  <>
                    <p>Submitted: {Object.entries(sheet.scores).map(([k, v]) => `${k} ${v}`).join(", ")} → {sheet.total.toFixed(2)}{sheet.supersedesId ? " (corrected)" : ""}</p>
                    <details><summary>Correct this sheet</summary>
                      <ScoreForm action={`${base}/score-sheets/${sheet.id}/correct`} fields={[...criteriaFields, { name: "reason", label: "Reason for correction", type: "text" as const, min: undefined, max: undefined, step: undefined, required: true }]} label="Submit correction" />
                    </details>
                  </>
                ) : slot.status === "live" || slot.status === "completed" ? (
                  <ScoreForm action={`${base}/performances/${slot.performanceId}/scores`} fields={criteriaFields} label="Submit scores (final)" />
                ) : <p className="muted">Scoring opens when this performance starts.</p>}
                {config.critiques.enabled && !recused.has(slot.entryId) ? (
                  <details><summary>Write critique</summary>
                    <JsonForm action={`${base}/performances/${slot.performanceId}/critiques`} submitLabel="Save critique" fields={[
                      { name: "body", label: "Critique", type: "textarea", required: true },
                      { name: "visibility", label: "Visibility", type: "select", defaultValue: config.critiques.defaultVisibility, options: [{ value: "private", label: "Producers only" }, { value: "contestant", label: "Entrant" }, { value: "public", label: "Public (after moderation)" }] }
                    ]} />
                  </details>
                ) : null}
                {!recused.has(slot.entryId) && !sheet ? (
                  <details><summary>Declare a conflict of interest</summary>
                    <JsonForm action={`${base}/recusals`} submitLabel="Recuse" extra={{ entryId: slot.entryId }} fields={[{ name: "reason", label: "Reason", required: true }]} />
                  </details>
                ) : null}
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}

function ScoreForm({ action, fields, label }: { action: string; fields: Array<{ name: string; label: string; type: "number" | "text"; min?: number; max?: number; step?: number; required: boolean }>; label: string }) {
  return <JsonForm action={action} submitLabel={label} fields={fields} shape="json-field" nest="scores" />;
}
