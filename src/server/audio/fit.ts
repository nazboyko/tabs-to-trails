/**
 * The fit pass: one look at the measured audio. If the walk runs more than 5%
 * over its target, the largest condensed section is shortened by what is
 * missing; a walk read in full has no condensed section, so its lowest-scored
 * section is condensed instead. If the walk runs more than 8% under, the
 * condensed section with the most of its source left out gets that time back.
 * Either way it happens once, and only that section is voiced again. No tempo
 * stretching, no filler. A walk still over after that shows its real length.
 */

import { MENTION_WORDS } from '../script/budget.js';

export const FIT_TOLERANCE = 0.05;
export const UNDER_TOLERANCE = 0.08;
/** A lengthening smaller than this is not worth a rewrite. */
export const MIN_ADDED_WORDS = 30;
/** A section read in full needs at least this many words to be worth condensing. */
export const MIN_CONDENSE_WORDS = 60;

export interface FitSection {
  id: string;
  treatment: 'full' | 'condensed' | 'mention';
  words: number;
  /** Words the section has when read in full. */
  fullWords: number;
  seconds: number;
  /** Importance 1-5; sections without one count as 3. */
  score?: number;
}

export interface FitDecision {
  sectionId: string;
  fromWords: number;
  toWords: number;
  /** Positive when the walk ran over, negative when it ran under. */
  overSeconds: number;
}

/** True when the walk runs long enough over its target for the fit pass to act. */
export function runsOver(targetSeconds: number | null, totalSeconds: number): boolean {
  return targetSeconds !== null && totalSeconds > targetSeconds * (1 + FIT_TOLERANCE);
}

/** Over target with nothing condensed yet: the importance scores pick what to condense. */
export function needsScores(targetSeconds: number | null, totalSeconds: number, sections: FitSection[]): boolean {
  return runsOver(targetSeconds, totalSeconds) && !sections.some((s) => s.treatment === 'condensed' && s.words > MENTION_WORDS && s.seconds > 0);
}

/** The full-read section to condense: lowest score first, then the longer one. */
function lowestScored(sections: FitSection[]): FitSection | null {
  const eligible = sections.filter((s) => s.treatment === 'full' && s.words >= MIN_CONDENSE_WORDS && s.seconds > 0);
  if (!eligible.length) return null;
  return eligible.reduce((a, b) => {
    const sa = a.score ?? 3;
    const sb = b.score ?? 3;
    if (sb !== sa) return sb < sa ? b : a;
    return b.words > a.words ? b : a;
  });
}

export function decideFit(targetSeconds: number | null, totalSeconds: number, sections: FitSection[]): FitDecision | null {
  if (targetSeconds === null) return null;

  if (runsOver(targetSeconds, totalSeconds)) {
    const condensed = sections.filter((s) => s.treatment === 'condensed' && s.words > MENTION_WORDS && s.seconds > 0);
    const pick = condensed.length ? condensed.reduce((a, b) => (b.seconds > a.seconds ? b : a)) : lowestScored(sections);
    if (!pick) return null;
    const overSeconds = totalSeconds - targetSeconds;
    const wordsPerSecond = pick.words / pick.seconds;
    // Aim a little under the target so the second rewrite's own overshoot still fits.
    const cut = Math.ceil((overSeconds + 5) * wordsPerSecond);
    const toWords = Math.max(MENTION_WORDS, pick.words - cut);
    if (toWords >= pick.words) return null;
    return { sectionId: pick.id, fromWords: pick.words, toWords, overSeconds };
  }

  const condensed = sections.filter((s) => s.treatment !== 'full' && s.words > 0 && s.seconds > 0);
  if (!condensed.length) return null;
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
