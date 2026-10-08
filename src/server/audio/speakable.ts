import { splitSentences } from '../source/sections.js';

/**
 * Pronunciation fixes applied after the number guard, right before the voice.
 * Entries are added only after hearing a real problem.
 */
const PRONOUNCE: [RegExp, string][] = [
  [/\s*&\s*/g, ' and '],
  [/\be\.g\./gi, 'for example'],
  [/\bi\.e\./gi, 'that is'],
  [/\bvs\.?(?=\s)/gi, 'versus'],
  [/\b([CF])#(?!\w)/g, '$1 sharp'],
  [/(^|\s)#(\d)/g, '$1number $2'],
  [/\s*>=\s*(?=\d)/g, ' at least '],
  [/\s*<=\s*(?=\d)/g, ' at most '],
  [/\s*>\s*(?=\d)/g, ' more than '],
  [/\s*<\s*(?=\d)/g, ' less than '],
  // "Settings > Accessibility" is a path through menus; a pause reads it best.
  [/\s+[>»]\s+/g, ', '],
];

export function speakable(text: string): string {
  let s = text;
  for (const [re, to] of PRONOUNCE) s = s.replace(re, to);
  return s.replace(/[*_#`|<>{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Pauses between sentence groups and between paragraphs, in seconds. */
export const CHUNK_GAP = 0.2;
/** Pause where one chunk had to be split to fit the phoneme limit. */
export const PIECE_GAP = 0.1;
export const PARAGRAPH_GAP = 0.45;

/** Kokoro reads at most 510 tokens per call, so text is voiced in sentence groups. */
export const MAX_CHUNK_CHARS = 320;

function splitLong(sentence: string): string[] {
  if (sentence.length <= MAX_CHUNK_CHARS) return [sentence];
  const out: string[] = [];
  let buf = '';
  for (const piece of sentence.split(/(?<=[,;:])\s+|\s+(?=\b(?:and|but|or|because|which|so)\b)/)) {
    if (buf && buf.length + piece.length + 1 > MAX_CHUNK_CHARS) {
      out.push(buf);
      buf = '';
    }
    buf = buf ? `${buf} ${piece}` : piece;
    while (buf.length > MAX_CHUNK_CHARS) {
      const cut = buf.lastIndexOf(' ', MAX_CHUNK_CHARS);
      const at = cut > 40 ? cut : MAX_CHUNK_CHARS;
      out.push(buf.slice(0, at).trim());
      buf = buf.slice(at).trim();
    }
  }
  if (buf) out.push(buf);
  return out;
}

export interface Chunk {
  text: string;
  /** True when the chunk ends a paragraph. */
  paragraphEnd: boolean;
}

/** Paragraphs -> sentence groups of at most MAX_CHUNK_CHARS characters. */
export function chunkText(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const sentences = splitSentences(speakable(para)).flatMap(splitLong);
    let buf = '';
    const start = chunks.length;
    for (const s of sentences) {
      if (buf && buf.length + s.length + 1 > MAX_CHUNK_CHARS) {
        chunks.push({ text: buf, paragraphEnd: false });
        buf = '';
      }
      buf = buf ? `${buf} ${s}` : s;
    }
    if (buf) chunks.push({ text: buf, paragraphEnd: false });
    if (chunks.length > start) chunks[chunks.length - 1]!.paragraphEnd = true;
  }
  return chunks;
}
