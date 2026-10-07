import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type VoiceKey } from '../config.js';
import { countWords } from '../source/sections.js';
import { DTYPE, VOICES, voiceText } from './kokoro.js';
import { seconds } from './wav.js';

/**
 * A fixed passage written for this app: about 250 words with the things that
 * slow a voice down in real articles (numbers, a version, short paragraphs).
 */
export const CALIBRATION_TEXT = `Most of what we save to read later never gets read. The tab stays open for a week, then a month (sometimes three), and one evening the browser closes and it is gone.

It was not a bad article. There was just never a quiet half hour in front of the screen to give it.

A walk is a quiet half hour. Your eyes are busy with the street, the trees and the traffic, but your ears are free. If the article could come along, the walk would carry it.

This recording is a test of the voice at its normal pace. The app uses it to learn how much text fits into a minute. If you ask for a 20-minute walk, it needs to know how much 20 minutes can hold before it decides what to keep in full and what to shorten.

Some things slow a voice down: numbers like 3.5 or 1,200, version names like 2.0, short lines, and long names. Others speed it up. One measurement is not perfect, but it is honest, and it beats a guess.

The result is saved on this computer, one number per voice. Every walk after this one starts from it, and every finished walk corrects it a little.

If a walk comes out long or short, the app shows the measured time instead of pretending it was exact. Then it gets out of the way, and you go outside.`;

export interface Calibration {
  voice: string;
  dtype: string;
  words: number;
  chars: number;
  seconds: number;
  wordsPerMinute: number;
  /** Characters of spoken text per second, pauses included. */
  charsPerSecond: number;
  measuredAt: string;
}

/** Characters a voice reads, counted the same way for the passage and for sources. */
export function spokenChars(text: string): number {
  return text.replace(/\s+/g, ' ').trim().length;
}

/** Words per minute for a source with this many characters per word. */
export function effectiveWpm(cal: Calibration, charsPerWord: number): number {
  return Math.round(((cal.charsPerSecond * 60) / charsPerWord) * 10) / 10;
}

function calibrationFile(): string {
  return path.join(loadConfig().WALKS_DIR, '.calibration.json');
}

async function readAll(): Promise<Record<string, Calibration>> {
  let raw: string;
  try {
    raw = await fs.readFile(calibrationFile(), 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, Calibration>;
  } catch {
    // Keep the damaged file for a look instead of overwriting every voice's numbers.
    await fs.rename(calibrationFile(), `${calibrationFile()}.bad`).catch(() => undefined);
    return {};
  }
}

function keyFor(voice: VoiceKey): string {
  return `${VOICES[voice].id}@${DTYPE}`;
}

async function save(key: string, value: Calibration): Promise<void> {
  await fs.mkdir(path.dirname(calibrationFile()), { recursive: true });
  const tmp = `${calibrationFile()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ ...(await readAll()), [key]: value }, null, 2));
  await fs.rename(tmp, calibrationFile());
}

export async function calibration(voice: VoiceKey): Promise<Calibration> {
  const key = keyFor(voice);
  const known = (await readAll())[key];
  if (known?.charsPerSecond) return known;
  const voiced = await voiceText(CALIBRATION_TEXT, voice);
  const words = countWords(CALIBRATION_TEXT);
  const chars = CALIBRATION_TEXT.split(/\n\s*\n/).reduce((n, p) => n + spokenChars(p), 0);
  const secs = seconds(voiced.samples);
  const result: Calibration = {
    voice: VOICES[voice].id,
    dtype: DTYPE,
    words,
    chars,
    seconds: Math.round(secs * 100) / 100,
    wordsPerMinute: Math.round((words / secs) * 60 * 10) / 10,
    charsPerSecond: Math.round((chars / secs) * 1000) / 1000,
    measuredAt: new Date().toISOString(),
  };
  await save(key, result);
  return result;
}
