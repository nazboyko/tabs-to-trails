import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/server/audio/speakable.js';
import type { Segment } from '../src/server/audio/timeline.js';
import { buildTimings, findPauses, sectionLines, snapToPauses } from '../src/server/audio/timings.js';

const SR = 1000;

/** Boundaries the voice would report for this text, if each chunk took `perChar` seconds per character. */
function voicedLike(text: string, perChar = 0.05): { samples: number; boundaries: number[] } {
  const chunks = chunkText(text);
  const boundaries: number[] = [];
  let at = 0;
  chunks.forEach((c, i) => {
    at += c.text.length * perChar * SR;
    if (i < chunks.length - 1) {
      at += (c.paragraphEnd ? 0.45 : 0.2) * SR;
      boundaries.push(Math.round(at));
    }
  });
  return { samples: Math.round(at), boundaries };
}

const text = 'The first sentence is here. A second one follows it.\n\nA new paragraph starts. It ends here.';

describe('sentence timings inside a section', () => {
  it('times every sentence, in order, with its paragraph', () => {
    const lines = sectionLines(text, voicedLike(text), SR);
    expect(lines.map((l) => l.text)).toEqual(['The first sentence is here.', 'A second one follows it.', 'A new paragraph starts.', 'It ends here.']);
    expect(lines.map((l) => l.para)).toEqual([0, 0, 1, 1]);
    for (let i = 1; i < lines.length; i++) expect(lines[i]!.start).toBeGreaterThanOrEqual(lines[i - 1]!.end - 1e-9);
    // The second paragraph starts where the voice started its group, after the paragraph pause.
    const voiced = voicedLike(text);
    expect(lines[2]!.start).toBeCloseTo(voiced.boundaries.at(-1)! / SR, 3);
    expect(lines.at(-1)!.end).toBeCloseTo(voiced.samples / SR, 3);
  });

  it('spreads by characters when the text no longer splits the way it was voiced', () => {
    const lines = sectionLines(text, { samples: 10 * SR, boundaries: [] }, SR);
    expect(lines).toHaveLength(4);
    expect(lines[0]!.start).toBe(0);
    expect(lines.at(-1)!.end).toBeCloseTo(10, 3);
  });
});

describe('pauses in the audio', () => {
  it('finds a pause between two stretches of sound and moves the estimate to it', () => {
    const audio = new Float32Array(3 * SR);
    for (let i = 0; i < audio.length; i++) if (i < 1200 || i > 1600) audio[i] = 0.3 * Math.sin(i);
    const pauses = findPauses(audio, SR);
    expect(pauses).toHaveLength(1);
    expect(pauses[0]!.start).toBeCloseTo(1.2, 1);
    expect(pauses[0]!.end).toBeCloseTo(1.61, 1);
    const snapped = snapToPauses(
      [
        { start: 0, end: 1.9 },
        { start: 1.9, end: 3 },
      ],
      pauses,
    );
    expect(snapped[1]!.start).toBeCloseTo(1.57, 1);
    expect(snapped[0]!.end).toBeCloseTo(1.2, 1);
  });

  it('leaves a start alone when no pause is near it', () => {
    const lines = [
      { start: 0, end: 5 },
      { start: 5, end: 9 },
    ];
    expect(snapToPauses(lines, [{ start: 8, end: 8.5 }])).toEqual(lines);
  });
});

describe('timings for the whole file', () => {
  const seg = (kind: Segment['kind'], start: number, end: number, over: Partial<Segment> = {}): Segment => ({ kind, label: kind, start, end, ...over });

  it('places sentences across a cue that splits their section, with the app lines between, ending at the file length', () => {
    const voiced = voicedLike(text);
    const length = voiced.samples / SR;
    const split = voiced.boundaries.at(-1)! / SR;
    const segments = [
      seg('app', 0, 5, { role: 'intro' }),
      seg('source', 6, 6 + split, { label: 'One', sectionId: 's01' }),
      seg('app', 6 + split + 1, 6 + split + 4, { role: 'halfway' }),
      seg('source', 6 + split + 5, 6 + length + 5, { label: 'One', sectionId: 's01' }),
      seg('app', 6 + length + 6, 6 + length + 8, { role: 'outro' }),
    ];
    const total = 6 + length + 9;
    const t = buildTimings({
      seconds: total,
      sampleRate: SR,
      segments,
      sections: [{ id: 's01', label: 'One', text }],
      voiced: { s01: voiced },
      appText: { intro: 'This is your walk.', halfway: "You're halfway.", outro: "That's the end." },
    });
    expect(t.lines.map((l) => l.speaker)).toEqual(['app', 'source', 'source', 'app', 'source', 'source', 'app']);
    expect(t.lines[3]!.text).toBe("You're halfway.");
    // The paragraph after the cue starts after it, where its audio was placed.
    expect(t.lines[4]!.start).toBeCloseTo(6 + split + 5, 2);
    for (let i = 1; i < t.lines.length; i++) expect(t.lines[i]!.start).toBeGreaterThanOrEqual(t.lines[i - 1]!.end);
    expect(t.lines.at(-1)!.end).toBe(Math.round(total * 1000) / 1000);
    expect(t.sections).toEqual([{ id: 's01', label: 'One', start: 6 }]);
  });
});

describe('the line being spoken', async () => {
  const { lineAt, stamp } = await import('../src/web/readalong.js');
  const lines = [
    { start: 0, end: 4 },
    { start: 4.2, end: 9 },
    { start: 9.5, end: 12 },
  ];

  it('is the last line that has started', () => {
    expect(lineAt(lines, -1)).toBe(-1);
    expect(lineAt(lines, 0)).toBe(0);
    expect(lineAt(lines, 4.19)).toBe(1);
    expect(lineAt(lines, 9.4)).toBe(1);
    expect(lineAt(lines, 60)).toBe(2);
    expect(lineAt([], 3)).toBe(-1);
  });

  it('writes times the way the screens do', () => {
    expect(stamp(149.4)).toBe('2:29');
    expect(stamp(3725)).toBe('1:02:05');
  });
});
