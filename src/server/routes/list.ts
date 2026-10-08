import { Hono } from 'hono';
import { z } from 'zod';
import { VOICE_KEYS } from '../config.js';
import { MAX_PIECES } from '../source/pieces.js';
import { viewStatus, type ListItem } from '../list/items.js';
import type { WalkList } from '../list/store.js';
import { MAX_FILE_BYTES, MAX_TEXT_CHARS } from '../source/paste.js';
import { SourceError } from '../source/types.js';
import type { Jobs } from '../walks/jobs.js';

const Id = z.string().regex(/^[a-f0-9]{12}$/);

const Source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string().trim().min(1).max(4000) }),
  z.object({ kind: z.literal('text'), text: z.string().max(MAX_TEXT_CHARS), title: z.string().max(300).optional() }),
  z.object({ kind: z.literal('file'), name: z.string().min(1).max(255), text: z.string().max(MAX_FILE_BYTES) }),
]);

/** One save holds what fits in one paste: the list itself has no limit. */
export const SaveBody = z.object({ sources: z.array(Source).min(1).max(50) });
export const PasteBody = z.object({ text: z.string().max(MAX_TEXT_CHARS), title: z.string().max(300).optional() });
export const OrderBody = z.object({ ids: z.array(Id).max(10_000) });
export const PreviewBody = z.object({
  items: z.array(Id).min(1).max(MAX_PIECES),
  minutes: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(45), z.literal(60), z.null()]),
  voice: z.enum(VOICE_KEYS),
  quietMinutes: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

export type ItemView = Omit<ListItem, 'doc' | 'walkId' | 'checkedAt'>;

/** What the page sees of an item: no stored doc, and the status as it stands now. */
export async function view(item: ListItem, jobs: Jobs): Promise<ItemView> {
  const state = item.walkId ? ((await jobs.status(item.walkId).catch(() => null))?.state ?? null) : null;
  const { doc: _doc, walkId: _walk, checkedAt: _checked, ...rest } = item;
  return { ...rest, status: viewStatus(item, state) };
}

const json = (header: string | undefined) => /^application\/json\b/i.test(header ?? '');
const BAD = 'That request is missing something. Reload the page and try again.';

export function listRoutes(list: WalkList, jobs: Jobs) {
  return new Hono()
    .get('/', async (c) => {
      const items = await Promise.all((await list.all()).map((i) => view(i, jobs)));
      // Items that went into a walk leave the list; one whose walk failed or was cancelled is back.
      return c.json({ items: items.filter((i) => i.status !== 'in_walk') });
    })
    .post('/', async (c) => {
      if (!json(c.req.header('content-type'))) return c.json({ error: BAD }, 415);
      const parsed = SaveBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: BAD }, 400);
      try {
        const { added, existing } = await list.add(parsed.data.sources);
        return c.json({ added: await Promise.all(added.map((i) => view(i, jobs))), existing: await Promise.all(existing.map((i) => view(i, jobs))) }, 201);
      } catch (err) {
        if (err instanceof SourceError) return c.json({ error: err.message }, 400);
        throw err;
      }
    })
    .post('/preview', async (c) => {
      if (!json(c.req.header('content-type'))) return c.json({ error: BAD }, 415);
      const parsed = PreviewBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: BAD }, 400);
      try {
        const { items, minutes, voice, quietMinutes } = parsed.data;
        return c.json(await list.preview(items, minutes, voice, minutes === null ? 0 : (quietMinutes ?? 0)));
      } catch (err) {
        if (err instanceof SourceError) return c.json({ error: err.message }, 400);
        throw err;
      }
    })
    .put('/order', async (c) => {
      if (!json(c.req.header('content-type'))) return c.json({ error: BAD }, 415);
      const parsed = OrderBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: BAD }, 400);
      try {
        await list.reorder(parsed.data.ids);
      } catch {
        return c.json({ error: 'The list changed in the meantime. Reload the page.' }, 409);
      }
      return c.body(null, 204);
    })
    .post('/:id/text', async (c) => {
      if (!json(c.req.header('content-type'))) return c.json({ error: BAD }, 415);
      const id = c.req.param('id');
      const parsed = PasteBody.safeParse(await c.req.json().catch(() => null));
      if (!Id.safeParse(id).success || !parsed.success) return c.json({ error: BAD }, 400);
      try {
        const item = await list.paste(id, parsed.data.text, parsed.data.title);
        return item ? c.json(await view(item, jobs)) : c.json({ error: 'That is no longer in your list.' }, 404);
      } catch (err) {
        if (err instanceof SourceError) return c.json({ error: err.message }, 400);
        throw err;
      }
    })
    .delete('/:id', async (c) => {
      const id = c.req.param('id');
      if (!Id.safeParse(id).success) return c.json({ error: BAD }, 400);
      return (await list.remove(id)) ? c.body(null, 204) : c.json({ error: 'That is no longer in your list.' }, 404);
    });
}
