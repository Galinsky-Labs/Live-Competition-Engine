import { randomBytes } from "node:crypto";
import {
  assertVoteAllowed, detectAnomalies, DomainError, GENESIS, networkKey, parseContestConfig, verifyChain, voteHash, voterKey,
  voteWindowInputSchema, windowState, type WindowStatus
} from "@live-competition-engine/engine";
import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import { getSqlClient } from "./index.ts";
import { recordAudit } from "./audit.ts";
import { lockEvent } from "./events.ts";
import { evaluateStoredFeature } from "./feature-flags.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AUDIENCE_CONSENT_VERSION = "audience-v1";

/** Fails closed unless the hierarchical feature flag (LC-08) enables the family for this event. */
export async function requireFeatureOn(feature: "chat" | "voting", organizationId: string, eventId: string) {
  const decision = await evaluateStoredFeature(feature, { organizationId, eventId });
  if (!decision.enabled) throw new DomainError(403, `${feature}_disabled`);
}

async function requireConsent(organizationId: string, eventId: string, accountId: string, consent: unknown) {
  const sql = getSqlClient();
  const [existing] = await sql`SELECT 1 FROM audience_consents WHERE competition_id = ${eventId} AND account_id = ${accountId}`;
  if (existing) return;
  if (consent !== true) throw new DomainError(428, "audience_consent_required");
  await sql`INSERT INTO audience_consents (organization_id, competition_id, account_id, consent_version) VALUES (${organizationId}, ${eventId}, ${accountId}, ${AUDIENCE_CONSENT_VERSION}) ON CONFLICT DO NOTHING`;
}

async function publicLiveEvent(organizationId: string, eventId: string) {
  const sql = getSqlClient();
  const [event] = await sql<{ status: string; config: Record<string, unknown> }[]>`SELECT status::text AS status, config FROM competitions WHERE organization_id = ${organizationId} AND id = ${eventId}`;
  if (!event || event.status === "draft") throw new DomainError(404, "event_not_found");
  return { status: event.status, config: parseContestConfig(event.config) };
}

/* ---------- LC-27 audience interaction ---------- */

export async function react(organizationId: string, eventId: string, accountId: string, reaction: unknown, performanceId?: unknown, consent?: unknown) {
  const event = await publicLiveEvent(organizationId, eventId);
  if (event.status !== "live") throw new DomainError(409, "event_not_live");
  if (typeof reaction !== "string" || !event.config.audience.reactions.includes(reaction)) throw new DomainError(400, "reaction_not_allowed");
  await requireConsent(organizationId, eventId, accountId, consent);
  const perf = typeof performanceId === "string" && uuid.test(performanceId) ? performanceId : null;
  return getSqlClient().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`react:${accountId}`}))`;
    const [recent] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM audience_reactions WHERE account_id = ${accountId} AND created_at > now() - interval '60 seconds'`;
    if (recent!.n >= event.config.audience.reactionsPerMinute) throw new DomainError(429, "rate_limited");
    await tx`INSERT INTO audience_reactions (organization_id, competition_id, performance_id, account_id, reaction) VALUES (${organizationId}, ${eventId}, ${perf}, ${accountId}, ${reaction})`;
    return { ok: true };
  });
}

export async function reactionCounts(organizationId: string, eventId: string, performanceId?: string) {
  const sql = getSqlClient();
  const rows = await sql<{ reaction: string; n: number }[]>`
    SELECT reaction, count(*)::int AS n FROM audience_reactions WHERE organization_id = ${organizationId} AND competition_id = ${eventId}
      ${performanceId ? sql`AND performance_id = ${performanceId}` : sql``} GROUP BY reaction`;
  return Object.fromEntries(rows.map(r => [r.reaction, r.n]));
}

