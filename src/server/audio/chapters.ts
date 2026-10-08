/**
 * Chapters for the file itself, so a phone's own player can resume and skip
 * with the laptop out of reach. Pure: from the measured timeline only.
 */

import type { Segment } from './timeline.js';

export interface Chapter {
  title: string;
  /** Seconds. */
  start: number;
  end: number;
}

export const CLOSING_TITLE = 'Closing';

/**
 * One chapter per section; in a walk of several pieces, the section is named
 * with its piece (a one-section piece by its title alone). The app's own lines
 * have no chapter of their own: the intro belongs to the first chapter, a cue
 * or a "Next:" line to the chapter that follows it, and the question and the
 * sign-off to a last chapter, "Closing". Chapters are back to back from 0 to
 * the end of the file.
 */
export function chaptersFrom(segments: Segment[], total: number, pieceTitles: string[] = []): Chapter[] {
  const sections: { id: string; label: string; piece?: number; end: number }[] = [];
  for (const seg of segments) {
    if (seg.kind !== 'source' || !seg.sectionId) continue;
    const last = sections.at(-1);
    if (last?.id === seg.sectionId) last.end = seg.end;
    else sections.push({ id: seg.sectionId, label: seg.label, piece: seg.piece, end: seg.end });
  }
  if (!sections.length) return [{ title: CLOSING_TITLE, start: 0, end: total }];
  const playlist = pieceTitles.length > 1;
  const perPiece = new Map<number, number>();
  for (const s of sections) perPiece.set(s.piece ?? 0, (perPiece.get(s.piece ?? 0) ?? 0) + 1);
  const title = (s: (typeof sections)[number]) => {
    if (!playlist) return s.label;
    const piece = pieceTitles[s.piece ?? 0] ?? s.label;
    return (perPiece.get(s.piece ?? 0) ?? 0) > 1 && s.label !== piece ? `${piece}: ${s.label}` : piece;
  };
  const chapters = sections.map((s, i) => ({ title: title(s), start: i === 0 ? 0 : sections[i - 1]!.end, end: s.end }));
  const lastEnd = sections.at(-1)!.end;
  if (total > lastEnd + 0.5) chapters.push({ title: CLOSING_TITLE, start: lastEnd, end: total });
  else chapters.at(-1)!.end = total;
  return chapters.map((c) => ({ ...c, start: round(c.start), end: round(c.end) }));
}

const round = (s: number) => Math.round(s * 1000) / 1000;

/** ffmpeg's metadata file: special characters escaped with a backslash, times in milliseconds. */
export function ffmetadata(tags: Record<string, string>, chapters: Chapter[]): string {
  const esc = (v: string) => v.replace(/[\\=;#\n]/g, (c) => `\\${c}`);
  const lines = [';FFMETADATA1', ...Object.entries(tags).map(([k, v]) => `${k}=${esc(v)}`)];
  for (const c of chapters) {
    lines.push('', '[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.start * 1000)}`, `END=${Math.round(c.end * 1000)}`, `title=${esc(c.title)}`);
  }
  return `${lines.join('\n')}\n`;
}
