/**
 * Read-along helpers: which line is being spoken, and how a person moving
 * the page by hand is told apart from the page following the voice. No
 * imports, so the phone page and the tests use the same code.
 */

export interface Timed {
  start: number;
  end: number;
}

/** The line being spoken at `t` seconds: the last one that has started, or -1 before the first. */
export function lineAt(lines: Timed[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.start <= t + 0.05) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Seconds as m:ss or h:mm:ss. */
export function stamp(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
