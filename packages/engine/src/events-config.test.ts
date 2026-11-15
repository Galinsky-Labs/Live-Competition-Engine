import test from "node:test";
import assert from "node:assert/strict";
import { assertTransition, canTransition, eventInputSchema, publishBlockers } from "./events.ts";
import { parseContestConfig, registrationState, safeParseContestConfig } from "./contest-config.ts";
import { DomainError } from "./errors.ts";

test("event lifecycle allows only forward, explicit transitions", () => {
  assert.equal(canTransition("draft", "published"), true);
  assert.equal(canTransition("published", "live"), true);
  assert.equal(canTransition("live", "paused"), true);
  assert.equal(canTransition("paused", "live"), true);
  assert.equal(canTransition("draft", "live"), false);
  assert.equal(canTransition("completed", "live"), false);
  assert.equal(canTransition("cancelled", "draft"), false);
  assert.throws(() => assertTransition("completed", "cancelled"), (e: unknown) => e instanceof DomainError && e.status === 409);
});

test("event input validates time zone, ordering and venue shape", () => {
  assert.equal(eventInputSchema.parse({ title: "Open Night", timezone: "America/Chicago" }).remote, false);
  assert.equal(eventInputSchema.safeParse({ title: "x" }).success, false);
  assert.equal(eventInputSchema.safeParse({ title: "Open Night", timezone: "Mars/Olympus" }).success, false);
  assert.equal(eventInputSchema.safeParse({ title: "Open Night", startsAt: "2026-12-01T20:00:00Z", endsAt: "2026-12-01T19:00:00Z" }).success, false);
  assert.equal(eventInputSchema.safeParse({ title: "Open Night", venue: { name: "Hall", extra: 1 } }).success, false);
});

test("publishing requires a start, a venue or remote stream and a valid configuration", () => {
  const base = { title: "Final", startsAt: null, endsAt: null, venue: null, remote: false, config: {} };
  assert.deepEqual(publishBlockers(base), ["startsAt is required", "a venue or remote stream is required"]);
  assert.deepEqual(publishBlockers({ ...base, startsAt: new Date(), remote: true }), []);
  const bad = publishBlockers({ ...base, startsAt: new Date(), remote: true, config: { scoring: { criteria: [{ key: "a", label: "A" }, { key: "a", label: "B" }] } } });
  assert.match(bad.join(), /unique/);
});

test("contest configuration defaults are domain-neutral and strict", () => {
  const config = parseContestConfig({});
  assert.equal(config.format, "solo");
  assert.equal(config.labels.entrant, "Entrant");
  assert.equal(config.scoring.criteria[0]!.key, "overall");
  assert.equal(safeParseContestConfig({ unknownField: true }).ok, false);
  assert.equal(safeParseContestConfig({ format: "group" }).ok, false, "group format needs group sizes");
  assert.equal(safeParseContestConfig({ scoring: { judgeWeight: 0, audienceWeight: 0 } }).ok, false);
  assert.equal(safeParseContestConfig({ scoring: { criteria: [{ key: "x", label: "X", min: 5, max: 5 }] } }).ok, false);
});

test("registration window follows the server clock", () => {
  const config = parseContestConfig({ registration: { opensAt: "2026-11-01T00:00:00Z", closesAt: "2026-11-10T00:00:00Z" } });
  assert.equal(registrationState(config, new Date("2026-10-31T23:59:59Z")), "not_open");
  assert.equal(registrationState(config, new Date("2026-11-05T00:00:00Z")), "open");
  assert.equal(registrationState(config, new Date("2026-11-10T00:00:00Z")), "closed");
});
