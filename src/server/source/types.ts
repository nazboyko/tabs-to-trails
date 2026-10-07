export type SourceKind = 'devto' | 'web' | 'text' | 'file';

export interface SourceDoc {
  kind: SourceKind;
  title: string;
  markdown: string;
  url?: string;
  byline?: string;
  /** Parts the adapter removed on purpose, named on the Ready screen. */
  leftOut?: string[];
}

/** A calm message the user can act on; shown as is. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly suggestPaste = true,
  ) {
    super(message);
  }
}

export const UNREADABLE =
  "I couldn't find a readable article on this page. Paste the text instead.";
