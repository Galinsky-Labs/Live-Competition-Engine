import { randomUUID } from "node:crypto";
import { DomainError, isBoundedText } from "@live-competition-engine/domain";
import {
  canRecreateStream,
  canResetStreamKey,
  isTerminalStreamStatus,
  publicEmbed,
  streamEffectForEvent,
  type StreamStatus
} from "@live-competition-engine/domain/streaming";
import { getSqlClient } from "./index.ts";
import { recordAudit, type Sql } from "./audit.ts";
import { requireEnabledFeature, isFeatureEnabled } from "./feature-guard.ts";
import { assertCompetitionInTenant, isCompetitionPublic, isUniqueViolation } from "./live-common.ts";
import { hashStreamKey, type ProviderStreamEvent, type StreamingProvider } from "./providers/streaming.ts";

export interface StreamView {
  id: string;
  competitionId: string;
  provider: "mux" | "fake";
  providerStreamId: string;
  ingestUrl: string;
  streamKeyLast4: string;
  playbackId: string | null;
  recordingAssetId: string | null;
  status: StreamStatus;
  failureReason: string | null;
  published: boolean;
  previousStreamId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Returned by create/recreate/reset: `streamKey` is present only on the first, non-replayed response. */
export interface StreamWithKey {
  stream: StreamView;
  streamKey: string | null;
  replayed: boolean;
}

interface StreamRow {
  id: string; competition_id: string; provider: "mux" | "fake"; provider_stream_id: string; ingest_url: string;
  stream_key_last4: string; playback_id: string | null; recording_asset_id: string | null; status: StreamStatus;
  failure_reason: string | null; published: boolean; previous_stream_id: string | null; revision: number;
  created_at: Date; updated_at: Date; idempotency_key: string;
}

const view = (row: StreamRow): StreamView => ({
  id: row.id,
  competitionId: row.competition_id,
  provider: row.provider,
  providerStreamId: row.provider_stream_id,
  ingestUrl: row.ingest_url,
  streamKeyLast4: row.stream_key_last4,
  playbackId: row.playback_id,
  recordingAssetId: row.recording_asset_id,
  status: row.status,
  failureReason: row.failure_reason,
  published: row.published,
  previousStreamId: row.previous_stream_id,
  revision: row.revision,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString()
});

const columns = (sql: Sql) => sql`
  id, competition_id, provider, provider_stream_id, ingest_url, stream_key_last4, playback_id,
  recording_asset_id, status, failure_reason, published, previous_stream_id, revision, created_at,
  updated_at, idempotency_key
`;

export function assertIdempotencyKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{8,200}$/.test(key)) throw new DomainError("invalid_idempotency_key");
}

async function findByIdempotencyKey(sql: Sql, organizationId: string, key: string) {
  const [row] = await sql<StreamRow[]>`
    SELECT ${columns(sql)} FROM streams WHERE organization_id = ${organizationId} AND idempotency_key = ${key}
  `;
  return row ?? null;
}

async function loadStream(sql: Sql, organizationId: string, streamId: string, lock = false): Promise<StreamRow> {
  const [row] = await sql<StreamRow[]>`
    SELECT ${columns(sql)} FROM streams WHERE organization_id = ${organizationId} AND id = ${streamId}
    ${lock ? sql`FOR UPDATE` : sql``}
  `;
  if (!row) throw new DomainError("stream_not_found");
  return row;
}

const last4 = (key: string) => key.slice(-4);

async function cleanupProviderStream(provider: StreamingProvider, providerStreamId: string) {
  try {
    await provider.deleteLiveStream(providerStreamId);
  } catch {
    // Best effort: an orphaned provider stream is idle and holds no engine state.
  }
}

/**
 * Create a provider live stream for a competition (feature `streaming`). Retries
 * with the same idempotency key return the stored stream without the key.
 */