export async function postAudienceMessage(organizationId: string, eventId: string, accountId: string, kind: unknown, body: unknown, consent?: unknown) {
  await requireFeatureOn("chat", organizationId, eventId);
  const event = await publicLiveEvent(organizationId, eventId);
  if (kind !== "chat" && kind !== "question") throw new DomainError(400, "invalid_kind");
  if (kind === "question" && !event.config.audience.questions) throw new DomainError(409, "questions_disabled");
  if (typeof body !== "string" || !body.trim() || body.length > 500) throw new DomainError(400, "invalid_body");
  await requireConsent(organizationId, eventId, accountId, consent);
  return getSqlClient().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`msg:${accountId}`}))`;
    const [recent] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM audience_messages WHERE account_id = ${accountId} AND created_at > now() - interval '60 seconds'`;
    if (recent!.n >= 5) throw new DomainError(429, "rate_limited");
    const [row] = await tx<{ id: string }[]>`INSERT INTO audience_messages (organization_id, competition_id, account_id, kind, body) VALUES (${organizationId}, ${eventId}, ${accountId}, ${kind}, ${body.trim()}) RETURNING id`;
    return { id: Number(row!.id), status: "pending" };
  });
}

/** Approved messages for everyone; producers also see pending and hidden ones. Author ids are never exposed publicly. */
export async function listAudienceMessages(organizationId: string, eventId: string, producer: boolean) {
  const sql = getSqlClient();
  const rows = await sql<{ id: string; kind: string; body: string; status: string; created_at: Date }[]>`
    SELECT id, kind, body, status, created_at FROM audience_messages WHERE organization_id = ${organizationId} AND competition_id = ${eventId}
      ${producer ? sql`` : sql`AND status = 'approved'`} ORDER BY id DESC LIMIT 200`;
  return rows.map(r => ({ id: Number(r.id), kind: r.kind, body: r.body, status: r.status, createdAt: r.created_at }));
}

export async function moderateAudienceMessage(organizationId: string, eventId: string, actorAccountId: string, messageId: unknown, status: unknown) {
  if (status !== "approved" && status !== "hidden") throw new DomainError(400, "invalid_status");
  const id = Number(messageId);
  if (!Number.isSafeInteger(id)) throw new DomainError(400, "invalid_message_id");
  return getSqlClient().begin(async tx => {
    const [row] = await tx<{ id: string }[]>`UPDATE audience_messages SET status = ${status}, moderated_by_account_id = ${actorAccountId}, moderated_at = now()
      WHERE organization_id = ${organizationId} AND competition_id = ${eventId} AND id = ${id} RETURNING id`;
    if (!row) throw new DomainError(404, "message_not_found");
    await recordAudit(tx, { organizationId, actorAccountId, action: `audience.message_${status}`, subjectType: "audience_message", subjectId: String(id) });
    return { id, status };
  });
}

export async function createPoll(organizationId: string, eventId: string, actorAccountId: string, question: unknown, options: unknown) {
  if (typeof question !== "string" || !question.trim() || question.length > 300) throw new DomainError(400, "invalid_question");
  if (!Array.isArray(options) || options.length < 2 || options.length > 10 || options.some(o => typeof o !== "string" || !o.trim() || o.length > 100)) throw new DomainError(400, "invalid_options");
  await requireFeatureOn("chat", organizationId, eventId);
  return getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const [row] = await tx<{ id: string }[]>`INSERT INTO audience_polls (organization_id, competition_id, question, options, created_by_account_id)
      VALUES (${organizationId}, ${eventId}, ${question.trim()}, ${tx.json(options.map(o => (o as string).trim()))}, ${actorAccountId}) RETURNING id`;
    await recordAudit(tx, { organizationId, actorAccountId, action: "audience.poll_created", subjectType: "poll", subjectId: row!.id });
    return { id: row!.id };
  });
}

export async function answerPoll(organizationId: string, eventId: string, accountId: string, pollId: unknown, optionIndex: unknown, consent?: unknown) {
  if (typeof pollId !== "string" || !uuid.test(pollId)) throw new DomainError(400, "invalid_poll_id");
  await requireConsent(organizationId, eventId, accountId, consent);
  const sql = getSqlClient();
  const [poll] = await sql<{ options: string[]; status: string }[]>`SELECT options, status FROM audience_polls WHERE organization_id = ${organizationId} AND competition_id = ${eventId} AND id = ${pollId}`;
  if (!poll) throw new DomainError(404, "poll_not_found");
  if (poll.status !== "open") throw new DomainError(409, "poll_closed");
  if (typeof optionIndex !== "number" || !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) throw new DomainError(400, "invalid_option");
  const rows = await sql`INSERT INTO audience_poll_answers (poll_id, account_id, option_index) VALUES (${pollId}, ${accountId}, ${optionIndex}) ON CONFLICT DO NOTHING RETURNING poll_id`;
  if (!rows.length) throw new DomainError(409, "already_answered");
  return { ok: true };
}

