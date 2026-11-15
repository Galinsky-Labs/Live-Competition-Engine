import { auditVoteWindow, listAudienceMessages, listPolls, listVoteWindows, reactionCounts, voteResults } from "@live-competition-engine/db/audience-voting";
import { evaluateStoredFeature } from "@live-competition-engine/db/feature-flags";
import { listEntrants, listStages } from "@live-competition-engine/db/stages";
import { parseContestConfig } from "@live-competition-engine/engine";
import { ActionButton, JsonForm } from "@/components/json-form";
import { pageAccount } from "@/lib/server-auth";
import type { SectionProps } from "@/server/event-sections";

const enabled = async (feature: "chat" | "voting", org: string, event: string) => (await evaluateStoredFeature(feature, { organizationId: org, eventId: event }).catch(() => ({ enabled: false }))).enabled;

export async function PublicAudience({ org, event }: SectionProps) {
  if (event.status !== "live" && event.status !== "paused" && event.status !== "completed") return null;
  const config = parseContestConfig(event.config);
  const base = `/api/organizations/${org.id}/events/${event.id}`;
  const account = await pageAccount();
  const [chat, voting] = await Promise.all([enabled("chat", org.id, event.id), enabled("voting", org.id, event.id)]);
  const counts = await reactionCounts(org.id, event.id);
  const names = new Map((await listEntrants(org.id, event.id)).map(e => [e.entryId, e.displayName]));
  const windows = voting ? await listVoteWindows(org.id, event.id) : [];
  const consent = { consent: true };
  return (
    <section aria-labelledby="aud-h">
      <h2 id="aud-h">Join in</h2>
      {!account ? <p><a href="/login">Sign in</a> to react, ask questions or vote. Taking part shares only what you submit; votes are stored without your account id.</p> : null}
      <p>{config.audience.reactions.map(r => account && event.status === "live"
        ? <ActionButton key={r} action={`${base}/reactions`} body={{ reaction: r, ...consent }} label={`${r.replace("_", " ")} (${counts[r] ?? 0})`} />
        : <span key={r} className="badge">{r} {counts[r] ?? 0}</span>)}</p>
      {voting ? await Promise.all(windows.filter(w => w.status !== "scheduled").map(async w => {
        const results = await voteResults(org.id, event.id, w.id, false);
        return (
          <article key={w.id} className="card">
            <h3>{w.title} <span className="badge">{w.status}</span></h3>
            {w.status === "open" && account ? w.options.map(id => <ActionButton key={id} action={`${base}/vote-windows/${w.id}/votes`} body={{ entryId: id }} label={`Vote ${names.get(id) ?? ""}`} />) : null}
            {results.tally ? <ul>{results.tally.map(t => <li key={t.entryId}>{names.get(t.entryId)}: {t.votes}</li>)}</ul> : <p className="muted">Results shown {w.visibility === "after_close" ? "when voting closes" : "with the final results"}.</p>}
          </article>
        );
      })) : null}
      {chat ? (
        <>
          {(await listPolls(org.id, event.id)).filter(p => p.status === "open").map(p => (
            <article key={p.id} className="card"><h3>{p.question}</h3>{account ? p.options.map((o, i) => <ActionButton key={o} action={`${base}/polls/${p.id}/answer`} body={{ optionIndex: i, ...consent }} label={`${o} (${p.counts[i]})`} />) : null}</article>
          ))}
          {account && event.status === "live" ? (
            <JsonForm action={`${base}/messages`} submitLabel="Send" extra={consent} fields={[
              { name: "kind", label: "Type", type: "select", options: [{ value: "chat", label: "Chat" }, ...(config.audience.questions ? [{ value: "question", label: "Question for the performers" }] : [])] },
              { name: "body", label: "Message (shown after moderation)", required: true }
            ]} />
          ) : null}
          <ul className="list" aria-live="polite">{(await listAudienceMessages(org.id, event.id, false)).slice(0, 30).map(m => <li key={m.id}>{m.kind === "question" ? "Q: " : ""}{m.body}</li>)}</ul>
        </>
      ) : null}
    </section>
  );
}

