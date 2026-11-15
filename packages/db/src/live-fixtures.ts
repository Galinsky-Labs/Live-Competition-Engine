import { randomUUID } from "node:crypto";
import { getSqlClient } from "./index.ts";
import { createAccount, createCompetition, createEntry, createTenant, grantRole } from "./test-fixtures.ts";

/**
 * Integration-test helpers for live-production modules (LC-22..LC-26).
 * Never import from production code.
 */
export async function createRound(organizationId: string, competitionId: string, ordinal: number, label = `Round ${ordinal}`): Promise<string> {
  const id = randomUUID();
  await getSqlClient()`INSERT INTO rounds (id, organization_id, competition_id, label, ordinal)
    VALUES (${id}, ${organizationId}, ${competitionId}, ${label}, ${ordinal})`;
  return id;
}

export async function createPerformance(organizationId: string, competitionId: string, roundId: string, entryId: string, ordinal: number): Promise<string> {
  const id = randomUUID();
  await getSqlClient()`INSERT INTO performances (id, organization_id, competition_id, round_id, entry_id, ordinal)
    VALUES (${id}, ${organizationId}, ${competitionId}, ${roundId}, ${entryId}, ${ordinal})`;
  return id;
}

/** A tenant with one competition, a producer, a judge, and two entries in one round. */
export async function createLiveShow() {
  const organizationId = await createTenant("Live show");
  const competitionId = await createCompetition(organizationId, "Live show");
  const producer = await createAccount(organizationId);
  const judge = await createAccount(organizationId);
  const performerA = await createAccount(organizationId);
  const performerB = await createAccount(organizationId);
  await grantRole(producer, "event_producer", { organizationId, competitionId });
  await grantRole(judge, "judge", { organizationId, competitionId });
  await grantRole(performerA, "performer", { organizationId, competitionId });
  await grantRole(performerB, "performer", { organizationId, competitionId });
  const entryA = await createEntry(organizationId, competitionId, "Entrant A");
  const entryB = await createEntry(organizationId, competitionId, "Entrant B");
  const roundId = await createRound(organizationId, competitionId, 1);
  const performanceA = await createPerformance(organizationId, competitionId, roundId, entryA.entryId, 1);
  const performanceB = await createPerformance(organizationId, competitionId, roundId, entryB.entryId, 2);
  return { organizationId, competitionId, producer, judge, performerA, performerB, entryA, entryB, roundId, performanceA, performanceB };
}
