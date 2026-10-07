import { describe, expect, it } from 'vitest';
import { walkMode } from '../src/server/script/budget.js';
import { askedLine, type AskedInput } from '../src/web/lengths.js';

describe('walkMode', () => {
  it('is full only when every section is read as written', () => {
    expect(walkMode([{ treatment: 'full' }, { treatment: 'full' }])).toBe('full');
    expect(walkMode([{ treatment: 'full' }, { treatment: 'condensed' }])).toBe('condensed');
    expect(walkMode([{ treatment: 'full' }, { treatment: 'mention' }])).toBe('condensed');
  });
});

describe('askedLine', () => {
  const base: AskedInput = { targetSeconds: 1200, actualSeconds: 1179, mode: 'full', sourceWords: 3160, scriptWords: 3160, fullSeconds: 1274 };

  it('says a walk read in full is read in full, even when it was planned as condensed', () => {
    expect(askedLine(base)).toBe('You asked for 20:00 · read in full');
  });

  it('says plainly when a walk is still over after the fit pass', () => {
    expect(askedLine({ ...base, targetSeconds: 600, actualSeconds: 676 })).toBe('You asked for 10:00. This one runs 1:16 longer, read in full.');
    expect(askedLine({ ...base, mode: 'condensed', targetSeconds: 600, actualSeconds: 660, scriptWords: 1200, sourceWords: 1500 })).toBe(
      'You asked for 10:00. This one runs 1:00 longer.',
    );
  });

  it('does not call a walk within the tolerance long', () => {
    expect(askedLine({ ...base, mode: 'condensed', targetSeconds: 600, actualSeconds: 615, scriptWords: 1531, sourceWords: 1726 })).toBe(
      "You asked for 10:00 · read in full it's about 12 min",
    );
  });

  it('says when a short source makes a shorter walk', () => {
    expect(askedLine({ ...base, targetSeconds: 600, actualSeconds: 61 })).toBe('You asked for 10:00. This one is shorter, so nothing was cut.');
  });

  it('covers the whole thing', () => {
    expect(askedLine({ ...base, targetSeconds: null })).toBe('The whole thing, read in full.');
  });
});
