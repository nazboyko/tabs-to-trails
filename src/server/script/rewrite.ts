import { chat, type ChatReply } from '../ollama.js';
import { countWords, sectionLabel, splitSentences, type Block, type Section } from '../source/sections.js';
import { adaptedKind, ADAPTED_ESTIMATE, coverageFor, type AdaptedKind, type Coverage, type PlanSection, type Treatment } from './budget.js';
import { newNumbers } from './guard.js';
import { blockToMarkdown, condenseSystem, describeSystem, lengthenNote, mentionSystem, retryNote, sectionSource, shortenSystem } from './prompts.js';

/** The model overshoots long word targets, so it is asked for a little less on those. */
export const ASK_FACTOR = 0.85;
export function askWords(target: number): number {
  return Math.round(target >= 400 ? target * ASK_FACTOR : target);
}
/** A rewrite longer than its budget by this factor gets one shortening pass. */
export const LENGTH_TOLERANCE = 1.15;
/** A rewrite shorter than this share of its budget gets one lengthening pass. */
export const SHORT_TOLERANCE = 0.65;

export interface ScriptSection {
  id: string;
  heading: string;
  part?: number;
  treatment: Treatment;
  coverage: Coverage;
  adapted: AdaptedKind[];
  text: string;
  words: number;
  /** Numbers the guard could not match to the source after one retry. */
  checkNumbers: string[];
  retried: boolean;
  modelSeconds: number;
  modelCalls: number;
}

/** Removes markdown and list syntax a model may still put in spoken text. */
export function toSpokenText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|\s)\*(\S[^*]*\S|\S)\*(?=\s|$|[.,!?;:])/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*\n\s*/g, '\n\n')
    .replace(/([^\n])\n(?!\n)/g, '$1 ')
    .trim();
}

const SOFTEN: [RegExp, string][] = [
  [/,?\s*\b(?:as )?(?:you can see|shown|seen|pictured|illustrated) (?:below|above|here)\b,?/gi, ''],
  [/\b(the|this|that) (table|code|snippet|image|screenshot|picture|figure|diagram|chart|list|example) (?:below|above)\b/gi, '$1 $2'],
  [/\b(?:click|tap) here\b/gi, 'follow the link'],
  [/\b(?:see|check) (?:the )?(?:image|screenshot|picture|figure|diagram) (?:below|above)\b\.?/gi, ''],
];

/** Small rule list for prose read as written: "as shown below" and similar. */
export function soften(text: string): string {
  let s = text;
  for (const [re, to] of SOFTEN) s = s.replace(re, to);
  return s
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^([a-z])/, (c) => c.toUpperCase())
    .trim();
}

