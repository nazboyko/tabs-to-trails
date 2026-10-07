import { describe, expect, it } from 'vitest';
import type { PlanSection } from '../src/server/script/budget.js';
import { listAsSentences, rewriteSection, soften, toSpokenText, type ChatFn } from '../src/server/script/rewrite.js';
import type { Section } from '../src/server/source/sections.js';

const section: Section = {
  id: 's01',
  heading: 'What I got wrong',
  level: 2,
  words: 30,
  blocks: [{ kind: 'prose', text: 'I missed calls from my sister that week, and she had a real reason to ring. For two days I checked the phone more.' }],
};

const planned = (treatment: PlanSection['treatment']): PlanSection => ({
  id: 's01',
  heading: 'What I got wrong',
  sourceWords: 26,
  fullWords: 26,
  adapted: [],
  score: 3,
  treatment,
  targetWords: 15,
  coverage: 'Condensed',
});

function fakeChat(replies: string[]): { fn: ChatFn; systems: string[] } {
  const systems: string[] = [];
  const fn: ChatFn = async (req) => {
    systems.push(req.system);
    const text = replies.shift() ?? '';
    return { text, promptTokens: 10, outputTokens: 10, seconds: 0.1 };
  };
  return { fn, systems };
}

describe('number guard in the rewrite', () => {
  it('retries once with the invented number named, then accepts a clean rewrite', async () => {
    const chat = fakeChat(['I missed 3 calls from my sister.', 'I missed calls from my sister. For 2 days I checked more.']);
    const out = await rewriteSection(section, planned('condensed'), { title: 'T', chatFn: chat.fn });
    expect(chat.systems).toHaveLength(2);
    expect(chat.systems[1]).toContain('numbers that are not in SOURCE: 3');
    expect(out.retried).toBe(true);
    expect(out.checkNumbers).toEqual([]);
    expect(out.text).toBe('I missed calls from my sister. For 2 days I checked more.');
  });

  it('keeps the text and marks the section when the retry adds the number again', async () => {
    const chat = fakeChat(['I missed 3 calls.', 'I missed 3 calls from her.']);
    const out = await rewriteSection(section, planned('condensed'), { title: 'T', chatFn: chat.fn });
    expect(out.checkNumbers).toEqual(['3']);
    expect(out.text).toBe('I missed 3 calls from her.');
  });

  it('does not call the model for prose in full mode', async () => {
    const chat = fakeChat([]);
    const out = await rewriteSection(section, { ...planned('full'), coverage: 'Full', targetWords: 26 }, { title: 'T', chatFn: chat.fn });
    expect(chat.systems).toHaveLength(0);
    expect(out.text).toBe(section.blocks[0]!.text);
    expect(out.coverage).toBe('Full');
  });

  it('sends only code to the model in full mode and guards its description', async () => {
    const withCode: Section = {
      ...section,
      blocks: [
        { kind: 'prose', text: 'We cache lookups.' },
        { kind: 'code', text: 'const cache = new Map();', lang: 'ts' },
        { kind: 'prose', text: 'That was all.' },
      ],
    };
    const chat = fakeChat(['It keeps 500 results in a map.', 'It keeps results in a map.']);
    const out = await rewriteSection(withCode, { ...planned('full'), adapted: ['code'] }, { title: 'T', chatFn: chat.fn });
    expect(chat.systems).toHaveLength(2);
    expect(out.text).toBe('We cache lookups.\n\nIt keeps results in a map.\n\nThat was all.');
  });
});

describe('length guard in the rewrite', () => {
  const long: Section = { ...section, words: 400, blocks: [{ kind: 'prose', text: 'word '.repeat(400).trim() + '.' }] };
  const plan = { ...planned('condensed'), fullWords: 400, sourceWords: 400, targetWords: 100 };

  it('shortens a rewrite that runs well over its budget, once', async () => {
    const chat = fakeChat(['word '.repeat(160).trim() + '.', 'word '.repeat(95).trim() + '.']);
    const out = await rewriteSection(long, plan, { title: 'T', chatFn: chat.fn });
    expect(chat.systems).toHaveLength(2);
    expect(chat.systems[1]).toContain('Target length: 95 words');
    expect(out.words).toBe(95);
  });

  it('keeps the longer text when the shorter one brings in a number', async () => {
    const chat = fakeChat(['word '.repeat(160).trim() + '.', 'word '.repeat(90).trim() + ' 42.']);
    const out = await rewriteSection(long, plan, { title: 'T', chatFn: chat.fn });
    expect(out.words).toBe(160);
    expect(out.checkNumbers).toEqual([]);
  });

  it('asks once for more when a rewrite comes back far too short', async () => {
    const chat = fakeChat(['word '.repeat(40).trim() + '.', 'word '.repeat(90).trim() + '.']);
    const out = await rewriteSection(long, plan, { title: 'T', chatFn: chat.fn });
    expect(chat.systems).toHaveLength(2);
    expect(chat.systems[1]).toContain('had 40 words, which is too short');
    expect(out.words).toBe(90);
  });

  it('leaves a rewrite inside the tolerance alone', async () => {
    const chat = fakeChat(['word '.repeat(110).trim() + '.']);
    await rewriteSection(long, plan, { title: 'T', chatFn: chat.fn });
    expect(chat.systems).toHaveLength(1);
  });
});

describe('spoken text helpers', () => {
  it('strips markdown a model may return', () => {
    expect(toSpokenText('## Title\n- **One** thing\n- `two`')).toBe('Title One thing two');
  });

  it('softens references to things a listener cannot see', () => {
    expect(soften('We measured it for 3 weeks, as shown below.')).toBe('We measured it for 3 weeks.');
    expect(soften('The table below has the numbers.')).toBe('The table has the numbers.');
  });

  it('reads a short list as sentences', () => {
    expect(listAsSentences(['First item', 'Second item!', '[x] Done'])).toBe('First item. Second item! Done.');
  });
});
