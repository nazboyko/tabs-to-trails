/**
 * Which rows make the walk for a length. No model and no imports, so the rule
 * runs in the browser and in the tests. The order is the next part of a
 * series first, then the oldest saved; first fit in that order, and best fit
 * when first fit leaves too much of the walk empty.
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
/** First fit that fills less than this share of the length gives way to best fit. */
export const FIRST_FIT_ENOUGH = 0.8;
/** Best fit looks at this many rows at most, in pick order, so a long list stays quick. */
const BEST_FIT_ROWS = 40;

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
 * nothing). First fit: tick rows in order while the total stays within the
 * length plus 5%, skip a row that would overflow and go on to later, shorter
 * ones; if every row is longer than the length, the first one alone (it will
 * be condensed). When that fills less than 80% of the length, best fit: the
 * set of up to 8 rows whose total is closest to the length without going
 * over 105%, the order deciding between equally close sets. A next series
 * part stays in the pick either way.
 */
export function pickWalk(rows: PickRow[], target: number | null): string[] {
  if (target === null) return [];
  const order = pickOrder(rows);
  const limit = target * (1 + PICK_TOLERANCE);
  const picked: PickRow[] = [];
  let total = 0;
  for (const r of order) {
    if (picked.length >= MAX_PICKED) break;
    if (total + r.minutes <= limit) {
      picked.push(r);
      total += r.minutes;
    }
  }
  if (!picked.length && order.length) return [order[0]!.id];
  if (total >= target * FIRST_FIT_ENOUGH) return picked.map((r) => r.id);
  const best = bestFit(order, target, limit);
  return (best ?? picked).map((r) => r.id);
}

/** Lists of positions in pick order; the earlier list is the one the order prefers. */
function earlier(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return a.length < b.length;
}

/**
 * The set closest to the length within the limit, by a small knapsack over
 * hundredths of a minute. The next series part (first in the order, when
 * there is one) is always in it.
 */
function bestFit(order: PickRow[], target: number, limit: number): PickRow[] | null {
  const unit = (m: number) => Math.round(m * 100);
  const required = order[0]?.seriesId ? order[0] : null;
  const pool = order.slice(required ? 1 : 0, BEST_FIT_ROWS);
  const base = required ? unit(required.minutes) : 0;
  const cap = Math.floor(limit * 100 + 1e-6) - base;
  const slots = MAX_PICKED - (required ? 1 : 0);
  if (cap < 0) return required ? [required] : null;
  // sets[k] maps a total (in hundredths) to the order-preferred list of k positions with that total.
  const sets: Map<number, number[]>[] = Array.from({ length: slots + 1 }, () => new Map());
  sets[0]!.set(0, []);
  pool.forEach((row, i) => {
    const w = unit(row.minutes);
    if (w > cap) return;
    for (let k = Math.min(slots, i + 1); k >= 1; k--) {
      for (const [sum, list] of sets[k - 1]!) {
        const next = sum + w;
        if (next > cap) continue;
        const candidate = [...list, i];
        const known = sets[k]!.get(next);
        if (!known || earlier(candidate, known)) sets[k]!.set(next, candidate);
      }
    }
  });
  const goal = unit(target) - base;
  let best: number[] | null = required ? [] : null;
  let bestSum = 0;
  for (let k = required ? 0 : 1; k <= slots; k++) {
    for (const [sum, list] of sets[k]!) {
      const d = Math.abs(sum - goal);
      const bd = best === null ? Infinity : Math.abs(bestSum - goal);
      if (best === null || d < bd || (d === bd && earlier(list, best))) {
        best = list;
        bestSum = sum;
      }
    }
  }
  if (best === null) return null;
  return [...(required ? [required] : []), ...best.map((i) => pool[i]!)];
}
