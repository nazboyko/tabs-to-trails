import { fetchDevto } from './devto.js';
import { fromFile, fromText } from './paste.js';
import { fetchReadable, parseHttpUrl } from './readable.js';
import { countWords, splitSections } from './sections.js';
import { SourceError, type SourceDoc, type SourceKind } from './types.js';

/** A source already read when it was saved to the list: its Markdown sits in the walk folder. */
export interface SavedInput {
  kind: 'saved';
  itemId: string;
  /** File name inside the walk folder, chosen by the server. */
  file: string;
  doc: { kind: SourceKind; title: string; url?: string; byline?: string; leftOut?: string[] };
}

export type SourceInput =
  | { kind: 'url'; url: string }
  | { kind: 'text'; text: string; title?: string }
  | { kind: 'file'; name: string; text: string }
  | SavedInput;

/** Longer than this is a book, not a walk. Said out loud instead of cut silently. */
export const MAX_SOURCE_WORDS = 60_000;

export async function readSource(input: SourceInput, signal?: AbortSignal): Promise<SourceDoc> {
  let doc: SourceDoc;
  if (input.kind === 'saved') throw new Error('A saved source is read from its walk folder.');
  if (input.kind === 'url') {
    parseHttpUrl(input.url);
    doc = (await fetchDevto(input.url, signal)) ?? (await fetchReadable(input.url, signal));
  } else if (input.kind === 'text') {
    doc = fromText(input.text, input.title);
  } else {
    doc = fromFile(input.name, input.text);
  }
  const words = countWords(doc.markdown);
  if (words > MAX_SOURCE_WORDS) {
    throw new SourceError(
      `This is about ${words.toLocaleString('en-US')} words, more than one walk can hold. Paste a part of it instead.`,
      false,
    );
  }
  if (!splitSections(doc.markdown).length) throw new SourceError('I found no text to read in this source. Paste the text instead.');
  return doc;
}
