import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { SourceError, UNREADABLE, type SourceDoc } from './types.js';

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
/** Readability text shorter than this is a cookie banner or a login wall, not an article. */
const MIN_ARTICLE_CHARS = 400;

export function parseHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new SourceError("That doesn't look like a web address. It should start with https://.");
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SourceError('Only http and https links can be read. Paste the text instead.');
  }
  url.hash = '';
  return url;
}

export interface FetchedPage {
  url: string;
  body: Buffer;
  contentType: string;
}

async function readCapped(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw tooLarge();
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw tooLarge();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function tooLarge(): SourceError {
  return new SourceError("That page is larger than 5 MB, so I didn't read it. Paste the text instead.");
}

/** GET with an http(s)-only rule on every hop, a timeout, a size cap and HTML only. */
export async function fetchPage(input: string, signal?: AbortSignal): Promise<FetchedPage> {
  let url = parseHttpUrl(input);
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: combined,
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'User-Agent': 'Mozilla/5.0 (compatible; TabsToTrails/0.1; reads one page for a listener)',
        },
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (timeout.aborted) throw new SourceError('The page took too long to answer. Try again, or paste the text instead.');
      throw new SourceError("I couldn't reach that page. Check the link, or paste the text instead.");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw new SourceError('That link redirects too many times. Open it in the browser and paste the text instead.');
      url = parseHttpUrl(new URL(res.headers.get('location')!, url).toString());
      await res.body?.cancel();
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new SourceError('That page needs a login. Copy the text from it and paste it instead.');
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new SourceError(`The page answered with an error (${res.status}). Check the link, or paste the text instead.`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      await res.body?.cancel();
      const kind = contentType.split(';')[0]?.trim() || 'an unknown type';
      throw new SourceError(`That link is not a web page I can read (it is ${kind}). Paste the text instead.`);
    }
    return { url: url.toString(), body: await readCapped(res), contentType };
  }
}

function turndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  td.use(gfm);
  td.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button', 'canvas', 'video', 'audio']);
  return td;
}

/** Reference lists, footnotes and edit links: things a listener has no use for. */
const NOISE = [
  'ol.references',
  '.reflist',
  '.references',
  '.mw-references-wrap',
  '.mw-editsection',
  'sup.reference',
  '.navbox',
  '.footnotes',
  'section.footnotes',
  '[role="doc-endnotes"]',
  '[role="doc-bibliography"]',
  '.citation-needed',
].join(',');

function cellText(cell: Element): string {
  return (cell.textContent ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
}

/** Any HTML table as a plain Markdown table; spans are flattened, the model only describes it. */
export function tableToMarkdown(table: Element): string {
  const rows = [...table.querySelectorAll('tr')]
    .map((tr) => [...tr.querySelectorAll('th, td')].map(cellText))
    .filter((cells) => cells.some((c) => c !== ''));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${[...cells, ...new Array(width - cells.length).fill('')].join(' | ')} |`;
  const caption = table.querySelector('caption') ? cellText(table.querySelector('caption')!) : '';
  const out = [line(rows[0]!), `| ${new Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)];
  return (caption ? `${caption}\n\n` : '') + out.join('\n');
}

/** HTML to Markdown through Readability. Page scripts never run. */
export function extractArticle(html: Buffer | string, pageUrl: string, contentType = 'text/html'): SourceDoc {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url: pageUrl, contentType: contentType.split(';')[0]?.trim() || 'text/html', virtualConsole });
  try {
    const doc = dom.window.document;
    const pageTitle = doc.title;
    doc.querySelectorAll(NOISE).forEach((el) => el.remove());
    const article = new Readability(doc, { charThreshold: 300 }).parse();
    if (!article?.content || (article.textContent ?? '').trim().length < MIN_ARTICLE_CHARS) {
      throw new SourceError(UNREADABLE);
    }
    const body = doc.createElement('div');
    body.innerHTML = article.content;
    body.querySelectorAll(NOISE).forEach((el) => el.remove());
    const tables: string[] = [];
    for (const table of [...body.querySelectorAll('table')].reverse()) {
      if (table.parentElement?.closest('table')) continue;
      const p = doc.createElement('p');
      p.textContent = `T2TTABLE${tables.length}T2T`;
      tables.push(tableToMarkdown(table));
      table.replaceWith(p);
    }
    const markdown = turndown()
      .turndown(body.innerHTML)
      .replace(/T2TTABLE(\d+)T2T/g, (_, n: string) => `\n\n${tables[Number(n)] ?? ''}\n\n`);
    const title = (article.title || pageTitle || new URL(pageUrl).hostname).replace(/\s+/g, ' ').trim();
    return { kind: 'web', title, markdown, url: pageUrl, byline: article.byline ?? undefined };
  } finally {
    dom.window.close();
  }
}

export async function fetchReadable(link: string, signal?: AbortSignal): Promise<SourceDoc> {
  const page = await fetchPage(link, signal);
  return extractArticle(page.body, page.url, page.contentType);
}
