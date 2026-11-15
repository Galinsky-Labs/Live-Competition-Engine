import {
  domainFailure,
  errorResponse,
  isUuid,
  json,
  readJsonObject,
  requireAction,
  requireMember,
  type Authorizer
} from "../../../../../lib/http";

export interface NotificationService {
  listInbox(org: string, account: string, options: { unreadOnly?: boolean; limit?: number }): Promise<unknown>;
  markRead(org: string, account: string, notificationId: string): Promise<void>;
  markAllRead(org: string, account: string): Promise<number>;
  getPreferences(org: string, account: string): Promise<unknown[]>;
  setPreferences(org: string, account: string, preferences: unknown): Promise<void>;
  notify(org: string, input: Record<string, unknown> & { accountId: string }): Promise<{ notificationId: string | null; emailMessageId: string | null; inApp: unknown; email: unknown }>;
}

const MAX_RECIPIENTS = 200;

/** Inbox and preferences are always the caller's own: account id comes from the session, never the request. */
export function createNotificationHandlers(authorizer: Authorizer, service: NotificationService) {
  async function asMember(request: Request, org: string, run: (accountId: string) => Promise<Response>): Promise<Response> {
    const principal = await requireMember(authorizer, request, org);
    if (principal instanceof Response) return principal;
    try {
      return await run(principal.accountId);
    } catch (error) {
      return domainFailure(error);
    }
  }

  return {
    inbox: (request: Request, org: string) => asMember(request, org, async accountId => {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get("limit") ?? "50");
      if (!Number.isSafeInteger(limit)) return errorResponse(400, "invalid_limit");
      return json(await service.listInbox(org, accountId, { unreadOnly: url.searchParams.get("unread") === "true", limit }));
    }),

    markRead: (request: Request, org: string, notificationId: string) => asMember(request, org, async accountId => {
      await service.markRead(org, accountId, notificationId);
      return json({ id: notificationId, read: true });
    }),

    markAllRead: (request: Request, org: string) => asMember(request, org, async accountId =>
      json({ updated: await service.markAllRead(org, accountId) })),

    getPreferences: (request: Request, org: string) => asMember(request, org, async accountId =>
      json({ preferences: await service.getPreferences(org, accountId) })),

    setPreferences: (request: Request, org: string) => asMember(request, org, async accountId => {
      const body = await readJsonObject(request, 16 * 1024);
      if (body instanceof Response) return body;
      await service.setPreferences(org, accountId, body.preferences);
      return json({ preferences: await service.getPreferences(org, accountId) });
    }),

    /** Tenant operators send an operational notification to members; consent is still enforced per recipient. */
    async send(request: Request, org: string): Promise<Response> {
      const principal = await requireAction(authorizer, request, "tenant.manage", { organizationId: org });
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 64 * 1024);
      if (body instanceof Response) return body;
      const recipients = body.accountIds;
      if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > MAX_RECIPIENTS || !recipients.every(isUuid)) {
        return errorResponse(400, "invalid_recipients");
      }
      if (body.category === "marketing") return errorResponse(400, "marketing_not_allowed_here");
      try {
        const results = [];
        for (const accountId of new Set(recipients as string[])) {
          const result = await service.notify(org, {
            accountId, category: body.category, title: body.title, body: body.body, link: body.link, idempotencyKey: body.idempotencyKey
          });
          results.push({ accountId, notificationId: result.notificationId, emailMessageId: result.emailMessageId, inApp: result.inApp, email: result.email });
        }
        return json({ results }, 202);
      } catch (error) {
        return domainFailure(error);
      }
    }
  };
}
