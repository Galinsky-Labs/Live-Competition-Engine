import * as controlRoom from "@live-competition-engine/db/control-room";
import { authService } from "../../../../../../../lib/services";
import { createControlRoomHandlers } from "./handler";

let handlers: ReturnType<typeof createControlRoomHandlers> | undefined;
export function controlRoomHandlers() {
  handlers ??= createControlRoomHandlers(authService(), {
    ...controlRoom,
    getControlRoom: (o, c) => controlRoom.getControlRoom(o, c)
  });
  return handlers;
}
