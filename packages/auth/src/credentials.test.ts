import test from "node:test";
import assert from "node:assert/strict";
import { AuthenticationError, AuthenticationService, type AuthStore, type SessionRecord } from "./index.ts";
import {
  CredentialError,
  CredentialService,
  hashPassword,
  normalizeEmail,
  passwordPolicyViolation,
  verifyPassword,
  type CredentialStore
} from "./credentials.ts";

class Memory implements CredentialStore, AuthStore {
  accounts = new Map<string, { id: string; hash: string }>();
  attempts: Array<{ key: string; ok: boolean; at: Date }> = [];
  sessions = new Map<string, SessionRecord>();
  async findCredentialByEmail(email: string) {
    const row = this.accounts.get(email);
    return row ? { accountId: row.id, passwordHash: row.hash } : null;
  }
  async createAccountWithCredential(email: string, hash: string) {
    if (this.accounts.has(email)) return null;
    const id = `acct-${this.accounts.size + 1}`;
    this.accounts.set(email, { id, hash });
    return id;
  }
  async countFailedAttempts(key: string, since: Date) {
    return this.attempts.filter(a => a.key === key && !a.ok && a.at >= since).length;
  }
  async recordAttempt(key: string, ok: boolean, at: Date) { this.attempts.push({ key, ok, at }); }
  async accountRecoveryEpoch(id: string) { return [...this.accounts.values()].some(a => a.id === id) ? 0 : null; }
  async findSession(hash: string) { return [...this.sessions.values()].find(s => s.tokenHash === hash) ?? null; }
  async saveSession(s: SessionRecord) { this.sessions.set(s.id, s); }
  async revokeSession() {}
  async replaceRecoveryCodes() {}
  async consumeRecoveryAndRevokeSessions() { return false; }
  async hasActiveMembership() { return false; }
  async listRoleGrants() { return []; }
}

test("password hashes are salted, verifiable and reject tampering", async () => {
  const a = await hashPassword("correct horse battery staple");
  const b = await hashPassword("correct horse battery staple");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("correct horse battery staple", a), true);
  assert.equal(await verifyPassword("correct horse battery stapler", a), false);
  assert.equal(await verifyPassword("x", "plain$text"), false);
  assert.equal(await verifyPassword("x", a.replace(/\$[^$]+$/, "$AAAA")), false);
});

test("email normalization and password policy", () => {
  assert.equal(normalizeEmail("  Person@Example.TEST "), "person@example.test");
  for (const bad of ["", "no-at", "a@b", "a b@example.test", 7, null]) assert.equal(normalizeEmail(bad), null);
  assert.equal(passwordPolicyViolation("short"), "too_short");
  assert.equal(passwordPolicyViolation("x".repeat(257)), "too_long");
  assert.equal(passwordPolicyViolation(12), "invalid");
  assert.equal(passwordPolicyViolation("long enough passphrase"), null);
});

test("sign-up issues a working bearer session; duplicates and weak passwords are refused", async () => {
  const store = new Memory();
  const auth = new AuthenticationService(store);
  const credentials = new CredentialService(store, auth);
  const created = await credentials.signUp("New@Example.test", "a sufficiently long passphrase");
  const principal = await auth.authorize(`Bearer ${created.token}`);
  assert.equal(principal.accountId, created.accountId);
  await assert.rejects(credentials.signUp("new@example.test", "another long passphrase"), (e: unknown) => e instanceof CredentialError && e.code === "email_taken");
  await assert.rejects(credentials.signUp("other@example.test", "short"), (e: unknown) => e instanceof CredentialError && e.code === "password_too_short");
  await assert.rejects(credentials.signUp("bad", "a sufficiently long passphrase"), (e: unknown) => e instanceof CredentialError && e.code === "email_invalid");
});

test("login is generic on failure and throttles repeated failures per email", async () => {
  const store = new Memory();
  const auth = new AuthenticationService(store);
  const credentials = new CredentialService(store, auth, { maxFailures: 3, windowMs: 60_000 });
  await credentials.signUp("user@example.test", "a sufficiently long passphrase");
  const now = new Date("2026-11-01T00:00:00Z");
  await assert.rejects(credentials.login("unknown@example.test", "whatever passphrase", now), AuthenticationError);
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(credentials.login("user@example.test", "wrong passphrase!!", now), AuthenticationError);
  }
  await assert.rejects(credentials.login("USER@example.test", "a sufficiently long passphrase", now), (e: unknown) => e instanceof CredentialError && e.code === "throttled");
  const later = new Date(now.getTime() + 61_000);
  const ok = await credentials.login("user@example.test", "a sufficiently long passphrase", later);
  assert.equal((await auth.authorize(`Bearer ${ok.token}`, undefined, later)).accountId, ok.accountId);
  assert.ok(store.attempts.every(a => /^[0-9a-f]{64}$/.test(a.key)), "raw emails are never stored in the attempt log");
});
