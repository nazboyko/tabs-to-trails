import { describe, expect, it } from 'vitest';
import { chaptersFrom } from '../src/server/audio/chapters.js';
import type { Segment } from '../src/server/audio/timeline.js';
import { previewFrom } from '../src/server/list/preview.js';
import { firstPlan, outroText, QUIET_OUTRO, quietMinutesOf, quietText, walkSource } from '../src/server/pipeline.js';
import { BuildBody } from '../src/server/routes/build.js';
import { pieceSections, type Piece } from '../src/server/source/pieces.js';
import type { SourceDoc } from '../src/server/source/types.js';

const words = (n: number) => Array.from({ length: n }, (_, i) => (i % 12 === 11 ? 'word.' : 'word')).join(' ');

function piece(title: string, n: number): Piece {
  const doc: SourceDoc = { kind: 'text', title, markdown: `## ${title}\n\n${words(n)}` };
  return { doc, sections: pieceSections(doc).sections, leftOut: [] };
}

describe('the quiet ending', () => {
  it('says how long the quiet lasts, in words', () => {
    expect(quietText(1)).toBe("That's the reading. I'm going quiet now. Keep walking for another minute.");
    expect(quietText(3)).toBe("That's the reading. I'm going quiet now. Keep walking for another 3 minutes.");
    expect(outroText(2)).toBe(QUIET_OUTRO);
    expect(outroText(0)).toMatch(/^That's the end\./);
  });

  it('is not offered for Everything, and stays between 0 and 3 minutes', () => {
    expect(quietMinutesOf({ minutes: null, quietMinutes: 2 })).toBe(0);
    expect(quietMinutesOf({ minutes: 20, quietMinutes: 2 })).toBe(2);
    expect(quietMinutesOf({ minutes: 20 })).toBe(0);
    expect(quietMinutesOf({ minutes: 20, quietMinutes: 9 })).toBe(3);
    expect(BuildBody.safeParse({ items: ['aaaaaaaaaa01'], minutes: 20, voice: 'heart', quietMinutes: 3 }).success).toBe(true);
    expect(BuildBody.safeParse({ items: ['aaaaaaaaaa01'], minutes: 20, voice: 'heart', quietMinutes: 4 }).success).toBe(false);
  });

  it('takes its minutes out of the reading, not out of the walk', () => {
    const pieces = [piece('A long read', 4000)];
    const { info, sections } = walkSource(pieces, []);
    const plain = firstPlan(info, sections, 20, 165).plan;
    const quiet = firstPlan(info, sections, 20, 165, 2).plan;
    // The walk is still 20 minutes long; the reading gets about two minutes fewer.
    expect(quiet.targetSeconds).toBe(1200);
    const lost = ((plain.budgetWords! - quiet.budgetWords!) / 165) * 60;
    expect(lost).toBeGreaterThan(115);
    expect(lost).toBeLessThan(135);
  });

  it('shows in the panel, and the panel still adds up to the walk', () => {
    const pieces = [piece('A long read', 4000)];
    const p = previewFrom(pieces, ['aaaaaaaaaa01'], 20, 165, 2);
    expect(p.quietMinutes).toBe(2);
    expect(p.minutes).toBeGreaterThan(19);
    expect(p.minutes).toBeLessThanOrEqual(20);
    expect(p.pieces[0]!.minutes).toBeLessThan(18);
    expect(previewFrom(pieces, ['aaaaaaaaaa01'], null, 165, 2).quietMinutes).toBe(0);
  });

  it('belongs to the closing chapter', () => {
    const seg = (kind: Segment['kind'], start: number, end: number, over: Partial<Segment> = {}): Segment => ({ kind, label: kind, start, end, ...over });
    const chapters = chaptersFrom(
      [
        seg('source', 2, 1000, { label: 'All of it', sectionId: 's01' }),
        seg('app', 1001, 1010, { role: 'question' }),
        seg('app', 1011, 1018, { role: 'quiet' }),
        seg('app', 1018, 1138, { role: 'silence' }),
        seg('app', 1140, 1142, { role: 'outro' }),
      ],
      1143,
    );
    expect(chapters.at(-1)).toEqual({ title: 'Closing', start: 1000, end: 1143 });
  });
});
