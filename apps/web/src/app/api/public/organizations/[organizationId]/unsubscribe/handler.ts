import { escapeHtml } from "@live-competition-engine/domain/markdown";

export type ApplyUnsubscribe = (organizationId: string, token: unknown) => Promise<{ ok: boolean; scope?: string }>;
export type VerifyUnsubscribe = (organizationId: string, token: unknown) => Promise<{ scope: string } | null>;

const headers = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"
};

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:Arial,Helvetica,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
    { status, headers }
  );
}

/**
 * Unsubscribe endpoint. GET only shows a confirmation form (link scanners must not
 * unsubscribe anyone). POST applies it — either from that form or as an RFC 8058
 * one-click request (`List-Unsubscribe=One-Click`) sent by the mailbox provider.
 */
export function createUnsubscribeHandlers(verify: VerifyUnsubscribe, apply: ApplyUnsubscribe) {
  return {
    async get(request: Request, organizationId: string): Promise<Response> {
      const token = new URL(request.url).searchParams.get("token");
      const verified = await verify(organizationId, token);
      if (!verified) return page("Link not valid", "<p>This unsubscribe link is not valid.</p>", 404);
      const what = verified.scope === "all" ? "all email" : `${verified.scope.replace(/_/g, " ")} email`;
      return page("Unsubscribe", `<p>Stop receiving ${escapeHtml(what)} from this organization?</p>` +
        `<form method="post"><input type="hidden" name="token" value="${escapeHtml(token ?? "")}">` +
        `<button type="submit">Unsubscribe</button></form>`);
    },

    async post(request: Request, organizationId: string): Promise<Response> {
      let token = new URL(request.url).searchParams.get("token");
      const contentType = request.headers.get("content-type") ?? "";
      if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
        const text = await request.text();
        if (text.length > 4096) return page("Request too large", "<p>Request too large.</p>", 413);
        const form = new URLSearchParams(text);
        token = form.get("token") ?? token;
      }
      const result = await apply(organizationId, token);
      if (!result.ok) return page("Link not valid", "<p>This unsubscribe link is not valid.</p>", 404);
      return page("Unsubscribed", "<p>You will no longer receive these emails. You can change this in your notification preferences.</p>");
    }
  };
}
