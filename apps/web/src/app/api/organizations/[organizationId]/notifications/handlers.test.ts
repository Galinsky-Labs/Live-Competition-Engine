import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { requirePostmark } from "@live-competition-engine/config/providers";
import { DomainError } from "@live-competition-engine/domain";
import { createJobRunHandler } from "../../../jobs/run/handler";
import { createPostmarkWebhookHandler } from "../../../webhooks/postmark/handler";
import { createNotificationHandlers, type NotificationService } from "./handlers";

const org = "11111111-1111-4111-8111-111111111111";
const accountId = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";
const member = { authorize: vi.fn(async () => ({ accountId, sessionId: "s", organizationId: org })), authorizeAction: vi.fn(async () => { throw new AuthenticationError("forbidden"); }) };
const operator = { ...member, authorizeAction: vi.fn(async () => ({ accountId, sessionId: "s", organizationId: org, role: "tenant_operator" as const, roleGrantId: "g", roleGrantVersion: 1 as const })) };
const anonymous = { authorize: vi.fn(async () => { throw new AuthenticationError("missing"); }), authorizeAction: vi.fn() };

function service(overrides: Partial<NotificationService> = {}): NotificationService {
  return {
    listInbox: vi.fn(async () => ({ unread: 0, notifications: [] })), markRead: vi.fn(async () => undefined), markAllRead: vi.fn(async () => 0),
    getPreferences: vi.fn(async () => []), setPreferences: vi.fn(async () => undefined),
    notify: vi.fn(async () => ({ notificationId: "n", emailMessageId: null, inApp: { allowed: true }, email: { allowed: false } })),
    ...overrides
  };
}

const req = (method: string, body?: unknown, headers: Record<string, string> = { authorization: "Bearer t" }, url = "https://engine.test/api/x") =>
  new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

describe("notification handlers", () => {
  it("lists only the caller's inbox", async () => {
    const svc = service();
    expect((await createNotificationHandlers(member, svc).inbox(req("GET", undefined, { authorization: "Bearer t" }, "https://x/api?accountId=evil&unread=true"), org)).status).toBe(200);
    expect(svc.listInbox).toHaveBeenCalledWith(org, accountId, { unreadOnly: true, limit: 50 });
  });

  it("requires authentication", async () => {
    expect((await createNotificationHandlers(anonymous, service()).inbox(req("GET", undefined, {}), org)).status).toBe(401);
  });

  it("maps invalid preferences and missing notifications", async () => {
    const handlers = createNotificationHandlers(member, service({
      setPreferences: vi.fn(async () => { throw new DomainError("invalid_channel"); }),
      markRead: vi.fn(async () => { throw new DomainError("notification_not_found"); })
    }));
    expect((await handlers.setPreferences(req("PUT", { preferences: [{ category: "results", channel: "sms", enabled: true }] }), org)).status).toBe(400);
    expect((await handlers.markRead(req("POST"), org, other)).status).toBe(404);
  });

  it("restricts operator sends to tenant.manage, bounded recipients and non-marketing", async () => {
    const svc = service();
    expect((await createNotificationHandlers(member, svc).send(req("POST", { accountIds: [other] }), org)).status).toBe(403);
    const handlers = createNotificationHandlers(operator, svc);
    expect((await handlers.send(req("POST", { accountIds: ["x"] }), org)).status).toBe(400);
    expect((await handlers.send(req("POST", { accountIds: [other], category: "marketing" }), org)).status).toBe(400);
    const ok = await handlers.send(req("POST", { accountIds: [other, other], category: "event_updates", title: "T", body: "B", idempotencyKey: "k1" }), org);
    expect(ok.status).toBe(202);
    expect(svc.notify).toHaveBeenCalledTimes(1);
  });
});

describe("job worker endpoint", () => {
  const secret = "s".repeat(40);
  it("fails closed without a configured secret and rejects wrong bearer", async () => {
    const run = vi.fn(async () => ({}));
    expect((await createJobRunHandler(() => undefined, run)(req("POST", undefined, { authorization: `Bearer ${secret}` }))).status).toBe(503);
    expect((await createJobRunHandler(() => secret, run)(req("POST", undefined, { authorization: "Bearer wrong" }))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs a bounded batch with the right secret", async () => {
    const run = vi.fn(async () => ({ jobs: { claimed: 0 } }));
    const response = await createJobRunHandler(() => secret, run)(req("POST", undefined, { authorization: `Bearer ${secret}` }, "https://x/api/jobs/run?limit=5"));
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledWith({ limit: 5 });
    expect((await createJobRunHandler(() => secret, run)(req("POST", undefined, { authorization: `Bearer ${secret}` }, "https://x?limit=1000"))).status).toBe(400);
  });
});

describe("postmark webhook", () => {
  const secret = "w".repeat(40);
  const parse = (body: Record<string, unknown>) => typeof body.RecordType === "string"
    ? { recordType: body.RecordType, messageId: null, email: null, type: null, inactive: false, occurredAt: null } : null;

  it("accepts basic auth or token query and rejects otherwise", async () => {
    const apply = vi.fn(async () => ({ action: "suppressed" }));
    const handler = createPostmarkWebhookHandler(() => secret, parse, apply);
    const basic = `Basic ${Buffer.from(`postmark:${secret}`).toString("base64")}`;
    expect((await handler(req("POST", { RecordType: "Bounce" }, { authorization: basic }))).status).toBe(200);
    expect((await handler(req("POST", { RecordType: "Bounce" }, {}, `https://x/api/webhooks/postmark?token=${secret}`))).status).toBe(200);
    expect((await handler(req("POST", { RecordType: "Bounce" }, {}, "https://x/api/webhooks/postmark?token=nope"))).status).toBe(401);
    expect((await handler(req("POST", { nothing: true }, { authorization: basic }))).status).toBe(400);
    expect(apply).toHaveBeenCalledTimes(2);
    expect((await createPostmarkWebhookHandler(() => undefined, parse, apply)(req("POST", {}))).status).toBe(503);
  });

  it("real email adapter configuration fails closed without credentials", () => {
    expect(() => requirePostmark({})).toThrow("postmark is not configured");
  });
});
