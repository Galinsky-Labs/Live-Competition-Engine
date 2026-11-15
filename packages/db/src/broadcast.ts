import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  CAPTION_LIMITS,
  blockedTermsFromRules,
  captionKinds,
  moderateCaption,
  type CaptionKind,
  type PublicTimer
} from "@live-competition-engine/domain/broadcast";
import { replayTimer, type TimerCommand, type TimerCommandType } from "@live-competition-engine/domain/timer";
import { getSqlClient } from "./index.ts";
import { recordAudit, type Sql } from "./audit.ts";
import { assertCompetitionInTenant, bumpBroadcastSequence, isCompetitionPublic, isUniqueViolation, lockShowControl } from "./live-common.ts";
import { assertIdempotencyKey } from "./streams.ts";

export interface Caption {
  id: string;
  kind: CaptionKind;
  text: string;
  subtitle: string | null;
  createdAt: string;
}

interface CaptionRow { id: string; kind: CaptionKind; text: string; subtitle: string | null; created_at: Date; created_by_account_id: string }

const toCaption = (row: CaptionRow): Caption => ({
  id: row.id, kind: row.kind, text: row.text, subtitle: row.subtitle, createdAt: row.created_at.toISOString()
});

/** Put a lower third or caption on air (replaces the active one of the same kind). */
export async function setCaption(
  organizationId: string,
  competitionId: string,
  actorAccountId: string,
  input: { kind: unknown; text: unknown; subtitle?: unknown; idempotencyKey: string }
): Promise<Caption> {
  assertIdempotencyKey(input.idempotencyKey);
  if (!(captionKinds as readonly unknown[]).includes(input.kind)) throw new DomainError("invalid_caption_kind");
  const kind = input.kind as CaptionKind;
  if (kind === "caption" && input.subtitle !== undefined && input.subtitle !== null) throw new DomainError("invalid_caption_subtitle");
  const sql = getSqlClient();
  const replay = async () => {
    const [row] = await sql<CaptionRow[]>`SELECT id, kind, text, subtitle, created_at, created_by_account_id FROM broadcast_captions
      WHERE organization_id = ${organizationId} AND idempotency_key = ${input.idempotencyKey}`;
    if (!row) return null;
    if (row.created_by_account_id !== actorAccountId || row.kind !== kind) throw new DomainError("idempotency_conflict");
    return toCaption(row);
  };
  const existing = await replay();
  if (existing) return existing;
  try {
    return await sql.begin(async tx => {
      const [competition] = await tx<{ rules: unknown }[]>`SELECT rules FROM competitions
        WHERE organization_id = ${organizationId} AND id = ${competitionId}`;
      if (!competition) throw new DomainError("competition_not_found");
      const terms = blockedTermsFromRules(competition.rules);
      const text = moderateCaption(input.text, terms, CAPTION_LIMITS.text);
      const subtitle = input.subtitle === undefined || input.subtitle === null || input.subtitle === ""
        ? null : moderateCaption(input.subtitle, terms, CAPTION_LIMITS.subtitle);
      await lockShowControl(tx, organizationId, competitionId);
      const cleared = await tx<{ id: string }[]>`UPDATE broadcast_captions SET active = false, cleared_at = now(), cleared_by_account_id = ${actorAccountId}
        WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND kind = ${kind} AND active RETURNING id`;
      const [row] = await tx<CaptionRow[]>`
        INSERT INTO broadcast_captions (organization_id, competition_id, kind, text, subtitle, idempotency_key, created_by_account_id)
        VALUES (${organizationId}, ${competitionId}, ${kind}, ${text}, ${subtitle}, ${input.idempotencyKey}, ${actorAccountId})
        RETURNING id, kind, text, subtitle, created_at, created_by_account_id
      `;
      await recordAudit(tx, {
        organizationId, actorAccountId, action: "broadcast.caption_set", subjectType: "broadcast_caption", subjectId: row!.id,
        details: { competitionId, kind, text, subtitle, replaced: cleared.map(c => c.id) }
      });
      await bumpBroadcastSequence(tx, organizationId, competitionId);
      return toCaption(row!);
    });
  } catch (error) {
    if (isUniqueViolation(error, "broadcast_captions_organization_id_idempotency_key_key")) {
      const again = await replay();
      if (again) return again;
    }
    throw error;
  }
}