export async function createStream(
  organizationId: string,
  competitionId: string,
  actorAccountId: string,
  input: { idempotencyKey: string },
  provider: StreamingProvider,
  options: { previousStreamId?: string } = {}
): Promise<StreamWithKey> {
  assertIdempotencyKey(input.idempotencyKey);
  const sql = getSqlClient();
  await assertCompetitionInTenant(sql, organizationId, competitionId);
  await requireEnabledFeature("streaming", { organizationId, eventId: competitionId, accountId: actorAccountId });

  const replay = async () => {
    const existing = await findByIdempotencyKey(sql, organizationId, input.idempotencyKey);
    if (!existing) return null;
    if (existing.competition_id !== competitionId) throw new DomainError("idempotency_conflict");
    return { stream: view(existing), streamKey: null, replayed: true };
  };
  const replayed = await replay();
  if (replayed) return replayed;

  if (options.previousStreamId) {
    const previous = await loadStream(sql, organizationId, options.previousStreamId);
    if (previous.competition_id !== competitionId) throw new DomainError("stream_not_found");
    if (!canRecreateStream(previous.status)) throw new DomainError(`invalid_state_stream_${previous.status}_recreate`);
  } else {
    const [open] = await sql`SELECT 1 FROM streams WHERE organization_id = ${organizationId}
      AND competition_id = ${competitionId} AND status NOT IN ('ended', 'failed')`;
    if (open) throw new DomainError("stream_conflict_open_stream_exists");
  }

  const streamId = randomUUID();
  let replacedProviderStreamId: string | null = null;
  const created = await provider.createLiveStream({ reference: streamId });
  try {
    const row = await sql.begin(async tx => {
      if (options.previousStreamId) {
        const previous = await loadStream(tx, organizationId, options.previousStreamId, true);
        if (!canRecreateStream(previous.status)) throw new DomainError(`invalid_state_stream_${previous.status}_recreate`);
        if (!isTerminalStreamStatus(previous.status)) {
          replacedProviderStreamId = previous.provider_stream_id;
          await tx`UPDATE streams SET status = 'failed', failure_reason = 'replaced_by_recreate',
            revision = revision + 1, updated_at = now()
            WHERE organization_id = ${organizationId} AND id = ${previous.id}`;
          await recordAudit(tx, {
            organizationId, actorAccountId, action: "stream.failed", subjectType: "stream", subjectId: previous.id,
            details: { from: previous.status, reason: "replaced_by_recreate" }
          });
        }
      }
      const [inserted] = await tx<StreamRow[]>`
        INSERT INTO streams (id, organization_id, competition_id, provider, provider_stream_id, ingest_url,
          stream_key_hash, stream_key_last4, playback_id, previous_stream_id, idempotency_key, created_by_account_id)
        VALUES (${streamId}, ${organizationId}, ${competitionId}, ${provider.name}, ${created.providerStreamId},
          ${created.ingestUrl}, ${hashStreamKey(created.streamKey)}, ${last4(created.streamKey)}, ${created.playbackId},
          ${options.previousStreamId ?? null}, ${input.idempotencyKey}, ${actorAccountId})
        RETURNING ${columns(tx)}
      `;
      await recordAudit(tx, {
        organizationId, actorAccountId,
        action: options.previousStreamId ? "stream.recreated" : "stream.created",
        subjectType: "stream", subjectId: streamId,
        details: { competitionId, provider: provider.name, previousStreamId: options.previousStreamId ?? null }
      });
      return inserted!;
    });
    if (replacedProviderStreamId) {
      // Best effort: stop the replaced provider session so a stale encoder cannot keep it alive.
      await provider.completeLiveStream(replacedProviderStreamId).catch(() => undefined);
    }
    return { stream: view(row), streamKey: created.streamKey, replayed: false };
  } catch (error) {
    await cleanupProviderStream(provider, created.providerStreamId);
    if (isUniqueViolation(error)) {
      const again = await replay();
      if (again) return again;
      throw new DomainError("stream_conflict_open_stream_exists");
    }
    throw error;
  }
}

/** Recovery: replace a failed/ended/disconnected stream with a fresh provider stream. */
export async function recreateStream(
  organizationId: string,
  streamId: string,
  actorAccountId: string,
  input: { idempotencyKey: string },
  provider: StreamingProvider
): Promise<StreamWithKey> {
  const previous = await loadStream(getSqlClient(), organizationId, streamId);
  return createStream(organizationId, previous.competition_id, actorAccountId, input, provider, { previousStreamId: streamId });
}

