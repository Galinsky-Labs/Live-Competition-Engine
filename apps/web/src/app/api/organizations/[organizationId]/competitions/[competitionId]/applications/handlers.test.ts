import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createApplicationHandlers, type ApplicationsService } from "./handlers";

const organizationId = "11111111-1111-4111-8111-111111111111";
const competitionId = "22222222-2222-4222-8222-222222222222";
const applicationId = "33333333-3333-4333-8333-333333333333";
const accountId = "44444444-4444-4444-8444-444444444444";

const principal = { accountId, sessionId: "s", organizationId };
const allow = {
  authorize: vi.fn(async () => principal),
  authorizeAction: vi.fn(async () => ({ ...principal, role: "event_producer" as const, roleGrantId: "g", roleGrantVersion: 1 as const }))
};
const deny = (code: "forbidden" | "missing") => ({
  authorize: vi.fn(async () => { throw new AuthenticationError(code); }),
  authorizeAction: vi.fn(async () => { throw new AuthenticationError(code); })
});

const req = (body?: unknown, url = "https://engine.test/api") => new Request(url, {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: "Bearer token", "content-type": "application/json" },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
});

function service(overrides: Partial<ApplicationsService> = {}): ApplicationsService {
  const fail = () => { throw new Error("unexpected call"); };
  return {
    getApplicationForm: vi.fn(fail), saveApplicationForm: vi.fn(fail), createApplication: vi.fn(fail),
    updateApplicationDraft: vi.fn(fail), submitApplication: vi.fn(fail), withdrawApplication: vi.fn(fail),
    getOwnApplication: vi.fn(fail), getApplicationForApplicant: vi.fn(fail), listApplicationsForReview: vi.fn(fail),
    getApplicationForReview: vi.fn(fail), decideApplications: vi.fn(fail), listApplicationDecisions: vi.fn(fail),
    ...overrides
  } as ApplicationsService;
}

describe("application handlers", () => {
  it("creates an application for the authenticated member (201) and returns an existing one idempotently (200)", async () => {
    const createApplication = vi.fn()
      .mockResolvedValueOnce({ application: { id: applicationId }, created: true })
      .mockResolvedValueOnce({ application: { id: applicationId }, created: false });
    const h = createApplicationHandlers(allow, service({ createApplication }));
    const body = { displayName: "Ada", answers: { bio: "x" }, accountId: "spoofed" };
    expect((await h.create(req(body), { organizationId, competitionId })).status).toBe(201);
    expect((await h.create(req(body), { organizationId, competitionId })).status).toBe(200);
    expect(createApplication).toHaveBeenCalledWith(organizationId, competitionId, accountId, { displayName: "Ada", answers: { bio: "x" } });
  });

  it("requires authentication and producer permission", async () => {
    const svc = service();
    expect((await createApplicationHandlers(deny("missing"), svc).create(req({}), { organizationId, competitionId })).status).toBe(401);
    const forbidden = createApplicationHandlers(deny("forbidden"), svc);
    expect((await forbidden.listForReview(req(), { organizationId, competitionId })).status).toBe(403);
    expect((await forbidden.decide(req({ status: "selected", expectedRevision: 2 }), { organizationId, competitionId, applicationId })).status).toBe(403);
    expect(svc.listApplicationsForReview).not.toHaveBeenCalled();
    expect(svc.decideApplications).not.toHaveBeenCalled();
  });

  it("checks the producer action against the competition scope", async () => {
    const authorizer = { ...allow, authorizeAction: vi.fn(allow.authorizeAction) };
    const listApplicationsForReview = vi.fn(async () => []);
    await createApplicationHandlers(authorizer, service({ listApplicationsForReview })).listForReview(
      req(undefined, "https://engine.test/api?status=waitlisted&limit=10"), { organizationId, competitionId });
    expect(authorizer.authorizeAction).toHaveBeenCalledWith("Bearer token", "event.manage", { organizationId, competitionId });
    expect(listApplicationsForReview).toHaveBeenCalledWith(organizationId, competitionId, { status: "waitlisted", limit: 10, offset: undefined });
  });

  it("returns 404 for malformed ids without calling services", async () => {
    const svc = service();
    const h = createApplicationHandlers(allow, svc);
    expect((await h.getOwn(req(), { organizationId, competitionId, applicationId: "nope" })).status).toBe(404);
    expect((await h.getForm(req(), { organizationId: "x", competitionId })).status).toBe(404);
  });

  it("rejects invalid input", async () => {
    const h = createApplicationHandlers(allow, service());
    expect((await h.submit(req("{not json"), { organizationId, competitionId, applicationId })).status).toBe(400);
    expect((await h.putForm(req({ form: {}, expectedRevision: "1" }), { organizationId, competitionId })).status).toBe(400);
    expect((await h.bulkDecide(req({ decisions: "all" }), { organizationId, competitionId })).status).toBe(400);
    expect((await h.listForReview(req(undefined, "https://engine.test/api?limit=-1"), { organizationId, competitionId })).status).toBe(400);
  });

  it("maps domain failures to statuses", async () => {
    const thrower = (code: string) => vi.fn(async () => { throw new DomainError(code); });
    const params = { organizationId, competitionId, applicationId };
    const status = async (code: string) => (await createApplicationHandlers(allow, service({ decideApplications: thrower(code) }))
      .decide(req({ status: "selected", expectedRevision: 1 }), params)).status;
    expect(await status("application_revision_conflict")).toBe(409);
    expect(await status("selection_capacity_conflict")).toBe(409);
    expect(await status("invalid_state_transition")).toBe(409);
    expect(await status("application_not_found")).toBe(404);
    expect(await status("feature_disabled")).toBe(403);
    expect(await status("decision_reason_required")).toBe(400);
  });

  it("passes the producer identity, not the body, to decisions", async () => {
    const decideApplications = vi.fn(async () => [{ id: applicationId, status: "selected" }]);
    const res = await createApplicationHandlers(allow, service({ decideApplications: decideApplications as never }))
      .decide(req({ status: "selected", expectedRevision: 3, actorAccountId: "spoofed" }), { organizationId, competitionId, applicationId });
    expect(res.status).toBe(200);
    expect(decideApplications).toHaveBeenCalledWith(organizationId, competitionId, accountId,
      [{ applicationId, status: "selected", reason: undefined, expectedRevision: 3 }]);
  });

  it("returns 404 when the form or own application is missing", async () => {
    const h = createApplicationHandlers(allow, service({ getApplicationForm: vi.fn(async () => null), getOwnApplication: vi.fn(async () => null) }));
    expect((await h.getForm(req(), { organizationId, competitionId })).status).toBe(404);
    expect((await h.mine(req(), { organizationId, competitionId })).status).toBe(404);
  });
});
