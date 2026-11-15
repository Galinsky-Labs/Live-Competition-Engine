import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseEventCreate, parseEventPatch } from "@live-competition-engine/domain/events";
import { closeDatabaseConnection } from "./index.ts";
import { listAuditEvents, verifyAuditChain } from "./audit.ts";
import { createAccount, createTenant } from "./test-fixtures.ts";
import {
  createEvent,
  getEvent,
  getPublicEvent,
  listEventHistory,
  listManagedEvents,
  listPublicEvents,
  transitionEvent,
  updateEvent
} from "./events.ts";

after(closeDatabaseConnection);

const slug = () => `ev-${randomUUID().slice(0, 8)}`;
const fields = (overrides: Record<string, unknown> = {}) => parseEventCreate({
  title: "Fixture event", slug: slug(), startsAt: "2027-05-01T18:00:00Z", venueName: "Main Hall",
  timezone: "Europe/Berlin", capacity: 120, visibility: "public", ...overrides
});

test("draft -> published -> live -> paused -> completed with history, audit and revisions", async () => {
  const org = await createTenant();
  const actor = await createAccount(org);
  const event = await createEvent(org, actor, fields());
  assert.equal(event.status, "draft");
  assert.equal(event.revision, 1);
  assert.equal(await getPublicEvent(org, event.id), null, "drafts are never public");

  const published = await transitionEvent(org, event.id, actor, "published", 1, null);
  assert.ok(published.publishedAt);
  assert.equal((await getPublicEvent(org, event.slug!))?.id, event.id);
  let revision = published.revision;
  for (const to of ["live", "paused", "live", "completed"] as const) {
    revision = (await transitionEvent(org, event.id, actor, to, revision, null)).revision;
  }
  assert.equal(revision, 6);
  await assert.rejects(transitionEvent(org, event.id, actor, "live", revision, null), { code: "invalid_state_transition" });
  await assert.rejects(updateEvent(org, event.id, actor, { capacity: 5 }, revision), { code: "invalid_state_event_closed" });

  const history = await listEventHistory(org, event.id);
  assert.deepEqual(history.map(row => `${row.from_status}>${row.to_status}`),
    ["draft>published", "published>live", "live>paused", "paused>live", "live>completed"]);
  const audit = await listAuditEvents(org, { subjectId: event.id });
  assert.equal(audit.filter(row => row.action === "event.status_changed").length, 5);
  assert.equal(audit.at(-1)?.action, "event.created");
  assert.equal((await verifyAuditChain(org)).valid, true);
});

test("cancellation requires a reason and is shown on the public projection", async () => {
  const org = await createTenant();
  const actor = await createAccount(org);
  const event = await createEvent(org, actor, fields());
  await transitionEvent(org, event.id, actor, "published", 1, null);
  await assert.rejects(transitionEvent(org, event.id, actor, "cancelled", 2, null), { code: "cancel_reason_required" });
  const cancelled = await transitionEvent(org, event.id, actor, "cancelled", 2, "Venue unavailable");
  assert.ok(cancelled.cancelledAt);
  const view = await getPublicEvent(org, event.id);
  assert.equal(view?.cancelReason, "Venue unavailable");
  assert.equal(view?.status, "cancelled");
});

test("publication preconditions and slug locking", async () => {
  const org = await createTenant();
  const actor = await createAccount(org);
  const bare = await createEvent(org, actor, parseEventCreate({ title: "Bare" }));
  await assert.rejects(transitionEvent(org, bare.id, actor, "published", 1, null), { code: "event_not_publishable_slug_required" });
  const event = await createEvent(org, actor, fields());
  await transitionEvent(org, event.id, actor, "published", 1, null);
  await assert.rejects(updateEvent(org, event.id, actor, parseEventPatch({ slug: "new-slug" }), 2), { code: "invalid_state_slug_locked" });
  const updated = await updateEvent(org, event.id, actor, parseEventPatch({ capacity: 300, streamUrl: "https://stream.example/live" }), 2);
  assert.equal(updated.capacity, 300);
  assert.equal(updated.revision, 3);
});

test("slugs are unique per tenant but reusable across tenants", async () => {
  const org = await createTenant();
  const other = await createTenant();
  const actor = await createAccount(org);
  const shared = slug();
  await createEvent(org, actor, fields({ slug: shared }));
  await assert.rejects(createEvent(org, actor, fields({ slug: shared })), { code: "event_slug_conflict" });
  await createEvent(other, actor, fields({ slug: shared }));
});

test("concurrent edits at one revision: exactly one wins", async () => {
  const org = await createTenant();
  const actor = await createAccount(org);
  const event = await createEvent(org, actor, fields());
  const results = await Promise.allSettled([
    updateEvent(org, event.id, actor, { capacity: 10 }, 1),
    updateEvent(org, event.id, actor, { capacity: 20 }, 1),
    transitionEvent(org, event.id, actor, "published", 1, null),
    transitionEvent(org, event.id, actor, "cancelled", 1, "duplicate")
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  for (const result of results) {
    if (result.status === "rejected") assert.equal((result.reason as { code: string }).code, "event_revision_conflict");
  }
  assert.equal((await getEvent(org, event.id))?.revision, 2);
});

test("tenant isolation and visibility of listings", async () => {
  const org = await createTenant();
  const other = await createTenant();
  const actor = await createAccount(org);
  const event = await createEvent(org, actor, fields());
  await transitionEvent(org, event.id, actor, "published", 1, null);
  const membersOnly = await createEvent(org, actor, fields({ visibility: "members" }));
  await transitionEvent(org, membersOnly.id, actor, "published", 1, null);
  await createEvent(org, actor, fields({ title: "Still a draft" }));

  assert.equal(await getEvent(other, event.id), null);
  assert.equal(await getPublicEvent(other, event.id), null);
  assert.equal(await getPublicEvent(other, event.slug!), null);
  await assert.rejects(updateEvent(other, event.id, actor, { capacity: 1 }, 2), { code: "event_not_found" });
  await assert.rejects(transitionEvent(other, event.id, actor, "live", 2, null), { code: "event_not_found" });

  assert.deepEqual((await listPublicEvents(org)).map(item => item.id), [event.id, membersOnly.id].filter(id => id === event.id));
  assert.equal((await listPublicEvents(org, { member: true })).length, 2);
  assert.equal(await getPublicEvent(org, membersOnly.id), null);
  assert.equal((await getPublicEvent(org, membersOnly.id, true))?.id, membersOnly.id);
  assert.equal((await listManagedEvents(org)).length, 3);
  assert.equal((await listPublicEvents(other)).length, 0);
});
