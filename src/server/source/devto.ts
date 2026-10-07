import { parseHeading } from './sections.js';
import { SourceError, type SourceDoc } from './types.js';

/** The challenge template's first line: "*This is a submission for the [...](...)*". */
const SUBMISSION_LINE = /^\s*[*_]*\s*This is a submission for\b.*$/i;
/** Template sections that are about the contest entry, not the piece. */
const ENTRY_SECTIONS = /^prize categories$/i;

/**
 * DEV challenge posts carry template parts a listener has no use for: the
 * submission line and the Prize Categories section. Both are removed and
 * named, so the Ready screen can say what was left out.
 */
export function cleanDevtoMarkdown(markdown: string): { markdown: string; leftOut: string[] } {
  const leftOut: string[] = [];
  const out: string[] = [];
  let skipLevel = 0;
  let inFence = false;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    const heading = inFence ? null : parseHeading(line);
    if (heading && skipLevel && heading.level <= skipLevel) skipLevel = 0;
    if (heading && ENTRY_SECTIONS.test(heading.text.trim())) {
      skipLevel = heading.level;
      if (!leftOut.includes(heading.text.trim())) leftOut.push(heading.text.trim());
      continue;
    }
    if (skipLevel) continue;
    if (!inFence && SUBMISSION_LINE.test(line)) {
      if (!leftOut.includes('the challenge submission line')) leftOut.push('the challenge submission line');
      continue;
    }
    out.push(line);
  }
  return { markdown: out.join('\n'), leftOut };
}

/** Returns `{ username, slug }` for an article link on dev.to, else null. */
export function parseDevtoUrl(input: string): { username: string; slug: string } | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!/^(www\.)?dev\.to$/i.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [username, slug] = parts as [string, string];
  if (!/^[\w-]+$/.test(username) || !/^[\w-]+$/.test(slug)) return null;
  return { username, slug };
}

interface DevtoArticle {
  title?: string;
  body_markdown?: string;
  user?: { name?: string };
}

export async function fetchDevto(link: string, signal?: AbortSignal): Promise<SourceDoc | null> {
  const parsed = parseDevtoUrl(link);
  if (!parsed) return null;
  const api = `https://dev.to/api/articles/${parsed.username}/${parsed.slug}`;
  let res: Response;
  try {
    res = await fetch(api, {
      headers: { Accept: 'application/json', 'User-Agent': 'tabs-to-trails' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SourceError("I couldn't reach dev.to. Check the connection, or paste the text instead.");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new SourceError(`dev.to answered ${res.status}. Try again in a minute, or paste the text instead.`);
  const body = (await res.json()) as DevtoArticle;
  if (!body.body_markdown || !body.title) return null;
  const { markdown, leftOut } = cleanDevtoMarkdown(body.body_markdown);
  return {
    kind: 'devto',
    title: body.title,
    markdown,
    url: link,
    byline: body.user?.name,
    leftOut,
  };
}