export async function clearCaption(organizationId: string, competitionId: string, actorAccountId: string, captionId: string): Promise<{ id: string; cleared: boolean }> {
  if (!isUuid(captionId)) throw new DomainError("caption_not_found");
  return getSqlClient().begin(async tx => {
    await assertCompetitionInTenant(tx, organizationId, competitionId);
    await lockShowControl(tx, organizationId, competitionId);
    const [row] = await tx<{ active: boolean }[]>`SELECT active FROM broadcast_captions
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${captionId} FOR UPDATE`;
    if (!row) throw new DomainError("caption_not_found");
    if (!row.active) return { id: captionId, cleared: false };
    await tx`UPDATE broadcast_captions SET active = false, cleared_at = now(), cleared_by_account_id = ${actorAccountId}
      WHERE organization_id = ${organizationId} AND id = ${captionId}`;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "broadcast.caption_cleared", subjectType: "broadcast_caption", subjectId: captionId,
      details: { competitionId }
    });
    await bumpBroadcastSequence(tx, organizationId, competitionId);
    return { id: captionId, cleared: true };
  });
}

export async function listActiveCaptions(organizationId: string, competitionId: string, sql: Sql = getSqlClient()): Promise<Caption[]> {
  const rows = await sql<CaptionRow[]>`SELECT id, kind, text, subtitle, created_at, created_by_account_id FROM broadcast_captions
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND active ORDER BY kind`;
  return rows.map(toCaption);
}

/* ------------------------------------------------------------------ */
/* Public projections. Everything below is anonymous-readable: only    */
/* explicitly listed public fields leave this module.                  */
/* ------------------------------------------------------------------ */

export interface PublicOverlay {
  competition: { title: string };
  show: { state: "standby" | "running" | "paused" | "ended" };
  /** Monotonic per competition; overlays ignore payloads older than what they show. */
  sequence: number;
  current: { displayName: string; roundLabel: string } | null;
  next: { displayName: string } | null;
  timer: (PublicTimer & { label: string }) | null;
  lowerThird: { text: string; subtitle: string | null } | null;
  caption: { text: string } | null;
}

async function publicTimer(sql: Sql, organizationId: string, competitionId: string, currentPerformanceId: string | null) {
  const [timer] = await sql<{ id: string; label: string; duration_ms: number; max_extension_ms: number }[]>`
    SELECT id, label, duration_ms, max_extension_ms FROM stage_timers
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
      AND (performance_id = ${currentPerformanceId} OR performance_id IS NULL)
    ORDER BY (performance_id IS NOT NULL) DESC, updated_at DESC LIMIT 1
  `;
  if (!timer) return null;
  const commands = await sql<{ command: TimerCommandType; amount_ms: number | null; duration_ms: number | null; issued_at_ms: string }[]>`
    SELECT command, amount_ms, duration_ms, issued_at_ms::text FROM stage_timer_commands WHERE timer_id = ${timer.id} ORDER BY sequence
  `;
  // Reasons are deliberately not replayed into the public view (they may be private, e.g. safety stops).
  const log: TimerCommand[] = commands.map(c => ({ type: c.command, at: Number(c.issued_at_ms), amountMs: c.amount_ms, durationMs: c.duration_ms }));
  const state = replayTimer({ durationMs: timer.duration_ms, maxExtensionMs: timer.max_extension_ms }, log);
  return {
    label: timer.label, status: state.status, durationMs: state.durationMs, extendedMs: state.extendedMs,
    elapsedBeforeMs: state.elapsedBeforeMs, runningSince: state.runningSince, sequence: state.sequence
  };
}

