import * as timers from "@live-competition-engine/db/timers";
import { authService } from "../../../../../../../lib/services";
import { createTimerHandlers } from "./handler";

let handlers: ReturnType<typeof createTimerHandlers> | undefined;
export function timerHandlers() {
  handlers ??= createTimerHandlers(authService(), {
    createTimer: timers.createTimer,
    listTimers: (o, c) => timers.listTimers(o, c),
    getTimer: (o, id) => timers.getTimer(o, id),
    issueTimerCommand: (o, id, actor, input) => timers.issueTimerCommand(o, id, actor, input),
    getTimerLog: timers.getTimerLog
  });
  return handlers;
}
