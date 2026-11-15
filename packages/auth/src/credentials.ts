import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { AuthenticationError, type AuthenticationService, type SessionRecord } from "./index.ts";

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;
const MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** Lower-cases and validates an email address. Returns null when it is not plausibly an address. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const email = input.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) return null;
  return email;
}

export function passwordPolicyViolation(password: unknown): "invalid" | "too_short" | "too_long" | null {
  if (typeof password !== "string") return "invalid";
  if ([...password].length < PASSWORD_MIN_LENGTH) return "too_short";
  if (password.length > PASSWORD_MAX_LENGTH) return "too_long";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: MAXMEM });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (!N || !r || !p || N > 1 << 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (salt.length < 16 || expected.length !== SCRYPT.keylen) return false;
  const actual = await scrypt(password.normalize("NFKC"), salt, expected.length, { N, r, p, maxmem: MAXMEM });
  return timingSafeEqual(actual, expected);
}

/** Email digests are stored for throttling so the attempt log never holds raw addresses. */
export const emailDigest = (email: string) => createHash("sha256").update(`login\0${email}`, "utf8").digest("hex");

export interface CredentialRecord {
  accountId: string;
  passwordHash: string;
}

export interface CredentialStore {
  findCredentialByEmail(email: string): Promise<CredentialRecord | null>;
  /** Creates an account and its credential atomically. Returns null when the email is already registered. */
  createAccountWithCredential(email: string, passwordHash: string): Promise<string | null>;
  countFailedAttempts(emailHash: string, since: Date): Promise<number>;
  recordAttempt(emailHash: string, succeeded: boolean, at: Date): Promise<void>;
}

export class CredentialError extends Error {
  readonly code: "email_invalid" | "password_invalid" | "password_too_short" | "password_too_long" | "email_taken" | "throttled";
  constructor(code: CredentialError["code"]) {
    super(`Credential request rejected: ${code}`);
    this.code = code;
  }
}

export interface CredentialServiceOptions {
  maxFailures?: number;
  windowMs?: number;
}

// A fixed, valid hash used to spend equal work when an email is unknown.
let dummyHash: Promise<string> | undefined;

/** First-party email + password sign-in that issues the same opaque bearer sessions as the rest of the API. */
export class CredentialService {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly store: CredentialStore;
  private readonly sessions: Pick<AuthenticationService, "issueSession">;

  constructor(
    store: CredentialStore,
    sessions: Pick<AuthenticationService, "issueSession">,
    options: CredentialServiceOptions = {}
  ) {
    this.store = store;
    this.sessions = sessions;
    this.maxFailures = options.maxFailures ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
  }

  async signUp(emailInput: unknown, password: unknown, now = new Date()): Promise<{ accountId: string; token: string; session: SessionRecord }> {
    const email = normalizeEmail(emailInput);
    if (!email) throw new CredentialError("email_invalid");
    const violation = passwordPolicyViolation(password);
    if (violation === "invalid") throw new CredentialError("password_invalid");
    if (violation === "too_short") throw new CredentialError("password_too_short");
    if (violation === "too_long") throw new CredentialError("password_too_long");
    const accountId = await this.store.createAccountWithCredential(email, await hashPassword(password as string));
    if (!accountId) throw new CredentialError("email_taken");
    const issued = await this.sessions.issueSession(accountId, now);
    return { accountId, ...issued };
  }

  async login(emailInput: unknown, password: unknown, now = new Date()): Promise<{ accountId: string; token: string; session: SessionRecord }> {
    const email = normalizeEmail(emailInput);
    if (!email || typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH) throw new AuthenticationError("invalid");
    const key = emailDigest(email);
    const failures = await this.store.countFailedAttempts(key, new Date(now.getTime() - this.windowMs));
    if (failures >= this.maxFailures) throw new CredentialError("throttled");
    const credential = await this.store.findCredentialByEmail(email);
    dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
    const ok = credential
      ? await verifyPassword(password, credential.passwordHash)
      : (await verifyPassword(password, await dummyHash), false);
    await this.store.recordAttempt(key, ok, now);
    if (!ok || !credential) throw new AuthenticationError("invalid");
    const issued = await this.sessions.issueSession(credential.accountId, now);
    return { accountId: credential.accountId, ...issued };
  }
}
