import { getOwnApplication, listApplications, listLineup } from "@live-competition-engine/db/registration";
import { listStages } from "@live-competition-engine/db/stages";
import { parseContestConfig, registrationState } from "@live-competition-engine/engine";
import { ActionButton, JsonForm } from "@/components/json-form";
import { pageAccount } from "@/lib/server-auth";
import type { SectionProps } from "@/server/event-sections";

export async function PublicRegistration({ org, event }: SectionProps) {
  const config = parseContestConfig(event.config);
  if (!config.eligibility.requiresApplication) return null;
  const base = `/api/organizations/${org.id}/events/${event.id}`;
  const account = await pageAccount();
  const own = account ? await getOwnApplication(org.id, event.id, account.accountId) : null;
  const state = event.status === "published" ? registrationState(config, new Date()) : "closed";
  return (
    <section className="card" aria-labelledby="apply-h">
      <h2 id="apply-h">Apply to take part</h2>
      {config.registration.closesAt ? <p className="muted">Applications close {new Date(config.registration.closesAt).toUTCString()}.</p> : null}
      {own ? (
        <>
          <p>Your application: <span className="badge">{own.status}</span>{own.waitlistPosition ? ` (waitlist #${own.waitlistPosition})` : ""}</p>
          {own.status !== "withdrawn" && own.status !== "rejected" ? <ActionButton action={`${base}/applications/${own.id}/withdraw`} label="Withdraw application" confirm="Withdraw your application?" /> : null}
        </>
      ) : !account ? <p><a href="/login">Sign in</a> to apply.</p> : state !== "open" ? <p>Applications are {state === "closed" ? "closed" : "not open yet"}.</p> : (
        <JsonForm action={`${base}/applications`} submitLabel="Submit application" extra={{ consent: { accepted: true, version: config.registration.consentVersion } }} fields={[
          { name: "displayName", label: `${config.labels.entrant} name`, required: true },
          { name: "statement", label: "About your entry", type: "textarea" },
          ...(config.format === "group" ? [{ name: "kind", label: "Kind", type: "select" as const, options: [{ value: "group", label: "Group" }] }, { name: "membersJson", label: "Members JSON array", required: true }] : [])
        ]}>
          <p className="muted">By submitting you consent (version {config.registration.consentVersion}) to the organizer reviewing and storing your application and, if selected, to your name appearing in public lineups and results.</p>
        </JsonForm>
      )}
    </section>
  );
}

export async function ManageRegistration({ org, event }: SectionProps) {
  const base = `/api/organizations/${org.id}/events/${event.id}`;
  const applications = await listApplications(org.id, event.id);
  const stages = (await listStages(org.id, event.id)).filter(s => s.status === "scheduled" && s.format !== "head_to_head" && s.format !== "round_robin");
  return (
    <>
      <section className="card" aria-labelledby="apps-h">
        <h2 id="apps-h">Applications ({applications.length})</h2>
        <ActionButton action={`${base}/applications/promote`} label="Promote next from waitlist" />
        <table>
          <thead><tr><th scope="col">Name</th><th scope="col">Statement</th><th scope="col">Status</th><th scope="col">Decide</th></tr></thead>
          <tbody>
            {applications.map(a => (
              <tr key={a.id}>
                <td>{a.displayName}{a.members.length ? ` (${a.members.join(", ")})` : ""}</td>
                <td>{a.statement?.slice(0, 200)}</td>
                <td><span className="badge">{a.status}</span>{a.waitlistPosition ? ` #${a.waitlistPosition}` : ""} <small className="muted">r{a.revision}</small></td>
                <td>
                  {(["under_review", "selected", "waitlisted", "rejected"] as const).filter(s => s !== a.status && a.status !== "withdrawn").map(s => (
                    <ActionButton key={s} action={`${base}/applications/${a.id}/decide`} label={s.replace("_", " ")}
                      body={{ status: s, expectedRevision: a.revision, ...(a.status === "selected" || a.status === "rejected" ? { reason: "Producer reconsideration" } : {}) }} />
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {await Promise.all(stages.map(async stage => {
        const lineup = await listLineup(org.id, event.id, stage.id);
        return (
          <section key={stage.id} className="card" aria-label={`Lineup for ${stage.label}`}>
            <h2>Running order: {stage.label}</h2>
            <ol>{lineup.map(slot => <li key={slot.performanceId}>{slot.displayName} <span className="badge">{slot.status}</span></li>)}</ol>
            <JsonForm action={`${base}/stages/${stage.id}/lineup`} method="PUT" submitLabel="Save running order" fields={[
              { name: "entryIdsJson", label: "Entry ids in performance order (JSON array)", type: "textarea", defaultValue: JSON.stringify(lineup.map(s => s.entryId)) }
            ]} />
          </section>
        );
      }))}
    </>
  );
}
