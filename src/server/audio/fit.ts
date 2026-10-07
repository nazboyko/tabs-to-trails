/**
 * The fit pass: one look at the measured audio. If the walk runs more than 5%
 * over its target, the largest condensed section is shortened by what is
 * missing and voiced again. It happens once; there is no tempo stretching and
 * no filler, and a walk under its target is left as it is.
 */

import { MENTION_WORDS } from '../script/budget.js';

export const FIT_TOLERANCE = 0.05;

export interface FitSection {
  id: string;
  treatment: 'full' | 'condensed' | 'mention';
  words: number;
  seconds: number;
}

export interface FitDecision {
  sectionId: string;
  fromWords: number;
  toWords: number;
  overSeconds: number;
}

export function decideFit(targetSeconds: number | null, totalSeconds: number, sections: FitSection[]): FitDecision | null {
  if (targetSeconds === null || totalSeconds <= targetSeconds * (1 + FIT_TOLERANCE)) return null;
  const candidates = sections.filter((s) => s.treatment === 'condensed' && s.words > MENTION_WORDS && s.seconds > 0);
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
