import { SourceError, type SourceDoc } from './types.js';

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
  return {
    kind: 'devto',
    title: body.title,
    markdown: body.body_markdown,
    url: link,
    byline: body.user?.name,
  };
}