export async function ManageAudience({ org, event }: SectionProps) {
  const base = `/api/organizations/${org.id}/events/${event.id}`;
  const [chat, voting] = await Promise.all([enabled("chat", org.id, event.id), enabled("voting", org.id, event.id)]);
  const names = new Map((await listEntrants(org.id, event.id)).map(e => [e.entryId, e.displayName]));
  const stages = await listStages(org.id, event.id);
  const windows = voting ? await listVoteWindows(org.id, event.id) : [];
  return (
    <section className="card" aria-labelledby="maud-h">
      <h2 id="maud-h">Audience and voting</h2>
      <p className="muted">Feature families (LC-08): chat {chat ? "on" : "off"}, voting {voting ? "on" : "off"}. Enable them at platform and tenant scope in the admin console.</p>
      {chat ? (
        <>
          <h3>Moderation queue</h3>
          <ul className="list">{(await listAudienceMessages(org.id, event.id, true)).filter(m => m.status === "pending").map(m => (
            <li key={m.id}>{m.kind}: {m.body} <ActionButton action={`${base}/messages/moderate`} body={{ messageId: m.id, status: "approved" }} label="Approve" /><ActionButton action={`${base}/messages/moderate`} body={{ messageId: m.id, status: "hidden" }} label="Hide" /></li>
          ))}</ul>
          <JsonForm action={`${base}/polls`} submitLabel="Start poll" fields={[{ name: "question", label: "Poll question", required: true }, { name: "optionsJson", label: "Options JSON array", required: true, defaultValue: "[\"Yes\",\"No\"]" }]} />
        </>
      ) : null}
      {voting ? (
        <>
          <h3>Vote windows</h3>
          {await Promise.all(windows.map(async w => {
            const audit = await auditVoteWindow(org.id, event.id, w.id);
            return (
              <article key={w.id} className="card">
                <p><strong>{w.title}</strong> <span className="badge">{w.status}</span> · {w.eligibility} · max {w.maxVotesPerVoter}/voter · {w.visibility}</p>
                {w.status === "scheduled" ? <ActionButton action={`${base}/vote-windows/${w.id}/open`} body={{ expectedRevision: w.revision }} label="Open voting" /> : null}
                {w.status === "open" ? <ActionButton action={`${base}/vote-windows/${w.id}/close`} body={{ expectedRevision: w.revision }} label="Close voting" /> : null}
                <p>Tally: {audit.tally.map(t => `${names.get(t.entryId)} ${t.votes}`).join(" · ")} · chain {audit.chainIntact ? "intact" : `BROKEN at ${audit.firstBrokenIndex}`} · {audit.voteCount} votes, {audit.voidCount} voided{audit.closedDigest ? ` · digest ${audit.digest.slice(0, 12)}… ${audit.digestMatchesClose ? "matches close" : "DIFFERS"}` : ""}</p>
                {audit.anomalies.length ? <ul>{audit.anomalies.map(a => <li key={a.kind} className="error">{a.kind}: {a.detail}</li>)}</ul> : null}
              </article>
            );
          }))}
          <JsonForm action={`${base}/vote-windows`} submitLabel="Create vote window" fields={[
            { name: "title", label: "Title", required: true },
            { name: "stageId", label: "Stage", type: "select", options: stages.map(s => ({ value: s.id, label: s.label })) },
            { name: "eligibility", label: "Who can vote", type: "select", options: [{ value: "any_account", label: "Any signed-in account" }, { value: "tenant_members", label: "Organization members" }, { value: "entitled", label: "Ticket/entitlement holders" }] },
            { name: "maxVotesPerVoter", label: "Votes per voter", type: "number", min: 1, defaultValue: 1 },
            { name: "visibility", label: "Results visibility", type: "select", options: [{ value: "after_close", label: "After close" }, { value: "live", label: "Live" }, { value: "hidden", label: "Hidden until results" }] }
          ]} />
        </>
      ) : null}
    </section>
  );
}
