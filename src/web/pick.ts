/**
 * Which rows make the walk for a length. No model and no imports, so the rule
 * runs in the browser and in the tests, and a person can follow it:
 * the next part of a series first, then the oldest saved, first fit.
 */

export interface PickRow {
  id: string;
  minutes: number;
  status: string;
  savedAt: string;
  seriesId?: string;
  part?: number;
}

/** A walk may run this much over the length before a row counts as too long for it. */
export const PICK_TOLERANCE = 0.05;
export const MAX_PICKED = 8;

/** Ready rows in the order they are considered: next-in-line series parts, then everything else, oldest saved first. */
export function pickOrder(rows: PickRow[]): PickRow[] {
  const ready = rows.filter((r) => r.status === 'ready');
  // Only the lowest waiting part of a series can go into the next walk.
  const next = new Map<string, PickRow>();
  for (const r of ready) {
    if (!r.seriesId) continue;
    const seen = next.get(r.seriesId);
    if (!seen || (r.part ?? 0) < (seen.part ?? 0)) next.set(r.seriesId, r);
  }
  const byAge = (a: PickRow, b: PickRow) => a.savedAt.localeCompare(b.savedAt);
  const parts = [...next.values()].sort(byAge);
  const rest = ready.filter((r) => !r.seriesId).sort(byAge);
  return [...parts, ...rest];
}

/**
 * The proposal for a length in minutes (null is "Everything", which proposes
 * nothing): tick rows while the total stays within the length plus 5%, skip a
 * row that would overflow and go on to later, shorter ones. If every row is
 * longer than the length, the first one alone (it will be condensed).
 */
export function pickWalk(rows: PickRow[], target: number | null): string[] {
  if (target === null) return [];
  const order = pickOrder(rows);
  const limit = target * (1 + PICK_TOLERANCE);
  const picked: string[] = [];
  let total = 0;
  for (const r of order) {
    if (picked.length >= MAX_PICKED) break;
    if (total + r.minutes <= limit) {
      picked.push(r.id);
      total += r.minutes;
    }
  }
  if (!picked.length && order.length) picked.push(order[0]!.id);
  return picked;
}
