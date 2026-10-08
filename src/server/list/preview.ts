/**
 * What the "Your walk" panel shows: the build's own first plan, made from the
 * same saved sources, so "in full", "condensed from 27 min" and the total
 * agree with the walk that comes out.
 */

import { firstPlan, walkSource } from '../pipeline.js';
import { SECTION_GAP, wordsToSeconds } from '../script/budget.js';
import type { Piece } from '../source/pieces.js';
import type { Section } from '../source/sections.js';
import { splitSeries } from './series.js';

export interface PiecePreview {
  id: string;
  title: string;
  /** Read in full. */
  fullMinutes: number;
  /** As planned for this walk. */
  minutes: number;
  treatment: 'full' | 'condensed';
  /** For a piece more than twice the walk: how many walks it would make as a series. */
  splitParts?: number;
}

export interface WalkPreview {
  pieces: PiecePreview[];
  /** The whole walk as planned, the app's own lines included. */
  minutes: number;
  targetMinutes: number | null;
  mode: 'full' | 'condensed';
  /** Minutes of silence at the end. */
  quietMinutes: number;
}

const round = (m: number) => Math.round(m * 10) / 10;

/** One piece as a series of walks of this length: each part about what one walk reads in full. */
export function seriesFor(piece: Piece, minutes: number, wpm: number): Section[][] {
  const { info, sections } = walkSource([piece], []);
  const { plan } = firstPlan(info, sections, minutes, wpm);
  return splitSeries(sections, plan.budgetWords ?? Math.floor((minutes * wpm) / 1.1));
}

/** A piece this many times longer than the walk is offered as a series. */
export const SERIES_FACTOR = 2;

/**
 * `pieceWpm` is each piece's own pace (its row's pace); without it every
 * piece is read at `wpm`. A piece's full minutes here are its row's minutes.
 */
export function previewFrom(
  pieces: Piece[],
  ids: string[],
  minutes: number | null,
  wpm: number,
  quietMinutes = 0,
  pieceWpm: number[] = pieces.map(() => wpm),
): WalkPreview {
  const { info, sections } = walkSource(pieces, []);
  const quiet = minutes === null ? 0 : quietMinutes;
  const { plan } = firstPlan(info, sections, minutes, wpm, quiet, pieceWpm);
  const seconds = (words: number, count: number, pace: number) => wordsToSeconds(words, pace) + Math.max(0, count - 1) * SECTION_GAP;
  let content = 0;
  const out = pieces.map((p, i) => {
    const own = plan.sections.filter((s) => (s.piece ?? 0) === i);
    const full = own.reduce((n, s) => n + s.fullWords, 0);
    const planned = own.reduce((n, s) => n + s.targetWords, 0);
    content += wordsToSeconds(planned, pieceWpm[i] ?? wpm);
    return {
      id: ids[i] ?? '',
      title: p.doc.title,
      fullMinutes: round(seconds(full, own.length, pieceWpm[i] ?? wpm) / 60),
      minutes: round(seconds(planned, own.length, pieceWpm[i] ?? wpm) / 60),
      treatment: own.every((s) => s.treatment === 'full') ? ('full' as const) : ('condensed' as const),
    };
  });
  const total = plan.mode === 'full' ? plan.fullSeconds : content + plan.fixedSeconds;
  return { pieces: out, minutes: round(total / 60), targetMinutes: minutes, mode: plan.mode, quietMinutes: quiet };
}
