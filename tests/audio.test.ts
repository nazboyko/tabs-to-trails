import { describe, expect, it } from 'vitest';
import { fitPhonemes, MAX_PHONEMES } from '../src/server/audio/kokoro.js';
import { chunkText, MAX_CHUNK_CHARS, speakable } from '../src/server/audio/speakable.js';
import { clock, placeHalfway } from '../src/server/audio/timeline.js';
import { decodeWav, encodeWav } from '../src/server/audio/wav.js';

describe('wav', () => {
  it('round-trips samples through 16-bit PCM', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
    const back = decodeWav(encodeWav(samples, 24000));
    expect(back.rate).toBe(24000);
    expect(back.samples.length).toBe(samples.length);
    back.samples.forEach((v, i) => expect(v).toBeCloseTo(samples[i]!, 3));
  });
});

describe('chunkText', () => {
  it('keeps chunks under the limit and marks paragraph ends', () => {
    const para = 'A sentence of moderate length goes here. '.repeat(20);
    const chunks = chunkText(`${para}\n\nShort one.`);
    expect(chunks.every((c) => c.text.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(chunks.at(-1)).toEqual({ text: 'Short one.', paragraphEnd: true });
    expect(chunks.filter((c) => c.paragraphEnd)).toHaveLength(2);
  });

  it('cuts a sentence that is too long on its own', () => {
    const long = 'word, '.repeat(120) + 'end.';
    expect(chunkText(long).every((c) => c.text.length <= MAX_CHUNK_CHARS)).toBe(true);
  });

  it('applies the pronunciation map', () => {
    expect(speakable('Tom & Jerry, e.g. cats')).toBe('Tom and Jerry, for example cats');
    expect(speakable('Latency > 200 ms in C# and F#')).toBe('Latency more than 200 ms in C sharp and F sharp');
    expect(speakable('Open Settings > Accessibility > Spoken Content')).toBe('Open Settings, Accessibility, Spoken Content');
    expect(speakable('Ranked #1 with < 5 errors')).toBe('Ranked number 1 with less than 5 errors');
  });
});

describe('placeHalfway', () => {
  it('puts the cue at the boundary nearest the middle of the finished walk', () => {
    const spot = placeHalfway({
      before: 10,
      pieces: [
        { length: 100, boundaries: [40, 80] },
        { length: 100, boundaries: [30, 60] },
      ],
      gap: 2,
      cue: 6,
      after: 12,
    })!;
    // total = 10 + 202 + 6 + 12 = 230; ideal cue start = 115 - 3 = 112
    expect(spot.total).toBe(230);
    expect(spot).toMatchObject({ piece: 1, offset: 0, cueStart: 112 });
  });

  it('can split a section at a sentence group', () => {
    const spot = placeHalfway({ before: 0, pieces: [{ length: 200, boundaries: [50, 98, 150] }], gap: 0, cue: 4, after: 0 })!;
    expect(spot).toMatchObject({ piece: 0, offset: 98 });
  });

  it('returns null with no content', () => {
    expect(placeHalfway({ before: 0, pieces: [], gap: 0, cue: 1, after: 0 })).toBeNull();
  });
});

describe('clock', () => {
  it('formats m:ss', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(1187.4)).toBe('19:47');
    expect(clock(59.6)).toBe('1:00');
  });
});

describe('fitPhonemes', () => {
  // Pretend every character is one phoneme, digits ten.
  const measure = async (t: string) => [...t].reduce((n, c) => n + (/\d/.test(c) ? 10 : 1), 0);

  it('leaves a chunk that fits alone', async () => {
    expect(await fitPhonemes('A short sentence.', measure)).toEqual(['A short sentence.']);
  });

  it('splits number-heavy text until every piece fits, losing no words', async () => {
    const text = 'Revenue was 1234567 in 2023. It was 2345678 in 2024, then 3456789 in 2025, with 98765 users and 12345 teams.';
    const pieces = await fitPhonemes(text, measure);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(await measure(p)).toBeLessThanOrEqual(MAX_PHONEMES);
    expect(pieces.join(' ')).toBe(text);
  });
});
