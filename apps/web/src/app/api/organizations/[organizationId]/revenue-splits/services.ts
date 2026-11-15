import { adjustSplit, createSplitRule, listSplitRules, partyAccountCode, payoutStatement } from "@live-competition-engine/db/revenue-splits";
import { authService } from "../../../../../lib/services";
import { createSplitHandlers } from "./handlers";

let handlers: ReturnType<typeof createSplitHandlers> | undefined;

export function splitHandlers() {
  handlers ??= createSplitHandlers(authService(), {
    list: listSplitRules,
    create: createSplitRule,
    adjust: adjustSplit,
    statement: payoutStatement,
    accountCode: partyAccountCode
  });
  return handlers;
}
