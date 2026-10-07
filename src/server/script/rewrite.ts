import { chat, PromptTooLarge, type ChatReply } from '../ollama.js';
import { countWords, sectionLabel, splitSentences, type Block, type Section } from '../source/sections.js';
import { adaptedKind, ADAPTED_ESTIMATE, coverageFor, fullBlockWords, type AdaptedKind, type Coverage, type PlanSection, type Treatment } from './budget.js';
import { newNumbers } from './guard.js';
import { blockToMarkdown, condenseSystem, describeSystem, lengthenNote, mentionSystem, retryNote, sectionSource, shortenSystem } from './prompts.js';

/** The model overshoots long word targets, so it is asked for a little less on those. */
export const ASK_FACTOR = 0.85;
export function askWords(target: number): number {
  return Math.round(target >= 400 ? target * ASK_FACTOR : target);
}
/** A rewrite longer than its budget by this factor gets one shortening pass. */
export const LENGTH_TOLERANCE = 1.1;
/** A rewrite shorter than this share of its budget gets one lengthening pass. */
export const SHORT_TOLERANCE = 0.8;

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
  /** Set when the model gave nothing usable and the section falls back to the source as written. */
  note?: string;
}

export const FALLBACK_NOTE = 'The model gave no usable text here, so this part is read from the start of the section as written.';

