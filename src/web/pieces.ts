/**
 * The list of sources a playlist walk is read from. No imports, so the same
 * file runs in the browser and in the tests.
 */

export const MAX_PIECES = 8;

export type QueuedSource =
  | { kind: 'url'; url: string }
  | { kind: 'text'; text: string; title?: string }
  | { kind: 'file'; name: string; text: string };

/** Links typed one per line, with https:// added where the scheme is missing. */
export function parseLinks(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/^[a-z]+:\/\//i.test(line) ? line : `https://${line}`));
}

/** The list with one item taken from one place and put at another. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** A short name for a source in the list: the link without its scheme, the file name, or the text's title or first words. */
export function sourceName(source: QueuedSource): string {
  if (source.kind === 'url') {
    const bare = source.url.replace(/^[a-z]+:\/\/(www\.)?/i, '').replace(/\/$/, '');
    return bare.length > 60 ? `${bare.slice(0, 57)}...` : bare;
  }
  if (source.kind === 'file') return source.name;
  const title = source.title?.trim();
  if (title) return title;
  const words = source.text.trim().split(/\s+/);
  return `“${words.slice(0, 6).join(' ')}${words.length > 6 ? '...' : ''}”`;
}

/** What can still go in: null when it fits, else the sentence to show. */
export function roomFor(inList: number, adding: number): string | null {
  if (inList + adding <= MAX_PIECES) return null;
  const left = MAX_PIECES - inList;
  if (left <= 0) return `A walk holds up to ${MAX_PIECES} pieces, and this one is full.`;
  return `A walk holds up to ${MAX_PIECES} pieces. There is room for ${left} more.`;
}
