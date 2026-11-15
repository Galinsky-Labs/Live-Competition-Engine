import { z } from "zod";
import { DomainError } from "./errors.ts";

/** LC-17 applications and LC-18 producer decisions. */
export const applicationStatuses = ["submitted", "under_review", "selected", "waitlisted", "rejected", "withdrawn"] as const;
export type ApplicationStatus = (typeof applicationStatuses)[number];

type Actor = "applicant" | "producer";
const producerMoves: Record<ApplicationStatus, ApplicationStatus[]> = {
  submitted: ["under_review", "selected", "waitlisted", "rejected"],
  under_review: ["selected", "waitlisted", "rejected"],
  waitlisted: ["selected", "rejected"],
  selected: ["rejected"],
  rejected: ["under_review"],
  withdrawn: []
};
const applicantMoves: Record<ApplicationStatus, ApplicationStatus[]> = {
  submitted: ["withdrawn"], under_review: ["withdrawn"], waitlisted: ["withdrawn"], selected: ["withdrawn"], rejected: [], withdrawn: []
};

/** Validates a decision; reversals of a selection or rejection must carry a reason. */
export function assertApplicationMove(actor: Actor, from: ApplicationStatus, to: ApplicationStatus, reason?: string | null) {
  const allowed = (actor === "producer" ? producerMoves : applicantMoves)[from];
  if (!allowed.includes(to)) throw new DomainError(409, "invalid_application_transition", `${actor} cannot move application from ${from} to ${to}`);
  if (actor === "producer" && (from === "selected" || from === "rejected") && (!reason || reason.trim().length < 3)) {
    throw new DomainError(400, "decision_reason_required");
  }
}

export const isApplicantEditable = (status: ApplicationStatus) => status === "submitted" || status === "under_review";

export const applicationInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  kind: z.enum(["individual", "group"]).default("individual"),
  members: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  statement: z.string().trim().max(4000).optional(),
  mediaIds: z.array(z.uuid()).max(10).default([]),
  consent: z.object({ accepted: z.literal(true), version: z.string().min(1).max(40) }).strict()
}).strict();
export type ApplicationInput = z.infer<typeof applicationInputSchema>;
