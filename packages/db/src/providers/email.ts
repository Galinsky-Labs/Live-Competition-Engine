import { createHash, timingSafeEqual } from "node:crypto";

/** Provider-neutral outbound email. Header values must already be single-line. */
export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string | null;
  headers?: Record<string, string>;
  tag?: string;
  metadata?: Record<string, string>;
}

export interface EmailProvider {
  readonly name: string;
  send(message: OutboundEmail): Promise<{ providerMessageId: string }>;
}

/** permanent = retrying cannot help (invalid/inactive recipient, rejected content). */
export class EmailSendError extends Error {
  readonly permanent: boolean;
  readonly providerCode: number | undefined;
  constructor(message: string, permanent: boolean, providerCode?: number) {
    super(message);
    this.permanent = permanent;
    this.providerCode = providerCode;
  }
}

const singleLine = (value: string) => !/[\r\n]/.test(value);

function assertSafe(message: OutboundEmail): void {
  if (!singleLine(message.from) || !singleLine(message.to) || !singleLine(message.subject)) {
    throw new EmailSendError("header injection refused", true);
  }
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || !singleLine(value)) throw new EmailSendError("invalid header", true);
  }
}

/** Postmark error codes where a retry is pointless (see Postmark API error code reference). */
const PERMANENT_POSTMARK_CODES = new Set([300, 406, 409, 410, 411, 412, 413, 1000]);

/**
 * Real Postmark adapter (`POST https://api.postmarkapp.com/email`). The caller passes
 * `requirePostmark()` from `@live-competition-engine/config/providers`, which throws
 * provider_not_configured when credentials are absent (fail closed). It is not imported
 * here because that module is not loadable by node's strip-only TypeScript test runner.
 */
export function createPostmarkProvider(
  config: { serverToken: string },
  fetchImpl: typeof fetch = fetch,
  options: { timeoutMs?: number; messageStream?: string } = {}
): EmailProvider {
  return {
    name: "postmark",
    async send(message) {
      assertSafe(message);
      if (!config?.serverToken) throw new EmailSendError("postmark not configured", false);
      const body = {
        From: message.from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.textBody,
        ...(message.htmlBody ? { HtmlBody: message.htmlBody } : {}),
        Headers: Object.entries(message.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
        ...(message.tag ? { Tag: message.tag } : {}),
        ...(message.metadata ? { Metadata: message.metadata } : {}),
        MessageStream: options.messageStream ?? "outbound"
      };
      let response: Response;
      try {
        response = await fetchImpl("https://api.postmarkapp.com/email", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": config.serverToken
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000)
        });
      } catch (error) {
        throw new EmailSendError(`postmark request failed: ${(error as Error)?.name ?? "error"}`, false);
      }
      let parsed: { ErrorCode?: number; Message?: string; MessageID?: string } = {};
      try {
        parsed = await response.json() as typeof parsed;
      } catch {
        // fall through with empty body
      }
      if (response.ok && parsed.ErrorCode === 0 && typeof parsed.MessageID === "string") {
        return { providerMessageId: parsed.MessageID };
      }
      const code = typeof parsed.ErrorCode === "number" ? parsed.ErrorCode : undefined;
      const permanent = response.status === 422 && code !== undefined && PERMANENT_POSTMARK_CODES.has(code);
      const transient = response.status === 429 || response.status >= 500;
      throw new EmailSendError(`postmark rejected: ${response.status} ${code ?? "?"}`, permanent && !transient, code);
    }
  };
}

/** Deterministic fake for tests. Never proves production deliverability. */
export function createFakeEmailProvider(behaviour: { fail?: "transient" | "permanent" | null } = {}) {
  const sent: OutboundEmail[] = [];
  let counter = 0;
  const provider: EmailProvider & { sent: OutboundEmail[]; behaviour: typeof behaviour } = {
    name: "fake",
    sent,
    behaviour,
    async send(message) {
      assertSafe(message);
      if (behaviour.fail) throw new EmailSendError(`fake ${behaviour.fail} failure`, behaviour.fail === "permanent");
      counter += 1;
      sent.push(message);
      return { providerMessageId: `fake-${createHash("sha256").update(`${message.to}\0${message.subject}\0${counter}\0${Math.random()}`).digest("hex").slice(0, 32)}` };
    }
  };
  return provider;
}

/** Constant-time comparison of two secrets (hashes first so lengths never leak). */
export function secretsEqual(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