export async function listPolls(organizationId: string, eventId: string) {
  const sql = getSqlClient();
  const polls = await sql<{ id: string; question: string; options: string[]; status: string }[]>`
    SELECT id, question, options, status FROM audience_polls WHERE organization_id = ${organizationId} AND competition_id = ${eventId} ORDER BY created_at DESC`;
  const counts = polls.length ? await sql<{ poll_id: string; option_index: number; n: number }[]>`
    SELECT poll_id, option_index, count(*)::int AS n FROM audience_poll_answers WHERE poll_id IN ${sql(polls.map(p => p.id))} GROUP BY poll_id, option_index` : [];
  return polls.map(p => ({ ...p, counts: p.options.map((_, i) => counts.find(c => c.poll_id === p.id && c.option_index === i)?.n ?? 0) }));
}

export async function closePoll(organizationId: string, eventId: string, actorAccountId: string, pollId: string) {
  const rows = await getSqlClient()`UPDATE audience_polls SET status = 'closed' WHERE organization_id = ${organizationId} AND competition_id = ${eventId} AND id = ${pollId} RETURNING id`;
  if (!rows.length) throw new DomainError(404, "poll_not_found");
  await recordAudit(getSqlClient(), { organizationId, actorAccountId, action: "audience.poll_closed", subjectType: "poll", subjectId: pollId });
  return { id: pollId, status: "closed" };
}

/* ---------- LC-28 voting ---------- */

interface WindowRow { id: string; competition_id: string; round_id: string | null; matchup_id: string | null; title: string; options: string[]; eligibility: string; max_votes_per_voter: number; max_votes_per_ip: number | null; member_weight: string; visibility: string; status: WindowStatus; opens_at: Date | null; closes_at: Date | null; secret: string; closed_digest: string | null; revision: number }
const publicWindow = (w: WindowRow) => ({ id: w.id, stageId: w.round_id, matchupId: w.matchup_id, title: w.title, options: w.options, eligibility: w.eligibility, maxVotesPerVoter: w.max_votes_per_voter, visibility: w.visibility, status: w.status, opensAt: w.opens_at, closesAt: w.closes_at, closedDigest: w.closed_digest, revision: w.revision });

export async function createVoteWindow(organizationId: string, eventId: string, actorAccountId: string, input: unknown) {
  const data = voteWindowInputSchema.parse(input);
  await requireFeatureOn("voting", organizationId, eventId);
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    if (event.status === "completed" || event.status === "cancelled") throw new DomainError(409, "event_closed");
    let options = data.options ?? [];
    if (data.matchupId) {
      const [m] = await tx<{ entry_a_id: string | null; entry_b_id: string | null; round_id: string }[]>`SELECT entry_a_id, entry_b_id, round_id FROM matchups WHERE competition_id = ${eventId} AND id = ${data.matchupId}`;
      if (!m?.entry_a_id || !m.entry_b_id) throw new DomainError(409, "matchup_not_ready");
      options = [m.entry_a_id, m.entry_b_id];
    } else if (data.stageId && !options.length) {
      options = (await tx<{ entry_id: string }[]>`SELECT entry_id FROM performances WHERE competition_id = ${eventId} AND round_id = ${data.stageId} AND status <> 'skipped' ORDER BY ordinal`).map(r => r.entry_id);
    }
    if (options.length < 2) throw new DomainError(400, "vote_needs_two_options");
    const valid = await tx<{ id: string }[]>`SELECT id FROM entries WHERE competition_id = ${eventId} AND status = 'approved' AND id IN ${tx(options)}`;
    if (valid.length !== new Set(options).size) throw new DomainError(400, "invalid_vote_option");
    const [row] = await tx<WindowRow[]>`
      INSERT INTO vote_windows (organization_id, competition_id, round_id, matchup_id, title, options, eligibility, max_votes_per_voter, max_votes_per_ip, member_weight, visibility, opens_at, closes_at, secret, created_by_account_id)
      VALUES (${organizationId}, ${eventId}, ${data.stageId ?? null}, ${data.matchupId ?? null}, ${data.title}, ${options}, ${data.eligibility}, ${data.maxVotesPerVoter}, ${data.maxVotesPerIp}, ${data.memberWeight},
        ${data.visibility}, ${data.opensAt ?? null}, ${data.closesAt ?? null}, ${randomBytes(32).toString("hex")}, ${actorAccountId})
      RETURNING *`;
    await recordAudit(tx, { organizationId, actorAccountId, action: "voting.window_created", subjectType: "vote_window", subjectId: row!.id, details: { options: options.length } });
    return publicWindow(row!);
  });
}

