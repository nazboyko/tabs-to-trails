import { SourceError, type SourceDoc } from './types.js';

export const MAX_TEXT_CHARS = 400_000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Text pasted from a page often has one line per paragraph and no blank lines.
 * Markdown needs the blank lines, so they are added back.
 */
export function normalizePasted(text: string): string {
  const unix = text.replace(/\r\n?/g, '\n').replace(/ /g, ' ').trim();
  if (/\n\s*\n/.test(unix)) return unix;
  return unix.replace(/\n+/g, '\n\n');
}

function firstHeading(md: string): string | null {
  const m = md.match(/^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/m);
  return m ? m[1]!.trim() : null;
}

export function titleFromFileName(name: string): string {
  const base = name.replace(/^.*[\\/]/, '').replace(/\.(md|markdown|txt)$/i, '');
  const words = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'your file';
}

export function fromText(text: string, title?: string): SourceDoc {
  if (text.length > MAX_TEXT_CHARS) {
    throw new SourceError('That is more text than one walk can hold. Paste a part of it instead.', false);
  }
  const markdown = normalizePasted(text);
  if (!/[\p{L}\p{N}]/u.test(markdown)) throw new SourceError('There is no text to read yet. Paste something first.', false);
  const clean = title?.replace(/\s+/g, ' ').trim();
  return { kind: 'text', title: clean || firstHeading(markdown) || 'your pasted text', markdown };
}

export function fromFile(name: string, data: Buffer | string): SourceDoc {
  if (!/\.(md|markdown|txt)$/i.test(name)) {
    throw new SourceError('Only .md and .txt files can be read. Paste the text instead.', false);
  }
  const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  if (size > MAX_FILE_BYTES) throw new SourceError('That file is larger than 2 MB. Paste a part of it instead.', false);
  const text = typeof data === 'string' ? data : new TextDecoder('utf-8').decode(data);
  const doc = fromText(text, firstHeading(normalizePasted(text)) ?? titleFromFileName(name));
  return { ...doc, kind: 'file' };
}
