import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_WPM } from '../src/server/list/items.js';
import { previewFrom } from '../src/server/list/preview.js';
import { WalkList, type ReadFn } from '../src/server/list/store.js';
import { firstPlan, sourceReader, walkSource } from '../src/server/pipeline.js';
import { readPieces } from '../src/server/source/pieces.js';
import type { SourceInput } from '../src/server/source/index.js';
import { pickOrder, pickWalk, type PickRow } from '../src/web/pick.js';

const row = (id: string, minutes: number, day: number, over: Partial<PickRow> = {}): PickRow => ({
  id,
  minutes,
  status: 'ready',
  savedAt: `2026-10-${String(day).padStart(2, '0')}T12:00:00Z`,
  ...over,
});

describe('picking a walk by length', () => {
  // Five rows waiting, saved on different days.
  const rows = [row('postgres', 27, 4), row('sqlite', 12, 5), row('walking', 19, 3), row('tides', 6, 6), row('bread', 4, 7)];

  it('takes the oldest first while the total stays within the length plus 5%', () => {
    // Saved order: walking 19, postgres 27, sqlite 12, tides 6, bread 4.
    expect(pickWalk(rows, 20)).toEqual(['walking']);
    expect(pickWalk(rows, 30)).toEqual(['walking', 'sqlite']);
    expect(pickWalk(rows, 45)).toEqual(['walking', 'postgres']);
    expect(pickWalk(rows, 60)).toEqual(['walking', 'postgres', 'sqlite', 'bread']);
  });

  it('skips a row that would overflow and goes on to later, shorter ones', () => {
    expect(pickWalk(rows, 10)).toEqual(['tides', 'bread']);
  });

  it('allows 5% over the length, and no more', () => {
    expect(pickWalk([row('a', 21, 1)], 20)).toEqual(['a']);
    expect(pickWalk([row('a', 15, 1), row('b', 6.1, 2), row('c', 5, 3)], 20)).toEqual(['a', 'c']);
  });

  it('takes the first row alone when every row is longer than the length', () => {
    expect(pickWalk([row('long', 50, 2), row('longer', 80, 1)], 20)).toEqual(['longer']);
  });

  it('stops at eight pieces', () => {
    const many = Array.from({ length: 12 }, (_, i) => row(`r${i}`, 1, i + 1));
    expect(pickWalk(many, 60)).toHaveLength(8);
  });

  it('proposes nothing for Everything, and nothing that is not ready', () => {
    expect(pickWalk(rows, null)).toEqual([]);
    expect(pickWalk([row('x', 5, 1, { status: 'checking' }), row('y', 5, 2, { status: 'unreadable' })], 20)).toEqual([]);
  });

  it('turns to best fit when first fit fills less than 80%: the 12-vs-19 case from the notes', () => {
    // Saved in this order; first fit takes the DEV post and the bread text, 11.4 minutes for 20.
    const notes = [row('walking', 39.2, 1), row('dev', 10.4, 2), row('thoreau', 19.2, 3), row('hiking', 29, 4), row('bread', 1, 5)];
    expect(pickWalk(notes, 20)).toEqual(['thoreau', 'bread']);
  });

  it('keeps first fit when it fills 80% or more', () => {
    // 16.5 of 20 is enough, though 19 alone would be closer.
    expect(pickWalk([row('a', 16.5, 1), row('b', 19, 2)], 20)).toEqual(['a']);
  });

  it('lets the order decide between sets that are equally close', () => {
    expect(pickWalk([row('m', 10.5, 1), row('p', 19, 2), row('q', 19, 3)], 20)).toEqual(['p']);
  });

  it('never goes over 105% and takes at most 8 rows in best fit', () => {
    const picked = pickWalk([row('big', 22, 1), row('x', 12, 2), ...Array.from({ length: 12 }, (_, i) => row(`s${i}`, 0.9, i + 3))], 20);
    expect(picked.length).toBeLessThanOrEqual(8);
    const total = picked.reduce((n, id) => n + (id === 'x' ? 12 : id === 'big' ? 22 : 0.9), 0);
    expect(total).toBeLessThanOrEqual(21);
    expect(picked).toEqual(['x', 's0', 's1', 's2', 's3', 's4', 's5', 's6']);
  });

  it('keeps the next series part in a best-fit pick', () => {
    // Without the part, "whole" alone would fit 20 exactly; the part stays and the rest fills around it.
    const rows = [row('part', 4, 9, { seriesId: 's', part: 2 }), row('whole', 20, 1), row('small', 6, 2)];
    expect(pickWalk(rows, 20)).toEqual(['part', 'small']);
  });

  it('puts the next part of a series first, and no later part of it', () => {
    const series = [
      row('old', 10, 1),
      row('p3', 18, 9, { seriesId: 's', part: 3 }),
      row('p2', 18, 9, { seriesId: 's', part: 2 }),
    ];
    expect(pickOrder(series).map((r) => r.id)).toEqual(['p2', 'old']);
    expect(pickWalk(series, 20)).toEqual(['p2']);
  });
});

