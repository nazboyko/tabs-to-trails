import type { Block } from '../source/sections.js';

const RULES = `You are preparing source material to be listened to on a walk.
Use only what is in SOURCE. Do not add facts, examples, numbers or opinions.
Keep names, numbers, warnings and limitations exactly as written. Write numbers as digits.
If SOURCE is uncertain, stay uncertain.
Write for the ear: short sentences, no markdown, no lists, no headings,
no "as you can see". Never read code or table cells literally.
For code: say what it does, using only what the code and nearby text show.
For tables: give the takeaway and the 2-4 comparisons that matter, with their numbers.`;

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

export function describeSystem(kind: 'code' | 'table' | 'list', words: number): string {
  const what =
    kind === 'code'
      ? 'Describe what the code in BLOCK does.'
      : kind === 'table'
        ? 'Tell the listener what the table in BLOCK shows.'
        : 'Turn the list in BLOCK into a few spoken sentences that keep its main points.';
  return `${RULES}
${what} Your words replace BLOCK and are read between the paragraphs around it,
so do not repeat CONTEXT and do not start with "This section".
Target length: ${words} words. Output only the spoken text.`;
}

export function lengthenNote(had: number, want: number): string {
  return `\n\nYour previous version had ${had} words, which is too short. Use about ${want} words and keep more of the detail in SOURCE. Still add nothing that is not in SOURCE.`;
}

export function shortenSystem(words: number): string {
  return `You shorten spoken text for a walk. Keep its facts, names, numbers, warnings and voice.
Do not add anything. No markdown, no lists, no headings.
Target length: ${words} words. Output only the shortened text.`;
}

export const QUESTION_SYSTEM = `You write one open question a listener could think about for the next two minutes of a walk.
Base it only on SOURCE. Do not add facts or numbers. Address the listener as "you".
One sentence that ends with a question mark. Output only the question.`;

export function retryNote(numbers: string[]): string {
  return `\n\nYour previous version used numbers that are not in SOURCE: ${numbers.join(', ')}. Use only numbers that appear in SOURCE.`;
}

export function blockToMarkdown(b: Block): string {
  switch (b.kind) {
    case 'code':
      return '```' + (b.lang ?? '') + '\n' + b.text + '\n```';
    case 'list':
      return (b.items ?? [b.text]).map((i) => `- ${i}`).join('\n');
    case 'quote':
      return `> ${b.text}`;
    case 'image':
      return `[Image: ${b.text}]`;
    default:
      return b.text;
  }
}

export function sectionSource(heading: string, blocks: Block[]): string {
  return `SECTION: ${heading}\n\nSOURCE:\n${blocks.map(blockToMarkdown).join('\n\n')}`;
}
