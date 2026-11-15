import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError } from "./errors.ts";

/** LC-28 voting rules and LC-29 integrity helpers (privacy-preserving voter keys, hash chain, anomalies). */
export const voteWindowInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  stageId: z.uuid().optional(),
  matchupId: z.uuid().optional(),
  options: z.array(z.uuid()).min(2).max(200).optional(),
  eligibility: z.enum(["any_account", "tenant_members", "entitled"]).default("any_account"),
  maxVotesPerVoter: z.number().int().min(1).max(100).default(1),
  maxVotesPerIp: z.number().int().min(1).max(100000).nullable().default(null),
  memberWeight: z.number().min(0.1).max(10).default(1),
  visibility: z.enum(["live", "after_close", "hidden"]).default("after_close"),
  opensAt: z.iso.datetime().optional(),
  closesAt: z.iso.datetime().optional()
}).strict().refine(w => !w.opensAt || !w.closesAt || Date.parse(w.closesAt) > Date.parse(w.opensAt), { message: "closesAt must follow opensAt", path: ["closesAt"] })
  .refine(w => !(w.stageId && w.matchupId), { message: "choose a stage or a matchup", path: ["matchupId"] });
export type VoteWindowInput = z.infer<typeof voteWindowInputSchema>;

export type WindowStatus = "scheduled" | "open" | "closed";
export function windowState(w: { status: WindowStatus; opensAt: Date | null; closesAt: Date | null }, now: Date): "not_open" | "open" | "closed" {
  if (w.status === "closed") return "closed";
  if (w.status === "scheduled") return "not_open";
  if (w.opensAt && now < w.opensAt) return "not_open";
  if (w.closesAt && now >= w.closesAt) return "closed";
  return "open";
}

/** Voter key: unlinkable across windows without the per-window secret; no account id is stored with votes. */
export const voterKey = (windowSecret: string, accountId: string) => createHash("sha256").update(`voter\0${windowSecret}\0${accountId}`).digest("hex");
export const networkKey = (daySecret: string, ip: string) => createHash("sha256").update(`ip\0${daySecret}\0${ip}`).digest("hex");

export interface ChainVote { windowId: string; voterHash: string; entryId: string; weight: string; castAt: string; prevHash: string }
export const GENESIS = "0".repeat(64);
export const voteHash = (v: ChainVote) => createHash("sha256").update([v.prevHash, v.windowId, v.voterHash, v.entryId, v.weight, v.castAt].join("|")).digest("hex");

/** Recomputes the chain; returns the index of the first broken link or -1 when intact. */
export function verifyChain(votes: Array<ChainVote & { rowHash: string }>): number {
  let prev = GENESIS;
  for (let i = 0; i < votes.length; i += 1) {
    const v = votes[i]!;
    if (v.prevHash !== prev || voteHash(v) !== v.rowHash) return i;
    prev = v.rowHash;
  }
  return -1;
}

export interface Anomaly { kind: "burst" | "network_concentration" | "new_account_surge"; detail: string; severity: "info" | "warn" }

/** Heuristics only; they flag for human review and never discard votes by themselves. */
export function detectAnomalies(votes: Array<{ castAt: Date; ipHash: string | null; newAccount: boolean }>): Anomaly[] {
  const out: Anomaly[] = [];
  if (votes.length < 20) return out;
  const perMinute = new Map<number, number>();
  for (const v of votes) perMinute.set(Math.floor(v.castAt.getTime() / 60000), (perMinute.get(Math.floor(v.castAt.getTime() / 60000)) ?? 0) + 1);
  const counts = [...perMinute.values()].sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)]!;
  const peak = counts[counts.length - 1]!;
  if (counts.length >= 3 && peak >= 20 && peak > median * 5) out.push({ kind: "burst", detail: `peak ${peak}/min vs median ${median}/min`, severity: "warn" });
  const perIp = new Map<string, number>();
  for (const v of votes) if (v.ipHash) perIp.set(v.ipHash, (perIp.get(v.ipHash) ?? 0) + 1);
  const top = Math.max(0, ...perIp.values());
  if (top / votes.length > 0.2 && top >= 10) out.push({ kind: "network_concentration", detail: `${top} of ${votes.length} votes share one network`, severity: "warn" });
  const fresh = votes.filter(v => v.newAccount).length;
  if (fresh / votes.length > 0.5) out.push({ kind: "new_account_surge", detail: `${fresh} of ${votes.length} votes from accounts under 24h old`, severity: "info" });
  return out;
}

export function assertVoteAllowed(input: { state: "not_open" | "open" | "closed"; validOption: boolean; votesByVoter: number; maxVotesPerVoter: number; votesByNetwork: number; maxVotesPerIp: number | null }) {
  if (input.state !== "open") throw new DomainError(409, input.state === "closed" ? "voting_closed" : "voting_not_open");
  if (!input.validOption) throw new DomainError(400, "invalid_vote_option");
  if (input.votesByVoter >= input.maxVotesPerVoter) throw new DomainError(409, "vote_limit_reached");
  if (input.maxVotesPerIp !== null && input.votesByNetwork >= input.maxVotesPerIp) throw new DomainError(429, "network_vote_limit_reached");
}
