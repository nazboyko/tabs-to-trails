import { describe, expect, it } from 'vitest';
import { allocate, carriedTarget, coverageFor, groupSections, MENTION_WORDS, MIN_WORDS_PER_SECTION, planWalk, SECTION_GAP } from '../src/server/script/budget.js';
import type { Section } from '../src/server/source/sections.js';

function prose(id: string, words: number, extra: Section['blocks'] = []): Section {
  const text = Array.from({ length: words }, () => 'word').join(' ');
  return { id, heading: id, level: 2, words, blocks: [{ kind: 'prose', text }, ...extra] };
}

describe('coverageFor', () => {
  it('labels by the share of the source that is kept', () => {
    expect(coverageFor(90, 100)).toBe('Full');
    expect(coverageFor(85, 100)).toBe('Full');
    expect(coverageFor(84, 100)).toBe('Condensed');
    expect(coverageFor(30, 100)).toBe('Condensed');
    expect(coverageFor(29, 100)).toBe('Brief');
  });
});

describe('allocate', () => {
  it('splits by weight and never gives more than the cap', () => {
    const out = allocate([1, 1, 1], [100, 1000, 1000], 900);
    expect(out[0]).toBe(100);
    expect(out[1]).toBeCloseTo(400);
    expect(out[2]).toBeCloseTo(400);
  });

  it('spends the whole budget when caps allow', () => {
    const out = allocate([3, 1], [1000, 1000], 400);
    expect(out[0]! + out[1]!).toBeCloseTo(400);
    expect(out[0]).toBeCloseTo(300);
  });
});

describe('planWalk', () => {
  const wpm = 150;

  it('reads in full when there is no target', () => {
    const plan = planWalk({ sections: [prose('a', 3000)], targetSeconds: null, wpm, fixedSeconds: 30 });
    expect(plan.mode).toBe('full');
    expect(plan.sections[0]!.coverage).toBe('Full');
  });

  it('reads in full and does not pad when the source is short', () => {
    const plan = planWalk({ sections: [prose('a', 600), prose('b', 300)], targetSeconds: 20 * 60, wpm, fixedSeconds: 30 });
    expect(plan.mode).toBe('full');
    expect(plan.sections.map((s) => s.targetWords)).toEqual([600, 300]);
  });

  it('computes the budget from target, fixed parts, gaps and margin', () => {
    const sections = [prose('a', 3000), prose('b', 3000)];
    const plan = planWalk({ sections, targetSeconds: 600, wpm, fixedSeconds: 30 });
    const content = 600 - 30 - SECTION_GAP - 10;
    expect(plan.budgetWords).toBe(Math.floor((content * wpm) / 60));
    expect(plan.mode).toBe('condensed');
  });

  it('keeps the condensed plan inside the word budget', () => {
    const sections = [prose('a', 2000), prose('b', 800), prose('c', 1200), prose('d', 400)];
    const plan = planWalk({ sections, targetSeconds: 600, wpm, fixedSeconds: 30 });
    const total = plan.sections.reduce((n, s) => n + s.targetWords, 0);
    expect(total).toBeLessThanOrEqual(plan.budgetWords! + sections.length);
    expect(total).toBeGreaterThan(plan.budgetWords! * 0.97);
    expect(plan.sections.every((s) => s.coverage !== 'Full')).toBe(true);
  });

  it('gives more words to more important sections', () => {
    const sections = [prose('a', 3000), prose('b', 3000)];
    const plan = planWalk({ sections, targetSeconds: 600, wpm, fixedSeconds: 30, scores: { a: 5, b: 1 } });
    expect(plan.sections[0]!.targetWords).toBeGreaterThan(plan.sections[1]!.targetWords * 4);
  });

  it('turns a section with a tiny share into a one-sentence mention', () => {
    const sections = [prose('a', 4000), prose('b', 60)];
    const plan = planWalk({ sections, targetSeconds: 600, wpm, fixedSeconds: 30, scores: { a: 5, b: 1 } });
    const b = plan.sections[1]!;
    expect(b.treatment).toBe('mention');
    expect(b.targetWords).toBe(MENTION_WORDS);
    expect(b.coverage).toBe('Brief');
  });

  it('reads a tiny section whole instead of mentioning it', () => {
    const sections = [prose('a', 4000), prose('b', 15)];
    const plan = planWalk({ sections, targetSeconds: 600, wpm, fixedSeconds: 30 });
    expect(plan.sections[1]!.treatment).toBe('full');
  });

  it('warns when the source is more than four times the budget', () => {
    const plan = planWalk({ sections: [prose('a', 9000)], targetSeconds: 600, wpm, fixedSeconds: 30 });
    expect(plan.tooLong).toBe(true);
  });

  it('counts code and tables by their expected description length', () => {
    const s = prose('a', 100, [
      { kind: 'code', text: 'x = 1\n'.repeat(80) },
      { kind: 'table', text: '| a | b |\n|---|---|\n| 1 | 2 |' },
    ]);
    const plan = planWalk({ sections: [s], targetSeconds: null, wpm, fixedSeconds: 30 });
    expect(plan.sections[0]!.adapted).toEqual(['code', 'table']);
    expect(plan.sections[0]!.sourceWords).toBe(100);
    expect(plan.fullWords).toBe(100 + 35 + 60);
  });
});

