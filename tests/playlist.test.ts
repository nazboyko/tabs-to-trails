import { describe, expect, it } from 'vitest';
import { clock, placeCues, type CueItem } from '../src/server/audio/timeline.js';
import { introText } from '../src/server/pipeline.js';
import { BuildBody } from '../src/server/routes/build.js';
import { carriedTarget, groupSections, planWalk } from '../src/server/script/budget.js';
import type { SourceInput } from '../src/server/source/index.js';
import { bridgeText, MAX_PIECES, readPieces, sourceLabel, threeQuarterText, walkTitle, wantsThreeQuarter } from '../src/server/source/pieces.js';
import type { Section } from '../src/server/source/sections.js';
import { SourceError, type SourceDoc } from '../src/server/source/types.js';
import { askedLine } from '../src/web/lengths.js';
import { moveItem, parseLinks, roomFor, sourceName } from '../src/web/pieces.js';

function prose(id: string, words: number, piece?: number): Section {
  const text = Array.from({ length: words }, () => 'word').join(' ');
  return { id, heading: id, level: 2, words, blocks: [{ kind: 'prose', text }], ...(piece === undefined ? {} : { piece }) };
}

function doc(title: string, markdown: string, kind: SourceDoc['kind'] = 'web'): SourceDoc {
  return { kind, title, markdown };
}

const link = (url: string): SourceInput => ({ kind: 'url', url });

describe('readPieces', () => {
  const pages: Record<string, SourceDoc> = {
    'https://a.example/one': doc('One', '## First\n\nSome words in the first piece.'),
    'https://b.example/two': doc('Two', 'Words without a heading at all.'),
  };
  const read = async (input: SourceInput) => {
    if (input.kind === 'url' && pages[input.url]) return pages[input.url]!;
    if (input.kind === 'text') return doc(input.title ?? 'your pasted text', input.text, 'text');
    throw new SourceError("I couldn't reach that page. Check the link, or paste the text instead.");
  };

  it('keeps the single-source behaviour: its error is the walk error', async () => {
    await expect(readPieces([link('https://down.example/')], read)).rejects.toThrow("I couldn't reach that page");
  });

  it('skips a source that cannot be read and names it', async () => {
    const { pieces, skipped } = await readPieces([link('https://a.example/one'), link('https://down.example/post/'), link('https://b.example/two')], read);
    expect(pieces.map((p) => p.doc.title)).toEqual(['One', 'Two']);
    expect(skipped).toEqual([{ label: 'down.example/post', reason: "I couldn't reach that page. Check the link, or paste the text instead." }]);
    // A text with no headings is one section that carries its title.
    expect(pieces[1]!.sections.map((s) => s.heading)).toEqual(['Two']);
  });

  it('fails only when every source fails, with the first reason', async () => {
    await expect(readPieces([link('https://down.example/a'), link('https://down.example/b')], read)).rejects.toThrow("I couldn't reach that page");
  });

  it('numbers pasted texts that have no title, so the bridges can tell them apart', async () => {
    const { pieces } = await readPieces(
      [
        { kind: 'text', text: 'First pasted words.' },
        { kind: 'text', text: 'Second pasted words.' },
      ],
      read,
    );
    expect(pieces.map((p) => p.doc.title)).toEqual(['Pasted text 1', 'Pasted text 2']);
    expect(pieces.map((p) => p.sections[0]!.heading)).toEqual(['Pasted text 1', 'Pasted text 2']);
  });

  it('skips a source with no text in it', async () => {
    const empty = async (input: SourceInput) => (input.kind === 'url' && input.url.includes('empty') ? doc('Empty', '') : read(input));
    const { pieces, skipped } = await readPieces([link('https://empty.example/'), link('https://a.example/one')], empty);
    expect(pieces).toHaveLength(1);
    expect(skipped[0]!.reason).toBe('There is no text to read in it.');
  });
});

