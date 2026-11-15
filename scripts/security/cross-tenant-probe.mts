/**
 * LC-54 cross-tenant penetration probe.
 *
 * Seeds a "victim" tenant (with recognizable marker data) and an "attacker" tenant whose
 * account holds tenant_operator + event_producer + judge + performer grants in its OWN tenant.
 * It then calls every API route found under apps/web/src/app/api with every exported method:
 *
 *  A. victim tenant path, attacker session   -> must not be 2xx, must not be 5xx
 *  B. victim tenant path, anonymous          -> must not be 2xx (except public/allow-listed), not 5xx
 *  C. attacker tenant path, victim nested ids (IDOR) -> response must not contain victim markers/ids, not 5xx
 *
 * Usage (server must already be running against DATABASE_URL):
 *   BASE_URL=http://localhost:3100 node scripts/security/cross-tenant-probe.mts
 * Exit code 1 on any finding.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { AuthenticationService } from "@live-competition-engine/auth";
import { createPostgresAuthStore } from "@live-competition-engine/db/auth-store";
import { closeDatabaseConnection, getSqlClient } from "@live-competition-engine/db";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const API_ROOT = join(import.meta.dirname, "../../apps/web/src/app/api");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Routes that are intentionally reachable without a tenant session. */
const PUBLIC_PREFIXES = ["/api/public/", "/api/health", "/api/ready", "/api/signup", "/api/webhooks/", "/api/tenant-context", "/api/tenant-assets/", "/api/organizations/invitations/accept"];

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "route.ts" ? [path] : [];
  });
}

interface Seed { org: string; slug: string; account: string; token: string; competition: string; round: string; entry: string; participant: string; marker: string }

async function seedTenant(label: string): Promise<Seed> {
  const sql = getSqlClient();
  const org = randomUUID(), account = randomUUID(), competition = randomUUID(), round = randomUUID();
  const participant = randomUUID(), entry = randomUUID();
  const marker = `${label}-MARKER-${randomUUID().slice(0, 8)}`;
  const slug = `probe-${label.toLowerCase()}-${org.slice(0, 8)}`;
  await sql`INSERT INTO organizations (id, name, slug) VALUES (${org}, ${marker}, ${slug})`;
  await sql`INSERT INTO accounts (id, email) VALUES (${account}, ${`${marker.toLowerCase()}@example.test`})`;
  await sql`INSERT INTO organization_memberships (organization_id, account_id) VALUES (${org}, ${account})`;
  await sql`INSERT INTO competitions (id, organization_id, title, status) VALUES (${competition}, ${org}, ${marker}, 'published')`;
  await sql`INSERT INTO rounds (id, organization_id, competition_id, label, ordinal) VALUES (${round}, ${org}, ${competition}, ${marker}, 1)`;
  await sql`INSERT INTO participants (id, organization_id, display_name) VALUES (${participant}, ${org}, ${marker})`;
  await sql`INSERT INTO entries (id, organization_id, competition_id, participant_id, status) VALUES (${entry}, ${org}, ${competition}, ${participant}, 'approved')`;
  for (const [role, comp] of [["tenant_operator", null], ["event_producer", competition], ["judge", competition], ["performer", competition], ["viewer", null], ["industry_scout", null]] as const) {
    await sql`INSERT INTO role_grants (account_id, role, organization_id, competition_id, granted_by_account_id) VALUES (${account}, ${role}, ${org}, ${comp}, ${account})`;
  }
  const { token } = await new AuthenticationService(createPostgresAuthStore()).issueSession(account);
  return { org, slug, account, token, competition, round, entry, participant, marker };
}

function urlFor(template: string, tenant: Seed, nested: Seed): string {
  return template
    .replace("[organizationId]", tenant.org)
    .replace("[organizationSlug]", tenant.slug)
    .replace("[competitionId]", nested.competition)
    .replace("[roundId]", nested.round)
    .replace("[entryId]", nested.entry)
    .replace("[participantId]", nested.participant)
    .replace("[accountId]", nested.account)
    .replace(/\[(\.\.\.)?[A-Za-z]+\]/g, () => randomUUID());
}

interface Finding { mode: string; method: string; route: string; status: number; detail: string }

async function call(method: string, url: string, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE_URL}${url}`, {
    method, headers, redirect: "manual",
    ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" })
  });
  return { status: response.status, body: await response.text() };
}

async function main() {
  const victim = await seedTenant("VICTIM");
  const attacker = await seedTenant("ATTACKER");
  const victimSecrets = [victim.marker, victim.org, victim.competition, victim.round, victim.entry, victim.participant, victim.account];
  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  let requests = 0;

  for (const file of routeFiles(API_ROOT).sort()) {
    const route = "/api/" + relative(API_ROOT, file).replace(/\/?route\.ts$/, "");
    const source = readFileSync(file, "utf8");
    const methods = METHODS.filter(m => new RegExp(`export\\s+(async\\s+function|const|function)\\s+${m}\\b|export\\s*\\{[^}]*\\b${m}\\b`).test(source));
    const isPublic = PUBLIC_PREFIXES.some(prefix => route.startsWith(prefix));
    const tenantScoped = route.includes("[organizationId]") || route.includes("[organizationSlug]");
    for (const method of methods) {
      // A + B: victim path with attacker session and anonymously.
      for (const [mode, token] of [["attacker-session", attacker.token], ["anonymous", undefined]] as const) {
        if (isPublic && mode === "anonymous") continue;
        const url = urlFor(route, victim, victim);
        const { status, body } = await call(method, url, token);
        requests++;
        const leaked = victimSecrets.filter(secret => secret !== victim.org && body.includes(secret));
        if (status === 503 && /_not_configured"/.test(body)) {
          // Provider/worker credentials absent: failing closed is the correct behavior.
        } else if (status >= 500) findings.push({ mode, method, route, status, detail: body.slice(0, 160) });
        else if (status >= 200 && status < 300 && !isPublic && (tenantScoped || mode === "anonymous")) {
          // Optional-auth routes may answer anonymously, but only with public projections.
          if (mode === "attacker-session" || leaked.length || method !== "GET") {
            findings.push({ mode, method, route, status, detail: leaked.length ? `leaked ${leaked.length} victim identifier(s)` : body.slice(0, 160) });
          } else warnings.push({ mode, method, route, status, detail: "optional-auth public projection" });
        } else if (status === 400 && !isPublic) warnings.push({ mode, method, route, status, detail: "validation before authorization" });
      }
      // C: attacker's own tenant in the path, victim ids nested (IDOR).
      if (tenantScoped) {
        const url = urlFor(route, attacker, victim);
        const { status, body } = await call(method, url, attacker.token);
        requests++;
        const leaked = victimSecrets.filter(secret => body.includes(secret));
        if (status >= 500 && !(status === 503 && /_not_configured"/.test(body))) findings.push({ mode: "idor", method, route, status, detail: body.slice(0, 160) });
        else if (leaked.length) findings.push({ mode: "idor", method, route, status, detail: `leaked ${leaked.length} victim identifier(s)` });
      }
    }
  }

  console.log(`cross-tenant probe: ${requests} requests, ${findings.length} findings, ${warnings.length} warnings`);
  for (const f of findings) console.log(`FINDING ${f.mode} ${f.method} ${f.route} -> ${f.status} ${f.detail}`);
  if (process.env.PROBE_VERBOSE) for (const w of warnings) console.log(`warning ${w.mode} ${w.method} ${w.route} -> ${w.status}`);
  await closeDatabaseConnection();
  process.exit(findings.length ? 1 : 0);
}

await main();
