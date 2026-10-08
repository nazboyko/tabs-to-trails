import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_WPM, estimateMinutes, linkKey, MAX_CHECKS, ordered, reorder, viewStatus, type ListItem } from '../src/server/list/items.js';
import { WalkList, type ReadFn } from '../src/server/list/store.js';
import type { Meta } from '../src/server/pipeline.js';
import { sourceReader } from '../src/server/pipeline.js';
import { SaveBody } from '../src/server/routes/list.js';
import { BuildBody } from '../src/server/routes/build.js';
import type { SourceInput } from '../src/server/source/index.js';
import type { Section } from '../src/server/source/sections.js';
import { SourceError, type SourceDoc } from '../src/server/source/types.js';
import { Jobs } from '../src/server/walks/jobs.js';
import { readJson } from '../src/server/walks/store.js';

const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');

function prose(id: string, n: number): Section {
  return { id, heading: id, level: 2, words: n, blocks: [{ kind: 'prose', text: words(n) }] };
}

function item(over: Partial<ListItem> = {}): ListItem {
  return { id: 'aaaaaaaaaaa1', kind: 'link', title: 't', label: 't', words: 0, minutes: 0, status: 'ready', savedAt: '2026-10-07T00:00:00Z', ...over };
}

describe('walk list helpers', () => {
  it('estimates minutes the way the planner does', () => {
    expect(estimateMinutes([prose('a', 1650)], DEFAULT_WPM)).toBe(10);
    // A second section adds the one-second gap between sections.
    expect(estimateMinutes([prose('a', 825), prose('b', 825)], DEFAULT_WPM)).toBeCloseTo(10, 1);
  });

  it('treats two saves of the same page as one link', () => {
    expect(linkKey('https://www.example.com/post/#comments')).toBe(linkKey('https://example.com/post'));
    expect(linkKey('https://example.com/a?page=2')).not.toBe(linkKey('https://example.com/a'));
  });

  it('gives an item back to the list when its walk failed, was cancelled or is gone', () => {
    const inWalk = item({ status: 'in_walk', walkId: 'bbbbbbbbbbb1' });
    expect(viewStatus(inWalk, 'running')).toBe('in_walk');
    expect(viewStatus(inWalk, 'done')).toBe('in_walk');
    expect(viewStatus(inWalk, 'failed')).toBe('ready');
    expect(viewStatus(inWalk, 'cancelled')).toBe('ready');
    expect(viewStatus(inWalk, null)).toBe('ready');
    expect(viewStatus(item({ status: 'checking' }), null)).toBe('checking');
  });

  it('reorders by the ids the page sends and keeps the rest where they were', () => {
    expect(reorder(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['c', 'a', 'b', 'd']);
    expect(() => reorder(['a', 'b'], ['a', 'a'])).toThrow();
    expect(() => reorder(['a', 'b'], ['z'])).toThrow();
  });

  it('lists folders the order file does not name yet, after the named ones', () => {
    expect(ordered(['b', 'gone', 'a'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
  });

  it('takes up to 50 sources in one save, and up to 8 items in one walk', () => {
    const one = { kind: 'url', url: 'https://example.com/a' };
    expect(SaveBody.safeParse({ sources: Array(50).fill(one) }).success).toBe(true);
    expect(SaveBody.safeParse({ sources: Array(51).fill(one) }).success).toBe(false);
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `aaaaaaaaaa${String(i).padStart(2, '0')}`);
    expect(BuildBody.safeParse({ items: ids(8), minutes: 20, voice: 'heart' }).success).toBe(true);
    expect(BuildBody.safeParse({ items: ids(9), minutes: 20, voice: 'heart' }).success).toBe(false);
    expect(BuildBody.safeParse({ items: ['aaaaaaaaaa01', 'aaaaaaaaaa01'], minutes: 20, voice: 'heart' }).success).toBe(false);
    expect(BuildBody.safeParse({ items: ['../../etc'], minutes: 20, voice: 'heart' }).success).toBe(false);
  });
});

describe('the walk list on disk', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 't2t-list-'));
    process.env.WALKS_DIR = tmp;
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const page = (title: string, n = 330): SourceDoc => ({ kind: 'web', title, markdown: `# ${title}\n\n${words(n)}`, url: undefined });

  /** A fake reader: links named "dead" fail, others read after a short wait; it counts checks running at once. */
  function reader() {
    const stats = { now: 0, max: 0, calls: 0 };
    const read: ReadFn = async (input: SourceInput) => {
      if (input.kind === 'text') {
        if (!input.text.trim()) throw new SourceError('There is no text to read yet. Paste something first.', false);
        return { kind: 'text', title: input.title || 'your pasted text', markdown: input.text };
      }
      if (input.kind !== 'url') throw new Error('unexpected');
      stats.calls++;
      stats.now++;
      stats.max = Math.max(stats.max, stats.now);
      await new Promise((r) => setTimeout(r, input.url.includes('slow') ? 60 : 10));
      stats.now--;
      if (input.url.includes('dead')) throw new SourceError("I couldn't reach that page. Check the link, or paste the text instead.");
      if (input.url.includes('odd')) throw new Error('socket hang up');
      return { ...page(`Page ${input.url.split('/').pop()}`), url: input.url };
    };
    return { read, stats };
  }

  it('checks links in the background, three at a time, and one failure blocks nothing', async () => {
    const { read, stats } = reader();
    const list = new WalkList(path.join(tmp, 'list1'), read, async () => DEFAULT_WPM);
    const urls = ['slow-1', 'dead-2', 'ok-3', 'odd-4', 'ok-5', 'ok-6'].map((n) => ({ kind: 'url' as const, url: `https://example.com/${n}` }));
    const { added } = await list.add(urls);
    expect(added.map((i) => i.status)).toEqual(Array(6).fill('checking'));
    await list.idle();
    const items = await list.all();
    expect(items.map((i) => i.status)).toEqual(['ready', 'unreadable', 'ready', 'unreadable', 'ready', 'ready']);
    expect(items[1]!.reason).toMatch(/couldn't reach/);
    expect(items[3]!.reason).toBe('It could not be read.');
    expect(items[0]!.title).toBe('Page slow-1');
    expect(items[0]!.minutes).toBeCloseTo(2, 0);
    expect(stats.max).toBeLessThanOrEqual(MAX_CHECKS);
    expect(stats.calls).toBe(6);
  });

  it('reads pasted text at once, and saves nothing when it is empty', async () => {
    const list = new WalkList(path.join(tmp, 'list2'), reader().read, async () => DEFAULT_WPM);
    const { added } = await list.add([{ kind: 'text', text: words(165), title: 'Notes' }]);
    expect(added[0]).toMatchObject({ status: 'ready', title: 'Notes', words: 165, kind: 'text' });
    await expect(list.add([{ kind: 'url', url: 'https://example.com/x' }, { kind: 'text', text: ' ' }])).rejects.toThrow('no text');
    expect((await list.all()).map((i) => i.title)).toEqual(['Notes']);
  });

  it('does not save the same link twice while it waits', async () => {
    const list = new WalkList(path.join(tmp, 'list3'), reader().read, async () => DEFAULT_WPM);
    await list.add([{ kind: 'url', url: 'https://example.com/ok-a' }]);
    const again = await list.add([{ kind: 'url', url: 'https://www.example.com/ok-a/' }]);
    expect(again.added).toHaveLength(0);
    expect(again.existing).toHaveLength(1);
    await list.idle();
  });

  it('fixes an unreadable row with pasted text, in place and under the link name', async () => {
    const list = new WalkList(path.join(tmp, 'list4'), reader().read, async () => DEFAULT_WPM);
    await list.add([{ kind: 'url', url: 'https://example.com/ok-1' }, { kind: 'url', url: 'https://members.example.com/dead-read' }]);
    await list.idle();
    const bad = (await list.all())[1]!;
    const fixed = await list.paste(bad.id, words(200));
    expect(fixed).toMatchObject({ status: 'ready', title: 'members.example.com/dead-read', url: 'https://members.example.com/dead-read', words: 200 });
    expect((await list.all()).map((i) => i.id)[1]).toBe(bad.id);
  });

  it('keeps the list and its order across a restart, and checks again what was being checked', async () => {
    const root = path.join(tmp, 'list5');
    const first = new WalkList(root, reader().read, async () => DEFAULT_WPM);
    await first.add([{ kind: 'text', text: words(50), title: 'One' }, { kind: 'text', text: words(50), title: 'Two' }, { kind: 'text', text: words(50), title: 'Three' }]);
    const ids = (await first.all()).map((i) => i.id);
    await first.reorder([ids[2]!, ids[0]!]);
    await first.remove(ids[1]!);
    // A link saved just before the process stopped is still "checking" on disk.
    await fs.mkdir(path.join(root, 'cccccccccccc'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'cccccccccccc', 'item.json'),
      JSON.stringify({ id: 'cccccccccccc', kind: 'link', title: 'x', label: 'x', url: 'https://example.com/ok-later', words: 0, minutes: 0, status: 'checking', savedAt: '2026-10-07T00:00:00Z' }),
    );
    const second = new WalkList(root, reader().read, async () => DEFAULT_WPM);
    expect((await second.all()).map((i) => i.title)).toEqual(['Three', 'One', 'x']);
    expect(await second.resume()).toBe(1);
    await second.idle();
    expect((await second.get('cccccccccccc'))?.status).toBe('ready');
  });

  it('copies a saved source into a walk, and the build reads that copy instead of the network', async () => {
    const list = new WalkList(path.join(tmp, 'list6'), reader().read, async () => DEFAULT_WPM);
    const { added } = await list.add([{ kind: 'text', text: `${words(120)}\n\n${words(80)}`, title: 'Saved piece' }]);
    let seen: unknown = null;
    const meta = { id: 'x' } as unknown as Meta;
    const jobs = new Jobs(async (_id, dir, req) => {
      seen = req;
      const input = req.source!;
      const doc = await sourceReader(dir)(input);
      expect(doc.title).toBe('Saved piece');
      expect(doc.markdown.split(/\s+/).length).toBe(200);
      return meta;
    });
    const record = await jobs.create({ minutes: 20, voice: 'heart', items: [added[0]!.id] }, async (dir) => {
      const saved = await list.copyInto(added[0]!.id, dir, 'saved-1.md');
      return { source: saved, minutes: 20, voice: 'heart', items: [added[0]!.id] };
    });
    await list.markInWalk([added[0]!.id], record.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toMatchObject({ source: { kind: 'saved', file: 'saved-1.md' }, items: [added[0]!.id] });
    expect((await readJson<{ request: { source: { kind: string } } }>(path.join(tmp, record.id), 'walk.json'))?.request.source.kind).toBe('saved');
    expect((await list.get(added[0]!.id))?.status).toBe('in_walk');
    // The reader refuses a file name the server did not choose.
    await expect(sourceReader(tmp)({ kind: 'saved', itemId: 'x', file: '../walk.json', doc: { kind: 'text', title: 'x' } })).rejects.toThrow('Bad saved');
  });
});

describe('the home screen copy', async () => {
  const { savedAgo, savedLine, things, walkTime } = await import('../src/web/list.js');

  it('writes walking time in minutes and hours', () => {
    expect(walkTime(0.4)).toBe('1 min');
    expect(walkTime(12.4)).toBe('12 min');
    expect(walkTime(72)).toBe('1 h 12 min');
    expect(walkTime(120)).toBe('2 h');
  });

  it('says when a row was saved, in days, then weeks, then months', () => {
    const now = new Date(2026, 9, 7, 21, 0);
    expect(savedAgo(new Date(2026, 9, 7, 1, 0).toISOString(), now)).toBe('saved today');
    expect(savedAgo(new Date(2026, 9, 6, 23, 0).toISOString(), now)).toBe('saved yesterday');
    expect(savedAgo(new Date(2026, 9, 4, 12, 0).toISOString(), now)).toBe('saved 3 days ago');
    expect(savedAgo(new Date(2026, 8, 20, 12, 0).toISOString(), now)).toBe('saved 2 weeks ago');
    expect(savedAgo(new Date(2026, 6, 1, 12, 0).toISOString(), now)).toBe('saved 3 months ago');
  });

  it('confirms a save with what is waiting, and never more than that', () => {
    expect(things(1)).toBe('1 thing');
    expect(savedLine(1, 0, 5)).toBe('Saved. 5 things waiting for a walk.');
    expect(savedLine(0, 1, 5)).toBe('Already in your list. 5 things waiting for a walk.');
  });
});
