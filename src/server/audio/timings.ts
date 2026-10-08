/**
 * Read-along timings: when each sentence is spoken in the finished file.
 * The voice reports where each sentence group starts; inside a group the
 * measured length is split across its sentences by their characters. Pure,
 * from what the walk folder already holds, so it works for any walk.
 */

import { splitSentences } from '../source/sections.js';
import { CHUNK_GAP, chunkText, PARAGRAPH_GAP, speakable } from './speakable.js';
import type { Segment } from './timeline.js';

export interface TimedLine {
  /** Seconds in the finished file. */
  start: number;
  end: number;
  text: string;
  speaker: 'source' | 'app';
  /** The section a source line belongs to. */
  section?: string;
  /** Paragraph within the section, from 0. */
  para?: number;
  role?: Segment['role'];
}

export interface TimedSection {
  id: string;
  label: string;
  start: number;
  piece?: number;
}

export interface Timings {
  seconds: number;
  sections: TimedSection[];
  lines: TimedLine[];
}

export interface TimingInput {
  seconds: number;
  sampleRate: number;
  segments: Segment[];
  sections: { id: string; label: string; text: string; piece?: number }[];
  /** Voiced audio per section id: total samples and where each sentence group after the first starts. */
  voiced: Record<string, { samples: number; boundaries: number[] } | undefined>;
  /** The app's spoken text for each role that has one (intro, halfway, question...). */
  appText: Partial<Record<NonNullable<Segment['role']>, string>>;
  /** Each section's voiced audio, when at hand: sentence starts are then moved to the pauses the voice really made. */
  audio?: Record<string, Float32Array | undefined>;
}

/** A stretch of near silence in voiced audio, in seconds. */
export interface Pause {
  start: number;
  end: number;
}

const FRAME = 0.01;
const QUIET = 0.01;
/** Shorter gaps are breaths and commas, not sentence ends. */
const MIN_PAUSE = 0.12;
/** How far from the estimate a sentence start may move. */
const SNAP_WINDOW = 1.2;
/** The first word starts a little before the voice is loud again. */
const LEAD = 0.04;

/** Pauses in the audio: 10 ms frames under a low level for at least 120 ms. */
export function findPauses(audio: Float32Array, sampleRate: number): Pause[] {
  const frame = Math.max(1, Math.round(sampleRate * FRAME));
  const pauses: Pause[] = [];
  let quietFrom = -1;
  const frames = Math.floor(audio.length / frame);
  for (let f = 0; f <= frames; f++) {
    let loud = true;
    if (f < frames) {
      let e = 0;
      for (let j = f * frame; j < (f + 1) * frame; j++) e += audio[j]! * audio[j]!;
      loud = Math.sqrt(e / frame) >= QUIET;
    }
    if (!loud && quietFrom < 0) quietFrom = f;
    if (loud && quietFrom >= 0) {
      if ((f - quietFrom) * FRAME >= MIN_PAUSE) pauses.push({ start: quietFrom * FRAME, end: f * FRAME });
      quietFrom = -1;
    }
  }
  return pauses;
}

/**
 * Moves each estimated sentence start (but the first) to the end of a real
 * pause near it, preferring longer pauses and keeping the order; the
 * sentence before then ends where that pause starts.
 */
export function snapToPauses<T extends { start: number; end: number }>(lines: T[], pauses: Pause[]): T[] {
  const out = lines.map((l) => ({ ...l }));
  let floor = out[0]?.start ?? 0;
  for (let i = 1; i < out.length; i++) {
    const est = out[i]!.start;
    let best: Pause | null = null;
    let bestScore = Infinity;
    for (const p of pauses) {
      if (p.end <= floor + 0.2 || Math.abs(p.end - est) > SNAP_WINDOW) continue;
      const score = Math.abs(p.end - est) - 0.8 * Math.min(0.6, p.end - p.start);
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) {
      out[i]!.start = Math.max(best.start, best.end - LEAD);
      out[i - 1]!.end = Math.min(out[i - 1]!.end, best.start);
    }
    floor = out[i]!.start;
  }
  return out;
}

interface Span {
  start: number;
  end: number;
  chars: number;
}

/** A character position inside a run of spans, as seconds. Starts at a boundary go to the next span, ends to the one before. */
function timeAt(spans: Span[], pos: number, side: 'start' | 'end'): number {
  let before = 0;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    const after = before + s.chars;
    const last = i === spans.length - 1;
    if (pos < after || (side === 'end' && pos === after) || last) {
      const share = s.chars ? Math.min(1, Math.max(0, (pos - before) / s.chars)) : 0;
      return s.start + share * (s.end - s.start);
    }
    before = after;
  }
  return spans.at(-1)?.end ?? 0;
}