async function lockWindow(tx: TransactionSql, organizationId: string, eventId: string, windowId: unknown) {
  if (typeof windowId !== "string" || !uuid.test(windowId)) throw new DomainError(400, "invalid_window_id");
  const [w] = await tx<WindowRow[]>`SELECT * FROM vote_windows WHERE organization_id = ${organizationId} AND competition_id = ${eventId} AND id = ${windowId} FOR UPDATE`;
  if (!w) throw new DomainError(404, "vote_window_not_found");
  return w;
}

const tallyDigest = (windowId: string, tally: Array<{ entryId: string; votes: number; weighted: number }>, head: string) =>
  createHash("sha256").update(JSON.stringify({ windowId, head, tally: [...tally].sort((a, b) => a.entryId.localeCompare(b.entryId)) })).digest("hex");

export async function setVoteWindowStatus(organizationId: string, eventId: string, actorAccountId: string, windowId: unknown, to: unknown, expectedRevision: unknown) {
  if (to !== "open" && to !== "closed") throw new DomainError(400, "invalid_window_status");
  return getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const w = await lockWindow(tx, organizationId, eventId, windowId);
    if (w.revision !== expectedRevision) throw new DomainError(409, "revision_conflict");
    if (w.status === "closed" || (to === "open" && w.status !== "scheduled")) throw new DomainError(409, "invalid_window_transition");
    let digest: string | null = null;
    if (to === "closed") {
      const t = await tallyTx(tx, w);
      digest = tallyDigest(w.id, t.tally, t.head);
    }
    const [row] = await tx<WindowRow[]>`UPDATE vote_windows SET status = ${to}, closed_digest = ${digest}, revision = revision + 1,
      opens_at = COALESCE(opens_at, CASE WHEN ${to} = 'open' THEN now() END), closes_at = CASE WHEN ${to} = 'closed' THEN LEAST(COALESCE(closes_at, now()), now()) ELSE closes_at END
      WHERE id = ${w.id} RETURNING *`;
    await recordAudit(tx, { organizationId, actorAccountId, action: `voting.window_${to}`, subjectType: "vote_window", subjectId: w.id, details: digest ? { digest } : {} });
    return publicWindow(row!);
  });
}

