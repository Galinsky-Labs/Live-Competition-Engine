import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { listAuditEvents } from "./audit.ts";
import { createAccount, createCompetition, createEntry, createTenant } from "./test-fixtures.ts";
import {
  createStage,
  decideAdvancement,
  getAdvancement,
  listStages,
  reorderStages,
  updateStage
} from "./stages.ts";

after(closeDatabaseConnection);

const heat = { label: "Heat", kind: "heat", timed: true, durationSeconds: 900, advancement: { type: "top_n", count: 2, ties: "include" } };
const key = () => `adv-${randomUUID()}`;

async function setup() {
  const org = await createTenant();
  const actor = await createAccount(org);
  const competition = await createCompetition(org);
  return { org, actor, competition };
}

async function finalResult(org: string, competition: string, roundId: string, rank: number, score: string) {
  const { entryId } = await createEntry(org, competition, `Entrant ${rank}-${randomUUID().slice(0, 4)}`);
  await getSqlClient()`INSERT INTO results (organization_id, competition_id, round_id, entry_id, rank, score, status)
    VALUES (${org}, ${competition}, ${roundId}, ${entryId}, ${rank}, ${score}, 'final')`;
  return entryId;
}

test("stages create rounds in order, update with revisions and reorder within slots", async () => {
  const { org, actor, competition } = await setup();
  const a = await createStage(org, competition, actor, { label: "Auditions", kind: "audition", timed: false });
  const b = await createStage(org, competition, actor, heat);
  const c = await createStage(org, competition, actor, { label: "Showcase", kind: "custom", customLabel: "Showcase", timed: false });
  assert.deepEqual([a.ordinal, b.ordinal, c.ordinal], [1, 2, 3]);

  const updated = await updateStage(org, competition, b.id, actor, { label: "Heats", durationSeconds: 600 }, 1);
  assert.equal(updated.revision, 2);
  assert.equal(updated.label, "Heats");
  await assert.rejects(updateStage(org, competition, b.id, actor, { label: "Stale" }, 1), { code: "stage_revision_conflict" });
  await assert.rejects(updateStage(org, competition, b.id, actor, { timed: false }, 2), { code: "invalid_stage_timing" });

  const reordered = await reorderStages(org, competition, actor, [c.id, a.id, b.id]);
  assert.deepEqual(reordered.map(stage => stage.id), [c.id, a.id, b.id]);
  assert.deepEqual(reordered.map(stage => stage.ordinal), [1, 2, 3]);
  await assert.rejects(reorderStages(org, competition, actor, [a.id, b.id]), { code: "invalid_stage_order" });

  // A started round cannot move.
  await getSqlClient()`UPDATE rounds SET status = 'live' WHERE id = ${c.roundId}`;
  await assert.rejects(reorderStages(org, competition, actor, [a.id, c.id, b.id]), { code: "invalid_state_stage_started" });
  const audit = await listAuditEvents(org, { subjectId: competition });
  assert.equal(audit[0]?.action, "stage.reordered");
});

test("advancement is computed from final results, recorded once, idempotent and audited", async () => {
  const { org, actor, competition } = await setup();
  const stage = await createStage(org, competition, actor, heat);
  await assert.rejects(decideAdvancement(org, competition, stage.id, actor, { idempotencyKey: key() }), { code: "invalid_state_no_final_results" });

  const first = await finalResult(org, competition, stage.roundId, 1, "9.5");
  const tiedA = await finalResult(org, competition, stage.roundId, 2, "8.0");
  const tiedB = await finalResult(org, competition, stage.roundId, 2, "8.0");
  const last = await finalResult(org, competition, stage.roundId, 4, "5.0");
  const idempotencyKey = key();
  const decision = await decideAdvancement(org, competition, stage.id, actor, { idempotencyKey });
  assert.deepEqual(decision.advancing, [first, ...[tiedA, tiedB].sort()]);
  assert.deepEqual(decision.eliminated, [last]);
  assert.equal(decision.replayed, false);

  const replay = await decideAdvancement(org, competition, stage.id, actor, { idempotencyKey });
  assert.equal(replay.replayed, true);
  assert.equal(replay.id, decision.id);
  await assert.rejects(decideAdvancement(org, competition, stage.id, actor, { idempotencyKey: key() }), { code: "stage_advancement_conflict" });
  await assert.rejects(updateStage(org, competition, stage.id, actor, { label: "Late edit" }, 1), { code: "invalid_state_stage_decided" });
  await assert.rejects(getSqlClient()`UPDATE stage_advancements SET tie_broken = true WHERE id = ${decision.id}`, /append-only/);

  assert.equal((await getAdvancement(org, competition, stage.id))?.id, decision.id);
  const audit = await listAuditEvents(org, { subjectId: stage.id });
  assert.equal(audit.filter(row => row.action === "stage.advancement_decided").length, 1);
});

test("concurrent advancement attempts record exactly one decision", async () => {
  const { org, actor, competition } = await setup();
  const stage = await createStage(org, competition, actor, heat);
  await finalResult(org, competition, stage.roundId, 1, "1");
  await finalResult(org, competition, stage.roundId, 2, "1");
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => decideAdvancement(org, competition, stage.id, actor, { idempotencyKey: key() })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
});

test("manual contracts take a selection; bracket contracts need a resolver", async () => {
  const { org, actor, competition } = await setup();
  const manual = await createStage(org, competition, actor, { label: "Picks", kind: "qualifier", timed: false, advancement: { type: "manual", maxSelections: 1 } });
  const chosen = await finalResult(org, competition, manual.roundId, 2, "7");
  await finalResult(org, competition, manual.roundId, 1, "9");
  await assert.rejects(decideAdvancement(org, competition, manual.id, actor, { idempotencyKey: key() }), { code: "advancement_selection_required" });
  const decision = await decideAdvancement(org, competition, manual.id, actor, { idempotencyKey: key(), selection: [chosen] });
  assert.deepEqual(decision.advancing, [chosen]);

  const bracket = await createStage(org, competition, actor, { label: "Bracket", kind: "final", timed: false, advancement: { type: "bracket" } });
  await assert.rejects(decideAdvancement(org, competition, bracket.id, actor, { idempotencyKey: key() }), { code: "invalid_state_bracket_undecided" });
  const winner = randomUUID();
  const viaBracket = await decideAdvancement(org, competition, bracket.id, actor, { idempotencyKey: key() }, { bracketWinners: async () => [winner] });
  assert.deepEqual(viaBracket.advancing, [winner]);
});

test("stages are tenant-isolated and closed events are read-only", async () => {
  const { org, actor, competition } = await setup();
  const other = await createTenant();
  const stage = await createStage(org, competition, actor, heat);
  assert.deepEqual(await listStages(other, competition), []);
  await assert.rejects(createStage(other, competition, actor, heat), { code: "event_not_found" });
  await assert.rejects(updateStage(other, competition, stage.id, actor, { label: "x" }, 1), { code: "event_not_found" });
  const foreignCompetition = await createCompetition(other);
  await assert.rejects(updateStage(other, foreignCompetition, stage.id, actor, { label: "x" }, 1), { code: "stage_not_found" });
  await assert.rejects(decideAdvancement(other, foreignCompetition, stage.id, actor, { idempotencyKey: key() }), { code: "stage_not_found" });
  assert.equal(await getAdvancement(other, competition, stage.id), null);

  await getSqlClient()`UPDATE competitions SET status = 'completed' WHERE id = ${competition}`;
  await assert.rejects(createStage(org, competition, actor, heat), { code: "invalid_state_event_closed" });
});
