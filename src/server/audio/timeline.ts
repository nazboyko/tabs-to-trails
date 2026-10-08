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
  // Sections with a gap between them; a cue may go before any section but the first.
  const items: CueItem[] = [];
  pieces.forEach((p, i) => {
    if (i > 0) items.push({ length: gap, boundaries: [], cueBefore: false });
    items.push({ length: p.length, boundaries: p.boundaries, cueBefore: i > 0 });
  });
  const [spot] = placeCues({ before, items, after, cues: [{ fraction: 0.5, length: cue }] });
  if (!spot) return null;
  return { piece: Math.floor(spot.item / 2), offset: spot.offset, cueStart: spot.cueStart, total: spot.total };
}

/** One stretch of the walk between the intro and the closing lines. */
export interface CueItem {
  length: number;
  /** Offsets inside the item where a cue may go (between sentence groups). */
  boundaries: number[];
  /** A cue may go right before this item starts. */
  cueBefore: boolean;
}

export interface CueRequest {
  /** Where the cue should sit, as a share of the finished walk. */
  fraction: number;
  /** The whole cue block in samples: pause, chime, spoken cue, pause. */
  length: number;
}

export interface CueSpot {
  /** Which of the requested cues this is. */
  cue: number;
  item: number;
  /** 0 means right before the item. */
  offset: number;
  /** Sample where the cue block starts in the finished walk. */
  cueStart: number;
  total: number;
}

/**
 * Places cues (in increasing order of fraction) at the allowed spot nearest
 * where each should sit in the finished walk, counting every cue's own length.
 * A cue that has no allowed spot after the previous one is left out.
 */
export function placeCues(input: { before: number; items: CueItem[]; after: number; cues: CueRequest[] }): CueSpot[] {
  const { before, items, after, cues } = input;
  const content = items.reduce((n, it) => n + it.length, 0);
  const total = before + content + after + cues.reduce((n, c) => n + c.length, 0);
  const candidates: { item: number; offset: number; base: number }[] = [];
  let start = before;
  items.forEach((it, i) => {
    if (it.cueBefore) candidates.push({ item: i, offset: 0, base: start });
    for (const b of it.boundaries) if (b > 0 && b < it.length) candidates.push({ item: i, offset: b, base: start + b });
    start += it.length;
  });
  const spots: CueSpot[] = [];
  let earlier = 0;
  let previous = -1;
  cues.forEach((cue, index) => {
    // In the finished walk, this cue starts at its base position plus the cues already placed before it.
    const ideal = cue.fraction * total - cue.length / 2 - earlier;
    let best: (typeof candidates)[number] | null = null;
    for (const c of candidates) {
      if (c.base <= previous) continue;
      if (!best || Math.abs(c.base - ideal) < Math.abs(best.base - ideal)) best = c;
    }
    if (!best) return;
    spots.push({ cue: index, item: best.item, offset: best.offset, cueStart: best.base + earlier, total });
    previous = best.base;
    earlier += cue.length;
  });
  return spots;
}

export type SegmentKind = 'app' | 'source';

export interface Segment {
  kind: SegmentKind;
  label: string;
  sectionId?: string;
  /** Piece of a multi-source walk. */
  piece?: number;
  role?: 'intro' | 'halfway' | 'threequarter' | 'bridge' | 'question' | 'outro';
  start: number;
  end: number;
}

/** Seconds as m:ss, or h:mm:ss from an hour on (the same as the screens show). */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