/** Casts one vote. The account id never reaches the votes table: only a per-window keyed hash does. */
export async function castVote(organizationId: string, eventId: string, accountId: string, windowId: unknown, entryId: unknown, network: { ip: string | null; daySecret: string }, now = new Date()) {
  await requireFeatureOn("voting", organizationId, eventId);
  return getSqlClient().begin(async tx => {
    const w = await lockWindow(tx, organizationId, eventId, windowId);
    let weight = 1;
    const [member] = await tx`SELECT 1 FROM organization_memberships WHERE organization_id = ${organizationId} AND account_id = ${accountId} AND status = 'active' AND suspended_at IS NULL`;
    if (w.eligibility === "tenant_members" && !member) throw new DomainError(403, "not_eligible_to_vote");
    if (w.eligibility === "entitled") {
      const [grant] = await tx`SELECT 1 FROM entitlement_grants WHERE organization_id = ${organizationId} AND account_id = ${accountId} AND (event_id = ${eventId} OR event_id IS NULL)
        AND capability IN ('event.view', 'event.enter') AND status = 'active' AND starts_at <= ${now.getTime()} AND (expires_at IS NULL OR expires_at > ${now.getTime()})`;
      if (!grant) throw new DomainError(403, "not_eligible_to_vote");
    }
    if (member) weight = Number(w.member_weight);
    const voter = voterKey(w.secret, accountId);
    const ipHash = network.ip ? networkKey(network.daySecret, network.ip) : null;
    const [counts] = await tx<{ by_voter: number; by_network: number }[]>`
      SELECT count(*) FILTER (WHERE voter_hash = ${voter})::int AS by_voter, count(*) FILTER (WHERE ${ipHash}::text IS NOT NULL AND ip_hash = ${ipHash})::int AS by_network
      FROM votes WHERE window_id = ${w.id}`;
    assertVoteAllowed({ state: windowState({ status: w.status, opensAt: w.opens_at, closesAt: w.closes_at }, now), validOption: typeof entryId === "string" && w.options.includes(entryId),
      votesByVoter: counts!.by_voter, maxVotesPerVoter: w.max_votes_per_voter, votesByNetwork: counts!.by_network, maxVotesPerIp: w.max_votes_per_ip });
    const [account] = await tx<{ created_at: Date }[]>`SELECT created_at FROM accounts WHERE id = ${accountId}`;
    const newAccount = now.getTime() - account!.created_at.getTime() < 24 * 3600_000;
    const [last] = await tx<{ row_hash: string }[]>`SELECT row_hash FROM votes WHERE window_id = ${w.id} ORDER BY id DESC LIMIT 1`;
    const castAt = now.toISOString();
    const link = { windowId: w.id, voterHash: voter, entryId: entryId as string, weight: weight.toFixed(2), castAt, prevHash: last?.row_hash ?? GENESIS };
    const rowHash = voteHash(link);
    try {
      await tx`INSERT INTO votes (window_id, voter_hash, entry_id, weight, ip_hash, new_account, cast_at, prev_hash, row_hash)
        VALUES (${w.id}, ${voter}, ${link.entryId}, ${link.weight}, ${ipHash}, ${newAccount}, ${castAt}, ${link.prevHash}, ${rowHash})`;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new DomainError(409, "already_voted_for_option");
      throw error;
    }
    return { receipt: rowHash };
  });
}

async function tallyTx(tx: TransactionSql, w: WindowRow) {
  const rows = await tx<{ entry_id: string; votes: number; weighted: string }[]>`
    SELECT v.entry_id, count(*)::int AS votes, COALESCE(sum(v.weight), 0)::text AS weighted FROM votes v
    WHERE v.window_id = ${w.id} AND NOT EXISTS (SELECT 1 FROM vote_voids x WHERE x.vote_id = v.id) GROUP BY v.entry_id`;
  const [head] = await tx<{ row_hash: string }[]>`SELECT row_hash FROM votes WHERE window_id = ${w.id} ORDER BY id DESC LIMIT 1`;
  const tally = w.options.map(entryId => {
    const r = rows.find(x => x.entry_id === entryId);
    return { entryId, votes: r?.votes ?? 0, weighted: Number(r?.weighted ?? 0) };
  });
  return { tally, head: head?.row_hash ?? GENESIS };
}

/** Results respect window visibility: live, after close, or hidden until producers publish results. */
export async function voteResults(organizationId: string, eventId: string, windowId: unknown, producer: boolean) {
  const sql = getSqlClient();
  return sql.begin(async tx => {
    const w = await lockWindow(tx, organizationId, eventId, windowId);
    const visible = producer || w.visibility === "live" || (w.visibility === "after_close" && w.status === "closed");
    if (!visible) return { window: publicWindow(w), tally: null };
    const t = await tallyTx(tx, w);
    return { window: publicWindow(w), tally: t.tally, chainHead: t.head };
  });
}

export async function listVoteWindows(organizationId: string, eventId: string) {
  const rows = await getSqlClient()<WindowRow[]>`SELECT * FROM vote_windows WHERE organization_id = ${organizationId} AND competition_id = ${eventId} ORDER BY created_at`;
  return rows.map(publicWindow);
}

