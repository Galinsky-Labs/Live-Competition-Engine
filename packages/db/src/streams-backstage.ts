import { assertStreamTransition, DomainError, type StreamingProvider, type StreamStatus } from "@live-competition-engine/engine";
import { getSqlClient } from "./index.ts";
import { recordAudit } from "./audit.ts";
import { lockEvent } from "./events.ts";

/* ---------- LC-22 streams ---------- */

export interface StreamRecord { provider: string; externalId: string | null; embedUrl: string | null; playbackUrl: string | null; ingestUrl: string | null; status: StreamStatus; failureReason: string | null; recordingUrl: string | null; revision: number; updatedAt: Date }
interface StreamRow { provider: string; external_id: string | null; embed_url: string | null; playback_url: string | null; ingest_url: string | null; status: StreamStatus; failure_reason: string | null; recording_url: string | null; revision: number; updated_at: Date }
const toStream = (r: StreamRow): StreamRecord => ({ provider: r.provider, externalId: r.external_id, embedUrl: r.embed_url, playbackUrl: r.playback_url, ingestUrl: r.ingest_url, status: r.status, failureReason: r.failure_reason, recordingUrl: r.recording_url, revision: r.revision, updatedAt: r.updated_at });
const cols = "provider, external_id, embed_url, playback_url, ingest_url, status, failure_reason, recording_url, revision, updated_at";

export async function getStream(organizationId: string, eventId: string): Promise<StreamRecord | null> {
  const [row] = await getSqlClient().unsafe<StreamRow[]>(`SELECT ${cols} FROM event_streams WHERE organization_id = $1 AND competition_id = $2`, [organizationId, eventId]);
  return row ? toStream(row) : null;
}

/** Creates or replaces the event's stream via the configured provider. Returns the one-time stream key. */
export async function configureStream(organizationId: string, eventId: string, actorAccountId: string, provider: StreamingProvider, embedUrl: unknown) {
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    if (event.status === "completed" || event.status === "cancelled") throw new DomainError(409, "event_closed");
    const [existing] = await tx<{ status: string }[]>`SELECT status FROM event_streams WHERE competition_id = ${eventId} FOR UPDATE`;
    if (existing?.status === "live") throw new DomainError(409, "stream_is_live");
    const setup = await provider.setup({ eventId, title: event.title, embedUrl: typeof embedUrl === "string" ? embedUrl : null });
    const [row] = await tx.unsafe<StreamRow[]>(
      `INSERT INTO event_streams (organization_id, competition_id, provider, external_id, embed_url, playback_url, ingest_url, status, updated_by_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'idle', $8)
       ON CONFLICT (competition_id) DO UPDATE SET provider = EXCLUDED.provider, external_id = EXCLUDED.external_id, embed_url = EXCLUDED.embed_url,
         playback_url = EXCLUDED.playback_url, ingest_url = EXCLUDED.ingest_url, status = 'idle', failure_reason = NULL,
         revision = event_streams.revision + 1, updated_by_account_id = EXCLUDED.updated_by_account_id, updated_at = now()
       RETURNING ${cols}`,
      [organizationId, eventId, setup.provider, setup.externalId, setup.embedUrl, setup.playbackUrl, setup.ingestUrl, actorAccountId]);
    await recordAudit(tx, { organizationId, actorAccountId, action: "stream.configured", subjectType: "event", subjectId: eventId, details: { provider: setup.provider, externalId: setup.externalId } });
    return { stream: toStream(row!), streamKey: setup.streamKey };
  });
}

/** Producer-reported lifecycle change (live, ended, failed with reason, recovered to idle/live). */
export async function setStreamStatus(organizationId: string, eventId: string, actorAccountId: string, to: unknown, expectedRevision: unknown, reason?: unknown, recordingUrl?: unknown) {
  if (to !== "idle" && to !== "live" && to !== "ended" && to !== "failed") throw new DomainError(400, "invalid_stream_status");
  const why = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : null;
  if (to === "failed" && !why) throw new DomainError(400, "failure_reason_required");
  const recording = typeof recordingUrl === "string" && /^https:\/\//.test(recordingUrl) ? recordingUrl.slice(0, 2000) : null;
  return getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const [current] = await tx.unsafe<StreamRow[]>(`SELECT ${cols} FROM event_streams WHERE organization_id = $1 AND competition_id = $2 FOR UPDATE`, [organizationId, eventId]);
    if (!current) throw new DomainError(404, "stream_not_configured");
    if (current.revision !== expectedRevision) throw new DomainError(409, "revision_conflict");
    assertStreamTransition(current.status, to);
    const [row] = await tx.unsafe<StreamRow[]>(
      `UPDATE event_streams SET status = $3, failure_reason = $4, recording_url = COALESCE($5, recording_url), revision = revision + 1,
         updated_by_account_id = $6, updated_at = now() WHERE organization_id = $1 AND competition_id = $2 RETURNING ${cols}`,
      [organizationId, eventId, to, to === "failed" ? why : null, recording, actorAccountId]);
    await recordAudit(tx, { organizationId, actorAccountId, action: `stream.${to}`, subjectType: "event", subjectId: eventId, details: { from: current.status, ...(why ? { reason: why } : {}) } });
    return toStream(row!);
  });
}

/* ---------- LC-23 backstage ---------- */

