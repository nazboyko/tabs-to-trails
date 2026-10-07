import { describe, expect, it } from 'vitest';
import { decideFit } from '../src/server/audio/fit.js';
import { MENTION_WORDS } from '../src/server/script/budget.js';

const sections = [
  { id: 's01', treatment: 'full' as const, words: 300, seconds: 120 },
  { id: 's02', treatment: 'condensed' as const, words: 400, seconds: 160 },
  { id: 's03', treatment: 'condensed' as const, words: 250, seconds: 100 },
];

describe('decideFit', () => {
  it('leaves a walk within 5% of its target alone', () => {
    expect(decideFit(1200, 1260, sections)).toBeNull();
    expect(decideFit(1200, 1100, sections)).toBeNull();
  });

  it('never fits a whole-thing walk', () => {
    expect(decideFit(null, 5000, sections)).toBeNull();
  });

  it('shortens the largest condensed section by the missing time', () => {
    const d = decideFit(1200, 1290, sections)!;
    expect(d.sectionId).toBe('s02');
    expect(d.overSeconds).toBe(90);
    // 400 words in 160 s = 2.5 words a second; (90 + 5) s * 2.5 = 238 words off
    expect(d.toWords).toBe(400 - 238);
  });

  it('does not touch sections that were read as written', () => {
    expect(decideFit(600, 900, [sections[0]!])).toBeNull();
  });

  it('stops at a one-sentence mention when the overflow is larger than the section', () => {
    expect(decideFit(600, 1400, sections)!.toWords).toBe(MENTION_WORDS);
  });
});
