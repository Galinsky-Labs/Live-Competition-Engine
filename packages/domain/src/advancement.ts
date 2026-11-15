import { z } from "zod";
import { DomainError } from "./index.ts";

/** LC-15 advancement contracts (shared by stage definitions and LC-14 template phases). */
export const advancementContractSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("top_n"),
    count: z.int().min(1).max(10_000),
    /** include: whole tie group at the cut advances; exclude: none of it; seed: break by seed, then entry id. */
    ties: z.enum(["include", "exclude", "seed"])
  }),
  z.strictObject({
    type: z.literal("score_threshold"),
    minScore: z.number().finite(),
    inclusive: z.boolean()
  }),
  z.strictObject({
    type: z.literal("manual"),
    maxSelections: z.int().min(1).max(10_000).optional()
  }),
  z.strictObject({ type: z.literal("bracket") })
]);

export type AdvancementContract = z.infer<typeof advancementContractSchema>;

export function parseAdvancementContract(input: unknown): AdvancementContract {
  const result = advancementContractSchema.safeParse(input);
  if (!result.success) throw new DomainError("invalid_advancement_contract");
  return result.data;
}
