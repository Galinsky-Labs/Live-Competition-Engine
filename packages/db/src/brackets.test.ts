import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { listAuditEvents } from "./audit.ts";
import { createAccount, createCompetition, createEntry, createTenant, enableFeature } from "./test-fixtures.ts";
import {
  actOnMatch,
  bracketWinnersForStage,
  createBracket,
  createMatch,
  createTeam,
  getBracket,
  getPublicBracket,
  listTeams,
  type BracketView
} from "./brackets.ts";
import { createStage, decideAdvancement } from "./stages.ts";

after(closeDatabaseConnection);

const key = () => `bracket-${randomUUID()}`;

async function setup(entrants: number) {
  const org = await createTenant();
  const actor = await createAccount(org);
  await enableFeature("brackets", org, actor);
  const competition = await createCompetition(org);
  const entries: string[] = [];
  for (let i = 0; i < entrants; i += 1) entries.push((await createEntry(org, competition, `Seed ${i + 1}`)).entryId);
  return { org, actor, competition, entries };
}

const match = (bracket: BracketView, round: number, position: number) =>
  bracket.matches.find(m => m.round === round && m.position === position)!;

async function play(org: string, competition: string, actor: string, matchId: string, winnerSlot: number) {
  const current = (await getBracket(org, competition, (await getSqlClient()<{ bracket_id: string }[]>`SELECT bracket_id FROM matches WHERE id = ${matchId}`)[0]!.bracket_id))!
    .matches.find(m => m.id === matchId)!;
  const live = await actOnMatch(org, competition, matchId, actor, { action: "start" }, current.revision);
  return actOnMatch(org, competition, matchId, actor, { action: "decide", winnerSlot }, live.revision);
}

test("seeded bracket with byes advances winners to the final and completes", async () => {
  const { org, actor, competition, entries } = await setup(3);
  const stage = await createStage(org, competition, actor, { label: "Knockout", kind: "final", timed: false, advancement: { type: "bracket" } });
  const idempotencyKey = key();
  const bracket = await createBracket(org, competition, actor, {
    stageId: stage.id, idempotencyKey, sides: entries.map((entryId, i) => ({ entryId, seed: i + 1 }))
  });
  assert.equal(bracket.size, 4);
  assert.equal(bracket.matches.length, 3);
  const bye = match(bracket, 1, 0);
  assert.equal(bye.bye, true);
  assert.equal(bye.status, "decided");
  assert.deepEqual(match(bracket, 2, 0).sides.map(side => side.seed), [1]);
  assert.equal((await createBracket(org, competition, actor, { stageId: stage.id, idempotencyKey, sides: [] })).replayed, true);

  // Seed 3 upsets seed 2, then wins the final against seed 1.
  await play(org, competition, actor, match(bracket, 1, 1).id, 1);
  let current = (await getBracket(org, competition, bracket.id))!;
  assert.deepEqual(match(current, 2, 0).sides.map(side => side.seed), [1, 3]);
  assert.equal(await bracketWinnersForStage(getSqlClient(), org, stage.id), null);
  await play(org, competition, actor, match(current, 2, 0).id, 1);
  current = (await getBracket(org, competition, bracket.id))!;
  assert.equal(current.status, "completed");
  assert.deepEqual(await bracketWinnersForStage(getSqlClient(), org, stage.id), [entries[2]]);

  // LC-15 integration: the bracket stage's advancement is the champion.
  const decision = await decideAdvancement(org, competition, stage.id, actor, { idempotencyKey: key() }, { bracketWinners: bracketWinnersForStage });
  assert.deepEqual(decision.advancing, [entries[2]]);

  const audit = await listAuditEvents(org, { subjectType: "match" });
  assert.equal(audit.filter(row => row.action === "match.decided").length, 2);
});

test("match lifecycle enforces revisions, sides and void reasons", async () => {
  const { org, actor, competition, entries } = await setup(4);
  const bracket = await createBracket(org, competition, actor, { idempotencyKey: key(), sides: entries.map((entryId, i) => ({ entryId, seed: i + 1 })) });
  const final = match(bracket, 2, 0);
  await assert.rejects(actOnMatch(org, competition, final.id, actor, { action: "start" }, 1), { code: "invalid_state_match_sides_incomplete" });
  const first = match(bracket, 1, 0);
  await assert.rejects(actOnMatch(org, competition, first.id, actor, { action: "decide", winnerSlot: 0 }, 1), { code: "invalid_state_match_transition" });
  const live = await actOnMatch(org, competition, first.id, actor, { action: "start" }, 1);
  await assert.rejects(actOnMatch(org, competition, first.id, actor, { action: "decide", winnerSlot: 0 }, 1), { code: "match_revision_conflict" });
  await assert.rejects(actOnMatch(org, competition, first.id, actor, { action: "decide", winnerSlot: 5 }, live.revision), { code: "invalid_match_winner" });
  await assert.rejects(actOnMatch(org, competition, first.id, actor, { action: "void" }, live.revision), { code: "void_reason_required" });
  const voided = await actOnMatch(org, competition, first.id, actor, { action: "void", reason: "Equipment failure" }, live.revision);
  assert.equal(voided.status, "void");
  assert.equal((await getBracket(org, competition, bracket.id))!.matches.find(m => m.id === final.id)!.sides.length, 0);
});

