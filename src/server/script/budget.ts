import { blockWords, countWords, sectionLabel, type Block, type Section } from '../source/sections.js';

export type Mode = 'full' | 'condensed';
export type Coverage = 'Full' | 'Condensed' | 'Brief';
export type Treatment = 'full' | 'condensed' | 'mention';
/** Blocks a listener cannot follow as written; the model describes them. Lists are read as sentences. */
export type AdaptedKind = 'code' | 'table';

/** Spoken words a short description of each adapted block is expected to take. */
export const ADAPTED_ESTIMATE: Record<AdaptedKind, number> = { code: 35, table: 60 };
/** Average words a condensed section should get at least; more sections than that are grouped. */
export const MIN_WORDS_PER_SECTION = 60;
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
  /** Words read as written: prose, quotes, short lists, alt text that states a fact. */
  sourceWords: number;
  /** sourceWords plus the expected length of described code, tables and long lists. */
  fullWords: number;
  adapted: AdaptedKind[];
  score: number;
  treatment: Treatment;
  targetWords: number;
  coverage: Coverage;
  /** Piece of a multi-source walk; 0 (or absent, in older plans) for a single source. */
  piece?: number;
}

export interface PieceBudget {
  fullWords: number;
  /** The piece's share of the word budget, in proportion to its full length. */
  budgetWords: number;
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
  /** Per-piece budgets of a condensed walk, index = piece. */
  pieces?: PieceBudget[];
  sections: PlanSection[];
}

export function adaptedKind(block: Block): AdaptedKind | null {
  if (block.kind === 'code') return 'code';
  if (block.kind === 'table') return 'table';
  return null;
}

/** Words of a block when read in full mode (adapted blocks use their estimate). */
export function fullBlockWords(block: Block): number {
  const kind = adaptedKind(block);
  if (kind) return ADAPTED_ESTIMATE[kind];
  return blockWords(block);
}

/**
 * What the walk turned out to be, not what was planned: full only when every
 * section is read as written. A planned condensed walk whose fit pass gave
 * every section its words back is full; a planned full walk the fit pass had
 * to condense is not.
 */
export function walkMode(sections: { treatment: Treatment }[]): Mode {
  return sections.every((s) => s.treatment === 'full') ? 'full' : 'condensed';
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
  /**
   * Each piece's own pace (index = piece): the voice's measured characters per
   * second over that piece's characters per word. Missing means `wpm`.
   */
  pieceWpm?: number[];
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
  // Carry-over stays inside the piece: one piece of a playlist cannot eat another's time.
  // `wordsSoFar` counts only the sections of the same piece written so far.
  const piece = s.piece ?? 0;
  const budget = plan.pieces?.[piece]?.budgetWords ?? plan.budgetWords;
  const rest = plan.sections.slice(index).filter((r) => (r.piece ?? 0) === piece);
  const fixed = rest.filter((r) => r.treatment !== 'condensed').reduce((n, r) => n + r.targetWords, 0);
  const flexible = rest.filter((r) => r.treatment === 'condensed').reduce((n, r) => n + r.targetWords, 0);
  if (flexible <= 0) return s.targetWords;
  const scale = (budget - wordsSoFar - fixed) / flexible;
  const target = Math.round(s.targetWords * Math.min(1.5, Math.max(0.3, scale)));
  return Math.min(s.fullWords, Math.max(MENTION_WORDS, target));
}

/**
 * A 10-minute walk cannot give a hundred short sections a sentence each. When
 * there are more sections than the budget can carry, the smallest neighbours
 * are merged until every group can get about MIN_WORDS_PER_SECTION words.
 * Each group keeps its member headings as lines of text for the model.
 */
export function groupSections(sections: Section[], budgetWords: number): Section[] {
  const maxGroups = Math.max(3, Math.floor(budgetWords / MIN_WORDS_PER_SECTION));
  if (sections.length <= maxGroups) return sections;
  type Group = { members: Section[]; words: number };
  const groups: Group[] = sections.map((s) => ({ members: [s], words: s.words + 5 }));
  while (groups.length > maxGroups) {
    let best = 0;
    for (let i = 1; i < groups.length - 1; i++) {
      if (groups[i]!.words + groups[i + 1]!.words < groups[best]!.words + groups[best + 1]!.words) best = i;
    }
    const a = groups[best]!;
    const b = groups[best + 1]!;
    groups.splice(best, 2, { members: [...a.members, ...b.members], words: a.words + b.words });
  }
  return groups.map((g) => {
    const first = g.members[0]!;
    if (g.members.length === 1) return first;
    const last = g.members[g.members.length - 1]!;
    const sameHeading = g.members.every((m) => m.heading === first.heading);
    const heading = !sameHeading
      ? `${sectionLabel(first)}, and ${g.members.length - 1} more`
      : first.heading === '' && first.part && last.part
        ? `Parts ${first.part} to ${last.part}`
        : first.heading;
    const blocks: Block[] = g.members.flatMap((m, i) =>
      i === 0 || sameHeading ? m.blocks : [{ kind: 'prose' as const, text: `${sectionLabel(m)}.` }, ...m.blocks],
    );
    const words = blocks.reduce((n, b) => n + blockWords(b), 0);
    return { id: first.id, heading, level: first.level, words, blocks, piece: first.piece };
  });
}

