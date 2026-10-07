import { describe, expect, it } from 'vitest';
import { decideFit } from '../src/server/audio/fit.js';
import { MENTION_WORDS } from '../src/server/script/budget.js';

const sections = [
  { id: 's01', treatment: 'full' as const, words: 300, fullWords: 300, seconds: 120 },
  { id: 's02', treatment: 'condensed' as const, words: 400, fullWords: 600, seconds: 160 },
  { id: 's03', treatment: 'condensed' as const, words: 250, fullWords: 900, seconds: 100 },
];

describe('decideFit', () => {
  it('leaves a walk within its tolerance alone', () => {
    expect(decideFit(1200, 1260, sections)).toBeNull();
    expect(decideFit(1200, 1110, sections)).toBeNull();
  });

  it('gives time back to the section with the most left out when the walk runs short', () => {
    const d = decideFit(1200, 1000, sections)!;
    expect(d.sectionId).toBe('s03');
    // 250 words in 100 s = 2.5 words a second; (200 - 5) s * 2.5 = 487 words more
    expect(d.toWords).toBe(250 + 487);
    expect(d.overSeconds).toBe(-200);
  });

  it('never lengthens a section past its source', () => {
    const d = decideFit(1200, 400, sections)!;
    expect(d.toWords).toBe(900);
  });

  it('does not lengthen when nothing was condensed', () => {
    expect(decideFit(1200, 600, [sections[0]!])).toBeNull();
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
