/**
 * The walk list: things saved to read on a walk. Pure helpers for order and
 * status, so the rules are tested without a folder or a network.
 */

import { planWalk } from '../script/budget.js';
import type { Section } from '../source/sections.js';
import type { SourceKind } from '../source/types.js';

export type ItemKind = 'link' | 'text' | 'file';
export type ItemStatus = 'checking' | 'ready' | 'unreadable' | 'in_walk';

/** How the source was read; with source.md it is everything a build needs. */
export interface SavedDoc {
  kind: SourceKind;
  title: string;
  url?: string;
  byline?: string;
  leftOut?: string[];
}

export interface ListItem {
  id: string;
  kind: ItemKind;
  /** The source's own title once read; before that, what the person gave. */
  title: string;
  /** What the person gave: the link, the file name or the text's title. */
  label: string;
  url?: string;
  words: number;
  /** Read in full, at the voice's measured pace. */
  minutes: number;
  status: ItemStatus;
  /** Why a row could not be read, in words for the person. */
  reason?: string;
  savedAt: string;
  checkedAt?: string;
  /** The walk this item went into; it counts as in that walk only while the walk is queued, running or done. */
  walkId?: string;
  seriesId?: string;
  part?: number;
  parts?: number;
  doc?: SavedDoc;
}

/** Words per minute before the voice has ever been measured. */
export const DEFAULT_WPM = 165;

/** Most checks running at once, so a long paste does not open a dozen connections. */
export const MAX_CHECKS = 3;

/** Read in full, in minutes: the planner's own estimate, gaps between sections included. */
export function estimateMinutes(sections: Section[], wpm: number): number {
  const plan = planWalk({ sections, targetSeconds: null, wpm, fixedSeconds: 0 });
  return Math.round((plan.fullSeconds / 60) * 10) / 10;
}

/** A link in a form two saves of the same page share: no fragment, no trailing slash, no "www.". */
export function linkKey(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return `${host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * The status a row shows. An item marked as in a walk is back in the list
 * when that walk failed, was cancelled or is gone.
 */
export function viewStatus(item: ListItem, walkState: string | null): ItemStatus {
  if (item.status !== 'in_walk') return item.status;
  return walkState === 'queued' || walkState === 'running' || walkState === 'done' ? 'in_walk' : 'ready';
}

/** A new order from the ids the page sends: those first, as given, then every other id where it was. */
export function reorder(order: string[], ids: string[]): string[] {
  if (new Set(ids).size !== ids.length) throw new Error('An item appears twice.');
  const known = new Set(order);
  for (const id of ids) if (!known.has(id)) throw new Error('There is no such item.');
  const moved = new Set(ids);
  return [...ids, ...order.filter((id) => !moved.has(id))];
}

/** Ids in the order file, then any folder the order file does not name yet (a crash between two writes). */
export function ordered(order: string[], present: string[]): string[] {
  const here = new Set(present);
  const listed = order.filter((id) => here.has(id));
  const seen = new Set(listed);
  return [...new Set([...listed, ...present.filter((id) => !seen.has(id)).sort()])];
}

/** The row a fresh check turns into. */
export function checked(item: ListItem, doc: SavedDoc, sections: Section[], wpm: number, now: string): ListItem {
  const words = sections.reduce((n, s) => n + s.words, 0);
  return {
    ...item,
    title: doc.title,
    url: doc.url ?? item.url,
    words,
    minutes: estimateMinutes(sections, wpm),
    status: 'ready',
    reason: undefined,
    checkedAt: now,
    doc,
  };
}

export function unreadable(item: ListItem, reason: string, now: string): ListItem {
  return { ...item, status: 'unreadable', reason, checkedAt: now, words: 0, minutes: 0, doc: undefined };
}
