import { DomainError, isUuid } from "./index.ts";

/**
 * LC-18 producer selection: lineup (slot) planning and panel roles. Pure functions.
 */

export const MAX_LINEUP = 500;
export const panelRoles = ["panelist", "head"] as const;
export type PanelRole = (typeof panelRoles)[number];

export interface CurrentSlot {
  performanceId: string;
  entryId: string;
  ordinal: number;
  /** Only queued performances may be moved or removed. */
  status: "queued" | "live" | "completed" | "skipped";
}

export interface LineupPlan {
  /** Performances that keep their row but change position. */
  moves: { performanceId: string; ordinal: number }[];
  /** New performances to create. */
  inserts: { entryId: string; ordinal: number }[];
  /** Queued performances to delete (their entries were removed from the lineup). */
  deletes: string[];
  /** Final order, 1-based. */
  order: { entryId: string; ordinal: number }[];
}

/** Validate the desired order: unique entry ids, bounded. */
export function parseLineup(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_LINEUP || !raw.every(isUuid)) throw new DomainError("invalid_lineup");
  const ids = (raw as string[]).map(id => id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new DomainError("invalid_lineup");
  return ids;
}

/**
 * Turn the current slots and the desired order of entries into the minimal set of
 * row changes. Started (non-queued) performances are immutable: they must stay in the
 * lineup at the same position, or the plan is refused.
 */
export function planLineup(current: readonly CurrentSlot[], desired: readonly string[]): LineupPlan {
  const byEntry = new Map<string, CurrentSlot>();
  for (const slot of current) {
    if (byEntry.has(slot.entryId)) throw new DomainError("invalid_state_duplicate_slot");
    byEntry.set(slot.entryId, slot);
  }
  const order = desired.map((entryId, index) => ({ entryId, ordinal: index + 1 }));
  const wanted = new Set(desired);
  const moves: LineupPlan["moves"] = [];
  const inserts: LineupPlan["inserts"] = [];
  const deletes: string[] = [];
  for (const slot of current) {
    if (!wanted.has(slot.entryId)) {
      if (slot.status !== "queued") throw new DomainError("invalid_state_performance_started");
      deletes.push(slot.performanceId);
    }
  }
  for (const { entryId, ordinal } of order) {
    const slot = byEntry.get(entryId);
    if (!slot) inserts.push({ entryId, ordinal });
    else if (slot.ordinal !== ordinal) {
      if (slot.status !== "queued") throw new DomainError("invalid_state_performance_started");
      moves.push({ performanceId: slot.performanceId, ordinal });
    }
  }
  return { moves, inserts, deletes, order };
}

export function parsePanelRole(value: unknown): PanelRole {
  if (value === undefined) return "panelist";
  if (typeof value !== "string" || !(panelRoles as readonly string[]).includes(value)) throw new DomainError("invalid_panel_role");
  return value as PanelRole;
}
