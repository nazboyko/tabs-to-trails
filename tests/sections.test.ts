import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { countWords, MAX_SECTION_WORDS, parseBlocks, plainText, splitSections, splitSentences, stripFrontMatter } from '../src/server/source/sections.js';

const mixed = fs.readFileSync(new URL('./fixtures/mixed.md', import.meta.url), 'utf8');

describe('plainText', () => {
  it('turns inline markdown into readable text', () => {
    expect(plainText('A [link](https://x.dev/a) and **bold** and `code` and *em*.')).toBe('A link and bold and code and em.');
    expect(plainText('See https://www.example.com/path for more.')).toBe('See example.com for more.');
    expect(plainText('Footnote[^1] and &amp; entity')).toBe('Footnote and & entity');
  });

  it('keeps underscores inside words', () => {
    expect(plainText('the until_done mode')).toBe('the until_done mode');
  });
});

describe('stripFrontMatter', () => {
  it('removes a leading YAML block only', () => {
    expect(stripFrontMatter('---\ntitle: x\n---\n\nBody').trim()).toBe('Body');
    expect(stripFrontMatter('Body\n---\nmore')).toBe('Body\n---\nmore');
  });
});

describe('parseBlocks', () => {
  const kinds = parseBlocks(mixed).map((b) => b.kind);

  it('keeps every block kind', () => {
    expect(kinds).toContain('code');
    expect(kinds).toContain('table');
    expect(kinds).toContain('list');
    expect(kinds).toContain('quote');
    expect(kinds).toContain('image');
  });

  it('drops comments, liquid tags and images without a meaningful alt', () => {
    const text = parseBlocks(mixed)
      .map((b) => b.text)
      .join('\n');
    expect(text).not.toContain('a comment that must not be read');
    expect(text).not.toContain('{%');
    expect(text).not.toContain('screenshot');
    expect(text).toContain('A chart of median latency');
  });

  it('reads list items without their markers', () => {
    const list = parseBlocks(mixed).find((b) => b.kind === 'list');
    expect(list && 'items' in list ? list.items : []).toEqual([
      'The cache size stays under 50 MB.',
      'Old entries expire after 10 minutes.',
      '[x] A restart starts with an empty cache.',
    ]);
  });
});

describe('splitSections', () => {
  const sections = splitSections(mixed);

  it('splits by heading and names the text before the first heading', () => {
    expect(sections.map((s) => s.heading)).toEqual([
      'Opening',
      'Why the cache was slow',
      'The fix',
      'What we checked',
      'Everything we tried first',
      'Closing',
    ]);
    expect(sections.map((s) => s.id)).toEqual(['s01', 's02', 's03', 's04', 's05', 's06']);
  });

  it('drops a heading with nothing under it', () => {
    expect(sections.find((s) => s.heading === 'Empty heading')).toBeUndefined();
  });

  it('counts spoken words, not code or table cells', () => {
    const fix = sections.find((s) => s.heading === 'The fix')!;
    expect(fix.blocks.map((b) => b.kind)).toEqual(['prose', 'code', 'prose']);
    expect(fix.words).toBe(countWords('We moved the lookup out of the request path: That was the whole change.'));
  });

  it('splits a very long section into parts and loses no words', () => {
    const para = 'This sentence has exactly eight words in it. '.repeat(40);
    const md = `## Long\n\n${Array.from({ length: 12 }, () => para).join('\n\n')}`;
    const parts = splitSections(md);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.words <= MAX_SECTION_WORDS)).toBe(true);
    expect(parts.map((p) => p.part)).toEqual(parts.map((_, i) => i + 1));
    expect(parts.reduce((n, p) => n + p.words, 0)).toBe(12 * 40 * 8);
  });

  it('splits one huge paragraph at sentence ends', () => {
    const md = `## Wall\n\n${'One more short sentence here. '.repeat(500)}`;
    const parts = splitSections(md);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.reduce((n, p) => n + p.words, 0)).toBe(2500);
  });
});

describe('splitSentences', () => {
  it('does not split decimals or versions', () => {
    expect(splitSentences('It took 3.5 seconds on v2.1.0. Then it stopped! Did it?')).toEqual([
      'It took 3.5 seconds on v2.1.0.',
      'Then it stopped!',
      'Did it?',
    ]);
  });
});
