/**
 * Markdown is the internal format. This module splits it into sections by
 * heading and keeps the kind of every block, so the script stage can read
 * prose as written and send only code, tables and long lists to the model.
 */

export type BlockKind = 'prose' | 'list' | 'code' | 'table' | 'quote' | 'image';

export interface Block {
  kind: BlockKind;
  /** Raw markdown for code and tables, plain text for everything else. */
  text: string;
  /** List items as plain text. */
  items?: string[];
  lang?: string;
}

export interface Section {
  id: string;
  heading: string;
  level: number;
  /** 1-based part number when a long section was split. */
  part?: number;
  /** Words a listener would hear if the section were read as written. */
  words: number;
  blocks: Block[];
}

/** Sections longer than this are split by paragraph groups. */
export const MAX_SECTION_WORDS = 1200;

/** Headings longer than this are not headings; the cap also bounds the work per line. */
const MAX_HEADING_CHARS = 300;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const IMAGE_ONLY = /^\s*\[?!\[([^\]]*)\]\([^)]*\)(\]\([^)]*\))?\s*$/;
const LIQUID = /^\s*\{%.*%\}\s*$/;

export function stripFrontMatter(md: string): string {
  const m = md.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/);
  return m ? md.slice(m[0].length) : md;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': ', ',
  '&ndash;': '-',
  '&hellip;': '...',
};

interface Fence {
  indent: number;
  char: string;
  length: number;
  lang?: string;
}

