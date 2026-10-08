import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAudiobook, encodeMp3, ffmpegBinary } from '../src/server/audio/assemble.js';
import { chaptersFrom, ffmetadata, type Chapter } from '../src/server/audio/chapters.js';
import type { Segment } from '../src/server/audio/timeline.js';
import { encodeWav, SAMPLE_RATE } from '../src/server/audio/wav.js';

const seg = (kind: Segment['kind'], start: number, end: number, over: Partial<Segment> = {}): Segment => ({ kind, label: kind, start, end, ...over });

describe('chapters from the timeline', () => {
  it('gives each section a chapter, the intro to the first and the closing lines to "Closing"', () => {
    const segments = [
      seg('app', 0, 8, { role: 'intro' }),
      seg('source', 9, 120, { label: 'Opening', sectionId: 's01' }),
      seg('source', 121, 300, { label: 'The middle', sectionId: 's02' }),
      seg('app', 301, 306, { role: 'halfway' }),
      seg('source', 307, 500, { label: 'The middle', sectionId: 's02' }),
      seg('source', 501, 590, { label: 'The end', sectionId: 's03' }),
      seg('app', 592, 605, { role: 'question' }),
      seg('app', 606, 610, { role: 'outro' }),
    ];
    expect(chaptersFrom(segments, 611)).toEqual([
      { title: 'Opening', start: 0, end: 120 },
      { title: 'The middle', start: 120, end: 500 },
      { title: 'The end', start: 500, end: 590 },
      { title: 'Closing', start: 590, end: 611 },
    ]);
  });

  it('puts a "Next:" line in the chapter of the piece it introduces, named after that piece', () => {
    const segments = [
      seg('app', 0, 8, { role: 'intro' }),
      seg('source', 9, 100, { label: 'What I Built', sectionId: 's01', piece: 0 }),
      seg('source', 101, 200, { label: 'Demo', sectionId: 's02', piece: 0 }),
      seg('app', 202, 205, { role: 'bridge', piece: 1 }),
      seg('source', 206, 400, { label: 'Walking', sectionId: 's03', piece: 1 }),
      seg('app', 402, 405, { role: 'outro' }),
    ];
    const chapters = chaptersFrom(segments, 406, ['My post', 'Walking']);
    expect(chapters.map((c) => c.title)).toEqual(['My post: What I Built', 'My post: Demo', 'Walking', 'Closing']);
    expect(chapters[2]!.start).toBe(200);
  });

  it('runs back to back from 0 to the end of the file', () => {
    const segments = [seg('source', 1, 50, { label: 'A', sectionId: 's01' }), seg('source', 51, 99.8, { label: 'B', sectionId: 's02' })];
    const chapters = chaptersFrom(segments, 100);
    expect(chapters[0]!.start).toBe(0);
    for (let i = 1; i < chapters.length; i++) expect(chapters[i]!.start).toBe(chapters[i - 1]!.end);
    expect(chapters.at(-1)!.end).toBe(100);
    expect(chaptersFrom([], 30)).toEqual([{ title: 'Closing', start: 0, end: 30 }]);
  });

  it('escapes what ffmpeg reads as syntax', () => {
    const text = ffmetadata({ title: 'A = B; #1' }, [{ title: 'Back\\slash', start: 0, end: 1.5 }]);
    expect(text).toContain('title=A \\= B\\; \\#1');
    expect(text).toContain('START=0\nEND=1500\ntitle=Back\\\\slash');
  });
});

describe('chapters in the files', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 't2t-chap-'));
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** What ffmpeg reads back from a file: its chapters with start times and titles. */
  async function readChapters(file: string): Promise<{ start: number; title: string }[]> {
    const out = await promisify(execFile)(ffmpegBinary(), ['-hide_banner', '-i', file]).catch((err: { stderr: string }) => ({ stderr: err.stderr }));
    const found: { start: number; title: string }[] = [];
    const re = /Chapter #\d+:\d+: start ([\d.]+), end [\d.]+\s+Metadata:\s+title\s+: (.+)/g;
    for (let m = re.exec(out.stderr); m; m = re.exec(out.stderr)) found.push({ start: Number(m[1]), title: m[2]!.trim() });
    return found;
  }

  it('writes the same chapters into the MP3 and the audiobook', async () => {
    const samples = new Float32Array(SAMPLE_RATE * 3).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
    const wav = path.join(tmp, 'walk.wav');
    await fs.writeFile(wav, encodeWav(samples));
    const chapters: Chapter[] = [
      { title: 'Why bread goes stale', start: 0, end: 1.2 },
      { title: 'Bringing it back', start: 1.2, end: 2.4 },
      { title: 'Closing', start: 2.4, end: 3 },
    ];
    const mp3 = path.join(tmp, 'walk.mp3');
    const m4b = path.join(tmp, 'walk.m4b');
    await encodeMp3(wav, mp3, { title: 'A test walk', date: '2026-10-07' }, chapters);
    await encodeAudiobook(mp3, m4b, { title: 'A test walk', date: '2026-10-07' }, chapters);
    for (const file of [mp3, m4b]) {
      const read = await readChapters(file);
      expect(read.map((c) => c.title)).toEqual(chapters.map((c) => c.title));
      read.forEach((c, i) => expect(c.start).toBeCloseTo(chapters[i]!.start, 1));
    }
    // The metadata file is removed after encoding.
    expect((await fs.readdir(tmp)).sort()).toEqual(['walk.m4b', 'walk.mp3', 'walk.wav']);
  });
});
