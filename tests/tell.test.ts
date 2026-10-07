import { describe, expect, it } from 'vitest';
import type { PlanSection } from '../src/server/script/budget.js';
import { readAsWritten, rewriteSection, type ChatFn } from '../src/server/script/rewrite.js';
import { announces, dropAnnouncements, dropRepeats } from '../src/server/script/tell.js';
import { cleanDevtoMarkdown } from '../src/server/source/devto.js';
import { factualAlt, parseBlocks, type Section } from '../src/server/source/sections.js';

describe('announcements', () => {
  it('finds sentences that announce a table or list instead of telling it', () => {
    expect(announces('Numbers from my laptop are listed.')).toBe(true);
    expect(announces('The table shows the metabolic equivalent of task for different activities.')).toBe(true);
    expect(announces('Several options are included.')).toBe(true);
    expect(announces('In the table, writing is 1.5.')).toBe(true);
    expect(announces('The data shows peak estimated METs percentiles by age and sex.')).toBe(true);
  });

  it('leaves sentences that tell alone', () => {
    expect(announces('Thinking off took 2.4 seconds on average; thinking on took 11.3.')).toBe(false);
    expect(announces('What he cannot hold is the list.')).toBe(false);
    expect(announces('Writing at a desk is 1.5 METs and walking slowly is 2.0.')).toBe(false);
  });

  it('drops announcing sentences unless they carry a number', () => {
    const text = 'Numbers from my laptop are listed. Thinking off took 2.4 seconds. The table shows 22 of 22 valid runs.';
    expect(dropAnnouncements(text)).toBe('Thinking off took 2.4 seconds. The table shows 22 of 22 valid runs.');
    expect(dropAnnouncements('The table is shown.')).toBe('The table is shown.');
  });
});

describe('dropRepeats', () => {
  it('drops a description sentence that repeats the paragraph after the block', () => {
    const after = 'The 22 runs went through the server while I tuned the prompt, and thinking made Gemma several times slower and worse at this job.';
    const text = 'Thinking off took 2.4 seconds. The 22 runs went through the server while I tuned the prompt. Thinking made Gemma several times slower and worse.';
    expect(dropRepeats(text, after)).toBe('Thinking off took 2.4 seconds.');
  });
});

describe('table descriptions in a rewrite', () => {
  const section: Section = {
    id: 's01',
    heading: 'Numbers',
    level: 2,
    words: 20,
    blocks: [
      { kind: 'prose', text: 'Numbers from my laptop:' },
      { kind: 'table', text: '| Setting | Seconds |\n|---|---|\n| Thinking off | 2.4 |\n| Thinking on | 11.3 |' },
      { kind: 'prose', text: 'Thinking made it slower, so it stays off.' },
    ],
  };
  const plan: PlanSection = { id: 's01', heading: 'Numbers', sourceWords: 11, fullWords: 71, adapted: ['table'], score: 3, treatment: 'full', targetWords: 71, coverage: 'Full' };

  it('asks again when the description announces, and keeps the version that tells', async () => {
    const replies = ['Numbers from my laptop are listed.', 'Thinking off took 2.4 seconds and thinking on took 11.3.'];
    const systems: string[] = [];
    const chatFn: ChatFn = async (req) => {
      systems.push(req.system);
      return { text: replies.shift() ?? '', promptTokens: 1, outputTokens: 1, seconds: 0.1 };
    };
    const out = await rewriteSection(section, plan, { title: 'T', chatFn });
    expect(systems).toHaveLength(2);
    expect(systems[1]).toContain('announced instead of telling');
    expect(out.text).toContain('Thinking off took 2.4 seconds and thinking on took 11.3.');
    expect(out.text).not.toContain('are listed');
  });
});

describe('images', () => {
  it('keeps alt text only when it states data', () => {
    expect(factualAlt('A chart of median latency falling from 840 ms to 120 ms over three weeks')).toBe(
      'A chart of median latency falling from 840 ms to 120 ms over three weeks',
    );
    expect(factualAlt('The kid screen at tablet size: a large pancake emoji and a timer at 9:57')).toBeNull();
    expect(factualAlt('{\\displaystyle {\\text{1 MET}} = 1 kcal}')).toBeNull();
    expect(factualAlt('A diagram of the pipeline stages')).toBeNull();
    expect(factualAlt('photo-2024.png')).toBeNull();
  });

  it('reads a kept alt text as its own sentence, never as "a picture"', () => {
    const [block] = parseBlocks('![A chart of signups rising from 40 to 90 a week](a.png)');
    expect(block).toEqual({ kind: 'image', text: 'A chart of signups rising from 40 to 90 a week' });
    expect(readAsWritten(block as Section['blocks'][number])).toBe('A chart of signups rising from 40 to 90 a week.');
    expect(parseBlocks('![The parent screen with six editable steps](b.png)')).toEqual([]);
  });
});

describe('cleanDevtoMarkdown', () => {
  const md = [
    '---',
    'title: A post',
    '---',
    '',
    '*This is a submission for the [Some Challenge](https://dev.to/challenges/x)*',
    '',
    '## What I Built',
    '',
    'Text about the build.',
    '',
    '```md',
    '## Prize Categories',
    '```',
    '',
    '## Prize Categories',
    '',
    'Best Use of Something. More words.',
    '',
    '### A detail inside the prize section',
    '',
    'Still part of it.',
    '',
    '## Thanks',
    '',
    'Thanks for reading.',
  ].join('\n');

  it('removes the submission line and the Prize Categories section, and names them', () => {
    const { markdown, leftOut } = cleanDevtoMarkdown(md);
    expect(markdown).not.toContain('This is a submission');
    expect(markdown).not.toContain('Best Use of Something');
    expect(markdown).not.toContain('Still part of it');
    expect(markdown).toContain('Text about the build.');
    expect(markdown).toContain('Thanks for reading.');
    expect(markdown).toContain('```md\n## Prize Categories\n```');
    expect(leftOut).toEqual(['the challenge submission line', 'Prize Categories']);
  });

  it('leaves a post without the template alone', () => {
    expect(cleanDevtoMarkdown('## Intro\n\nHello.')).toEqual({ markdown: '## Intro\n\nHello.', leftOut: [] });
  });
});
