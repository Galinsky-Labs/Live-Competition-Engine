import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { listAuditEvents, verifyAuditChain } from "./audit.ts";
import { createAccount, createCompetition, createEntry, createTenant } from "./test-fixtures.ts";
import {
  editProfile,
  linkParticipantAccount,
  listProfiles,
  moderateProfile,
  parseProfilePatch,
  readProfile
} from "./profiles.ts";

after(closeDatabaseConnection);

const patch = (overrides: Record<string, unknown> = {}) => parseProfilePatch({
  displayName: "Fixture Performer", bio: "Bio", roles: ["performer"], visibility: "public", ...overrides
});

test("owner creates, edits with compare-and-set and visibility is enforced", async () => {
  const org = await createTenant();
  const owner = await createAccount(org);
  const member = await createAccount(org);
  const profileId = randomUUID();

  const created = await editProfile(org, profileId, owner, patch(), null);
  assert.equal(created.revision, 1);
  assert.equal((await readProfile(org, profileId, null))?.displayName, "Fixture Performer");

  const updated = await editProfile(org, profileId, owner, patch({ visibility: "members", bio: "Updated" }), 1);
  assert.equal(updated.revision, 2);
  assert.equal(await readProfile(org, profileId, null), null);
  assert.equal((await readProfile(org, profileId, member))?.bio, "Updated");

  await editProfile(org, profileId, owner, patch({ visibility: "private" }), 2);
  assert.equal(await readProfile(org, profileId, member), null);
  assert.equal((await readProfile(org, profileId, owner))?.revision, 3);

  await assert.rejects(editProfile(org, profileId, owner, patch(), 1), { code: "profile_revision_conflict" });
  await assert.rejects(editProfile(org, profileId, member, patch(), 3), { code: "forbidden" });
  // One profile per member per tenant.
  await assert.rejects(editProfile(org, randomUUID(), owner, patch(), null), { code: "profile_revision_conflict" });

  const audit = await listAuditEvents(org, { subjectType: "profile", subjectId: profileId });
  assert.deepEqual(audit.map(event => event.action), ["profile.updated", "profile.updated", "profile.created"]);
  assert.equal((await verifyAuditChain(org)).valid, true);
});

test("concurrent edits at the same revision produce exactly one winner", async () => {
  const org = await createTenant();
  const owner = await createAccount(org);
  const profileId = randomUUID();
  await editProfile(org, profileId, owner, patch(), null);
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, index) => editProfile(org, profileId, owner, patch({ bio: `race ${index}` }), 1))
  );
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  for (const result of results) {
    if (result.status === "rejected") assert.equal((result.reason as { code: string }).code, "profile_revision_conflict");
  }
  assert.equal((await readProfile(org, profileId, owner))?.revision, 2);
});

test("non-members, suspended members and other tenants cannot write or read", async () => {
  const org = await createTenant();
  const other = await createTenant();
  const owner = await createAccount(org);
  const outsider = await createAccount(other);
  const profileId = randomUUID();
  await editProfile(org, profileId, owner, patch(), null);

  // Cross-tenant: the profile is invisible through another tenant and not writable there.
  assert.equal(await readProfile(other, profileId, null), null);
  assert.equal(await readProfile(other, profileId, outsider), null);
  await assert.rejects(editProfile(other, profileId, outsider, patch(), 1), { code: "profile_not_found" });
  await assert.rejects(editProfile(org, randomUUID(), outsider, patch(), null), { code: "forbidden" });
  assert.equal((await listProfiles(other, null)).profiles.some(item => item.id === profileId), false);
  await assert.rejects(moderateProfile(other, profileId, outsider, { hidden: true }), { code: "profile_not_found" });

  await getSqlClient()`UPDATE organization_memberships SET status = 'suspended', suspended_at = now()
    WHERE organization_id = ${org} AND account_id = ${owner}`;
  await assert.rejects(editProfile(org, profileId, owner, patch(), 1), { code: "forbidden" });
  assert.equal(await readProfile(org, profileId, null), null);
  assert.equal((await listProfiles(org, null)).profiles.length, 0);
});

