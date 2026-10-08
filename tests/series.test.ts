import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_WPM } from '../src/server/list/items.js';
import { seriesFor } from '../src/server/list/preview.js';
import { partMarkdown, splitSeries } from '../src/server/list/series.js';
import { WalkList, type ReadFn } from '../src/server/list/store.js';
import { introText, nextPartText, outroText } from '../src/server/pipeline.js';
import type { SourceInput } from '../src/server/source/index.js';
import { pieceSections } from '../src/server/source/pieces.js';
import { splitSections, type Section } from '../src/server/source/sections.js';
import { pickWalk } from '../src/web/pick.js';

const words = (n: number) => Array.from({ length: n }, (_, i) => (i % 12 === 11 ? 'word.' : 'word')).join(' ');

function section(id: string, paragraphs: number[]): Section {
  return { id, heading: id, level: 2, words: paragraphs.reduce((a, b) => a + b, 0), blocks: paragraphs.map((n) => ({ kind: 'prose' as const, text: words(n) })) };
}

const sum = (part: Section[]) => part.reduce((n, s) => n + s.blocks.reduce((m, b) => m + b.text.split(' ').length, 0), 0);

describe('splitting a long read into walks', () => {
  it('cuts at section boundaries into even parts', () => {
    const sections = Array.from({ length: 6 }, (_, i) => section(`s${i}`, [500, 500]));
    const parts = splitSeries(sections, 2000);
    expect(parts.map(sum)).toEqual([2000, 2000, 2000]);
    expect(parts.flat().map((s) => s.id)).toEqual(sections.map((s) => s.id));
  });

  it('cuts one huge section at paragraph boundaries, and only that one', () => {
    const parts = splitSeries([section('big', Array(10).fill(500))], 2000);
    expect(parts.map(sum)).toEqual([2000, 2000, 1000]);
    expect(parts.every((p) => p.every((s) => s.heading === 'big'))).toBe(true);
  });

  it('joins a short last part to the one before it', () => {
    const parts = splitSeries([section('a', [2000]), section('b', [2000]), section('c', [300])], 2000);
    expect(parts.map(sum)).toEqual([2000, 2300]);
  });

  it('makes three walks of a 50-minute read at 20 minutes', () => {
    const md = Array.from({ length: 9 }, (_, i) => `## Part ${i + 1}\n\n${words(450)}\n\n${words(467)}`).join('\n\n');
    const doc = { kind: 'text' as const, title: 'A long read', markdown: md };
    const piece = { doc, sections: pieceSections(doc).sections, leftOut: [] };
    const total = piece.sections.reduce((n, s) => n + s.words, 0);
    expect(total / DEFAULT_WPM).toBeGreaterThan(49);
    expect(seriesFor(piece, 20, DEFAULT_WPM)).toHaveLength(3);
  });

  it('writes a part back as Markdown that reads the same', () => {
    const md = '## One\n\nFirst paragraph here.\n\n- an item\n- another item\n\n```js\nconst a = 1;\n```\n\n## Two\n\nLast paragraph.';
    const sections = splitSections(md);
    const again = splitSections(partMarkdown(sections));
    expect(again.map((s) => s.heading)).toEqual(sections.map((s) => s.heading));
    expect(again.map((s) => s.blocks.map((b) => b.kind))).toEqual(sections.map((s) => s.blocks.map((b) => b.kind)));
  });
});

describe('a series in the walk', () => {
  it('names the part in the intro and points to the next one at the end', () => {
    const series = { part: 1, parts: 3, title: 'Walking' };
    expect(introText(20, 'Walking, part 1 of 3', true, [], series)).toBe(
      "This is part 1 of 3 of Walking, a 20-minute Walk Edition. Start walking. I'll tell you when you're halfway.",
    );
    expect(outroText(0, series)).toBe("That's the end. You should be almost home. Part 2 is waiting for your next walk.");
    expect(outroText(2, series)).toBe('You should be almost home. Part 2 is waiting for your next walk.');
    expect(nextPartText({ ...series, part: 3 })).toBe('');
    expect(introText(18, 'Walking, part 2 of 3', false, [], { ...series, part: 2 })).toBe('This is part 2 of 3 of Walking, an 18-minute Walk Edition. Start walking.');
  });
});

describe('a series in the list', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 't2t-series-'));
    process.env.WALKS_DIR = tmp;
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const read: ReadFn = async (input: SourceInput) => {
    if (input.kind !== 'text') throw new Error('unexpected');
    return { kind: 'text', title: input.title ?? 'your pasted text', markdown: input.text };
  };

  it('replaces the row with its parts in place, part 1 first in line', async () => {
    const list = new WalkList(path.join(tmp, 'list'), read, async () => DEFAULT_WPM);
    const long = Array.from({ length: 9 }, (_, i) => `## Chapter ${i + 1}\n\n${words(450)}\n\n${words(467)}`).join('\n\n');
    await list.add([{ kind: 'text', title: 'Older', text: words(300) }]);
    const { added } = await list.add([{ kind: 'text', title: 'A long read', text: long }]);
    await list.add([{ kind: 'text', title: 'Newer', text: words(300) }]);
    const preview = await list.preview([added[0]!.id], 20, 'heart');
    expect(preview.pieces[0]!.splitParts).toBe(3);

    const parts = await list.split(added[0]!.id, 20, 'heart');
    expect(parts.map((p) => [p.part, p.parts])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(parts[0]!.doc!.title).toBe('A long read, part 1 of 3');
    const all = await list.all();
    expect(all.map((i) => (i.part ? `part ${i.part}` : i.title))).toEqual(['Older', 'part 1', 'part 2', 'part 3', 'Newer']);
    expect(await list.get(added[0]!.id)).toBeNull();
    // Each part reads back as its own source, about one walk long.
    const pieces = await list.pieces(parts.map((p) => p.id));
    for (const p of pieces) expect(p.sections.reduce((n, s) => n + s.words, 0) / DEFAULT_WPM).toBeLessThan(20);
    // The next part goes first; the later ones wait for it.
    expect(pickWalk(all, 20)[0]).toBe(parts[0]!.id);
    expect(pickWalk(all, 60)).not.toContain(parts[1]!.id);
    // Removing one part removes only that part.
    await list.remove(parts[2]!.id);
    expect((await list.all()).filter((i) => i.seriesId)).toHaveLength(2);
  });
});
