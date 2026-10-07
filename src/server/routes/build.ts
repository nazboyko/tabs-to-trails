import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { VOICE_KEYS } from '../config.js';
import { fromFile, fromText, MAX_FILE_BYTES, MAX_TEXT_CHARS } from '../source/paste.js';
import { parseHttpUrl } from '../source/readable.js';
import { SourceError } from '../source/types.js';
import { isWalkId } from '../walks/store.js';
import type { Jobs, Status } from '../walks/jobs.js';
import type { Meta } from '../pipeline.js';
import { health } from './health.js';

export const BuildBody = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('url'), url: z.string().trim().min(1).max(4000) }),
    z.object({ kind: z.literal('text'), text: z.string().max(MAX_TEXT_CHARS), title: z.string().max(300).optional() }),
    z.object({ kind: z.literal('file'), name: z.string().min(1).max(255), text: z.string().max(MAX_FILE_BYTES) }),
  ]),
  minutes: z.union([z.literal(10), z.literal(20), z.literal(30), z.null()]),
  voice: z.enum(VOICE_KEYS),
});

export function buildRoutes(jobs: Jobs) {
  return new Hono()
    .post('/', async (c) => {
      // JSON only: a plain form or text/plain post from another page cannot start a build.
      if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) {
        return c.json({ error: 'That request is missing something. Reload the page and try again.' }, 415);
      }
      const parsed = BuildBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'That request is missing something. Reload the page and try again.' }, 400);
      const body = parsed.data;
      try {
        if (body.source.kind === 'url') parseHttpUrl(body.source.url);
        else if (body.source.kind === 'text') fromText(body.source.text, body.source.title);
        else fromFile(body.source.name, body.source.text);
      } catch (err) {
        if (err instanceof SourceError) return c.json({ error: err.message, suggestPaste: err.suggestPaste }, 400);
        throw err;
      }
      const h = await health();
      if (!h.ready) return c.json({ error: 'Something still needs to be installed.', setup: true }, 503);
      const record = await jobs.create(body);
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