describe('playlist wording', () => {
  it('names the walk after its pieces', () => {
    expect(walkTitle(['Walking'])).toBe('Walking');
    expect(walkTitle(['Bread', 'Tides'])).toBe('Bread and Tides');
    expect(walkTitle(['Bread', 'Tides', 'Moths'])).toBe('Bread and 2 more');
  });

  it('says the next title between pieces', () => {
    expect(bridgeText('Two tides a day')).toBe('Next: Two tides a day.');
    expect(bridgeText('Why now?')).toBe('Next: Why now.');
  });

  it('writes an hour-long walk as h:mm:ss, as the screens do', () => {
    expect(clock(3725)).toBe('1:02:05');
    expect(clock(3599.6)).toBe('1:00:00');
  });

  it('counts the minutes left at three quarters', () => {
    expect(threeQuarterText(14.6)).toBe('About 15 minutes left.');
    expect(threeQuarterText(0.7)).toBe('About 1 minute left.');
  });

  it('gives the second cue to walks of 45 minutes or more', () => {
    expect(wantsThreeQuarter(45 * 60)).toBe(true);
    expect(wantsThreeQuarter(43 * 60)).toBe(true);
    expect(wantsThreeQuarter(40 * 60)).toBe(false);
  });

  it('introduces a playlist by its first piece, and a single source as before', () => {
    expect(introText(60, 'Bread and Tides', true, ['Bread', 'Tides'])).toBe(
      "This is your 60-minute Walk Edition, with 2 pieces. First: Bread. Start walking. I'll tell you when you're halfway.",
    );
    expect(introText(10, 'Walking', true, ['Walking'])).toBe("This is your 10-minute Walk Edition of Walking. Start walking. I'll tell you when you're halfway.");
  });

  it('labels a link by host and path', () => {
    expect(sourceLabel(link('https://www.example.com/blog/post/'))).toBe('example.com/blog/post');
    expect(sourceLabel({ kind: 'file', name: 'notes.md', text: '' })).toBe('notes.md');
  });
});

describe('planning a playlist', () => {
  const wpm = 150;

  it('splits the time between pieces in proportion to their length', () => {
    const sections = [prose('s01', 2000, 0), prose('s02', 2000, 0), prose('s03', 2000, 1)];
    const plan = planWalk({ sections, targetSeconds: 600, wpm, fixedSeconds: 40 });
    expect(plan.mode).toBe('condensed');
    const [a, b] = plan.pieces!;
    expect(a!.budgetWords / b!.budgetWords).toBeCloseTo(2, 1);
    const byPiece = (p: number) => plan.sections.filter((s) => s.piece === p).reduce((n, s) => n + s.targetWords, 0);
    expect(byPiece(0) / byPiece(1)).toBeCloseTo(2, 1);
  });

  it('reads short pieces in full and does not pad them', () => {
    const plan = planWalk({ sections: [prose('s01', 300, 0), prose('s02', 200, 1)], targetSeconds: 3600, wpm, fixedSeconds: 40 });
    expect(plan.mode).toBe('full');
    expect(plan.sections.map((s) => s.targetWords)).toEqual([300, 200]);
  });

  it('keeps carry-over inside a piece', () => {
    const sections = [prose('s01', 2000, 0), prose('s02', 2000, 0), prose('s03', 2000, 1)];
    const plan = planWalk({ sections, targetSeconds: 600, wpm, fixedSeconds: 40 });
    // The first piece ran long; the second piece's target does not shrink for it.
    expect(carriedTarget(plan, 2, 0)).toBe(plan.sections[2]!.targetWords);
    expect(carriedTarget(plan, 1, plan.sections[0]!.targetWords + 100)).toBeLessThan(plan.sections[1]!.targetWords);
  });

  it('keeps the piece when sections are grouped', () => {
    const many = Array.from({ length: 12 }, (_, i) => prose(`s${i + 1}`, 40, 1));
    const grouped = groupSections(many, 200);
    expect(grouped.length).toBeLessThan(many.length);
    expect(grouped.every((g) => g.piece === 1)).toBe(true);
  });

  it('plans a single source exactly as before', () => {
    const sections = [prose('a', 2000), prose('b', 1000)];
    const plan = planWalk({ sections, targetSeconds: 600, wpm, fixedSeconds: 40 });
    expect(plan.pieces).toHaveLength(1);
    expect(plan.pieces![0]!.budgetWords).toBe(plan.budgetWords);
  });
});

