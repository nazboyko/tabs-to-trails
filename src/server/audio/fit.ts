/**
 * The fit pass: one look at the measured audio. If the walk runs more than 5%
 * over its target, the largest condensed section is shortened by what is
 * missing; if it runs more than 8% under, the condensed section with the most
 * of its source left out gets that time back. Either way it happens once, and
 * only that section is voiced again. No tempo stretching, no filler.
 */

import { MENTION_WORDS } from '../script/budget.js';

export const FIT_TOLERANCE = 0.05;
export const UNDER_TOLERANCE = 0.08;
/** A lengthening smaller than this is not worth a rewrite. */
export const MIN_ADDED_WORDS = 30;

export interface FitSection {
  id: string;
  treatment: 'full' | 'condensed' | 'mention';
  words: number;
  /** Words the section has when read in full. */
  fullWords: number;
  seconds: number;
}

export interface FitDecision {
  sectionId: string;
  fromWords: number;
  toWords: number;
  /** Positive when the walk ran over, negative when it ran under. */
  overSeconds: number;
}

export function decideFit(targetSeconds: number | null, totalSeconds: number, sections: FitSection[]): FitDecision | null {
  if (targetSeconds === null) return null;
  const condensed = sections.filter((s) => s.treatment !== 'full' && s.words > 0 && s.seconds > 0);
  if (!condensed.length) return null;

  if (totalSeconds > targetSeconds * (1 + FIT_TOLERANCE)) {
    const candidates = condensed.filter((s) => s.treatment === 'condensed' && s.words > MENTION_WORDS);
    if (!candidates.length) return null;
    const largest = candidates.reduce((a, b) => (b.seconds > a.seconds ? b : a));
    const overSeconds = totalSeconds - targetSeconds;
    const wordsPerSecond = largest.words / largest.seconds;
    // Aim a little under the target so the second rewrite's own overshoot still fits.
    const cut = Math.ceil((overSeconds + 5) * wordsPerSecond);
    const toWords = Math.max(MENTION_WORDS, largest.words - cut);
    if (toWords >= largest.words) return null;
    return { sectionId: largest.id, fromWords: largest.words, toWords, overSeconds };
  }

  if (totalSeconds < targetSeconds * (1 - UNDER_TOLERANCE)) {
    const roomiest = condensed.reduce((a, b) => (b.fullWords - b.words > a.fullWords - a.words ? b : a));
    const room = roomiest.fullWords - roomiest.words;
    const wordsPerSecond = roomiest.words / roomiest.seconds;
    const wanted = Math.floor((targetSeconds - totalSeconds - 5) * wordsPerSecond);
    const toWords = roomiest.words + Math.min(room, wanted);
    if (toWords - roomiest.words < MIN_ADDED_WORDS) return null;
    return { sectionId: roomiest.id, fromWords: roomiest.words, toWords, overSeconds: totalSeconds - targetSeconds };
  }
  return null;
}
