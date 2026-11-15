import { randomBytes } from "node:crypto";
import { EntitlementService } from "@live-competition-engine/auth/entitlements";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  VOTING_LIMITS,
  ballotCommitment,
  ballotWeight,
  canonicalChoiceJson,
  canViewVoteResults,
  evaluateEligibility,
  nextWindowStatus,
  validateBallotChoice,
  validateVoteWindow,
  voteWindowPhase,
  type BallotType,
  type EligibilityRule,
  type ResultVisibility,
  type VoteRules,
  type WeightingRule,
  type WindowPhase,
  type WindowStatus
} from "@live-competition-engine/domain/voting";
import { tallyBallots, type CanonicalChoice, type TallyMethod, type TallyResult } from "@live-competition-engine/domain/voting-tally";
import { ensureActiveMember, ensureCompetition, requireAudienceConsent } from "./audience.ts";
import { recordAudit, type Sql } from "./audit.ts";
import { PostgresEntitlementStore } from "./entitlements.ts";
import { requireEnabledFeature } from "./feature-guard.ts";
import { getSqlClient } from "./index.ts";
import { consumeRateLimit, type RateLimitRule } from "./rate-limit.ts";
import { writeTallySnapshot, type TallySnapshot } from "./vote-snapshots.ts";

/** Per-account ballot submission limit (abuse control; see LC-29 docs). */
export const ballotRateLimit: RateLimitRule = { limit: 10, windowMs: 60_000, mode: "fixed" };

export interface VoteOptionView {
  id: string;
  ordinal: number;
  entryId: string;
  performanceId: string | null;
  label: string;
}

export interface VoteWindowView {
  id: string;
  competitionId: string;
  roundId: string | null;
  label: string;
  status: WindowStatus;
  phase: WindowPhase;
  opensAt: Date;
  closesAt: Date;
  closedAt: Date | null;
  revision: number;
  rules: VoteRules;
  options: VoteOptionView[];
}

export interface WindowRow {
  id: string;
  organization_id: string;
  competition_id: string;
  round_id: string | null;
  label: string;
  status: WindowStatus;
  opens_at: Date;
  closes_at: Date;
  closed_at: Date | null;
  ballot_type: BallotType;
  tally_method: TallyMethod;
  eligibility: EligibilityRule;
  exclude_participants: boolean;
  weighting: WeightingRule;
  verified_weight: number;
  max_points: number | null;
  max_selections: number | null;
  result_visibility: ResultVisibility;
  allow_change: boolean;
  revision: number;
}

export interface Viewer {
  isManager: boolean;
  accountId?: string;
  now?: Date;
}

export const rulesOf = (row: WindowRow): VoteRules => ({
  ballotType: row.ballot_type,
  tallyMethod: row.tally_method,
  eligibility: row.eligibility,
  excludeParticipants: row.exclude_participants,
  weighting: row.weighting,
  verifiedWeight: row.verified_weight,
  maxPoints: row.max_points,
  maxSelections: row.max_selections,
  resultVisibility: row.result_visibility,
  allowChange: row.allow_change
});

/** Load a window in the tenant + competition, optionally locking it. Drafts are hidden from non-managers. */
export async function loadWindow(
  sql: Sql,
  organizationId: string,
  competitionId: string,
  windowId: string,
  lock: "none" | "share" | "update" = "none",
  includeDraft = true
): Promise<WindowRow> {
  if (!isUuid(windowId)) throw new DomainError("vote_window_not_found");
  const [row] = await sql<WindowRow[]>`
    SELECT id, organization_id, competition_id, round_id, label, status, opens_at, closes_at, closed_at,
      ballot_type, tally_method, eligibility, exclude_participants, weighting, verified_weight,
      max_points, max_selections, result_visibility, allow_change, revision
    FROM vote_windows
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${windowId}
    ${lock === "share" ? sql`FOR SHARE` : lock === "update" ? sql`FOR UPDATE` : sql``}
  `;
  if (!row || (!includeDraft && row.status === "draft")) throw new DomainError("vote_window_not_found");
  return row;
}

export async function loadOptions(sql: Sql, organizationId: string, windowId: string): Promise<VoteOptionView[]> {
  const rows = await sql<{ id: string; ordinal: number; entry_id: string; performance_id: string | null; label: string }[]>`
    SELECT id, ordinal, entry_id, performance_id, label FROM vote_window_options
    WHERE organization_id = ${organizationId} AND window_id = ${windowId} ORDER BY ordinal
  `;
  return rows.map(row => ({ id: row.id, ordinal: row.ordinal, entryId: row.entry_id, performanceId: row.performance_id, label: row.label }));
}