class EmptyReply extends Error {}

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
  [/,?\s*\bas (?:you can see|shown|seen|pictured|illustrated) (?:below|above|here)(?=[.,;:!?]|$)/gi, ''],
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
    .replace(/^[\s,;:]+/, '')
    .replace(/([.!?])[\s,;:]*,\s*/g, '$1 ')
    .replace(/\s{2,}/g, ' ')
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, pre: string, c: string) => pre + c.toUpperCase())
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
  let first = await chatFn({ system: ask.system, user: ask.user, maxTokens, signal });
  let seconds = first.seconds;
  let calls = 1;
  if (countWords(toSpokenText(first.text)) < 3) {
    first = await chatFn({ system: ask.system, user: ask.user, maxTokens, signal });
    seconds += first.seconds;
    calls++;
    if (countWords(toSpokenText(first.text)) < 3) throw new EmptyReply();
  }
  let text = toSpokenText(first.text);
  let retried = false;
  let missing = newNumbers(ask.source, text);
  if (missing.length) {
    const second = await chatFn({ system: ask.system + retryNote(missing), user: ask.user, maxTokens, signal });
    seconds += second.seconds;
    calls++;
    retried = true;
    const retryText = toSpokenText(second.text);
    const retryMissing = newNumbers(ask.source, retryText);
    if (countWords(retryText) >= 3 && retryMissing.length <= missing.length) {
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
    if (countWords(shortText) >= ask.limit * 0.4 && newNumbers(ask.source, shortText).every((n) => missing.includes(n))) {
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

/** The start of a section read as written, cut at a sentence end near `words`. */
export function openingAsWritten(section: Section, words: number): string {
  const sentences = section.blocks.flatMap((b) => splitSentences(readAsWritten(b)));
  const out: string[] = [];
  let n = 0;
  for (const sentence of sentences) {
    if (out.length && n + countWords(sentence) > words) break;
    out.push(sentence);
    n += countWords(sentence);
  }
  return out.join(' ');
}

function modelGaveUp(err: unknown): boolean {
  return err instanceof EmptyReply || err instanceof PromptTooLarge;
}

/**
 * Gemma condenses to roughly this share of a text whatever target it is
 * given, so a section that must keep more than MILD_CUT of its words is not
 * sent whole: its opening is read as written and only the rest is condensed.
 */
export const NATURAL_RATIO = 0.45;
export const MILD_CUT = 0.6;
const MIN_TAIL_WORDS = 40;

/** Opening blocks to read as written and the rest to condense, or null when the cut is not mild. */
export function splitForMildCut(section: Section, plan: Pick<PlanSection, 'targetWords' | 'fullWords'>): { head: Section; tail: Section; headWords: number } | null {
  const { targetWords: target, fullWords: full } = plan;
  if (full <= 0 || target / full < MILD_CUT || section.blocks.length < 2) return null;
  // head + NATURAL_RATIO * (full - head) = target
  const wantHead = (target - NATURAL_RATIO * full) / (1 - NATURAL_RATIO);
  let headWords = 0;
  let cut = 0;
  for (const block of section.blocks) {
    const w = fullBlockWords(block);
    if (headWords + w / 2 > wantHead) break;
    headWords += w;
    cut++;
  }
  if (cut === 0 || cut >= section.blocks.length || full - headWords < MIN_TAIL_WORDS) return null;
  const head: Section = { ...section, blocks: section.blocks.slice(0, cut), words: headWords };
  const tail: Section = { ...section, blocks: section.blocks.slice(cut), words: full - headWords };
  return { head, tail, headWords };
}

export interface RewriteOptions {
  title: string;
  chatFn?: ChatFn;
  signal?: AbortSignal;
}

export async function rewriteSection(section: Section, plan: PlanSection, opts: RewriteOptions): Promise<ScriptSection> {
  const chatFn: ChatFn = opts.chatFn ?? chat;
  const label = sectionLabel(section);
  const sourceText = [opts.title, label, ...section.blocks.map((b) => blockToMarkdown(b, true))].join('\n\n');
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
    let note: string | undefined;
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
      let r: Guarded;
      try {
        r = await askGuarded(
          {
            system: describeSystem(kind, words),
            user: `TITLE: ${opts.title}\nSECTION: ${label}\n\nCONTEXT BEFORE:\n${before}\n\nBLOCK:\n${blockMd}\n\nCONTEXT AFTER:\n${after}`,
            source: [opts.title, label, before, blockToMarkdown(block, true), after].join('\n'),
            words,
          },
          chatFn,
          opts.signal,
        );
      } catch (err) {
        if (!modelGaveUp(err)) throw err;
        parts.push(kind === 'code' ? 'There is a code example here.' : 'There is a table here.');
        note = 'The model gave no usable description for one block here, so the script only says it is there.';
        continue;
      }
      parts.push(r.text);
      checkNumbers.push(...r.checkNumbers.filter((n) => !checkNumbers.includes(n)));
      retried ||= r.retried;
      seconds += r.seconds;
      calls += r.calls;
    }
    const text = parts.join('\n\n');
    return { ...base, coverage: 'Full', text, words: countWords(text), checkNumbers, retried, modelSeconds: seconds, modelCalls: calls, note };
  }

  const split = plan.treatment === 'condensed' ? splitForMildCut(section, plan) : null;
  if (split) {
    // Keep the opening as written; only the rest is condensed, at a cut the model can hold.
    const head = await rewriteSection(split.head, { ...plan, treatment: 'full', targetWords: split.headWords, fullWords: split.headWords }, opts);
    const tailTarget = Math.max(MIN_TAIL_WORDS, plan.targetWords - head.words);
    const tail = await rewriteSection(split.tail, { ...plan, targetWords: tailTarget, fullWords: plan.fullWords - split.headWords }, opts);
    const text = `${head.text}\n\n${tail.text}`;
    const outWords = countWords(text);
    return {
      ...base,
      coverage: coverageFor(outWords, plan.fullWords),
      text,
      words: outWords,
      checkNumbers: [...new Set([...head.checkNumbers, ...tail.checkNumbers])],
      retried: head.retried || tail.retried,
      modelSeconds: head.modelSeconds + tail.modelSeconds,
      modelCalls: head.modelCalls + tail.modelCalls,
      note: head.note ?? tail.note,
    };
  }

  const words = Math.max(12, askWords(plan.targetWords));
  const system = plan.treatment === 'mention' ? mentionSystem(words) : condenseSystem(words);
  let r: Guarded;
  try {
    r = await askGuarded(
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
  } catch (err) {
    if (!modelGaveUp(err)) throw err;
    const text = openingAsWritten(section, plan.targetWords);
    const outWords = countWords(text);
    return {
      ...base,
      coverage: plan.treatment === 'mention' ? 'Brief' : coverageFor(outWords, plan.fullWords),
      text,
      words: outWords,
      checkNumbers: [],
      retried: false,
      modelSeconds: 0,
      modelCalls: 0,
      note: FALLBACK_NOTE,
    };
  }
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