describe('carriedTarget', () => {
  const sections = [prose('a', 1000), prose('b', 1000), prose('c', 1000)];
  const plan = planWalk({ sections, targetSeconds: 600, wpm: 150, fixedSeconds: 30 });

  it('uses the planned target when nothing has been written yet', () => {
    expect(carriedTarget(plan, 0, 0)).toBe(plan.sections[0]!.targetWords);
  });

  it('gives the rest more room when earlier sections came out short', () => {
    const planned = plan.sections[1]!.targetWords;
    const short = Math.round(plan.sections[0]!.targetWords * 0.6);
    expect(carriedTarget(plan, 1, short)).toBeGreaterThan(planned);
  });

  it('takes room away when earlier sections ran long, down to 30% of the plan', () => {
    const planned = plan.sections[2]!.targetWords;
    expect(carriedTarget(plan, 2, plan.budgetWords! - 200)).toBe(200);
    expect(carriedTarget(plan, 2, plan.budgetWords! + 500)).toBe(Math.round(planned * 0.3));
  });

  it('keeps the whole script near the budget', () => {
    const first = Math.round(plan.sections[0]!.targetWords * 0.7);
    const second = carriedTarget(plan, 1, first);
    const third = carriedTarget(plan, 2, first + second);
    expect(Math.abs(first + second + third - plan.budgetWords!)).toBeLessThanOrEqual(2);
  });
});

describe('many small sections', () => {
  const tips = Array.from({ length: 100 }, (_, i) => ({ ...prose(`t${i}`, 30), heading: `Tip ${i + 1}` }));

  it('groups neighbours so a short walk can still cover them', () => {
    const groups = groupSections(tips, 1152);
    expect(groups.length).toBeLessThanOrEqual(Math.floor(1152 / MIN_WORDS_PER_SECTION));
    expect(groups[0]!.heading).toMatch(/^Tip 1, and \d+ more$/);
    expect(groups[0]!.blocks.some((b) => b.text === 'Tip 2.')).toBe(true);
  });

  it('keeps the grouped plan inside the budget', () => {
    const first = planWalk({ sections: tips, targetSeconds: 600, wpm: 150, fixedSeconds: 30 });
    const groups = groupSections(tips, first.budgetWords!);
    const plan = planWalk({ sections: groups, targetSeconds: 600, wpm: 150, fixedSeconds: 30 });
    const total = plan.sections.reduce((n, s) => n + s.targetWords, 0);
    expect(total).toBeLessThanOrEqual(plan.budgetWords! * 1.05);
  });

  it('leaves a handful of sections alone', () => {
    const few = tips.slice(0, 5);
    expect(groupSections(few, 1200)).toBe(few);
  });
});

describe('lists', () => {
  it('are read as sentences in full and never counted as a short description', () => {
    const items = Array.from({ length: 12 }, (_, i) => `Item ${i} has exactly seven words here`);
    const s: Section = { id: 'l', heading: 'L', level: 2, words: 84, blocks: [{ kind: 'list', text: items.join('\n'), items }] };
    const plan = planWalk({ sections: [s], targetSeconds: null, wpm: 150, fixedSeconds: 30 });
    expect(plan.sections[0]!.adapted).toEqual([]);
    expect(plan.fullWords).toBe(84);
  });
});
