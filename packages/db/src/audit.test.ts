import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { canonicalJson, recordAudit, verifyAuditChain } from "./audit.ts";

test("canonical JSON sorts keys deterministically", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

test("audit chain is append-only, gap-free and verifiable", async () => {
  const sql = getSqlClient();
  const org = randomUUID();
  try {
    await Promise.all(Array.from({ length: 12 }, (_, i) => sql.begin(tx => recordAudit(tx, {
      organizationId: org, actorAccountId: null, action: "test.recorded",
      subjectType: "test", subjectId: String(i), details: { i, nested: { z: 1, a: 2 } }
    }))));
    const verification = await verifyAuditChain(org);
    assert.equal(verification.valid, true);
    assert.equal(verification.count, 12); // >= 10 guards against text ordering of sequence
    await assert.rejects(sql`UPDATE audit_events SET details = '{}' WHERE chain_key = ${org}`, /append-only/);
    await assert.rejects(sql`DELETE FROM audit_events WHERE chain_key = ${org}`, /append-only/);
    // A rolled-back state change leaves no audit evidence.
    await assert.rejects(sql.begin(async tx => {
      await recordAudit(tx, { organizationId: org, actorAccountId: null, action: "test.rolled_back", subjectType: "test", subjectId: "x" });
      throw new Error("abort");
    }), /abort/);
    assert.equal((await verifyAuditChain(org)).count, 12);
  } finally {
    await closeDatabaseConnection();
  }
});
