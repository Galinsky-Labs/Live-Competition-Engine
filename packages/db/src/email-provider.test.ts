import test from "node:test";
import assert from "node:assert/strict";
import { createFakeEmailProvider, createPostmarkProvider, EmailSendError, secretsEqual } from "./providers/email.ts";

const message = { from: "Org <a@example.org>", to: "b@example.org", subject: "Hi", textBody: "Body", headers: { "List-Unsubscribe": "<https://x>" } };

test("postmark adapter posts the documented request and returns MessageID", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return Response.json({ ErrorCode: 0, Message: "OK", MessageID: "pm-123" });
  }) as unknown as typeof fetch;
  const provider = createPostmarkProvider({ serverToken: "server-token" }, fetchImpl);
  assert.deepEqual(await provider.send(message), { providerMessageId: "pm-123" });
  assert.equal(captured!.url, "https://api.postmarkapp.com/email");
  const headers = captured!.init.headers as Record<string, string>;
  assert.equal(headers["X-Postmark-Server-Token"], "server-token");
  const body = JSON.parse(String(captured!.init.body));
  assert.equal(body.From, message.from);
  assert.deepEqual(body.Headers, [{ Name: "List-Unsubscribe", Value: "<https://x>" }]);
});

test("postmark adapter classifies permanent and transient failures", async () => {
  const respond = (status: number, body: unknown) => (async () => Response.json(body, { status })) as unknown as typeof fetch;
  await assert.rejects(createPostmarkProvider({ serverToken: "t" }, respond(422, { ErrorCode: 406, Message: "Inactive" })).send(message),
    (error: unknown) => error instanceof EmailSendError && error.permanent === true);
  await assert.rejects(createPostmarkProvider({ serverToken: "t" }, respond(503, {})).send(message),
    (error: unknown) => error instanceof EmailSendError && error.permanent === false);
  const network = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  await assert.rejects(createPostmarkProvider({ serverToken: "t" }, network).send(message),
    (error: unknown) => error instanceof EmailSendError && error.permanent === false);
});

test("adapters refuse header injection and the real adapter fails closed without credentials", async () => {
  await assert.rejects(createFakeEmailProvider().send({ ...message, subject: "a\r\nBcc: x@y" }), EmailSendError);
  await assert.rejects(createPostmarkProvider({ serverToken: "" }).send(message), EmailSendError);
  assert.equal(secretsEqual("abc", "abc"), true);
  assert.equal(secretsEqual("abc", "abd"), false);
});