test("concurrent winner recordings: exactly one succeeds and advances once", async () => {
  const { org, actor, competition, entries } = await setup(2);
  const bracket = await createBracket(org, competition, actor, { idempotencyKey: key(), sides: entries.map((entryId, i) => ({ entryId, seed: i + 1 })) });
  const only = match(bracket, 1, 0);
  const live = await actOnMatch(org, competition, only.id, actor, { action: "start" }, 1);
  const results = await Promise.allSettled([0, 1, 0, 1].map(slot =>
    actOnMatch(org, competition, only.id, actor, { action: "decide", winnerSlot: slot }, live.revision)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
});

test("teams form generic group sides and standalone multi-side matches", async () => {
  const { org, actor, competition } = await setup(0);
  const participants: string[] = [];
  for (let i = 0; i < 6; i += 1) participants.push((await createEntry(org, competition, `Member ${i}`)).participantId);
  const teams = [];
  for (let i = 0; i < 3; i += 1) {
    teams.push(await createTeam(org, competition, actor, { name: `Crew ${i}`, participantIds: participants.slice(i * 2, i * 2 + 2) }));
  }
  await assert.rejects(createTeam(org, competition, actor, { name: "Crew 0", participantIds: [] }), { code: "invalid_team_members" });
  await assert.rejects(createTeam(org, competition, actor, { name: "crew 0", participantIds: [participants[0]] }), { code: "team_name_conflict" });
  await assert.rejects(createTeam(org, competition, actor, { name: "Other", participantIds: [participants[0]] }), { code: "team_member_conflict" });
  assert.equal((await listTeams(org, competition)).length, 3);

  const standalone = await createMatch(org, competition, actor, { sides: teams.map(team => ({ teamId: team.id })) });
  assert.equal(standalone.sides.length, 3);
  assert.equal(standalone.sides[0]?.displayName, "Crew 0");
  const live = await actOnMatch(org, competition, standalone.id, actor, { action: "start" }, 1);
  const decided = await actOnMatch(org, competition, standalone.id, actor, { action: "decide", winnerSlot: 2 }, live.revision);
  assert.equal(decided.winnerSlot, 2);
  const teamBracket = await createBracket(org, competition, actor, { idempotencyKey: key(), sides: teams.map((team, i) => ({ teamId: team.id, seed: i + 1 })) });
  assert.equal(teamBracket.sideKind, "team");
});

test("brackets are optional, feature-gated and tenant-isolated", async () => {
  const { org, actor, competition, entries } = await setup(2);
  const other = await createTenant();
  await enableFeature("brackets", other, actor);
  const otherCompetition = await createCompetition(other);
  const bracket = await createBracket(org, competition, actor, { idempotencyKey: key(), sides: entries.map((entryId, i) => ({ entryId, seed: i + 1 })) });

  assert.equal(await getBracket(other, otherCompetition, bracket.id), null);
  await assert.rejects(getBracket(other, competition, bracket.id), { code: "event_not_found" });
  await assert.rejects(actOnMatch(other, otherCompetition, bracket.matches[0]!.id, actor, { action: "start" }, 1), { code: "match_not_found" });
  // Foreign entries cannot be seeded into another tenant's bracket.
  await assert.rejects(createBracket(other, otherCompetition, actor, { idempotencyKey: key(), sides: entries.map((entryId, i) => ({ entryId, seed: i + 1 })) }), { code: "entry_not_found" });
  await assert.rejects(createBracket(org, competition, actor, { idempotencyKey: key(), sides: [{ entryId: entries[0], seed: 1 }, { entryId: entries[1], seed: 3 }] }), { code: "invalid_bracket_seeds" });

  // Public read requires a public, non-draft event.
  assert.equal(await getPublicBracket(org, competition, bracket.id), null);
  await getSqlClient()`UPDATE competitions SET status = 'published', visibility = 'public' WHERE id = ${competition}`;
  assert.equal((await getPublicBracket(org, competition, bracket.id))?.id, bracket.id);

  await getSqlClient()`UPDATE feature_flags SET enabled = false WHERE scope_key = ${`tenant:${org}`} AND feature = 'brackets'`;
  await assert.rejects(getBracket(org, competition, bracket.id), { code: "feature_disabled" });
  await assert.rejects(createMatch(org, competition, actor, { sides: entries.map(entryId => ({ entryId })) }), { code: "feature_disabled" });
  // Events and stages keep working with brackets disabled.
  await createStage(org, competition, actor, { label: "Open", kind: "audition", timed: false });
});