describe('placeCues', () => {
  const section = (length: number, boundaries: number[], cueBefore: boolean): CueItem => ({ length, boundaries, cueBefore });

  it('places the halfway and three-quarter cues in order, counting the first cue', () => {
    const items = [section(400, [100, 200, 300], false), section(10, [], false), section(400, [100, 200, 300], true)];
    const spots = placeCues({ before: 0, items, after: 0, cues: [{ fraction: 0.5, length: 20 }, { fraction: 0.75, length: 20 }] });
    expect(spots.map((s) => s.cue)).toEqual([0, 1]);
    const total = spots[0]!.total;
    expect(total).toBe(850);
    expect(Math.abs(spots[0]!.cueStart + 10 - total / 2)).toBeLessThan(60);
    expect(Math.abs(spots[1]!.cueStart + 10 - total * 0.75)).toBeLessThan(60);
    expect(spots[1]!.cueStart).toBeGreaterThan(spots[0]!.cueStart);
  });

  it('puts a cue before a bridge, never between the bridge and its piece', () => {
    // Piece one, the pause and bridge, then piece two with no inner boundaries.
    const items = [section(500, [], false), section(10, [], false), section(20, [], true), section(10, [], false), section(500, [], false)];
    const [spot] = placeCues({ before: 0, items, after: 0, cues: [{ fraction: 0.5, length: 20 }] });
    expect(spot!.item).toBe(2);
    expect(spot!.offset).toBe(0);
  });

  it('leaves out a cue that has nowhere to go after the one before it', () => {
    const items = [section(500, [], false), section(500, [250], false)];
    const spots = placeCues({ before: 0, items, after: 0, cues: [{ fraction: 0.5, length: 10 }, { fraction: 0.75, length: 10 }] });
    expect(spots.map((s) => s.cue)).toEqual([0]);
  });
});

describe('BuildBody', () => {
  const one = { kind: 'url', url: 'https://example.com/a' };

  it('takes one source or a list of up to eight', () => {
    expect(BuildBody.safeParse({ source: one, minutes: 20, voice: 'heart' }).success).toBe(true);
    expect(BuildBody.safeParse({ sources: Array(MAX_PIECES).fill(one), minutes: 60, voice: 'heart' }).success).toBe(true);
    expect(BuildBody.safeParse({ sources: Array(MAX_PIECES + 1).fill(one), minutes: 60, voice: 'heart' }).success).toBe(false);
    expect(BuildBody.safeParse({ source: one, sources: [one], minutes: 20, voice: 'heart' }).success).toBe(false);
    expect(BuildBody.safeParse({ minutes: 20, voice: 'heart' }).success).toBe(false);
  });

  it('knows the 45 and 60 minute walks', () => {
    for (const minutes of [10, 20, 30, 45, 60, null]) expect(BuildBody.safeParse({ source: one, minutes, voice: 'heart' }).success).toBe(true);
    expect(BuildBody.safeParse({ source: one, minutes: 40, voice: 'heart' }).success).toBe(false);
  });
});

describe('the Build screen list', () => {
  it('reads links one per line and adds the scheme', () => {
    expect(parseLinks('example.com/a\n\n  https://b.example/x  \r\nhttp://c.example')).toEqual(['https://example.com/a', 'https://b.example/x', 'http://c.example']);
  });

  it('moves an item and leaves the list alone for a move off the end', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  });

  it('names each source briefly', () => {
    expect(sourceName({ kind: 'url', url: 'https://www.example.com/post/' })).toBe('example.com/post');
    expect(sourceName({ kind: 'text', text: 'one two three four five six seven' })).toBe('“one two three four five six...”');
    expect(sourceName({ kind: 'text', text: 'x', title: 'My notes' })).toBe('My notes');
  });

  it('says how much room is left', () => {
    expect(roomFor(5, 3)).toBeNull();
    expect(roomFor(6, 3)).toBe('A walk holds up to 8 pieces. There is room for 2 more.');
    expect(roomFor(8, 1)).toBe('A walk holds up to 8 pieces, and this one is full.');
  });

  it('says a short playlist is shorter together', () => {
    const line = askedLine({ targetSeconds: 3600, actualSeconds: 139, mode: 'full', sourceWords: 293, scriptWords: 293, fullSeconds: 140, pieces: 2 });
    expect(line).toBe('You asked for 1:00:00. Together they run shorter, so nothing was cut.');
  });
});
