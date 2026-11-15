import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { listAuditEvents } from "./audit.ts";
import { createAccount, createCompetition, createTenant, enableFeature } from "./test-fixtures.ts";
import { editProfile, parseProfilePatch } from "./profiles.ts";
import {
  follow,
  followerCount,
  listConsentedFollowers,
  listMyFollows,
  parseFollowTarget,
  setNotificationConsent,
  unfollow
} from "./follows.ts";

after(closeDatabaseConnection);

async function tenantWithFollows() {
  const org = await createTenant();
  const operator = await createAccount(org);
  await enableFeature("follows", org, operator);
  return { org, operator };
}

async function publishedEvent(org: string): Promise<string> {
  const id = await createCompetition(org, "Followable event");
  await getSqlClient()`UPDATE competitions SET status = 'published', visibility = 'public' WHERE id = ${id}`;
  return id;
}

test("follow and unfollow are idempotent, including under concurrency", async () => {
  const { org } = await tenantWithFollows();
  const member = await createAccount(org);
  const event = await publishedEvent(org);
  const target = parseFollowTarget({ targetType: "competition", targetId: event });

  const results = await Promise.all(Array.from({ length: 5 }, () => follow(org, member, target)));
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(new Set(results.map(result => result.follow.id)).size, 1);
  assert.equal(results[0]!.follow.notifyConsent, false);
  assert.equal(await followerCount(org, target, null), 1);

  assert.deepEqual(await unfollow(org, member, target), { removed: true });
  assert.deepEqual(await unfollow(org, member, target), { removed: false });
  assert.equal(await followerCount(org, target, null), 0);
});

test("notification consent is an explicit, timestamped, audited opt-in", async () => {
  const { org } = await tenantWithFollows();
  const member = await createAccount(org);
  const other = await createAccount(org);
  const tenantTarget = parseFollowTarget({ targetType: "organization", targetId: org });

  await assert.rejects(setNotificationConsent(org, member, tenantTarget, true), { code: "follow_not_found" });
  await follow(org, member, tenantTarget);
  await follow(org, other, tenantTarget);
  assert.deepEqual(await listConsentedFollowers(org, tenantTarget), []);

  const granted = await setNotificationConsent(org, member, tenantTarget, true);
  assert.equal(granted.notifyConsent, true);
  assert.ok(granted.notifyConsentAt instanceof Date);
  await setNotificationConsent(org, member, tenantTarget, true); // no-op
  assert.deepEqual(await listConsentedFollowers(org, tenantTarget), [member]);

  await unfollow(org, member, tenantTarget);
  assert.deepEqual(await listConsentedFollowers(org, tenantTarget), []);
  const audit = await listAuditEvents(org, { subjectId: granted.id });
  assert.deepEqual(audit.map(event => event.action), ["follow.notification_consent_withdrawn", "follow.notification_consent_granted"]);
});

test("profiles: only visible targets can be followed and counted", async () => {
  const { org } = await tenantWithFollows();
  const owner = await createAccount(org);
  const member = await createAccount(org);
  const profileId = randomUUID();
  const patch = (visibility: string) => parseProfilePatch({ displayName: "Followed", bio: "", roles: [], visibility });
  await editProfile(org, profileId, owner, patch("members"), null);
  const target = parseFollowTarget({ targetType: "profile", targetId: profileId });

  await follow(org, member, target);
  assert.equal(await followerCount(org, target, member), 1);
  assert.equal(await followerCount(org, target, null), null);
  await editProfile(org, profileId, owner, patch("private"), 1);
  await assert.rejects(follow(org, await createAccount(org), target), { code: "follow_target_not_found" });

  // Draft events cannot be followed.
  const draft = await createCompetition(org);
  await assert.rejects(follow(org, member, parseFollowTarget({ targetType: "competition", targetId: draft })), { code: "follow_target_not_found" });
  const mine = await listMyFollows(org, member);
  assert.deepEqual(mine.follows.map(item => item.targetId), [profileId]);
});

test("cross-tenant follows are rejected and lists never leak other tenants", async () => {
  const { org } = await tenantWithFollows();
  const { org: other } = await tenantWithFollows();
  const member = await createAccount(org);
  const foreignEvent = await publishedEvent(other);

  await assert.rejects(follow(org, member, parseFollowTarget({ targetType: "competition", targetId: foreignEvent })), { code: "follow_target_not_found" });
  await assert.rejects(follow(org, member, parseFollowTarget({ targetType: "organization", targetId: other })), { code: "follow_target_not_found" });
  // Membership FK: not a member of `other`.
  await assert.rejects(follow(other, member, parseFollowTarget({ targetType: "organization", targetId: other })));
  assert.equal(await followerCount(org, parseFollowTarget({ targetType: "competition", targetId: foreignEvent }), null), null);
});

test("follows fail closed when the feature is disabled for the tenant", async () => {
  const { org, operator } = await tenantWithFollows();
  await getSqlClient()`UPDATE feature_flags SET enabled = false WHERE scope_key = ${`tenant:${org}`} AND feature = 'follows'`;
  const target = parseFollowTarget({ targetType: "organization", targetId: org });
  await assert.rejects(follow(org, operator, target), { code: "feature_disabled" });
  await assert.rejects(followerCount(org, target, null), { code: "feature_disabled" });
  assert.throws(() => parseFollowTarget({ targetType: "user", targetId: org }), { code: "invalid_follow_target" });
});