export async function loadActiveBallots(sql: Sql, organizationId: string, windowId: string) {
  return sql<{ id: string; receipt: string; choice: CanonicalChoice; weight: number; salt: string; commitment: string; account_id: string; created_at: Date }[]>`
    SELECT id, receipt, choice, weight, salt, commitment, account_id, created_at FROM vote_ballots
    WHERE organization_id = ${organizationId} AND window_id = ${windowId} AND status = 'active'
    ORDER BY commitment
  `;
}

const view = (row: WindowRow, options: VoteOptionView[], now: Date): VoteWindowView => ({
  id: row.id,
  competitionId: row.competition_id,
  roundId: row.round_id,
  label: row.label,
  status: row.status,
  phase: voteWindowPhase(row.status, row.opens_at, row.closes_at, now),
  opensAt: row.opens_at,
  closesAt: row.closes_at,
  closedAt: row.closed_at,
  revision: row.revision,
  rules: rulesOf(row),
  options
});

async function managerPreflight(organizationId: string, competitionId: string) {
  await ensureCompetition(getSqlClient(), organizationId, competitionId);
  await requireEnabledFeature("voting", { organizationId, eventId: competitionId });
}

export async function createVoteWindow(
  organizationId: string,
  competitionId: string,
  actorAccountId: string,
  input: Record<string, unknown>
): Promise<VoteWindowView> {
  const definition = validateVoteWindow(input);
  await managerPreflight(organizationId, competitionId);
  const windowId = await getSqlClient().begin(async tx => {
    if (definition.roundId) {
      const round = await tx`SELECT 1 FROM rounds WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${definition.roundId}`;
      if (round.length !== 1) throw new DomainError("round_not_found");
    }
    for (const option of definition.options) {
      const entry = await tx`SELECT 1 FROM entries WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${option.entryId}`;
      if (entry.length !== 1) throw new DomainError("entry_not_found");
      if (option.performanceId) {
        const performance = await tx`
          SELECT 1 FROM performances WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
            AND id = ${option.performanceId} AND entry_id = ${option.entryId}
            ${definition.roundId ? tx`AND round_id = ${definition.roundId}` : tx``}
        `;
        if (performance.length !== 1) throw new DomainError("performance_not_found");
      }
    }
    const rules = definition.rules;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO vote_windows (organization_id, competition_id, round_id, label, opens_at, closes_at, ballot_type, tally_method,
        eligibility, exclude_participants, weighting, verified_weight, max_points, max_selections, result_visibility,
        allow_change, created_by_account_id)
      VALUES (${organizationId}, ${competitionId}, ${definition.roundId}, ${definition.label}, ${definition.opensAt}, ${definition.closesAt},
        ${rules.ballotType}, ${rules.tallyMethod}, ${rules.eligibility}, ${rules.excludeParticipants}, ${rules.weighting},
        ${rules.verifiedWeight}, ${rules.maxPoints}, ${rules.maxSelections}, ${rules.resultVisibility}, ${rules.allowChange}, ${actorAccountId})
      RETURNING id
    `;
    for (const [index, option] of definition.options.entries()) {
      await tx`
        INSERT INTO vote_window_options (organization_id, competition_id, window_id, ordinal, entry_id, performance_id, label)
        VALUES (${organizationId}, ${competitionId}, ${row!.id}, ${index + 1}, ${option.entryId}, ${option.performanceId}, ${option.label})
      `;
    }
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "voting.window_created", subjectType: "vote_window", subjectId: row!.id,
      details: { competitionId, roundId: definition.roundId, opensAt: definition.opensAt.toISOString(), closesAt: definition.closesAt.toISOString(), rules: { ...rules }, optionCount: definition.options.length }
    });
    return row!.id;
  });
  return getVoteWindow(organizationId, competitionId, windowId, { isManager: true });
}

/** publish (draft → published) or cancel (draft|published → cancelled), guarded by revision. */
export async function transitionVoteWindow(
  organizationId: string,
  competitionId: string,
  windowId: string,
  actorAccountId: string,
  action: unknown,
  expectedRevision: unknown,
  now: Date = new Date()
): Promise<VoteWindowView> {
  if (action !== "publish" && action !== "cancel") throw new DomainError("invalid_action");
  if (!Number.isInteger(expectedRevision)) throw new DomainError("invalid_revision");
  await managerPreflight(organizationId, competitionId);
  await getSqlClient().begin(async tx => {
    const row = await loadWindow(tx, organizationId, competitionId, windowId, "update");
    if (row.revision !== expectedRevision) throw new DomainError("revision_conflict");
    const next = nextWindowStatus(row.status, action, voteWindowPhase(row.status, row.opens_at, row.closes_at, now));
    if (action === "publish" && row.closes_at.getTime() <= now.getTime()) throw new DomainError("invalid_schedule");
    await tx`UPDATE vote_windows SET status = ${next}, revision = revision + 1 WHERE organization_id = ${organizationId} AND id = ${windowId}`;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: action === "publish" ? "voting.window_published" : "voting.window_cancelled",
      subjectType: "vote_window", subjectId: windowId, details: { competitionId, from: row.status, to: next }
    });
  });
  return getVoteWindow(organizationId, competitionId, windowId, { isManager: true, now });
}

/**
 * Close a published window (early, or after its scheduled close) and write the
 * version-1 tally snapshot with its Merkle root in the same transaction.
 * Ballots take a FOR SHARE lock on the window, so none can commit after the close.
 */
export async function closeVoteWindow(
  organizationId: string,
  competitionId: string,
  windowId: string,
  actorAccountId: string,
  now: Date = new Date()
): Promise<{ window: VoteWindowView; snapshot: TallySnapshot }> {
  await managerPreflight(organizationId, competitionId);
  const snapshot = await getSqlClient().begin(async tx => {
    const row = await loadWindow(tx, organizationId, competitionId, windowId, "update");
    nextWindowStatus(row.status, "close", voteWindowPhase(row.status, row.opens_at, row.closes_at, now));
    await tx`
      UPDATE vote_windows SET status = 'closed', closed_at = ${now}, closed_by_account_id = ${actorAccountId}, revision = revision + 1
      WHERE organization_id = ${organizationId} AND id = ${windowId}
    `;
    const written = await writeTallySnapshot(tx, { organizationId, windowId, method: row.tally_method, actorAccountId, reason: "close" });
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "voting.window_closed", subjectType: "vote_window", subjectId: windowId,
      details: { competitionId, early: now.getTime() < row.closes_at.getTime(), snapshotVersion: written.version, merkleRoot: written.merkleRoot, ballotCount: written.ballotCount }
    });
    return written;
  });
  return { window: await getVoteWindow(organizationId, competitionId, windowId, { isManager: true, now }), snapshot };
}

export async function listVoteWindows(organizationId: string, competitionId: string, viewer: Viewer): Promise<VoteWindowView[]> {
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  const now = viewer.now ?? new Date();
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM vote_windows WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
      ${viewer.isManager ? sql`` : sql`AND status <> 'draft'`}
    ORDER BY opens_at, id LIMIT 100
  `;
  const views: VoteWindowView[] = [];
  for (const row of rows) views.push(await getVoteWindow(organizationId, competitionId, row.id, { ...viewer, now }));
  return views;
}

export interface MyBallot {
  receipt: string;
  choice: CanonicalChoice;
  weight: number;
  createdAt: Date;
}

export async function getVoteWindow(
  organizationId: string,
  competitionId: string,
  windowId: string,
  viewer: Viewer
): Promise<VoteWindowView & { myBallot?: MyBallot | null }> {
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  const row = await loadWindow(sql, organizationId, competitionId, windowId, "none", viewer.isManager);
  const result: VoteWindowView & { myBallot?: MyBallot | null } = view(row, await loadOptions(sql, organizationId, windowId), viewer.now ?? new Date());
  if (viewer.accountId) {
    const [mine] = await sql<{ receipt: string; choice: CanonicalChoice; weight: number; created_at: Date }[]>`
      SELECT receipt, choice, weight, created_at FROM vote_ballots
      WHERE organization_id = ${organizationId} AND window_id = ${windowId} AND account_id = ${viewer.accountId} AND status = 'active'
    `;
    result.myBallot = mine ? { receipt: mine.receipt, choice: mine.choice, weight: mine.weight, createdAt: mine.created_at } : null;
  }
  return result;
}

export interface Voter {
  accountId: string;
  sessionId: string;
}

export interface BallotReceipt {
  ballotId: string;
  windowId: string;
  receipt: string;
  salt: string;
  commitment: string;
  weight: number;
  choice: CanonicalChoice;
  createdAt: Date;
  replayed: boolean;
}

async function hasEventViewEntitlement(organizationId: string, competitionId: string, voter: Voter, now: Date): Promise<boolean> {
  const store = new PostgresEntitlementStore();
  const decision = await new EntitlementService(store, store).resolve(
    { accountId: voter.accountId, sessionId: voter.sessionId, organizationId },
    { organizationId, eventId: competitionId, capability: "event.view" },
    now.getTime()
  );
  return decision.allowed;
}

/**
 * Submit (or, when the window allows it, change) a ballot. Idempotent per
 * (account, idempotencyKey): a retry with the same key and choice returns the
 * original receipt, even after the window closed; a different choice under the
 * same key is a conflict.
 */
export async function castBallot(
  organizationId: string,
  competitionId: string,
  windowId: string,
  voter: Voter,
  choiceInput: unknown,
  idempotencyKey: unknown,
  now: Date = new Date()
): Promise<BallotReceipt> {
  if (typeof idempotencyKey !== "string" || !VOTING_LIMITS.idempotencyKeyPattern.test(idempotencyKey)) throw new DomainError("invalid_idempotency_key");
  if (!isUuid(windowId)) throw new DomainError("vote_window_not_found");
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  await ensureActiveMember(sql, organizationId, voter.accountId);
  await requireEnabledFeature("voting", { organizationId, eventId: competitionId, accountId: voter.accountId });
  const preview = await loadWindow(sql, organizationId, competitionId, windowId, "none", false);
  const entitled = preview.eligibility === "entitled" ? await hasEventViewEntitlement(organizationId, competitionId, voter, now) : false;

  return sql.begin(async tx => {
    const row = await loadWindow(tx, organizationId, competitionId, windowId, "share", false);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`ballot:${windowId}:${voter.accountId}`}, 0))`;
    const options = await loadOptions(tx, organizationId, windowId);
    const rules = rulesOf(row);

    const [replay] = await tx<{ id: string; receipt: string; salt: string; commitment: string; weight: number; choice: CanonicalChoice; created_at: Date }[]>`
      SELECT id, receipt, salt, commitment, weight, choice, created_at FROM vote_ballots
      WHERE organization_id = ${organizationId} AND window_id = ${windowId} AND account_id = ${voter.accountId} AND idempotency_key = ${idempotencyKey}
    `;
    if (replay) {
      let same = false;
      try {
        same = canonicalChoiceJson(validateBallotChoice(rules, options.map(option => option.id), choiceInput)) === canonicalChoiceJson(replay.choice);
      } catch {
        same = false;
      }
      if (!same) throw new DomainError("idempotency_conflict");
      return { ballotId: replay.id, windowId, receipt: replay.receipt, salt: replay.salt, commitment: replay.commitment, weight: replay.weight, choice: replay.choice, createdAt: replay.created_at, replayed: true };
    }

    if (voteWindowPhase(row.status, row.opens_at, row.closes_at, now) !== "open") throw new DomainError("invalid_state_window_not_open");
    await requireAudienceConsent(tx, organizationId, competitionId, voter.accountId);
    const [facts] = await tx<{ status: string; created_at: Date; participant: boolean; verified: boolean }[]>`
      SELECT m.status, m.created_at,
        EXISTS (
          SELECT 1 FROM role_grants g
          WHERE g.account_id = m.account_id AND g.organization_id = m.organization_id AND g.competition_id = ${competitionId}
            AND g.role IN ('performer', 'judge') AND g.revoked_at IS NULL
        ) AS participant,
        EXISTS (SELECT 1 FROM account_identities i WHERE i.account_id = m.account_id AND i.verified_at IS NOT NULL) AS verified
      FROM organization_memberships m
      WHERE m.organization_id = ${organizationId} AND m.account_id = ${voter.accountId}
    `;
    const eligibility = evaluateEligibility(rules, {
      membershipActive: facts?.status === "active",
      membershipCreatedAt: facts?.created_at ?? now,
      windowOpensAt: row.opens_at,
      hasEventViewEntitlement: entitled,
      isEntrantOrJudge: facts?.participant ?? false
    });
    if (!eligibility.eligible) throw new DomainError("voter_not_eligible", eligibility.reason);
    const choice = validateBallotChoice(rules, options.map(option => option.id), choiceInput);

    const prior = await tx<{ id: string; status: string }[]>`
      SELECT id, status FROM vote_ballots
      WHERE organization_id = ${organizationId} AND window_id = ${windowId} AND account_id = ${voter.accountId} AND status IN ('active', 'voided')
    `;
    if (prior.some(ballot => ballot.status === "voided")) throw new DomainError("ballot_voided");
    const active = prior.find(ballot => ballot.status === "active");
    if (active && !rules.allowChange) throw new DomainError("vote_conflict");
    await consumeRateLimit(tx, { organizationId, accountId: voter.accountId, action: "voting.ballot" }, ballotRateLimit, now);
    if (active) {
      await tx`UPDATE vote_ballots SET status = 'superseded', superseded_at = ${now} WHERE organization_id = ${organizationId} AND id = ${active.id}`;
    }
    const weight = ballotWeight(rules, facts?.verified ?? false);
    const receipt = randomBytes(16).toString("base64url");
    const salt = randomBytes(32).toString("hex");
    const commitment = ballotCommitment(receipt, choice, weight, salt);
    const [ballot] = await tx<{ id: string; created_at: Date }[]>`
      INSERT INTO vote_ballots (organization_id, window_id, account_id, receipt, choice, weight, salt, commitment, idempotency_key, created_at)
      VALUES (${organizationId}, ${windowId}, ${voter.accountId}, ${receipt}, ${tx.json(choice as never)}, ${weight}, ${salt}, ${commitment}, ${idempotencyKey}, ${now})
      RETURNING id, created_at
    `;
    // The audit entry links actor and receipt only; the choice is never written to the log.
    await recordAudit(tx, {
      organizationId, actorAccountId: voter.accountId, action: active ? "voting.ballot_changed" : "voting.ballot_cast",
      subjectType: "vote_window", subjectId: windowId, details: { receipt, weight }
    });
    return { ballotId: ballot!.id, windowId, receipt, salt, commitment, weight, choice, createdAt: ballot!.created_at, replayed: false };
  });
}

export interface WindowTally {
  windowId: string;
  phase: WindowPhase;
  source: "live" | "snapshot";
  snapshotVersion: number | null;
  merkleRoot: string | null;
  tally: TallyResult;
  options: VoteOptionView[];
}

/** Pure helper used by results finalization: tally canonical ballots for a window's options. */
export function tallyWindow(method: TallyMethod, options: readonly VoteOptionView[], ballots: readonly { weight: number; choice: CanonicalChoice }[]): TallyResult {
  return tallyBallots(method, options.map(option => option.id), ballots.map(ballot => ({ weight: ballot.weight, choice: ballot.choice })));
}

/**
 * Results respecting the visibility rule. Closed windows report the latest
 * snapshot; open windows (live visibility or managers) are tallied on read.
 */
export async function getVoteResults(
  organizationId: string,
  competitionId: string,
  windowId: string,
  viewer: Viewer
): Promise<{ visible: false; phase: WindowPhase } | ({ visible: true } & WindowTally)> {
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  const row = await loadWindow(sql, organizationId, competitionId, windowId, "none", viewer.isManager);
  const phase = voteWindowPhase(row.status, row.opens_at, row.closes_at, viewer.now ?? new Date());
  if (!canViewVoteResults(row.result_visibility, phase, viewer.isManager)) return { visible: false, phase };
  return { visible: true, ...(await computeWindowTally(sql, row, phase)) };
}

async function computeWindowTally(sql: Sql, row: WindowRow, phase: WindowPhase): Promise<WindowTally> {
  const options = await loadOptions(sql, row.organization_id, row.id);
  if (row.status === "closed") {
    const [snapshot] = await sql<{ version: number; merkle_root: string; tally: TallyResult }[]>`
      SELECT version, merkle_root, tally FROM vote_tally_snapshots
      WHERE organization_id = ${row.organization_id} AND window_id = ${row.id} ORDER BY version DESC LIMIT 1
    `;
    if (snapshot) {
      return { windowId: row.id, phase, source: "snapshot", snapshotVersion: snapshot.version, merkleRoot: snapshot.merkle_root, tally: snapshot.tally, options };
    }
  }
  const ballots = await loadActiveBallots(sql, row.organization_id, row.id);
  return { windowId: row.id, phase, source: "live", snapshotVersion: null, merkleRoot: null, tally: tallyWindow(row.tally_method, options, ballots), options };
}

/**
 * Final tallies for results finalization (LC-30): only for closed windows,
 * always from the latest immutable snapshot version.
 */
export async function finalVoteTally(organizationId: string, competitionId: string, windowId: string): Promise<WindowTally> {
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  const row = await loadWindow(sql, organizationId, competitionId, windowId);
  if (row.status !== "closed") throw new DomainError("invalid_state_window_not_closed");
  const tally = await computeWindowTally(sql, row, "closed");
  if (tally.source !== "snapshot") throw new DomainError("invalid_state_snapshot_missing");
  return tally;
}
