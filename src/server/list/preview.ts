/**
 * What the "Your walk" panel shows: the build's own first plan, made from the
 * same saved sources, so "in full", "condensed from 27 min" and the total
 * agree with the walk that comes out.
 */

import { firstPlan, walkSource } from '../pipeline.js';
import { SECTION_GAP, wordsToSeconds } from '../script/budget.js';
import type { Piece } from '../source/pieces.js';

export interface PiecePreview {
  id: string;
  title: string;
  /** Read in full. */
  fullMinutes: number;
  /** As planned for this walk. */
  minutes: number;
  treatment: 'full' | 'condensed';
}

export interface WalkPreview {
  pieces: PiecePreview[];
  /** The whole walk as planned, the app's own lines included. */
  minutes: number;
  targetMinutes: number | null;
  mode: 'full' | 'condensed';
}

const round = (m: number) => Math.round(m * 10) / 10;

export function previewFrom(pieces: Piece[], ids: string[], minutes: number | null, wpm: number): WalkPreview {
  const { info, sections } = walkSource(pieces, []);
  const { plan } = firstPlan(info, sections, minutes, wpm);
  const seconds = (words: number, count: number) => wordsToSeconds(words, wpm) + Math.max(0, count - 1) * SECTION_GAP;
  const out = pieces.map((p, i) => {
    const own = plan.sections.filter((s) => (s.piece ?? 0) === i);
    const full = own.reduce((n, s) => n + s.fullWords, 0);
    const planned = own.reduce((n, s) => n + s.targetWords, 0);
    return {
      id: ids[i] ?? '',
      title: p.doc.title,
      fullMinutes: round(seconds(full, own.length) / 60),
      minutes: round(seconds(planned, own.length) / 60),
      treatment: own.every((s) => s.treatment === 'full') ? ('full' as const) : ('condensed' as const),
    };
  });
  const content = plan.sections.reduce((n, s) => n + s.targetWords, 0);
  const total = plan.mode === 'full' ? plan.fullSeconds : wordsToSeconds(content, wpm) + plan.fixedSeconds;
  return { pieces: out, minutes: round(total / 60), targetMinutes: minutes, mode: plan.mode };
}