export type BackstageRole = "producer" | "judge" | "performer";
const readable: Record<BackstageRole, string[]> = {
  producer: ["crew", "judges", "performers", "everyone_backstage"],
  judge: ["judges", "everyone_backstage"],
  performer: ["performers", "everyone_backstage"]
};
const writable: Record<BackstageRole, string[]> = {
  producer: ["crew", "judges", "performers", "everyone_backstage"],
  judge: ["judges"],
  performer: ["crew"]
};

/** Resolves the caller's least-privilege backstage role: producer, accepted judge, or approved entrant. */
export async function backstageRole(organizationId: string, eventId: string, accountId: string, isProducer: boolean): Promise<{ role: BackstageRole; entryIds: string[] } | null> {
  if (isProducer) return { role: "producer", entryIds: [] };
  const sql = getSqlClient();
  const [judge] = await sql`SELECT 1 FROM competition_judges cj JOIN judges j ON j.id = cj.judge_id
    WHERE cj.organization_id = ${organizationId} AND cj.competition_id = ${eventId} AND j.account_id = ${accountId} AND cj.status = 'accepted'`;
  if (judge) return { role: "judge", entryIds: [] };
  const entries = await sql<{ id: string }[]>`SELECT e.id FROM entries e JOIN participants p ON p.id = e.participant_id
    WHERE e.organization_id = ${organizationId} AND e.competition_id = ${eventId} AND e.status = 'approved' AND p.account_id = ${accountId}`;
  return entries.length ? { role: "performer", entryIds: entries.map(e => e.id) } : null;
}

export async function postBackstage(organizationId: string, eventId: string, accountId: string, who: { role: BackstageRole }, input: { audience?: unknown; body?: unknown; kind?: unknown; entryId?: unknown }) {
  const audience = typeof input.audience === "string" ? input.audience : who.role === "producer" ? "everyone_backstage" : who.role === "judge" ? "judges" : "crew";
  if (!writable[who.role].includes(audience)) throw new DomainError(403, "audience_not_allowed");
  if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 2000) throw new DomainError(400, "invalid_body");
  const kind = input.kind === "cue" ? "cue" : "message";
  if (kind === "cue" && who.role !== "producer") throw new DomainError(403, "only_producers_cue");
  const entryId = typeof input.entryId === "string" ? input.entryId : null;
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    if (event.status === "completed" || event.status === "cancelled") throw new DomainError(409, "event_closed");
    const [row] = await tx<{ id: string; created_at: Date }[]>`
      INSERT INTO backstage_messages (organization_id, competition_id, author_account_id, author_role, audience, kind, body, entry_id)
      VALUES (${organizationId}, ${eventId}, ${accountId}, ${who.role}, ${audience}, ${kind}, ${input.body!.toString().trim()}, ${entryId}) RETURNING id, created_at`;
    return { id: Number(row!.id), createdAt: row!.created_at, audience, kind };
  });
}

export async function listBackstage(organizationId: string, eventId: string, who: { role: BackstageRole }, afterId = 0) {
  const rows = await getSqlClient()<{ id: string; author_role: string; audience: string; kind: string; body: string; entry_id: string | null; created_at: Date }[]>`
    SELECT id, author_role, audience, kind, body, entry_id, created_at FROM backstage_messages
    WHERE organization_id = ${organizationId} AND competition_id = ${eventId} AND audience IN ${getSqlClient()(readable[who.role])} AND id > ${afterId}
    ORDER BY id DESC LIMIT 100`;
  return rows.map(r => ({ id: Number(r.id), authorRole: r.author_role, audience: r.audience, kind: r.kind, body: r.body, entryId: r.entry_id, createdAt: r.created_at }));
}

export async function setReadiness(organizationId: string, eventId: string, accountId: string, who: { role: BackstageRole; entryIds: string[] }, entryId: unknown, status: unknown, note?: unknown) {
  if (typeof entryId !== "string") throw new DomainError(400, "invalid_entry_id");
  if (status !== "not_ready" && status !== "ready" && status !== "technical_issue" && status !== "on_stage") throw new DomainError(400, "invalid_readiness");
  if (who.role === "judge") throw new DomainError(403, "forbidden");
  if (who.role === "performer" && (!who.entryIds.includes(entryId) || status === "on_stage")) throw new DomainError(403, "forbidden");
  const text = typeof note === "string" ? note.trim().slice(0, 500) || null : null;
  const sql = getSqlClient();
  const [row] = await sql<{ status: string }[]>`
    INSERT INTO performer_readiness (organization_id, competition_id, entry_id, status, note, updated_by_account_id)
    SELECT ${organizationId}, ${eventId}, e.id, ${status}, ${text}, ${accountId} FROM entries e
    WHERE e.organization_id = ${organizationId} AND e.competition_id = ${eventId} AND e.id = ${entryId} AND e.status = 'approved'
    ON CONFLICT (competition_id, entry_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_by_account_id = EXCLUDED.updated_by_account_id, updated_at = now()
    RETURNING status`;
  if (!row) throw new DomainError(404, "entry_not_found");
  return { entryId, status: row.status };
}

export async function listReadiness(organizationId: string, eventId: string, who: { role: BackstageRole; entryIds: string[] }) {
  if (who.role === "judge") return [];
  const rows = await getSqlClient()<{ entry_id: string; status: string; note: string | null; updated_at: Date }[]>`
    SELECT entry_id, status, note, updated_at FROM performer_readiness WHERE organization_id = ${organizationId} AND competition_id = ${eventId}`;
  return rows.filter(r => who.role === "producer" || who.entryIds.includes(r.entry_id)).map(r => ({ entryId: r.entry_id, status: r.status, note: r.note, updatedAt: r.updated_at }));
}