test("linked history comes only from final results of published events", async () => {
  const org = await createTenant();
  const other = await createTenant();
  const owner = await createAccount(org);
  const operator = await createAccount(org);
  const profileId = randomUUID();
  await editProfile(org, profileId, owner, patch(), null);
  const sql = getSqlClient();

  const published = await createCompetition(org, "Published event");
  const draft = await createCompetition(org, "Draft event");
  const provisional = await createCompetition(org, "Provisional event");
  const privateEvent = await createCompetition(org, "Private event");
  await sql`UPDATE competitions SET status = 'completed', visibility = 'public' WHERE id IN (${published}, ${provisional})`;
  await sql`UPDATE competitions SET status = 'completed', visibility = 'private' WHERE id = ${privateEvent}`;
  for (const [competitionId, status] of [[published, "final"], [draft, "final"], [provisional, "provisional"], [privateEvent, "final"]] as const) {
    const { participantId, entryId } = await createEntry(org, competitionId);
    await linkParticipantAccount(org, participantId, owner, operator);
    await sql`INSERT INTO results (organization_id, competition_id, entry_id, rank, status)
      VALUES (${org}, ${competitionId}, ${entryId}, 1, ${status})`;
  }
  const view = await readProfile(org, profileId, null);
  assert.deepEqual(view?.history, [{ eventId: published, title: "Published event" }]);

  // Cross-tenant participant link is rejected: account is not a member there / participant not found.
  const foreign = await createEntry(other, await createCompetition(other));
  await assert.rejects(linkParticipantAccount(other, foreign.participantId, owner, operator), { code: "member_not_found" });
  await assert.rejects(linkParticipantAccount(org, foreign.participantId, owner, operator), { code: "participant_not_found" });
});

test("moderation hides a profile from everyone but its owner and is audited", async () => {
  const org = await createTenant();
  const owner = await createAccount(org);
  const operator = await createAccount(org);
  const profileId = randomUUID();
  await editProfile(org, profileId, owner, patch(), null);
  assert.equal((await listProfiles(org, null)).profiles.length, 1);

  await moderateProfile(org, profileId, operator, { hidden: true, reason: "Policy review" });
  assert.equal(await readProfile(org, profileId, null), null);
  assert.equal((await readProfile(org, profileId, owner))?.hidden, true);
  assert.equal((await listProfiles(org, operator)).profiles.length, 0);
  await moderateProfile(org, profileId, operator, { hidden: false });
  assert.equal((await readProfile(org, profileId, null))?.hidden, false);

  const audit = await listAuditEvents(org, { subjectType: "profile", subjectId: profileId });
  assert.deepEqual(audit.slice(0, 2).map(event => event.action), ["profile.restored", "profile.hidden"]);
});

test("listing paginates by keyset and respects member visibility", async () => {
  const org = await createTenant();
  const viewer = await createAccount(org);
  for (const visibility of ["public", "members", "private", "public"]) {
    await editProfile(org, randomUUID(), await createAccount(org), patch({ visibility }), null);
  }
  assert.equal((await listProfiles(org, null)).profiles.length, 2);
  const first = await listProfiles(org, viewer, { limit: 2 });
  assert.equal(first.profiles.length, 2);
  assert.ok(first.next);
  const second = await listProfiles(org, viewer, { limit: 2, after: first.next! });
  assert.equal(second.profiles.length, 1);
  assert.equal(second.next, null);
  await assert.rejects(listProfiles(org, null, { after: "bad" }), { code: "invalid_cursor" });
});

test("patch parser rejects mass assignment and malformed values", () => {
  for (const body of [
    { displayName: "A", bio: "", roles: [], visibility: "public", revision: 9 },
    { displayName: "", bio: "", roles: [], visibility: "public" },
    { displayName: "A", bio: "x".repeat(2001), roles: [], visibility: "public" },
    { displayName: "A", bio: "", roles: ["admin"], visibility: "public" },
    { displayName: "A", bio: "", roles: ["judge", "judge"], visibility: "public" },
    { displayName: "A", bio: "", roles: [], visibility: "secret" }
  ]) {
    assert.throws(() => parseProfilePatch(body), { code: "invalid_profile" });
  }
});
