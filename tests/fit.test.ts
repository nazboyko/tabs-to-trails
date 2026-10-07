import { describe, expect, it } from 'vitest';
import { decideFit, needsScores } from '../src/server/audio/fit.js';
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

  it('condenses the lowest-scored section of a walk read in full when it runs over', () => {
    const full = [
      { id: 'a', treatment: 'full' as const, words: 400, fullWords: 400, seconds: 160, score: 4 },
      { id: 'b', treatment: 'full' as const, words: 300, fullWords: 300, seconds: 120, score: 2 },
      { id: 'c', treatment: 'full' as const, words: 500, fullWords: 500, seconds: 200, score: 3 },
    ];
    // 480 s walk against a 420 s target: 60 s over; b reads 2.5 words a second, (60 + 5) * 2.5 = 163 words off
    const d = decideFit(420, 480, full)!;
    expect(d.sectionId).toBe('b');
    expect(d.toWords).toBe(300 - 163);
    expect(needsScores(420, 480, full)).toBe(true);
  });

  it('breaks a tie in score by taking the longer section, and skips tiny ones', () => {
    const full = [
      { id: 'tiny', treatment: 'full' as const, words: 20, fullWords: 20, seconds: 8, score: 1 },
      { id: 'short', treatment: 'full' as const, words: 200, fullWords: 200, seconds: 80, score: 2 },
      { id: 'long', treatment: 'full' as const, words: 600, fullWords: 600, seconds: 240, score: 2 },
    ];
    expect(decideFit(300, 340, full)!.sectionId).toBe('long');
  });

  it('cuts no further than a one-sentence mention, so a walk can stay over', () => {
    const full = [{ id: 'a', treatment: 'full' as const, words: 100, fullWords: 100, seconds: 40, score: 3 }];
    const d = decideFit(60, 400, full)!;
    expect(d.toWords).toBe(MENTION_WORDS);
  });

  it('leaves a full walk within the tolerance alone and needs no scores then', () => {
    const full = [{ id: 'a', treatment: 'full' as const, words: 400, fullWords: 400, seconds: 160 }];
    expect(decideFit(600, 620, full)).toBeNull();
    expect(needsScores(600, 620, full)).toBe(false);
  });

  it('prefers a section that is already condensed over one read in full', () => {
    expect(needsScores(1200, 1400, sections)).toBe(false);
    expect(decideFit(1200, 1400, sections)!.sectionId).toBe('s02');
  });

  it('stops at a one-sentence mention when the overflow is larger than the section', () => {
    expect(decideFit(600, 1400, sections)!.toWords).toBe(MENTION_WORDS);
  });
});