export function planWalk(input: PlanInput): Plan {
  const { sections, targetSeconds, wpm } = input;
  const fixedSeconds = input.fixedSeconds + Math.max(0, sections.length - 1) * SECTION_GAP;
  const base = sections.map((s) => {
    const adapted = [...new Set(s.blocks.map(adaptedKind).filter((k): k is AdaptedKind => k !== null))];
    const sourceWords = s.blocks.filter((b) => !adaptedKind(b)).reduce((n, b) => n + fullBlockWords(b), 0);
    const fullWords = s.blocks.reduce((n, b) => n + fullBlockWords(b), 0);
    const score = Math.min(5, Math.max(1, Math.round(input.scores?.[s.id] ?? 3)));
    return { id: s.id, heading: s.heading, part: s.part, sourceWords, fullWords, adapted, score, piece: s.piece ?? 0 };
  });
  const fullWords = base.reduce((n, s) => n + s.fullWords, 0);
  const pieceCount = Math.max(0, ...base.map((s) => s.piece)) + 1;
  const pieceFull = Array.from({ length: pieceCount }, (_, p) => base.filter((s) => s.piece === p).reduce((n, s) => n + s.fullWords, 0));
  const paces = Array.from({ length: pieceCount }, (_, p) => input.pieceWpm?.[p] ?? wpm);
  // One pace for all (every single-source walk): the plan is worked out in words, as it always was.
  const onePace = paces.every((x) => x === wpm);
  const pieceSeconds = pieceFull.map((w, p) => wordsToSeconds(w, paces[p]!));
  const fullSeconds = (onePace ? wordsToSeconds(fullWords, wpm) : pieceSeconds.reduce((a, b) => a + b, 0)) + fixedSeconds;

  const asFull = (): PlanSection[] =>
    base.map((s) => ({ ...s, treatment: 'full', targetWords: s.fullWords, coverage: 'Full' }));

  if (targetSeconds === null) {
    return { mode: 'full', targetSeconds, wpm, fixedSeconds, budgetWords: null, fullWords, fullSeconds, tooLong: false, sections: asFull() };
  }

  const contentSeconds = Math.max(30, targetSeconds - fixedSeconds - MARGIN_SECONDS);
  // Each piece gets time in proportion to its full length (in seconds, at its own pace),
  // then shares it out among its own sections by length and importance.
  const fullContent = fullSeconds - fixedSeconds;
  const pieces: PieceBudget[] = pieceFull.map((full, p) => ({
    fullWords: full,
    budgetWords: onePace
      ? fullWords > 0
        ? Math.floor((Math.floor((contentSeconds * wpm) / 60) * full) / fullWords)
        : 0
      : fullContent > 0
        ? Math.floor((contentSeconds * (pieceSeconds[p]! / fullContent) * paces[p]!) / 60)
        : 0,
  }));
  const budgetWords = onePace ? Math.floor((contentSeconds * wpm) / 60) : pieces.reduce((n, pb) => n + pb.budgetWords, 0);
  if (onePace ? fullWords <= budgetWords * 1.05 : fullContent <= contentSeconds * 1.05) {
    return { mode: 'full', targetSeconds, wpm, fixedSeconds, budgetWords, fullWords, fullSeconds, tooLong: false, sections: asFull() };
  }

  const targets = new Array<number>(base.length).fill(0);
  const mention = new Array<boolean>(base.length).fill(false);
  pieces.forEach((pb, p) => {
    const idx = base.map((s, i) => (s.piece === p ? i : -1)).filter((i) => i >= 0);
    const share = allocatePiece(idx.map((i) => base[i]!), pb.budgetWords);
    idx.forEach((i, k) => {
      targets[i] = share.targets[k]!;
      mention[i] = share.mention[k]!;
    });
  });

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
    pieces,
    sections: planned,
  };
}

/**
 * One piece's budget across its sections: by length times importance, capped
 * at full length. A section whose share is tiny is either read whole (if it is
 * short anyway) or reduced to a one-sentence mention; the rest share what is left.
 */
function allocatePiece(sections: { fullWords: number; score: number }[], budgetWords: number): { targets: number[]; mention: boolean[] } {
  const weights = sections.map((s) => s.fullWords * s.score);
  const caps = sections.map((s) => s.fullWords);
  let targets = allocate(weights, caps, budgetWords);
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
  return { targets, mention };
}
