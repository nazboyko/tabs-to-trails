/**
 * A series: one long read cut into several walks instead of one squeezed one.
 * Pure: sections in, parts out, and the Markdown each part is saved as.
 */

import { fullBlockWords } from '../script/budget.js';
import type { Block, Section } from '../source/sections.js';

/** A part may run this much over its words before the next section starts a new part. */
export const PART_TOLERANCE = 0.05;
/** A last part shorter than this share of a walk joins the part before it. */
export const TAIL_SHARE = 0.25;

const words = (blocks: Block[]) => blocks.reduce((n, b) => n + fullBlockWords(b), 0);

/** A section longer than one part, cut at paragraph boundaries into pieces that each fit. */
function cutSection(s: Section, partWords: number): Section[] {
  if (words(s.blocks) <= partWords * (1 + PART_TOLERANCE) || s.blocks.length < 2) return [s];
  const out: Section[] = [];
  let blocks: Block[] = [];
  for (const b of s.blocks) {
    if (blocks.length && words([...blocks, b]) > partWords) {
      out.push({ ...s, blocks, words: words(blocks) });
      blocks = [];
    }
    blocks.push(b);
  }
  if (blocks.length) out.push({ ...s, blocks, words: words(blocks) });
  return out;
}

/**
 * Cuts the sections into parts of about `partWords` each, at section
 * boundaries (inside a section only when it alone is longer than a part), and
 * joins a short last part to the one before it.
 */
export function splitSeries(sections: Section[], partWords: number): Section[][] {
  const pieces = sections.flatMap((s) => cutSection(s, partWords));
  const parts: Section[][] = [];
  let current: Section[] = [];
  let sum = 0;
  for (const s of pieces) {
    const w = words(s.blocks);
    if (current.length && sum + w > partWords * (1 + PART_TOLERANCE)) {
      parts.push(current);
      current = [];
      sum = 0;
    }
    current.push(s);
    sum += w;
  }
  if (current.length) parts.push(current);
  if (parts.length > 1 && words(parts.at(-1)!.flatMap((s) => s.blocks)) < partWords * TAIL_SHARE) {
    const tail = parts.pop()!;
    parts[parts.length - 1]!.push(...tail);
  }
  return parts;
}

/** A part's sections as Markdown again, so it is saved and read like any other source. */
export function partMarkdown(sections: Section[]): string {
  const out: string[] = [];
  let last: string | null = null;
  for (const s of sections) {
    // A section cut in two keeps its heading once per part.
    if (s.heading && s.heading !== 'Opening' && s.heading !== last) out.push(`${'#'.repeat(Math.min(6, Math.max(2, s.level)))} ${s.heading}`);
    last = s.heading;
    for (const b of s.blocks) {
      if (b.kind === 'list') out.push((b.items ?? b.text.split('\n')).map((i) => `- ${i}`).join('\n'));
      else if (b.kind === 'quote') out.push(`> ${b.text}`);
      else if (b.kind === 'code') out.push(`\`\`\`${b.lang ?? ''}\n${b.text}\n\`\`\``);
      else out.push(b.text);
    }
  }
  return `${out.join('\n\n')}\n`;
}
