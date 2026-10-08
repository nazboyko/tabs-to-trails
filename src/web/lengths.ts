/**
 * Walk lengths in words a person reads at a glance. No imports, so the same
 * file runs in the browser and in the tests.
 */

/** Seconds as m:ss (or h:mm:ss for very long walks). */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "about 34 min" style rounding for estimates. */
export function aboutMinutes(seconds: number): string {
  return `about ${Math.max(1, Math.round(seconds / 60))} min`;
}

/** A walk this far over its target is called over, plainly. */
export const OVER_TOLERANCE = 0.05;

export interface AskedInput {
  targetSeconds: number | null;
  actualSeconds: number;
  /** What the walk turned out to be: full when every section is read as written. */
  mode: 'full' | 'condensed';
  sourceWords: number;
  scriptWords: number;
  /** The plan's estimate of the whole source read in full. */
  fullSeconds: number;
  /** How many sources the walk reads, one after another. */
  pieces?: number;
}

/** The line under the measured length on the Ready screen. */
export function askedLine(w: AskedInput): string {
  const { targetSeconds: target, actualSeconds: actual } = w;
  if (target === null) return 'The whole thing, read in full.';
  if (actual > target * (1 + OVER_TOLERANCE)) {
    return `You asked for ${clock(target)}. This one runs ${clock(actual - target)} longer${w.mode === 'full' ? ', read in full' : ''}.`;
  }
  if (w.mode === 'full' && actual < target * 0.9) {
    // Nothing is padded: a short source makes a short walk, and the line says so.
    const shorter = (w.pieces ?? 1) > 1 ? 'Together they run shorter' : 'This one is shorter';
    return `You asked for ${clock(target)}. ${shorter}, so nothing was cut.`;
  }
  if (w.mode === 'full') return `You asked for ${clock(target)} · read in full`;
  // The full-length estimate uses this walk's own measured pace.
  const fullEstimate = w.scriptWords > 0 ? (actual * w.sourceWords) / w.scriptWords : w.fullSeconds;
  return `You asked for ${clock(target)} · read in full it's ${aboutMinutes(fullEstimate)}`;
}