/** Overlay data, or null when the competition does not exist in the tenant or is not public. */
export async function getPublicOverlay(organizationId: string, competitionId: string): Promise<PublicOverlay | null> {
  if (!isUuid(organizationId) || !isUuid(competitionId)) return null;
  const sql = getSqlClient();
  return sql.begin("isolation level repeatable read read only", async tx => {
    if (!(await isCompetitionPublic(tx, organizationId, competitionId))) return null;
    const [competition] = await tx<{ title: string }[]>`SELECT title FROM competitions WHERE organization_id = ${organizationId} AND id = ${competitionId}`;
    const [show] = await tx<{ state: PublicOverlay["show"]["state"]; broadcast_sequence: string }[]>`
      SELECT state, broadcast_sequence::text FROM show_controls WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}`;
    const lineup = await tx<{ id: string; status: string; display_name: string; label: string }[]>`
      SELECT p.id, p.status::text AS status, pt.display_name, r.label
      FROM performances p
      JOIN rounds r ON r.id = p.round_id AND r.organization_id = p.organization_id
      JOIN entries e ON e.id = p.entry_id AND e.organization_id = p.organization_id
      JOIN participants pt ON pt.id = e.participant_id AND pt.organization_id = e.organization_id
      WHERE p.organization_id = ${organizationId} AND p.competition_id = ${competitionId}
        AND (p.status = 'live' OR (p.status = 'queued' AND r.status IN ('scheduled', 'live')))
      ORDER BY (p.status = 'live') DESC, r.ordinal, p.ordinal LIMIT 2
    `;
    const live = lineup.find(row => row.status === "live") ?? null;
    const next = lineup.find(row => row.status === "queued") ?? null;
    const captions = await listActiveCaptions(organizationId, competitionId, tx);
    const lower = captions.find(c => c.kind === "lower_third");
    const caption = captions.find(c => c.kind === "caption");
    const timer = await publicTimer(tx, organizationId, competitionId, live?.id ?? null);
    return {
      competition: { title: competition!.title },
      show: { state: show?.state ?? "standby" },
      sequence: Number(show?.broadcast_sequence ?? 0),
      current: live ? { displayName: live.display_name, roundLabel: live.label } : null,
      next: next ? { displayName: next.display_name } : null,
      timer,
      lowerThird: lower ? { text: lower.text, subtitle: lower.subtitle } : null,
      caption: caption ? { text: caption.text } : null
    };
  }) as Promise<PublicOverlay | null>;
}

export interface PublicScoreboard {
  competition: { title: string };
  sequence: number;
  rounds: Array<{ label: string; ordinal: number; standings: Array<{ rank: number | null; displayName: string; score: string | null; final: boolean }> }>;
}

/** Standings only for rounds whose results the control room published; void results never appear. */
export async function getPublicScoreboard(organizationId: string, competitionId: string): Promise<PublicScoreboard | null> {
  if (!isUuid(organizationId) || !isUuid(competitionId)) return null;
  const sql = getSqlClient();
  return sql.begin("isolation level repeatable read read only", async tx => {
    if (!(await isCompetitionPublic(tx, organizationId, competitionId))) return null;
    const [competition] = await tx<{ title: string }[]>`SELECT title FROM competitions WHERE organization_id = ${organizationId} AND id = ${competitionId}`;
    const [show] = await tx<{ broadcast_sequence: string }[]>`SELECT broadcast_sequence::text FROM show_controls
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}`;
    const rows = await tx<{ round_id: string; label: string; ordinal: number; rank: number | null; display_name: string; score: string | null; status: string }[]>`
      SELECT r.id AS round_id, r.label, r.ordinal, res.rank, pt.display_name, res.score, res.status::text AS status
      FROM round_publications rp
      JOIN rounds r ON r.id = rp.round_id AND r.organization_id = rp.organization_id
      JOIN results res ON res.round_id = r.id AND res.organization_id = r.organization_id AND res.status <> 'void'
      JOIN entries e ON e.id = res.entry_id AND e.organization_id = res.organization_id
      JOIN participants pt ON pt.id = e.participant_id AND pt.organization_id = e.organization_id
      WHERE rp.organization_id = ${organizationId} AND rp.competition_id = ${competitionId} AND rp.results_published
      ORDER BY r.ordinal, res.rank NULLS LAST, pt.display_name
      LIMIT 2000
    `;
    const rounds = new Map<string, PublicScoreboard["rounds"][number]>();
    for (const row of rows) {
      let round = rounds.get(row.round_id);
      if (!round) {
        round = { label: row.label, ordinal: row.ordinal, standings: [] };
        rounds.set(row.round_id, round);
      }
      round.standings.push({ rank: row.rank, displayName: row.display_name, score: row.score, final: row.status === "final" });
    }
    return { competition: { title: competition!.title }, sequence: Number(show?.broadcast_sequence ?? 0), rounds: [...rounds.values()] };
  }) as Promise<PublicScoreboard | null>;
}
