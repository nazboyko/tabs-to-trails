import type { Block } from '../source/sections.js';

const RULES = `You are preparing source material to be listened to on a walk.
Use only what is in SOURCE. Do not add facts, examples, numbers or opinions.
Keep names, numbers, warnings and limitations exactly as written. Write numbers as digits.
If SOURCE is uncertain, stay uncertain.
Write for the ear: short sentences, no markdown, no lists, no headings,
no "as you can see". Never read code or table cells literally.
For code: say what it does, using only what the code and nearby text show.
For tables: say what the table tells. Start with the main finding, then the 2-4 comparisons that matter, with their numbers.
For lists: say what the items have in common, then name the ones that matter.
Never announce: do not say that there is a table or a list, or that things are listed, shown or included.`;

export function condenseSystem(words: number): string {
  return `${RULES}
Keep the author's voice: if SOURCE says "I", you say "I".
Target length: ${words} words. Output only the spoken text.`;
}

export function mentionSystem(words: number): string {
  return `${RULES}
Say in one sentence what SOURCE covers, so a listener knows it was there.
Target length: ${words} words. Output only the spoken text.`;
}

export function describeSystem(kind: 'code' | 'table', words: number): string {
  const what =
    kind === 'code'
      ? 'Describe what the code in BLOCK does.'
      : 'Say what the table in BLOCK tells: its main finding first, then the comparisons that matter, with their numbers. Do not mention the table itself.';
  return `${RULES}
${what} Your words replace BLOCK and are read between the paragraphs around it,
so do not repeat CONTEXT and do not start with "This section".
Target length: ${words} words. Output only the spoken text.`;
}

export function tellNote(sentences: string[]): string {
  return `\n\nYour previous version announced instead of telling ("${sentences[0]}"). Start with what the numbers or items say. Do not mention a table or a list, and do not say that anything is listed, shown or included.`;
}

export function lengthenNote(had: number, want: number): string {
  return `\n\nYour previous version had ${had} words, which is too short. Use about ${want} words and keep more of the detail in SOURCE. Still add nothing that is not in SOURCE.`;
}

export function shortenSystem(words: number): string {
  return `You shorten spoken text for a walk. Keep its facts, names, numbers, warnings and voice.
Do not add anything. No markdown, no lists, no headings. Never say that there is a table or a list, or that things are listed, shown or included.
Target length: ${words} words. Output only the shortened text.`;
}

export const QUESTION_SYSTEM = `You write one open question a listener could think about for the next two minutes of a walk.
Base it only on SOURCE. Do not add facts or numbers. Address the listener as "you".
One sentence that ends with a question mark. Output only the question.`;

export function retryNote(numbers: string[]): string {
  return `\n\nYour previous version used numbers that are not in SOURCE: ${numbers.join(', ')}. Use only numbers that appear in SOURCE.`;
}

/** Code and tables are only described, so a very long one is sent as its start and end. */
const MAX_BLOCK_LINES = { code: 80, table: 40 };
const MAX_BLOCK_CHARS = 6000;

function trimBlock(text: string, kind: 'code' | 'table'): string {
  const lines = text.split('\n');
  let out = text;
  const max = MAX_BLOCK_LINES[kind];
  if (lines.length > max) {
    const head = lines.slice(0, Math.round(max * 0.75));
    const tail = lines.slice(-Math.round(max * 0.2));
    out = [...head, `... (${lines.length - head.length - tail.length} more lines) ...`, ...tail].join('\n');
  }
  if (out.length > MAX_BLOCK_CHARS) out = `${out.slice(0, MAX_BLOCK_CHARS - 1000)}\n...\n${out.slice(-800)}`;
  return out;
}

/** Markdown for the model. `full` keeps long code and tables whole (for the number guard). */
export function blockToMarkdown(b: Block, full = false): string {
  switch (b.kind) {
    case 'code':
      return '```' + (b.lang ?? '') + '\n' + (full ? b.text : trimBlock(b.text, 'code')) + '\n```';
    case 'table':
      return full ? b.text : trimBlock(b.text, 'table');
    case 'list':
      return (b.items ?? [b.text]).map((i) => `- ${i}`).join('\n');
    case 'quote':
      return `> ${b.text}`;
    case 'image':
      return b.text;
    default:
      return b.text;
  }
}

export function sectionSource(heading: string, blocks: Block[]): string {
  return `SECTION: ${heading}\n\nSOURCE:\n${blocks.map((b) => blockToMarkdown(b)).join('\n\n')}`;
}
