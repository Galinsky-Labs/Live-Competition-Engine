import { DomainError } from "./errors.ts";

/** LC-16 optional head-to-head structures. Nothing here is required by other formats. */

/** Standard bracket seed positions, e.g. size 8 → [1, 8, 4, 5, 2, 7, 3, 6]. */
export function seedPositions(size: number): number[] {
  if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) throw new DomainError(400, "bracket_size_must_be_power_of_two");
  let order = [1, 2];
  while (order.length < size) {
    const next = order.length * 2 + 1;
    order = order.flatMap(seed => [seed, next - seed]);
  }
  return order;
}

export interface PlannedMatchup {
  round: number;
  slot: number;
  entryA: string | null;
  entryB: string | null;
  seedA: number | null;
  seedB: number | null;
  /** Set when one side is a bye: the present entrant advances automatically. */
  byeWinner: string | null;
  next: { round: number; slot: number; side: "a" | "b" } | null;
}

/** Single elimination with byes to the top seeds. `seeded` is ordered best seed first. */
export function planSingleElimination(seeded: string[]): PlannedMatchup[] {
  if (new Set(seeded).size !== seeded.length) throw new DomainError(400, "duplicate_entrant");
  if (seeded.length < 2) throw new DomainError(400, "bracket_needs_two_entrants");
  if (seeded.length > 1024) throw new DomainError(400, "bracket_too_large");
  let size = 2;
  while (size < seeded.length) size *= 2;
  const positions = seedPositions(size);
  const rounds = Math.log2(size);
  const matchups: PlannedMatchup[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const count = size / 2 ** round;
    for (let slot = 0; slot < count; slot += 1) {
      const next = round < rounds ? { round: round + 1, slot: Math.floor(slot / 2), side: (slot % 2 === 0 ? "a" : "b") as "a" | "b" } : null;
      if (round === 1) {
        const seedA = positions[slot * 2]!, seedB = positions[slot * 2 + 1]!;
        const entryA = seeded[seedA - 1] ?? null, entryB = seeded[seedB - 1] ?? null;
        matchups.push({
          round, slot, entryA, entryB,
          seedA: entryA ? seedA : null, seedB: entryB ? seedB : null,
          byeWinner: entryA && !entryB ? entryA : !entryA && entryB ? entryB : null,
          next
        });
      } else {
        matchups.push({ round, slot, entryA: null, entryB: null, seedA: null, seedB: null, byeWinner: null, next });
      }
    }
  }
  // Byes advance immediately into round two.
  for (const m of matchups.filter(m => m.round === 1 && m.byeWinner && m.next)) {
    const target = matchups.find(t => t.round === m.next!.round && t.slot === m.next!.slot)!;
    if (m.next!.side === "a") { target.entryA = m.byeWinner; target.seedA = m.seedA ?? m.seedB; }
    else { target.entryB = m.byeWinner; target.seedB = m.seedA ?? m.seedB; }
  }
  return matchups;
}

/** Round-robin pairings via the circle method; each pair meets exactly once. */
export function planRoundRobin(entrants: string[]): Array<{ round: number; slot: number; entryA: string; entryB: string }> {
  if (new Set(entrants).size !== entrants.length) throw new DomainError(400, "duplicate_entrant");
  if (entrants.length < 2) throw new DomainError(400, "round_robin_needs_two_entrants");
  if (entrants.length > 64) throw new DomainError(400, "round_robin_too_large");
  const list: Array<string | null> = entrants.length % 2 === 0 ? [...entrants] : [...entrants, null];
  const n = list.length;
  const result: Array<{ round: number; slot: number; entryA: string; entryB: string }> = [];
  for (let round = 1; round < n; round += 1) {
    let slot = 0;
    for (let i = 0; i < n / 2; i += 1) {
      const a = list[i], b = list[n - 1 - i];
      if (a && b) result.push({ round, slot: slot++, entryA: a, entryB: b });
    }
    list.splice(1, 0, list.pop()!);
  }
  return result;
}
