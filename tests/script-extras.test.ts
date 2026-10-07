import { describe, expect, it } from 'vitest';
import { importancePrompt, parseScores, scoreSections } from '../src/server/script/importance.js';
import { cleanQuestion, closingQuestion } from '../src/server/script/question.js';
import type { Section } from '../src/server/source/sections.js';

const sections: Section[] = [
  { id: 's01', heading: 'Why', level: 2, words: 12, blocks: [{ kind: 'prose', text: 'The cache was slow for three weeks. We fixed it.' }] },
  { id: 's02', heading: 'Thanks', level: 2, words: 4, blocks: [{ kind: 'prose', text: 'Thanks for reading this.' }] },
];

describe('importance scores', () => {
  it('sends headings, lengths and first sentences', () => {
    const prompt = importancePrompt('A post', sections);
    expect(prompt).toContain('s01 | Why | 12 words | The cache was slow for three weeks.');
    expect(prompt).toContain('s02 | Thanks | 4 words | Thanks for reading this.');
  });

  it('parses valid scores and rejects junk', () => {
    expect(parseScores('{"scores":[{"id":"s01","score":5},{"id":"s02","score":1}]}', ['s01', 's02'])).toEqual({ s01: 5, s02: 1 });
    expect(parseScores('not json', ['s01'])).toBeNull();
    expect(parseScores('{"scores":[{"id":"zz","score":9}]}', ['s01', 's02'])).toBeNull();
  });

  it('falls back to null when the model call fails', async () => {
    const out = await scoreSections('T', sections, async () => {
      throw new Error('down');
    });
    expect(out.scores).toBeNull();
  });
});

describe('closing question', () => {
  it('keeps one question sentence', () => {
    expect(cleanQuestion('Here is one. **What would you keep if the cache were gone?** More text.')).toBe(
      'What would you keep if the cache were gone?',
    );
    expect(cleanQuestion('No question here.')).toBeNull();
    expect(cleanQuestion('Why?')).toBeNull();
  });

  it('drops a question that brings in a number the source lacks', async () => {
    const replies = ['What would change if it took 40 days?', 'What would you measure first next time?'];
    const out = await closingQuestion('T', 'We measured the cache for three weeks.', async () => ({
      text: replies.shift()!,
      promptTokens: 1,
      outputTokens: 1,
      seconds: 0.1,
    }));
    expect(out.question).toBe('What would you measure first next time?');
  });
});