function endSentence(text: string): string {
  return /[.!?:;…]["'’”)]?$/.test(text) ? text : `${text}.`;
}

/** A short list read as sentences, one per item. */
export function listAsSentences(items: string[]): string {
  return items.map((i) => endSentence(soften(i.replace(/^\[[ xX]\]\s*/, '')))).join(' ');
}

export function readAsWritten(block: Block): string {
  switch (block.kind) {
    case 'prose':
    case 'quote':
      return soften(block.text);
    case 'list':
      return listAsSentences(block.items ?? [block.text]);
    case 'image':
      return `There is a picture here: ${endSentence(block.text)}`;
    default:
      return '';
  }
}

interface Ask {
  system: string;
  user: string;
  source: string;
  /** Words asked for. */
  words: number;
  /** Words the plan has room for; longer output is shortened once. */
  limit?: number;
  /** Words of the source, so a short rewrite is lengthened only when there is more to keep. */
  sourceWords?: number;
}

interface Guarded {
  text: string;
  checkNumbers: string[];
  retried: boolean;
  shortened: boolean;
  seconds: number;
  calls: number;
}

export type ChatFn = (req: { system: string; user: string; maxTokens?: number; signal?: AbortSignal }) => Promise<ChatReply>;

async function askGuarded(ask: Ask, chatFn: ChatFn, signal?: AbortSignal): Promise<Guarded> {
  const maxTokens = Math.max(200, Math.round((ask.limit ?? ask.words) * 2.5) + 100);
  const first = await chatFn({ system: ask.system, user: ask.user, maxTokens, signal });
  let text = toSpokenText(first.text);
  let seconds = first.seconds;
  let calls = 1;
  let retried = false;
  let missing = newNumbers(ask.source, text);
  if (missing.length) {
    const second = await chatFn({ system: ask.system + retryNote(missing), user: ask.user, maxTokens, signal });
    seconds += second.seconds;
    calls++;
    retried = true;
    const retryText = toSpokenText(second.text);
    const retryMissing = newNumbers(ask.source, retryText);
    if (retryMissing.length <= missing.length) {
      text = retryText;
      missing = retryMissing;
    }
  }
  const limit = ask.limit ?? 0;
  const got = countWords(text);
  if (limit >= 40 && got < limit * SHORT_TOLERANCE && (ask.sourceWords ?? 0) > got * 1.3) {
    const longer = await chatFn({ system: ask.system + (missing.length ? retryNote(missing) : '') + lengthenNote(got, limit), user: ask.user, maxTokens, signal });
    seconds += longer.seconds;
    calls++;
    const longerText = toSpokenText(longer.text);
    const longerMissing = newNumbers(ask.source, longerText);
    if (countWords(longerText) > got && longerMissing.every((n) => missing.includes(n))) {
      text = longerText;
      missing = longerMissing;
    }
  }
  let shortened = false;
  if (ask.limit && ask.limit >= 30 && countWords(text) > ask.limit * LENGTH_TOLERANCE) {
    const short = await chatFn({ system: shortenSystem(Math.round(ask.limit * 0.95)), user: text, maxTokens, signal });
    seconds += short.seconds;
    calls++;
    const shortText = toSpokenText(short.text);
    // A shorter version that brings in a number of its own is not worth keeping.
    if (shortText && newNumbers(ask.source, shortText).every((n) => missing.includes(n))) {
      text = shortText;
      shortened = true;
    }
  }
  return { text, checkNumbers: missing, retried, shortened, seconds, calls };
}

function context(blocks: Block[], index: number, step: -1 | 1): string {
  for (let i = index + step; i >= 0 && i < blocks.length; i += step) {
    const b = blocks[i]!;
    if (b.kind === 'prose' || b.kind === 'quote') return b.text;
  }
  return '(none)';
}

export interface RewriteOptions {
  title: string;
  chatFn?: ChatFn;
  signal?: AbortSignal;
}

export async function rewriteSection(section: Section, plan: PlanSection, opts: RewriteOptions): Promise<ScriptSection> {
  const chatFn: ChatFn = opts.chatFn ?? chat;
  const label = sectionLabel(section);
  const sourceText = [section.heading, ...section.blocks.map(blockToMarkdown)].join('\n\n');
  const base = {
    id: section.id,
    heading: section.heading,
    part: section.part,
    treatment: plan.treatment,
    adapted: plan.adapted,
  };

  if (plan.treatment === 'full') {
    const parts: string[] = [];
    const checkNumbers: string[] = [];
    let retried = false;
    let seconds = 0;
    let calls = 0;
    for (let i = 0; i < section.blocks.length; i++) {
      const block = section.blocks[i]!;
      const kind = adaptedKind(block);
      if (!kind) {
        const spoken = readAsWritten(block);
        if (spoken) parts.push(spoken);
        continue;
      }
      const words = ADAPTED_ESTIMATE[kind];
      const before = context(section.blocks, i, -1);
      const after = context(section.blocks, i, 1);
      const blockMd = blockToMarkdown(block);
      const r = await askGuarded(
        {
          system: describeSystem(kind, words),
          user: `TITLE: ${opts.title}\nSECTION: ${label}\n\nCONTEXT BEFORE:\n${before}\n\nBLOCK:\n${blockMd}\n\nCONTEXT AFTER:\n${after}`,
          source: [before, blockMd, after, section.heading].join('\n'),
          words,
        },
        chatFn,
        opts.signal,
      );
      parts.push(r.text);
      checkNumbers.push(...r.checkNumbers.filter((n) => !checkNumbers.includes(n)));
      retried ||= r.retried;
      seconds += r.seconds;
      calls += r.calls;
    }
    const text = parts.join('\n\n');
    return { ...base, coverage: 'Full', text, words: countWords(text), checkNumbers, retried, modelSeconds: seconds, modelCalls: calls };
  }

  const words = Math.max(12, askWords(plan.targetWords));
  const system = plan.treatment === 'mention' ? mentionSystem(words) : condenseSystem(words);
  const r = await askGuarded(
    {
      system,
      user: `TITLE: ${opts.title}\n${sectionSource(label, section.blocks)}`,
      source: sourceText,
      words,
      limit: plan.treatment === 'mention' ? undefined : plan.targetWords,
      sourceWords: plan.fullWords,
    },
    chatFn,
    opts.signal,
  );
  let text = r.text;
  if (plan.treatment === 'mention') text = splitSentences(text)[0] ?? text;
  const outWords = countWords(text);
  const coverage = plan.treatment === 'mention' ? 'Brief' : coverageFor(outWords, plan.fullWords);
  return {
    ...base,
    coverage,
    text,
    words: outWords,
    checkNumbers: r.checkNumbers,
    retried: r.retried,
    modelSeconds: r.seconds,
    modelCalls: r.calls,
  };
}
