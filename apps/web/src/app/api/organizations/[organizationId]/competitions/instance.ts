import { isEventStatus, parseEventCreate, parseEventPatch } from "@live-competition-engine/domain/events";
import {
  createEvent,
  getEvent,
  getPublicEvent,
  listEventHistory,
  listManagedEvents,
  listPublicEvents,
  transitionEvent,
  updateEvent
} from "@live-competition-engine/db/events";
import { authService } from "../../../../../lib/services";
import { createEventHandlers } from "./handler";

export const eventHandlers = createEventHandlers(authService(), {
  parseCreate: parseEventCreate,
  parsePatch: parseEventPatch,
  isStatus: isEventStatus,
  create: createEvent,
  get: getEvent,
  history: listEventHistory,
  update: updateEvent,
  transition: transitionEvent,
  getPublic: getPublicEvent,
  listPublic: listPublicEvents,
  listManaged: listManagedEvents
});