/* ---------- LC-29 integrity ---------- */

export async function auditVoteWindow(organizationId: string, eventId: string, windowId: unknown) {
  const sql = getSqlClient();
  return sql.begin(async tx => {
    const w = await lockWindow(tx, organizationId, eventId, windowId);
    const votes = await tx<{ id: string; voter_hash: string; entry_id: string; weight: string; cast_at: Date; prev_hash: string; row_hash: string; ip_hash: string | null; new_account: boolean }[]>`
      SELECT id, voter_hash, entry_id, weight::text AS weight, cast_at, prev_hash, row_hash, ip_hash, new_account FROM votes WHERE window_id = ${w.id} ORDER BY id`;
    const broken = verifyChain(votes.map(v => ({ windowId: w.id, voterHash: v.voter_hash, entryId: v.entry_id, weight: Number(v.weight).toFixed(2), castAt: v.cast_at.toISOString(), prevHash: v.prev_hash, rowHash: v.row_hash })));
    const voids = await tx<{ vote_id: string; reason: string }[]>`SELECT vote_id, reason FROM vote_voids WHERE window_id = ${w.id}`;
    const t = await tallyTx(tx, w);
    const digest = tallyDigest(w.id, t.tally, t.head);
    return {
      chainIntact: broken === -1, firstBrokenIndex: broken, voteCount: votes.length, voidCount: voids.length,
      anomalies: detectAnomalies(votes.map(v => ({ castAt: v.cast_at, ipHash: v.ip_hash, newAccount: v.new_account }))),
      tally: t.tally, digest, closedDigest: w.closed_digest, digestMatchesClose: w.closed_digest === null ? null : w.closed_digest === digest
    };
  });
}

/** Voids votes sharing a network fingerprint (e.g. after an anomaly review). Votes stay; voids are recorded with a reason. */
export async function voidVotesByNetwork(organizationId: string, eventId: string, actorAccountId: string, windowId: unknown, ipHash: unknown, reason: unknown) {
  if (typeof ipHash !== "string" || !/^[0-9a-f]{64}$/.test(ipHash)) throw new DomainError(400, "invalid_network_hash");
  if (typeof reason !== "string" || reason.trim().length < 3) throw new DomainError(400, "reason_required");
  return getSqlClient().begin(async tx => {
    const w = await lockWindow(tx, organizationId, eventId, windowId);
    if (w.status === "closed") throw new DomainError(409, "window_closed");
    const rows = await tx`INSERT INTO vote_voids (window_id, vote_id, reason, voided_by_account_id)
      SELECT ${w.id}, v.id, ${reason.trim()}, ${actorAccountId} FROM votes v WHERE v.window_id = ${w.id} AND v.ip_hash = ${ipHash}
      ON CONFLICT (vote_id) DO NOTHING RETURNING id`;
    await recordAudit(tx, { organizationId, actorAccountId, action: "voting.votes_voided", subjectType: "vote_window", subjectId: w.id, details: { count: rows.length, reason } });
    return { voided: rows.length };
  });
}

/** Audience share per entry (0–100) across closed windows of a stage; used by LC-20 scoring when audienceWeight > 0. */
export async function stageAudienceShares(organizationId: string, eventId: string, stageId: string): Promise<Map<string, number>> {
  const sql = getSqlClient();
  const rows = await sql<{ entry_id: string; weighted: string }[]>`
    SELECT v.entry_id, sum(v.weight)::text AS weighted FROM votes v JOIN vote_windows w ON w.id = v.window_id
    WHERE w.organization_id = ${organizationId} AND w.competition_id = ${eventId} AND w.round_id = ${stageId} AND w.status = 'closed'
      AND NOT EXISTS (SELECT 1 FROM vote_voids x WHERE x.vote_id = v.id) GROUP BY v.entry_id`;
  const total = rows.reduce((a, r) => a + Number(r.weighted), 0);
  return new Map(rows.map(r => [r.entry_id, total ? (Number(r.weighted) / total) * 100 : 0]));
}
