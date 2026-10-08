import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { VOICE_KEYS } from '../config.js';
import { fromFile, fromText, MAX_FILE_BYTES, MAX_TEXT_CHARS } from '../source/paste.js';
import { parseHttpUrl } from '../source/readable.js';
import { MAX_PIECES } from '../source/pieces.js';
import { SourceError } from '../source/types.js';
import { viewStatus } from '../list/items.js';
import type { WalkList } from '../list/store.js';
import { isWalkId } from '../walks/store.js';
import type { Jobs, Status } from '../walks/jobs.js';
import type { Meta } from '../pipeline.js';
import { health } from './health.js';

const Source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string().trim().min(1).max(4000) }),
  z.object({ kind: z.literal('text'), text: z.string().max(MAX_TEXT_CHARS), title: z.string().max(300).optional() }),
  z.object({ kind: z.literal('file'), name: z.string().min(1).max(255), text: z.string().max(MAX_FILE_BYTES) }),
]);

/** One source, a playlist of up to eight read one after another, or up to eight items of the walk list. */
export const BuildBody = z
  .object({
    source: Source.optional(),
    sources: z.array(Source).min(1).max(MAX_PIECES).optional(),
    items: z
      .array(z.string().regex(/^[a-f0-9]{12}$/))
      .min(1)
      .max(MAX_PIECES)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    minutes: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(45), z.literal(60), z.null()]),
    voice: z.enum(VOICE_KEYS),
  })
  .refine((b) => (b.source ? 1 : 0) + (b.sources ? 1 : 0) + (b.items ? 1 : 0) === 1);

type SourceBody = z.infer<typeof Source>;

function checkSource(source: SourceBody): void {
  if (source.kind === 'url') parseHttpUrl(source.url);
  else if (source.kind === 'text') fromText(source.text, source.title);
  else fromFile(source.name, source.text);
}

/** The first problem with the sources, or null. In a playlist, only a list where nothing can be used is refused. */
function sourceProblem(sources: SourceBody[]): SourceError | null {
  const problems: SourceError[] = [];
  for (const source of sources) {
    try {
      checkSource(source);
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      problems.push(err);
    }
  }
  return problems.length === sources.length ? problems[0]! : null;
}

/** Why a list item cannot go into a walk right now, or null. */
async function notReady(list: WalkList, jobs: Jobs, id: string): Promise<string | null> {
  const item = await list.get(id);
  if (!item) return 'One of the pieces is no longer in your list. Reload the page.';
  const state = item.walkId ? ((await jobs.status(item.walkId).catch(() => null))?.state ?? null) : null;
  const status = viewStatus(item, state);
  if (status === 'checking') return `${item.title} is still being checked. Give it a moment.`;
  if (status === 'unreadable') return `${item.title} could not be read. Paste its text first.`;
  if (status === 'in_walk') return `${item.title} is already in a walk.`;
  return null;
}

export function buildRoutes(jobs: Jobs, list: WalkList) {
  return new Hono()
    .post('/', async (c) => {
      // JSON only: a plain form or text/plain post from another page cannot start a build.
      if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) {
        return c.json({ error: 'That request is missing something. Reload the page and try again.' }, 415);
      }
      const parsed = BuildBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'That request is missing something. Reload the page and try again.' }, 400);
      const { source, sources, items, minutes, voice } = parsed.data;
      if (items) {
        for (const id of items) {
          const problem = await notReady(list, jobs, id);
          if (problem) return c.json({ error: problem }, 400);
        }
        const ready = await health();
        if (!ready.ready) return c.json({ error: 'Something still needs to be installed.', setup: true }, 503);
        // The saved Markdown is copied into the walk, so the build needs no network and later list edits cannot change it.
        const record = await jobs.create({ minutes, voice, items }, async (dir) => {
          const saved = await Promise.all(items.map((id, i) => list.copyInto(id, dir, `saved-${i + 1}.md`)));
          return saved.length === 1 ? { source: saved[0]!, minutes, voice, items } : { sources: saved, minutes, voice, items };
        });
        await list.markInWalk(items, record.id);
        return c.json({ id: record.id }, 202);
      }
      // A list of one is a single-source walk, the same as before playlists.
      const inputs = sources ?? [source!];
      const problem = sourceProblem(inputs);
      if (problem) return c.json({ error: problem.message, suggestPaste: problem.suggestPaste }, 400);
      const h = await health();
      if (!h.ready) return c.json({ error: 'Something still needs to be installed.', setup: true }, 503);
      const record = await jobs.create(inputs.length === 1 ? { source: inputs[0]!, minutes, voice } : { sources: inputs, minutes, voice });
      return c.json({ id: record.id }, 202);
    })
    .get('/:id/events', async (c) => {
      const id = c.req.param('id');
      if (!isWalkId(id) || !(await jobs.status(id))) return c.json({ error: 'There is no walk with that id.' }, 404);
      return streamSSE(c, async (stream) => {
        let closed = false;
        let wake: () => void = () => undefined;
        const finished = new Promise<void>((resolve) => (wake = resolve));
        const send = async (status: Status, meta?: Meta) => {
          if (closed) return;
          await stream.writeSSE({ event: 'status', data: JSON.stringify({ status, meta }) });
          if (status.state === 'done' || status.state === 'failed' || status.state === 'cancelled') wake();
        };
        const unsubscribe = jobs.subscribe(id, (status, meta) => void send(status, meta).catch(() => wake()));
        stream.onAbort(() => {
          closed = true;
          wake();
        });
        const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }).catch(() => wake()), 15_000);
        try {
          const now = await jobs.status(id);
          if (now) await send(now);
          await finished;
        } finally {
          clearInterval(ping);
          unsubscribe();
        }
      });
    })
    .post('/:id/retry', async (c) => {
      const id = c.req.param('id');
      if (!isWalkId(id)) return c.json({ error: 'There is no walk with that id.' }, 404);
      return (await jobs.retry(id)) ? c.json({ id }, 202) : c.json({ error: 'This walk is not waiting for a retry.' }, 409);
    })
    .delete('/:id', async (c) => {
      const id = c.req.param('id');
      if (!isWalkId(id)) return c.json({ error: 'There is no walk with that id.' }, 404);
      return (await jobs.cancel(id)) ? c.body(null, 204) : c.json({ error: 'This walk is already finished.' }, 409);
    });
}