/** An opening code fence (CommonMark: a backtick fence's info string has no backtick). */
export function openFence(line: string): Fence | null {
  const m = line.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
  if (!m) return null;
  const marker = m[2]!;
  const info = m[3]!;
  if (marker[0] === '`' && info.includes('`')) return null;
  const lang = info.trim().split(/\s+/)[0]?.replace(/[^\w+#.-]/g, '');
  return { indent: m[1]!.length, char: marker[0]!, length: marker.length, lang: lang || undefined };
}

function closesFence(line: string, fence: Fence): boolean {
  const t = line.trim();
  return t.length >= fence.length && [...t].every((c) => c === fence.char);
}

/** An ATX heading, parsed without backtracking regexes. */
export function parseHeading(line: string): { level: number; text: string } | null {
  if (line.length > MAX_HEADING_CHARS) return null;
  const m = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/);
  if (!m) return null;
  let text = (m[2] ?? '').trimEnd();
  const closing = text.match(/(?:^|[ \t])#+$/);
  if (closing) text = text.slice(0, closing.index).trimEnd();
  return text ? { level: m[1]!.length, text } : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'a link';
  }
}

/** A markdown link whose text may hold one level of brackets and whose URL may hold parentheses. */
const LINK = /\[((?:\\.|\[[^[\]]{0,200}\]|[^[\]\\]){1,400})\]\((?:[^()\s]|\([^()\s]{0,200}\)){0,2000}(?:\s+"[^"]{0,300}")?\)/g;
const REF_LINK = /\[((?:\\.|[^[\]\\]){1,400})\]\[[^[\]]{0,100}\]/g;
/** Real HTML tags only, so "n <k the loop" and "x > 3" keep their words. */
const TAG =
  /<\/?(?:a|abbr|b|blockquote|br|button|center|cite|code|dd|del|details|div|dl|dt|em|figcaption|figure|font|h[1-6]|hr|i|iframe|img|input|ins|kbd|label|li|mark|ol|p|picture|pre|q|s|section|small|source|span|strong|sub|summary|sup|table|tbody|td|th|thead|tr|u|ul|video)\b[^<>]{0,300}>/gi;
/** Reference links into the same page: [[1]](#cite_note-1), [\[a\]](#note-a). */
const CITATION_LINK = /\[(?:\\?\[[^\]]{1,24}\\?\]|\^?\d{1,3})\]\(#[^)]*\)/g;
const EDIT_LINK = /\\?\[\[edit\]\([^)]*\)\\?\]/gi;
/** Reference marks left in plain text: "walked.[3]", "[citation needed]". */
const CITATION =
  /(?<=^|[\s.,;:!?)"'’”])\[\d{1,3}\]|\[\s*(?:edit|citation needed|clarification needed|note \d+|nb \d+|when\?|who\?|by whom\?|according to whom\?|dubious[^\]]*|failed verification)\s*\]/gi;

/** Inline markdown to plain text a voice can read. */
export function plainText(md: string): string {
  let s = md;
  s = s.replace(/\{%.*?%\}/g, ' ');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[\^[^\]]+\]/g, '');
  s = s.replace(CITATION_LINK, '').replace(EDIT_LINK, '');
  s = s.replace(LINK, '$1');
  s = s.replace(REF_LINK, '$1');
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, u: string) => hostOf(u));
  s = s.replace(TAG, ' ');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, (_, pre: string, u: string) => `${pre}${hostOf(u)}`);
  s = s.replace(/`+([^`]{1,500})`+/g, '$1');
  s = s.replace(/\*\*(.{1,500}?)\*\*/g, '$1');
  s = s.replace(/__(.{1,500}?)__/g, '$1');
  s = s.replace(/(^|[^\w*])\*(?!\s)(.{1,500}?)(?<!\s)\*(?!\w)/g, '$1$2');
  s = s.replace(/(^|[^\w])_(?!\s)(.{1,500}?)(?<!\s)_(?!\w)/g, '$1$2');
  s = s.replace(/~~(.{1,500}?)~~/g, '$1');
  s = s.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ');
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1');
  s = s.replace(CITATION, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

export function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.,-]*/gu);
  return m ? m.length : 0;
}

type Raw = Block | { kind: 'heading'; level: number; text: string };

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    openFence(line) !== null ||
    parseHeading(line) !== null ||
    RULE.test(line) ||
    LIST_ITEM.test(line) ||
    QUOTE.test(line) ||
    IMAGE_ONLY.test(line) ||
    LIQUID.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next))
  );
}

function meaningfulAlt(alt: string): string | null {
  const text = plainText(alt);
  if (countWords(text) < 4) return null;
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(text)) return null;
  return text;
}

export function parseBlocks(markdown: string): Raw[] {
  const lines = stripFrontMatter(markdown)
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n');
  const out: Raw[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line) || RULE.test(line) || LIQUID.test(line)) {
      i++;
      continue;
    }
    const fence = openFence(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i]!, fence)) body.push(lines[i++]!);
      i++;
      const dedent = new RegExp(`^[ \\t]{0,${fence.indent}}`);
      if (body.some((l) => l.trim() !== '')) {
        out.push({ kind: 'code', text: body.map((l) => l.replace(dedent, '')).join('\n'), lang: fence.lang });
      }
      continue;
    }
    const heading = parseHeading(line);
    if (heading) {
      out.push({ kind: 'heading', level: heading.level, text: plainText(heading.text) });
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!)) {
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.includes('|') && !isBlank(lines[i]!)) rows.push(lines[i++]!);
      out.push({ kind: 'table', text: rows.join('\n') });
      continue;
    }
    const image = line.match(IMAGE_ONLY);
    if (image) {
      const alt = meaningfulAlt(image[1]!);
      if (alt) out.push({ kind: 'image', text: alt });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(lines[i++]!.match(QUOTE)![1]!);
      const text = plainText(body.join(' '));
      if (text) out.push({ kind: 'quote', text });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: string[] = [];
      const raw: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (openFence(l)) break;
        const item = l.match(LIST_ITEM);
        if (item) {
          items.push(item[3]!);
          raw.push(l);
          i++;
          continue;
        }
        if (!isBlank(l) && /^\s{2,}/.test(l) && items.length) {
          items[items.length - 1] += ' ' + l.trim();
          raw.push(l);
          i++;
          continue;
        }
        if (isBlank(l) && i + 1 < lines.length && (LIST_ITEM.test(lines[i + 1]!) || /^\s{2,}\S/.test(lines[i + 1]!))) {
          i++;
          continue;
        }
        break;
      }
      // A list of nothing but links ("See also", "Related posts") is skipped: there is nothing to hear.
      const linksOnly = items.length >= 3 && items.every((t) => /^\s*\[[^\]]{1,200}\]\([^)\s]{1,2000}(?:\s+"[^"]{0,300}")?\)\s*$/.test(t));
      const clean = items.map(plainText).filter((t) => t !== '');
      if (clean.length && !linksOnly) out.push({ kind: 'list', text: clean.join('\n'), items: clean });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]!) && (para.length === 0 || !startsBlock(lines[i]!, lines[i + 1]))) {
      para.push(lines[i++]!);
    }
    const text = plainText(para.join(' '));
    if (text) out.push({ kind: 'prose', text });
  }
  return out;
}

export function blockWords(block: Block): number {
  if (block.kind === 'code' || block.kind === 'table') return 0;
  return countWords(block.text);
}

function sectionWords(blocks: Block[]): number {
  return blocks.reduce((n, b) => n + blockWords(b), 0);
}

/** Very long paragraphs are cut at sentence ends so a section can be split. */
const MAX_PARAGRAPH_WORDS = 400;

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…]["'’”)\]]*)\s+(?=["'“‘(\[]?[\p{Lu}\p{N}])/u)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

function splitList(block: Block): Block[] {
  const out: Block[] = [];
  let items: string[] = [];
  let words = 0;
  for (const item of block.items ?? []) {
    const w = countWords(item);
    if (items.length && words + w > MAX_PARAGRAPH_WORDS / 2) {
      out.push({ kind: 'list', text: items.join('\n'), items });
      items = [];
      words = 0;
    }
    items.push(item);
    words += w;
  }
  if (items.length) out.push({ kind: 'list', text: items.join('\n'), items });
  return out;
}

function splitParagraph(block: Block): Block[] {
  if (block.kind === 'list' && countWords(block.text) > MAX_PARAGRAPH_WORDS) return splitList(block);
  if (block.kind !== 'prose' || countWords(block.text) <= MAX_PARAGRAPH_WORDS) return [block];
  const out: Block[] = [];
  let buf: string[] = [];
  let words = 0;
  for (const sentence of splitSentences(block.text)) {
    const w = countWords(sentence);
    if (buf.length && words + w > MAX_PARAGRAPH_WORDS / 2) {
      out.push({ kind: 'prose', text: buf.join(' ') });
      buf = [];
      words = 0;
    }
    buf.push(sentence);
    words += w;
  }
  if (buf.length) out.push({ kind: 'prose', text: buf.join(' ') });
  return out;
}

/** Splits an oversized section into parts of whole blocks. */
function splitLong(heading: string, level: number, input: Block[]): Omit<Section, 'id'>[] {
  const total = sectionWords(input);
  if (total <= MAX_SECTION_WORDS) return [{ heading, level, words: total, blocks: input }];
  const blocks = input.flatMap(splitParagraph);
  const partsWanted = Math.ceil(total / MAX_SECTION_WORDS);
  const perPart = total / partsWanted;
  const parts: Block[][] = [[]];
  for (const b of blocks) {
    const current = parts[parts.length - 1]!;
    const words = sectionWords(current);
    if (current.length && words + blockWords(b) / 2 > perPart && parts.length < partsWanted) parts.push([b]);
    else current.push(b);
  }
  return parts.map((p, n) => ({ heading, level, part: n + 1, words: sectionWords(p), blocks: p }));
}

export function splitSections(markdown: string): Section[] {
  const raw = parseBlocks(markdown);
  const groups: { heading: string; level: number; blocks: Block[] }[] = [];
  let current = { heading: '', level: 0, blocks: [] as Block[] };
  for (const r of raw) {
    if (r.kind === 'heading') {
      if (current.blocks.length) groups.push(current);
      current = { heading: r.text, level: r.level, blocks: [] };
    } else {
      current.blocks.push(r);
    }
  }
  if (current.blocks.length) groups.push(current);

  const sections: Omit<Section, 'id'>[] = [];
  for (const g of groups) sections.push(...splitLong(g.heading || 'Opening', g.level, g.blocks));
  return sections.map((s, n) => ({ id: `s${String(n + 1).padStart(2, '0')}`, ...s }));
}

const BACK_MATTER = /^(references|notes|footnotes|citations|sources|bibliography|works cited|further reading|external links|see also|related articles|comments)$/i;

/** Lists of references and links are left out of the walk; their headings are kept to say so. */
export function dropBackMatter(sections: Section[]): { kept: Section[]; dropped: string[] } {
  const kept: Section[] = [];
  const dropped: string[] = [];
  for (const s of sections) {
    if (BACK_MATTER.test(s.heading.trim())) {
      if (!dropped.includes(s.heading)) dropped.push(s.heading);
    } else kept.push(s);
  }
  return { kept: kept.length ? kept : sections, dropped: kept.length ? dropped : [] };
}

/** A text without headings has parts with an empty heading: "Part 3". */
export function sectionLabel(s: Pick<Section, 'heading' | 'part'>): string {
  if (!s.heading) return s.part ? `Part ${s.part}` : 'The text';
  return s.part ? `${s.heading}, part ${s.part}` : s.heading;
}