describe('the panel and the walk agree', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 't2t-pick-'));
    process.env.WALKS_DIR = tmp;
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const words = (n: number) => Array.from({ length: n }, (_, i) => (i % 12 === 11 ? 'word.' : 'word')).join(' ');
  const read: ReadFn = async (input: SourceInput) => {
    if (input.kind !== 'text') throw new Error('unexpected');
    return { kind: 'text', title: input.title ?? 'your pasted text', markdown: input.text };
  };

  it('plans each piece the way the build plans the copies it reads', async () => {
    const list = new WalkList(path.join(tmp, 'list'), read, async () => DEFAULT_WPM);
    const { added } = await list.add([
      { kind: 'text', title: 'Long piece', text: `## One\n\n${words(2400)}\n\n## Two\n\n${words(1800)}` },
      { kind: 'text', title: 'Short piece', text: words(700) },
    ]);
    const ids = added.map((i) => i.id);
    for (const minutes of [10, 20, 45, null] as const) {
      const panel = await list.preview(ids, minutes, 'heart');
      // What the build does: copies in the walk folder, read back, the same first plan.
      const dir = path.join(tmp, `walk-${minutes}`);
      await fs.mkdir(dir, { recursive: true });
      const saved = await Promise.all(ids.map((id, i) => list.copyInto(id, dir, `saved-${i + 1}.md`)));
      const { pieces } = await readPieces(saved, sourceReader(dir));
      const { info, sections } = walkSource(pieces, []);
      const { plan } = firstPlan(info, sections, minutes, DEFAULT_WPM, 0, [DEFAULT_WPM, DEFAULT_WPM]);
      expect(panel.mode).toBe(plan.mode);
      // The panel may also offer a series for a long piece; the plan itself is the build's.
      const plain = { ...panel, pieces: panel.pieces.map(({ splitParts: _offer, ...p }) => p) };
      expect(plain).toEqual(previewFrom(pieces, ids, minutes, DEFAULT_WPM));
      const planned = (p: number) => plan.sections.filter((s) => s.piece === p).reduce((n, s) => n + s.targetWords, 0);
      expect(panel.pieces[0]!.minutes / panel.pieces[1]!.minutes).toBeCloseTo((planned(0) + 1 / 60) / planned(1), 0);
    }
    const twenty = await list.preview(ids, 20, 'heart');
    expect(twenty.mode).toBe('condensed');
    expect(twenty.pieces.map((p) => p.treatment)).toEqual(['condensed', 'condensed']);
    expect(twenty.minutes).toBeGreaterThan(18);
    expect(twenty.minutes).toBeLessThanOrEqual(20);
    const everything = await list.preview(ids, null, 'heart');
    expect(everything.pieces.map((p) => p.treatment)).toEqual(['full', 'full']);
    expect(everything.pieces[1]!.fullMinutes).toBeCloseTo(700 / DEFAULT_WPM, 1);
  });
});

describe('one pace everywhere', () => {
  let tmp: string;
  beforeAll(async () => {
    // The walks folder this test file's config already points at (it is read once per file).
    const { loadConfig } = await import('../src/server/config.js');
    tmp = loadConfig().WALKS_DIR;
    await fs.mkdir(tmp, { recursive: true });
    const { VOICES, DTYPE } = await import('../src/server/audio/kokoro.js');
    // A measured voice: 15 characters a second.
    await fs.writeFile(
      path.join(tmp, '.calibration.json'),
      JSON.stringify({ [`${VOICES.heart.id}@${DTYPE}`]: { voice: VOICES.heart.id, dtype: DTYPE, words: 250, chars: 1400, seconds: 93.3, wordsPerMinute: 160.8, charsPerSecond: 15, measuredAt: '2026-10-07T00:00:00Z' } }),
    );
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const read: ReadFn = async (input: SourceInput) => {
    if (input.kind !== 'text') throw new Error('unexpected');
    return { kind: 'text', title: input.title ?? 'your pasted text', markdown: input.text };
  };

  it("shows a row's minutes and the same piece's minutes in the panel as one number, at the chosen voice's pace", async () => {
    const list = new WalkList(path.join(tmp, 'list'), read, async () => DEFAULT_WPM);
    // Two sources with different word lengths, so one blended pace would give each a different number.
    const short = Array.from({ length: 1400 }, (_, i) => (i % 10 === 9 ? 'a.' : 'a')).join(' ');
    const long = Array.from({ length: 1600 }, (_, i) => (i % 10 === 9 ? 'extraordinarily.' : 'extraordinarily')).join(' ');
    const { added } = await list.add([
      { kind: 'text', title: 'Short words', text: short },
      { kind: 'text', title: 'Long words', text: long },
    ]);
    const ids = added.map((i) => i.id);
    const rows = await list.withMinutes(await list.all(), 'heart');
    for (const minutes of [null, 20, 60] as const) {
      const panel = await list.preview(ids, minutes, 'heart');
      expect(panel.pieces.map((p) => p.fullMinutes)).toEqual(rows.map((r) => r.minutes));
      for (const p of panel.pieces) if (p.treatment === 'full') expect(p.minutes).toBe(p.fullMinutes);
    }
    // The two rows read at clearly different paces, and neither is the plain default.
    expect(rows[0]!.minutes).not.toBe(estimateAt(rows[0]!.words, DEFAULT_WPM));
    expect(rows[1]!.minutes / rows[1]!.words).toBeGreaterThan((rows[0]!.minutes / rows[0]!.words) * 3);
  });
});

/** Minutes for a number of words at a plain words-per-minute pace. */
function estimateAt(words: number, wpm: number): number {
  return Math.round((words / wpm) * 10) / 10;
}
