import { blockWords, countWords, type Block, type Section } from '../source/sections.js';

export type Mode = 'full' | 'condensed';
export type Coverage = 'Full' | 'Condensed' | 'Brief';
export type Treatment = 'full' | 'condensed' | 'mention';
export type AdaptedKind = 'code' | 'table' | 'list';

/** Spoken words a short description of each adapted block is expected to take. */
export const ADAPTED_ESTIMATE: Record<AdaptedKind, number> = { code: 35, table: 60, list: 50 };
/** Lists longer than this go to the model instead of being read item by item. */
export const LONG_LIST_ITEMS = 8;
export const LONG_LIST_WORDS = 120;
/** A section whose share falls under this many words becomes a one-sentence mention. */
export const MENTION_THRESHOLD = 25;
export const MENTION_WORDS = 20;
/** Sections this short are read whole rather than mentioned. */
export const SMALL_SECTION_WORDS = 30;
/** Silence between sections, in seconds. */
export const SECTION_GAP = 1.0;
export const MARGIN_SECONDS = 10;

export interface PlanSection {
  id: string;
  heading: string;
  part?: number;
  /** Words read as written: prose, quotes, short lists, image descriptions. */
  sourceWords: number;
  /** sourceWords plus the expected length of described code, tables and long lists. */
  fullWords: number;
  adapted: AdaptedKind[];
  score: number;
  treatment: Treatment;
  targetWords: number;
  coverage: Coverage;
}

export interface Plan {
  mode: Mode;
  targetSeconds: number | null;
  wpm: number;
  fixedSeconds: number;
  budgetWords: number | null;
  fullWords: number;
  /** Expected length of the whole walk if the source is read in full. */
  fullSeconds: number;
  tooLong: boolean;
  /** True when the model's importance scores shaped the budgets. */
  scored?: boolean;
  sections: PlanSection[];
}

export function isLongList(block: Block): boolean {
  return block.kind === 'list' && ((block.items?.length ?? 0) > LONG_LIST_ITEMS || countWords(block.text) > LONG_LIST_WORDS);
}

export function adaptedKind(block: Block): AdaptedKind | null {
  if (block.kind === 'code') return 'code';
  if (block.kind === 'table') return 'table';
  if (isLongList(block)) return 'list';
  return null;
}

/** Words of a block when read in full mode (adapted blocks use their estimate). */
export function fullBlockWords(block: Block): number {
  const kind = adaptedKind(block);
  if (kind) return ADAPTED_ESTIMATE[kind];
  if (block.kind === 'image') return blockWords(block) + 5;
  return blockWords(block);
}

export function coverageFor(targetWords: number, fullWords: number): Coverage {
  if (fullWords <= 0) return 'Full';
  const ratio = targetWords / fullWords;
  if (ratio >= 0.85) return 'Full';
  if (ratio >= 0.3) return 'Condensed';
  return 'Brief';
}

export function wordsToSeconds(words: number, wpm: number): number {
  return (words / wpm) * 60;
}

export interface PlanInput {
  sections: Section[];
  /** null means "Whole thing". */
  targetSeconds: number | null;
  wpm: number;
  /** Intro, halfway cue, question, outro and chimes. */
  fixedSeconds: number;
  /** Importance 1-5 per section id; missing ids count as 3. */
  scores?: Record<string, number>;
}

/**
 * Splits `budget` across sections in proportion to weight, never giving a
 * section more than its full length. Returns words per section index.
 */
export function allocate(weights: number[], caps: number[], budget: number): number[] {
  const out = new Array<number>(weights.length).fill(0);
  const open = new Set(weights.map((_, i) => i).filter((i) => caps[i]! > 0));
  let left = budget;
  while (open.size && left > 0.5) {
    const total = [...open].reduce((s, i) => s + weights[i]!, 0);
    if (total <= 0) break;
    let capped = false;
    for (const i of [...open]) {
      const share = (left * weights[i]!) / total;
      if (out[i]! + share >= caps[i]!) {
        left -= caps[i]! - out[i]!;
        out[i] = caps[i]!;
        open.delete(i);
        capped = true;
      }
    }
    if (capped) continue;
    for (const i of open) out[i]! += (left * weights[i]!) / total;
    left = 0;
  }
  return out;
}

/**
 * Word target for the next condensed section, given what the sections before
 * it actually came out at. Overshoot and undershoot carry forward, so the
 * script as a whole tracks the budget.
 */
