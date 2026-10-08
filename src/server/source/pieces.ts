/**
 * Playlist walks: several sources read one after another into one Walk
 * Edition. One source is a piece; a single-source walk is a walk with one.
 */

import type { SourceInput } from './index.js';
import { dropBackMatter, splitSections, type Section } from './sections.js';
import { SourceError, type SourceDoc } from './types.js';

export const MAX_PIECES = 8;

/** The title paste mode gives a text that has none. */
const UNTITLED = 'your pasted text';

export interface Piece {
  doc: SourceDoc;
  sections: Section[];
  /** Headings of reference and link lists, and adapter removals, left out of this piece. */
  leftOut: string[];
}

export interface Skipped {
  /** What the person gave: a link, a file name or a text title. */
  label: string;
  reason: string;
}

/** A short name for a source the person gave, for "could not use" notes. */
export function sourceLabel(input: SourceInput): string {
  if (input.kind === 'url') {
    try {
      const u = new URL(input.url.trim());
      const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
      const short = `${u.hostname.replace(/^www\./, '')}${path}`;
      return short.length > 60 ? `${short.slice(0, 57)}...` : short;
    } catch {
      return input.url.trim().slice(0, 60);
    }
  }
  if (input.kind === 'file') return input.name;
  if (input.kind === 'saved') return input.doc.title;
  return input.title?.trim() || 'Pasted text';
}

/** Sections of one source, with back matter left out and untitled texts named sensibly. */
export function pieceSections(doc: SourceDoc): { sections: Section[]; dropped: string[] } {
  const { kept, dropped } = dropBackMatter(splitSections(doc.markdown));
  let sections = kept;
  // A text with no headings at all is not an "Opening": one section carries the title, parts are numbered.
  if (sections.every((s) => s.heading === 'Opening')) {
    sections = sections.length === 1 ? [{ ...sections[0]!, heading: doc.title }] : sections.map((s) => ({ ...s, heading: '' }));
  }
  return { sections, dropped };
}

export type ReadFn = (input: SourceInput, signal?: AbortSignal) => Promise<SourceDoc>;

/**
 * Reads every source. With one source, its error is the walk's error, as it
 * always was. With several, a source that cannot be read (or has no text) is
 * skipped and named; only when every source fails does the walk fail, with
 * the first reason.
 */
export async function readPieces(inputs: SourceInput[], read: ReadFn, signal?: AbortSignal): Promise<{ pieces: Piece[]; skipped: Skipped[] }> {
  if (inputs.length === 1) {
    const doc = await read(inputs[0]!, signal);
    const { sections, dropped } = pieceSections(doc);
    return { pieces: [{ doc, sections, leftOut: [...(doc.leftOut ?? []), ...dropped] }], skipped: [] };
  }
  const pieces: Piece[] = [];
  const skipped: Skipped[] = [];
  let firstError: unknown = null;
  let untitled = 0;
  for (const input of inputs) {
    signal?.throwIfAborted();
    try {
      const got = await read(input, signal);
      // Several pasted texts without a title get numbers, so the bridges can tell them apart.
      const doc = got.title === UNTITLED ? { ...got, title: `Pasted text ${untitled + 1}` } : got;
      const { sections, dropped } = pieceSections(doc);
      if (!sections.length) throw new SourceError('There is no text to read in it.');
      if (doc !== got) untitled++;
      pieces.push({ doc, sections, leftOut: [...(doc.leftOut ?? []), ...dropped] });
    } catch (err) {
      if (signal?.aborted) throw err;
      firstError ??= err;
      // Source errors are written for people; anything else gets a plain sentence.
      skipped.push({ label: sourceLabel(input), reason: err instanceof SourceError ? err.message : 'It could not be read.' });
    }
  }
  if (!pieces.length) throw firstError;
  return { pieces, skipped };
}

/** One title for the whole walk: the piece's own, "A and B", or "A and 3 more". */
export function walkTitle(titles: string[]): string {
  if (titles.length <= 1) return titles[0] ?? 'Walk';
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles[0]} and ${titles.length - 1} more`;
}

/** The app's line between two pieces. */
export function bridgeText(title: string): string {
  return `Next: ${title.replace(/[.!?]+$/, '')}.`;
}

/** The second cue on long walks. */
export function threeQuarterText(minutesLeft: number): string {
  const n = Math.max(1, Math.round(minutesLeft));
  return `About ${n} ${n === 1 ? 'minute' : 'minutes'} left.`;
}

/** Walks this long (measured, with a 5% tolerance) get the three-quarter cue. */
export const THREE_QUARTER_MINUTES = 45;

export function wantsThreeQuarter(totalSeconds: number): boolean {
  return totalSeconds >= THREE_QUARTER_MINUTES * 60 * 0.95;
}
