/**
 * Words for the walk list on the home screen. No imports, so the same file
 * runs in the browser and in the tests.
 */

/** "12 min", "1 h 12 min", "2 h": walking time, rounded to the minute. */
export function walkTime(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** "saved today", "saved yesterday", "saved 3 days ago", "saved 2 weeks ago", "saved 3 months ago". */
export function savedAgo(savedAt: string, now: Date = new Date()): string {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((day(now) - day(new Date(savedAt))) / 86_400_000);
  if (days <= 0) return 'saved today';
  if (days === 1) return 'saved yesterday';
  if (days < 14) return `saved ${days} days ago`;
  if (days < 60) return `saved ${Math.round(days / 7)} weeks ago`;
  return `saved ${Math.round(days / 30)} months ago`;
}

/** A row's name: a part of a series says which part it is. */
export function rowTitle(item: { title: string; part?: number; parts?: number }): string {
  return item.part && item.parts ? `Part ${item.part} of ${item.parts} · ${item.title}` : item.title;
}

/** "1 thing", "4 things": the list's own count. */
export function things(n: number): string {
  return `${n} ${n === 1 ? 'thing' : 'things'}`;
}

/** The status line after a save from the bookmarklet or the add box. */
export function savedLine(added: number, existing: number, waiting: number): string {
  const tail = `${things(waiting)} waiting for a walk.`;
  if (!added && existing) return `${existing === 1 ? 'Already in your list' : 'All of these are already in your list'}. ${tail}`;
  return `Saved. ${tail}`;
}