/** Each sentence of one section, timed inside the section's own audio (seconds from its start). */
export function sectionLines(text: string, voiced: { samples: number; boundaries: number[] }, sampleRate: number): { text: string; para: number; start: number; end: number }[] {
  const total = voiced.samples / sampleRate;
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => speakable(p) !== '');
  const sentences = paras.map((p) => splitSentences(p));
  const chunks = chunkText(text);
  const weight = (s: string) => Math.max(1, speakable(s).length + 1);

  // The voice's own groups: where each starts and ends, without the pause after it.
  let spans: Span[][];
  if (chunks.length === voiced.boundaries.length + 1 && chunks.filter((c) => c.paragraphEnd).length === paras.length) {
    const flat = chunks.map((c, i) => ({
      start: i === 0 ? 0 : voiced.boundaries[i - 1]! / sampleRate,
      end: i < chunks.length - 1 ? voiced.boundaries[i]! / sampleRate - (c.paragraphEnd ? PARAGRAPH_GAP : CHUNK_GAP) : total,
      chars: c.text.length + 1,
      paragraphEnd: c.paragraphEnd,
    }));
    spans = [];
    let current: Span[] = [];
    for (const s of flat) {
      current.push({ start: s.start, end: Math.max(s.start, s.end), chars: s.chars });
      if (s.paragraphEnd) {
        spans.push(current);
        current = [];
      }
    }
  } else {
    // The text no longer splits the way it did when it was voiced: spread the section evenly by characters.
    const all = sentences.flat().reduce((n, s) => n + weight(s), 0);
    let at = 0;
    spans = sentences.map((ss) => {
      const chars = ss.reduce((n, s) => n + weight(s), 0);
      const span = { start: (at / all) * total, end: ((at + chars) / all) * total, chars };
      at += chars;
      return [span];
    });
  }

  const out: { text: string; para: number; start: number; end: number }[] = [];
  sentences.forEach((ss, para) => {
    const group = spans[para] ?? [];
    const chars = group.reduce((n, s) => n + s.chars, 0);
    const words = ss.reduce((n, s) => n + weight(s), 0);
    const scale = words ? chars / words : 1;
    let pos = 0;
    for (const s of ss) {
      const w = weight(s) * scale;
      out.push({ text: s, para, start: timeAt(group, pos, 'start'), end: timeAt(group, pos + w, 'end') });
      pos += w;
    }
  });
  return out;
}

/** From a time inside a section's audio to the time in the file, across the cues that split it. */
function placeInFile(segs: Segment[], t: number, side: 'start' | 'end'): number {
  let before = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const length = seg.end - seg.start;
    const last = i === segs.length - 1;
    // A millisecond of slack: a start exactly where a cue split the section belongs after the cue.
    const edge = before + length;
    if ((side === 'start' ? t < edge - 0.001 : t <= edge + 0.001) || last) return seg.start + Math.min(length, Math.max(0, t - before));
    before += length;
  }
  return segs.at(-1)?.end ?? 0;
}

const round = (s: number) => Math.round(s * 1000) / 1000;

export function buildTimings(input: TimingInput): Timings {
  const lines: TimedLine[] = [];
  const sections: TimedSection[] = [];
  for (const s of input.sections) {
    const segs = input.segments.filter((g) => g.kind === 'source' && g.sectionId === s.id);
    const voiced = input.voiced[s.id];
    if (!segs.length || !voiced) continue;
    sections.push({ id: s.id, label: s.label, start: round(segs[0]!.start), ...(s.piece !== undefined ? { piece: s.piece } : {}) });
    const audio = input.audio?.[s.id];
    let local = sectionLines(s.text, voiced, input.sampleRate);
    if (audio) local = snapToPauses(local, findPauses(audio, input.sampleRate));
    for (const line of local) {
      lines.push({
        start: placeInFile(segs, line.start, 'start'),
        end: placeInFile(segs, line.end, 'end'),
        text: line.text,
        speaker: 'source',
        section: s.id,
        para: line.para,
      });
    }
  }
  for (const seg of input.segments) {
    if (seg.kind !== 'app' || !seg.role || seg.role === 'silence') continue;
    const text = seg.role === 'bridge' ? seg.label : input.appText[seg.role];
    if (text) lines.push({ start: seg.start, end: seg.end, text, speaker: 'app', role: seg.role });
  }
  lines.sort((a, b) => a.start - b.start);
  // In order, never overlapping, and the last one runs to the end of the file.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (next && line.end > next.start) line.end = next.start;
    if (line.end < line.start) line.end = line.start;
  }
  if (lines.length) lines.at(-1)!.end = Math.max(lines.at(-1)!.end, input.seconds);
  return {
    seconds: round(input.seconds),
    sections,
    lines: lines.map((l) => ({ ...l, start: round(l.start), end: round(l.end) })),
  };
}
