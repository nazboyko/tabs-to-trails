/**
 * Where the halfway cue goes. Everything here is in samples and pure, so the
 * placement is tested without any audio.
 */

export interface ContentPiece {
  length: number;
  /** Offsets inside the piece where one sentence group ends and the next starts. */
  boundaries: number[];
}

export interface HalfwayInput {
  /** Samples before the first content piece (intro and its pause). */
  before: number;
  pieces: ContentPiece[];
  /** Pause between two content pieces. */
  gap: number;
  /** The whole cue block: pause, chime, spoken cue, pause. */
  cue: number;
  /** Samples after the last piece (question, outro, pauses). */
  after: number;
}

export interface HalfwaySpot {
  piece: number;
  /** 0 means right before the piece starts. */
  offset: number;
  /** Sample where the cue block starts in the finished walk. */
  cueStart: number;
  total: number;
}

export function placeHalfway(input: HalfwayInput): HalfwaySpot | null {
  const { before, pieces, gap, cue, after } = input;
  if (!pieces.length) return null;
  const content = pieces.reduce((n, p) => n + p.length, 0) + gap * (pieces.length - 1);
  const total = before + content + cue + after;
  const ideal = total / 2 - cue / 2;
  let best: HalfwaySpot | null = null;
  let start = before;
  pieces.forEach((p, i) => {
    const candidates = i === 0 ? p.boundaries : [0, ...p.boundaries];
    for (const offset of candidates) {
      const cueStart = start + offset;
      if (!best || Math.abs(cueStart - ideal) < Math.abs(best.cueStart - ideal)) {
        best = { piece: i, offset, cueStart, total };
      }
    }
    start += p.length + gap;
  });
  return best;
}

export type SegmentKind = 'app' | 'source';

export interface Segment {
  kind: SegmentKind;
  label: string;
  sectionId?: string;
  role?: 'intro' | 'halfway' | 'question' | 'outro';
  start: number;
  end: number;
}

/** Seconds as m:ss. */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