/** Recovery for a leaked or lost key: rotate it at the provider; the new key is returned once. */
export async function resetStreamKey(
  organizationId: string,
  streamId: string,
  actorAccountId: string,
  provider: StreamingProvider
): Promise<StreamWithKey> {
  const sql = getSqlClient();
  const current = await loadStream(sql, organizationId, streamId);
  await requireEnabledFeature("streaming", { organizationId, eventId: current.competition_id, accountId: actorAccountId });
  if (!canResetStreamKey(current.status)) throw new DomainError(`invalid_state_stream_${current.status}_reset_key`);
  if (current.provider !== provider.name) throw new DomainError("stream_provider_mismatch");
  const { streamKey } = await provider.resetStreamKey(current.provider_stream_id);
  const row = await sql.begin(async tx => {
    const locked = await loadStream(tx, organizationId, streamId, true);
    if (!canResetStreamKey(locked.status)) throw new DomainError(`invalid_state_stream_${locked.status}_reset_key`);
    const [updated] = await tx<StreamRow[]>`
      UPDATE streams SET stream_key_hash = ${hashStreamKey(streamKey)}, stream_key_last4 = ${last4(streamKey)},
        revision = revision + 1, updated_at = now()
      WHERE organization_id = ${organizationId} AND id = ${streamId}
      RETURNING ${columns(tx)}
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "stream.key_reset", subjectType: "stream", subjectId: streamId,
      details: { revision: updated!.revision }
    });
    return updated!;
  });
  return { stream: view(row), streamKey, replayed: false };
}

/** Producer ends the stream: the provider is told to finalize the recording. */
export async function endStream(
  organizationId: string,
  streamId: string,
  actorAccountId: string,
  provider: StreamingProvider
): Promise<StreamView> {
  const sql = getSqlClient();
  const current = await loadStream(sql, organizationId, streamId);
  if (isTerminalStreamStatus(current.status)) throw new DomainError(`invalid_state_stream_${current.status}_end`);
  if (current.provider !== provider.name) throw new DomainError("stream_provider_mismatch");
  await provider.completeLiveStream(current.provider_stream_id);
  return sql.begin(async tx => {
    const locked = await loadStream(tx, organizationId, streamId, true);
    if (isTerminalStreamStatus(locked.status)) throw new DomainError(`invalid_state_stream_${locked.status}_end`);
    const [updated] = await tx<StreamRow[]>`
      UPDATE streams SET status = 'ended', revision = revision + 1, updated_at = now()
      WHERE organization_id = ${organizationId} AND id = ${streamId} RETURNING ${columns(tx)}
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "stream.ended", subjectType: "stream", subjectId: streamId,
      details: { from: locked.status }
    });
    return view(updated!);
  });
}

/** Toggle the public embed. Optimistic revision guards against stale control-room clicks. */
export async function setStreamPublished(
  organizationId: string,
  streamId: string,
  actorAccountId: string,
  input: { published: boolean; expectedRevision: number }
): Promise<StreamView> {
  if (typeof input.published !== "boolean" || !Number.isInteger(input.expectedRevision)) throw new DomainError("invalid_input");
  const sql = getSqlClient();
  const current = await loadStream(sql, organizationId, streamId);
  if (input.published) {
    await requireEnabledFeature("streaming", { organizationId, eventId: current.competition_id, accountId: actorAccountId });
  }
  return sql.begin(async tx => {
    const [updated] = await tx<StreamRow[]>`
      UPDATE streams SET published = ${input.published}, revision = revision + 1, updated_at = now()
      WHERE organization_id = ${organizationId} AND id = ${streamId} AND revision = ${input.expectedRevision}
      RETURNING ${columns(tx)}
    `;
    if (!updated) throw new DomainError("stream_revision_conflict");
    await recordAudit(tx, {
      organizationId, actorAccountId, action: input.published ? "stream.published" : "stream.unpublished",
      subjectType: "stream", subjectId: streamId, details: { revision: updated.revision }
    });
    return view(updated);
  });
}

