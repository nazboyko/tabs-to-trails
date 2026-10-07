import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDevtoUrl } from '../src/server/source/devto.js';
import { fromFile, fromText, normalizePasted, titleFromFileName } from '../src/server/source/paste.js';
import { extractArticle, fetchPage, MAX_BYTES } from '../src/server/source/readable.js';
import { dropBackMatter, splitSections } from '../src/server/source/sections.js';
import { SourceError, UNREADABLE } from '../src/server/source/types.js';

const articleHtml = fs.readFileSync(new URL('./fixtures/article.html', import.meta.url));

describe('parseDevtoUrl', () => {
  it('recognizes article links and nothing else', () => {
    expect(parseDevtoUrl('https://dev.to/nazar-boyko/some-post-o1m?x=1')).toEqual({ username: 'nazar-boyko', slug: 'some-post-o1m' });
    expect(parseDevtoUrl('https://dev.to/nazar-boyko')).toBeNull();
    expect(parseDevtoUrl('https://example.com/a/b')).toBeNull();
    expect(parseDevtoUrl('not a url')).toBeNull();
  });
});

describe('extractArticle', () => {
  const doc = extractArticle(articleHtml, 'https://blog.example/notes');

  it('keeps the article and drops navigation and footer', () => {
    expect(doc.title).toBe('Field notes on quiet mornings');
    expect(doc.markdown).toContain('For four weeks I kept a notebook');
    expect(doc.markdown).not.toContain('Archive');
    expect(doc.markdown).not.toContain('newsletter');
  });

  it('never runs page scripts', () => {
    expect(doc.markdown).not.toContain('SCRIPT RAN');
    expect(doc.title).not.toContain('changed by a script');
  });

  it('turns tables and code into markdown blocks', () => {
    const kinds = splitSections(doc.markdown).flatMap((s) => s.blocks.map((b) => b.kind));
    expect(kinds).toContain('table');
    expect(kinds).toContain('code');
  });

  it('leaves out a references list and says which', () => {
    const { kept, dropped } = dropBackMatter(splitSections(doc.markdown));
    expect(dropped).toEqual(['References']);
    expect(kept.map((s) => s.heading)).not.toContain('References');
  });

  it('refuses a page with no article text', () => {
    expect(() => extractArticle('<html><body><p>Sign in to continue.</p></body></html>', 'https://x.example/')).toThrow(UNREADABLE);
  });
});

describe('fetchPage', () => {
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = req.url ?? '/';
      if (path === '/article') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(articleHtml);
      } else if (path.startsWith('/hop/')) {
        const n = Number(path.slice(5));
        res.writeHead(302, { Location: n > 0 ? `/hop/${n - 1}` : '/article' }).end();
      } else if (path === '/pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' }).end('%PDF-1.4');
      } else if (path === '/huge') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const chunk = Buffer.alloc(1024 * 1024, 'a');
        for (let i = 0; i < 6; i++) res.write(chunk);
        res.end();
      } else if (path === '/login') {
        res.writeHead(403).end();
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const message = async (url: string) => {
    try {
      await fetchPage(url);
      return 'no error';
    } catch (err) {
      expect(err).toBeInstanceOf(SourceError);
      return (err as Error).message;
    }
  };

  it('reads an HTML page', async () => {
    const page = await fetchPage(`${base}/article`);
    expect(page.contentType).toContain('text/html');
    expect(page.body.length).toBe(articleHtml.length);
  });

  it('follows up to three redirects and no more', async () => {
    expect((await fetchPage(`${base}/hop/2`)).url).toBe(`${base}/article`);
    expect(await message(`${base}/hop/3`)).toMatch(/redirects too many times/);
  });

  it('gives a calm sentence with one action for each failure', async () => {
    expect(await message(`${base}/missing`)).toBe('The page answered with an error (404). Check the link, or paste the text instead.');
    expect(await message(`${base}/login`)).toMatch(/needs a login/);
    expect(await message(`${base}/pdf`)).toMatch(/not a web page I can read \(it is application\/pdf\)/);
    expect(await message(`${base}/huge`)).toMatch(/larger than 5 MB/);
    expect(await message('ftp://example.com/file')).toMatch(/Only http and https/);
    expect(await message('example dot com')).toMatch(/doesn't look like a web address/);
    expect(await message('http://127.0.0.1:1/closed')).toMatch(/couldn't reach that page/);
    expect(MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe('paste and file', () => {
  it('adds paragraph breaks to one-line-per-paragraph text', () => {
    expect(normalizePasted('First para.\nSecond para.')).toBe('First para.\n\nSecond para.');
    expect(normalizePasted('A\n\nB\nstill B')).toBe('A\n\nB\nstill B');
  });

  it('uses the given title, then a heading, then a plain name', () => {
    expect(fromText('Some text here.', 'My title').title).toBe('My title');
    expect(fromText('# Heading\n\nBody text.').title).toBe('Heading');
    expect(fromText('Body text only.').title).toBe('your pasted text');
  });

  it('refuses empty text', () => {
    expect(() => fromText('   \n  ')).toThrow(/no text to read/);
  });

  it('reads .md and .txt files and names them from the file name', () => {
    expect(titleFromFileName('notes-on_caching.md')).toBe('Notes on caching');
    const doc = fromFile('draft.txt', Buffer.from('One line.\nTwo lines.'));
    expect(doc.kind).toBe('file');
    expect(doc.title).toBe('Draft');
    expect(() => fromFile('paper.pdf', 'x')).toThrow(/Only .md and .txt/);
  });
});