export function carriedTarget(plan: Plan, index: number, wordsSoFar: number): number {
  const s = plan.sections[index]!;
  if (plan.mode !== 'condensed' || s.treatment !== 'condensed' || plan.budgetWords === null) return s.targetWords;
  const rest = plan.sections.slice(index);
  const fixed = rest.filter((r) => r.treatment !== 'condensed').reduce((n, r) => n + r.targetWords, 0);
  const flexible = rest.filter((r) => r.treatment === 'condensed').reduce((n, r) => n + r.targetWords, 0);
  if (flexible <= 0) return s.targetWords;
  const scale = (plan.budgetWords - wordsSoFar - fixed) / flexible;
  const target = Math.round(s.targetWords * Math.min(1.5, Math.max(0.3, scale)));
  return Math.min(s.fullWords, Math.max(MENTION_WORDS, target));
}

export function planWalk(input: PlanInput): Plan {
  const { sections, targetSeconds, wpm } = input;
  const fixedSeconds = input.fixedSeconds + Math.max(0, sections.length - 1) * SECTION_GAP;
  const base = sections.map((s) => {
    const adapted = [...new Set(s.blocks.map(adaptedKind).filter((k): k is AdaptedKind => k !== null))];
    const sourceWords = s.blocks.filter((b) => !adaptedKind(b)).reduce((n, b) => n + fullBlockWords(b), 0);
    const fullWords = s.blocks.reduce((n, b) => n + fullBlockWords(b), 0);
    const score = Math.min(5, Math.max(1, Math.round(input.scores?.[s.id] ?? 3)));
    return { id: s.id, heading: s.heading, part: s.part, sourceWords, fullWords, adapted, score };
  });
  const fullWords = base.reduce((n, s) => n + s.fullWords, 0);
  const fullSeconds = wordsToSeconds(fullWords, wpm) + fixedSeconds;

  const asFull = (): PlanSection[] =>
    base.map((s) => ({ ...s, treatment: 'full', targetWords: s.fullWords, coverage: 'Full' }));

  if (targetSeconds === null) {
    return { mode: 'full', targetSeconds, wpm, fixedSeconds, budgetWords: null, fullWords, fullSeconds, tooLong: false, sections: asFull() };
  }

  const contentSeconds = Math.max(30, targetSeconds - fixedSeconds - MARGIN_SECONDS);
  const budgetWords = Math.floor((contentSeconds * wpm) / 60);
  if (fullWords <= budgetWords * 1.05) {
    return { mode: 'full', targetSeconds, wpm, fixedSeconds, budgetWords, fullWords, fullSeconds, tooLong: false, sections: asFull() };
  }

  const weights = base.map((s) => s.fullWords * s.score);
  const caps = base.map((s) => s.fullWords);
  let targets = allocate(weights, caps, budgetWords);
  // A section whose share is tiny is either read whole (if it is short anyway)
  // or reduced to a one-sentence mention; the rest share what is left.
  const small = targets.map((t, i) => t < MENTION_THRESHOLD && caps[i]! <= SMALL_SECTION_WORDS);
  const mention = targets.map((t, i) => t < MENTION_THRESHOLD && caps[i]! > SMALL_SECTION_WORDS);
  if (small.some(Boolean) || mention.some(Boolean)) {
    const fixed = targets.reduce((n, _, i) => n + (small[i] ? caps[i]! : mention[i] ? MENTION_WORDS : 0), 0);
    const rest = allocate(
      weights.map((w, i) => (small[i] || mention[i] ? 0 : w)),
      caps.map((c, i) => (small[i] || mention[i] ? 0 : c)),
      Math.max(0, budgetWords - fixed),
    );
    targets = rest.map((t, i) => (small[i] ? caps[i]! : mention[i] ? MENTION_WORDS : t));
  }

  const planned: PlanSection[] = base.map((s, i) => {
    const targetWords = Math.round(targets[i]!);
    const ratio = s.fullWords > 0 ? targetWords / s.fullWords : 1;
    const treatment: Treatment = mention[i] ? 'mention' : ratio >= 0.95 ? 'full' : 'condensed';
    const coverage: Coverage = mention[i] ? 'Brief' : coverageFor(targetWords, s.fullWords);
    return { ...s, treatment, targetWords, coverage };
  });

  return {
    mode: 'condensed',
    targetSeconds,
    wpm,
    fixedSeconds,
    budgetWords,
    fullWords,
    fullSeconds,
    tooLong: fullWords > 4 * budgetWords,
    sections: planned,
  };
}