export async function getStream(organizationId: string, streamId: string): Promise<StreamView> {
  return view(await loadStream(getSqlClient(), organizationId, streamId));
}

export async function listStreams(organizationId: string, competitionId: string): Promise<StreamView[]> {
  const sql = getSqlClient();
  const rows = await sql<StreamRow[]>`
    SELECT ${columns(sql)} FROM streams
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
    ORDER BY created_at DESC LIMIT 50
  `;
  return rows.map(view);
}

export type ProviderEventOutcome = "duplicate" | "unknown_stream" | "applied" | "recording" | `ignored:${string}`;

/**
 * Apply a verified provider webhook event exactly once (unique provider event id).
 * Signature verification happens before this call, in the webhook route.
 */
export async function applyProviderStreamEvent(event: ProviderStreamEvent): Promise<ProviderEventOutcome> {
  if (!isBoundedText(event.eventId, 200, 1) || !isBoundedText(event.type, 100, 1)) throw new DomainError("invalid_event");
  return getSqlClient().begin(async tx => {
    const [inbox] = await tx<{ id: string }[]>`
      INSERT INTO stream_provider_events (provider, provider_event_id, event_type, provider_stream_id, outcome)
      VALUES (${event.provider}, ${event.eventId}, ${event.type}, ${event.providerStreamId}, 'received')
      ON CONFLICT (provider, provider_event_id) DO NOTHING
      RETURNING id::text
    `;
    if (!inbox) return "duplicate";
    const finish = async (outcome: ProviderEventOutcome, stream?: { organizationId: string; id: string }) => {
      await tx`UPDATE stream_provider_events SET outcome = ${outcome}, organization_id = ${stream?.organizationId ?? null},
        stream_id = ${stream?.id ?? null} WHERE id = ${inbox.id}`;
      return outcome;
    };
    if (!event.providerStreamId) return finish("unknown_stream");
    const [stream] = await tx<{ id: string; organization_id: string; status: StreamStatus }[]>`
      SELECT id, organization_id, status FROM streams
      WHERE provider = ${event.provider} AND provider_stream_id = ${event.providerStreamId}
      FOR UPDATE
    `;
    if (!stream) return finish("unknown_stream");
    const ref = { organizationId: stream.organization_id, id: stream.id };
    const effect = streamEffectForEvent(stream.status, { type: event.type, assetId: event.assetId });
    if (effect.kind === "ignore") return finish(`ignored:${effect.reason}`, ref);
    if (effect.kind === "recording") {
      await tx`UPDATE streams SET recording_asset_id = ${effect.assetId}, last_event_at = now(), updated_at = now(),
        revision = revision + 1 WHERE id = ${stream.id}`;
      await recordAudit(tx, {
        organizationId: stream.organization_id, actorAccountId: null, action: "stream.recording_available",
        subjectType: "stream", subjectId: stream.id, details: { providerEventId: event.eventId }
      });
      return finish("recording", ref);
    }
    await tx`UPDATE streams SET status = ${effect.to}, failure_reason = ${effect.reason ?? null},
      last_event_at = now(), updated_at = now(), revision = revision + 1 WHERE id = ${stream.id}`;
    await recordAudit(tx, {
      organizationId: stream.organization_id, actorAccountId: null, action: `stream.${effect.to}`,
      subjectType: "stream", subjectId: stream.id,
      details: { from: stream.status, providerEventId: event.eventId, type: event.type }
    });
    return finish("applied", ref);
  });
}

/** Anonymous embed info: only the newest published stream, only when the competition is public. */
export async function getPublicStreamEmbed(organizationId: string, competitionId: string) {
  const sql = getSqlClient();
  if (!(await isCompetitionPublic(sql, organizationId, competitionId))) return null;
  if (!(await isFeatureEnabled("streaming", { organizationId, eventId: competitionId }))) return null;
  const [row] = await sql<{ status: StreamStatus; published: boolean; playback_id: string | null }[]>`
    SELECT status, published, playback_id FROM streams
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND published
      AND status <> 'failed'
    ORDER BY created_at DESC LIMIT 1
  `;
  return row ? publicEmbed({ status: row.status, published: row.published, playbackId: row.playback_id }) : null;
}
