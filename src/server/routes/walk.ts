import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { loadConfig } from '../config.js';
import { encodeAudiobook } from '../audio/assemble.js';
import { chaptersFrom, type Chapter } from '../audio/chapters.js';
import type { Segment } from '../audio/timeline.js';
import { HALFWAY_TEXT, OUTRO_TEXT, QUESTION_LEAD, requestSources, type BuildRequest, type Meta, type Script, type SourceInfo } from '../pipeline.js';
import type { Plan } from '../script/budget.js';
import { sectionLabel } from '../source/sections.js';
import type { Jobs } from '../walks/jobs.js';
import { lanAddress, qrDataUrl, shareUrl, tokenMatches } from '../walks/share.js';
import { exists, isWalkId, listWalkIds, readJson, walkDir } from '../walks/store.js';

interface Timeline {
  seconds: number;
  halfwaySeconds: number | null;
  threeQuarterSeconds?: number | null;
  segments: Segment[];
  /** Missing in walks made before chapters; then they are worked out from the segments. */
  chapters?: Chapter[];
}

/** The walk's chapters, as written into its files. */
export function walkChapters(timeline: Timeline, meta: Meta): Chapter[] {
  return timeline.chapters ?? chaptersFrom(timeline.segments, timeline.seconds, (meta.pieces ?? []).map((p) => p.title));
}

const building = new Map<string, Promise<void>>();

/** The audiobook file, made from the MP3 on the first request and kept beside it. */
export async function audiobookFile(id: string): Promise<string | null> {
  const dir = walkDir(id);
  const file = path.join(dir, 'final.m4b');
  if (await exists(file)) return file;
  const [meta, timeline] = await Promise.all([readJson<Meta>(dir, 'meta.json'), readJson<Timeline>(dir, 'timeline.json')]);
  if (!meta || !timeline || !(await exists(path.join(dir, 'final.mp3')))) return null;
  let job = building.get(id);
  if (!job) {
    job = encodeAudiobook(path.join(dir, 'final.mp3'), file, { title: meta.title, date: meta.createdAt.slice(0, 10) }, walkChapters(timeline, meta)).finally(() =>
      building.delete(id),
    );
    building.set(id, job);
  }
  await job;
  return file;
}

/** The links the walk was asked for, one per line, so a failed build can offer them again. */
function requestedLinks(req: BuildRequest): string | null {
  const urls = requestSources(req).filter((s) => s.kind === 'url');
  return urls.length ? urls.map((s) => (s.kind === 'url' ? s.url : '')).join('\n') : null;
}

export async function walkSummary(id: string) {
  const meta = await readJson<Meta>(walkDir(id), 'meta.json');
  if (!meta) return null;
  return { id, title: meta.title, actualSeconds: meta.actualSeconds, targetSeconds: meta.targetSeconds, createdAt: meta.createdAt };
}

/** Everything the Ready and Script screens show, read from the walk folder. */
export async function walkDetail(id: string, jobs: Jobs, port: number) {
  const dir = walkDir(id);
  const [meta, script, plan, timeline, info, record] = await Promise.all([
    readJson<Meta>(dir, 'meta.json'),
    readJson<Script>(dir, 'script.json'),
    readJson<Plan>(dir, 'plan.json'),
    readJson<Timeline>(dir, 'timeline.json'),
    readJson<SourceInfo>(dir, 'source.json'),
    jobs.record(id),
  ]);
  const status = await jobs.status(id);
  if (!meta || !script || !plan || !timeline || !record) {
    const req = record?.request;
    return {
      id,
      status,
      ready: false as const,
      title: info?.title ?? null,
      request: req ? { minutes: req.minutes, voice: req.voice, url: requestedLinks(req) } : null,
    };
  }
  const at = (role: Segment['role']) => timeline.segments.find((s) => s.role === role)?.start ?? null;
  const app = (await readJson<{ app: Record<string, { text: string } | undefined> }>(dir, 'voice.json'))?.app ?? {};
  const intro = app.intro?.text ?? '';
  const threeQuarter = timeline.threeQuarterSeconds ?? null;
  const url = shareUrl(id, record.token, port, loadConfig().SHARE_HOST ?? lanAddress());
  return {
    id,
    status,
    ready: true as const,
    title: meta.title,
    meta,
    plan: { mode: meta.mode, targetSeconds: plan.targetSeconds, fullSeconds: plan.fullSeconds, tooLong: plan.tooLong },
    sections: script.sections.map((s) => {
      const segs = timeline.segments.filter((g) => g.sectionId === s.id);
      const planned = plan.sections.find((p) => p.id === s.id);
      return {
        id: s.id,
        label: sectionLabel(s),
        piece: s.piece ?? 0,
        coverage: s.coverage,
        adapted: s.adapted,
        checkNumbers: s.checkNumbers,
        note: s.note ?? null,
        text: s.text,
        words: s.words,
        sourceWords: planned?.fullWords ?? s.words,
        start: segs[0]?.start ?? 0,
        seconds: segs.reduce((n, g) => n + (g.end - g.start), 0),
      };
    }),
    app: {
      intro: { text: intro, start: at('intro') },
      halfway: timeline.halfwaySeconds === null ? null : { text: HALFWAY_TEXT, start: timeline.halfwaySeconds },
      threeQuarter: threeQuarter === null || !app.threequarter ? null : { text: app.threequarter.text, start: threeQuarter },
      bridges: timeline.segments.filter((g) => g.role === 'bridge').map((g) => ({ piece: g.piece ?? 0, text: g.label, start: g.start })),
      question: script.question ? { text: `${QUESTION_LEAD} ${script.question}`, start: at('question') } : null,
      outro: { text: OUTRO_TEXT, start: at('outro') },
    },
    segments: timeline.segments,
    leftOut: info?.leftOut ?? [],
    /** List items this walk took out of the waiting list. */
    closed: record.request.items?.length ?? 0,
    pieces: meta.pieces ?? [],
    skipped: meta.skipped ?? [],
    share: url ? { url, qr: await qrDataUrl(url) } : null,
  };
}

/** Serves the MP3 with byte ranges, which phone browsers need to seek and stream. */
export async function sendAudio(c: Context, id: string, download: boolean): Promise<Response> {
  const file = path.join(walkDir(id), 'final.mp3');
  const meta = await readJson<Meta>(walkDir(id), 'meta.json');
  if (!meta || !(await exists(file))) return c.text('This walk has no audio yet.', 404);
  return sendFile(c, file, 'audio/mpeg', download ? meta.fileName : null);
}

/** The audiobook (.m4b), always as a download. */
export async function sendAudiobook(c: Context, id: string): Promise<Response> {
  const meta = await readJson<Meta>(walkDir(id), 'meta.json');
  const file = meta ? await audiobookFile(id).catch(() => null) : null;
  if (!meta || !file) return c.text('This walk has no audio yet.', 404);
  return sendFile(c, file, 'audio/mp4', meta.fileName.replace(/\.mp3$/, '.m4b'));
}

async function sendFile(c: Context, file: string, type: string, attachment: string | null): Promise<Response> {
  const size = (await fsp.stat(file)).size;
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  };
  if (attachment) headers['Content-Disposition'] = `attachment; filename="${attachment}"`;
  const range = c.req.header('range')?.match(/^bytes=(\d*)-(\d*)$/);
  let start = 0;
  let end = size - 1;
  let status: 200 | 206 = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) {
      return c.body(null, 416, { 'Content-Range': `bytes */${size}` });
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  if (c.req.method === 'HEAD') return c.body(null, status, headers);
  const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
  return c.body(stream, status, headers);
}

export function walkRoutes(jobs: Jobs) {
  const port = () => loadConfig().PORT;
  return new Hono()
    .get('/', async (c) => {
      const ids = await listWalkIds();
      const all = (await Promise.all(ids.map(walkSummary))).filter((w) => w !== null);
      all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      let active: { id: string; title: string | null } | null = null;
      for (const id of ids) {
        const status = await jobs.status(id);
        if (status && (status.state === 'running' || status.state === 'queued')) {
          active = { id, title: (await readJson<SourceInfo>(walkDir(id), 'source.json'))?.title ?? null };
          break;
        }
      }
      const walked = { count: all.length, seconds: Math.round(all.reduce((n, w) => n + w.actualSeconds, 0)) };
      return c.json({ walks: all.slice(0, 20), active, total: all.length, walked, lan: (loadConfig().SHARE_HOST ?? lanAddress()) !== null });
    })
    .get('/:id', async (c) => {
      const id = c.req.param('id');
      if (!isWalkId(id) || !(await jobs.record(id))) return c.json({ error: 'There is no walk with that id.' }, 404);
      return c.json(await walkDetail(id, jobs, port()));
    })
    .get('/:id/audio', async (c) => {
      const id = c.req.param('id');
      if (!isWalkId(id)) return c.text('Not found', 404);
      return sendAudio(c, id, c.req.query('download') !== '0');
    })
    .get('/:id/audiobook', async (c) => {
      const id = c.req.param('id');
      if (!isWalkId(id)) return c.text('Not found', 404);
      return sendAudiobook(c, id);
    })
    .get('/:id/source', async (c) => {
      const id = c.req.param('id');
      if (!isWalkId(id)) return c.text('Not found', 404);
      const file = path.join(walkDir(id), 'source.md');
      if (!(await exists(file))) return c.text('Not found', 404);
      return c.body(await fsp.readFile(file, 'utf8'), 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
    });
}

/** The phone side: reachable from the local network, but only with the walk's token. */
export function phoneRoutes(jobs: Jobs, phonePage: () => Promise<string | null>) {
  const allowed = async (c: Context): Promise<string | null> => {
    const id = c.req.param('id') ?? '';
    if (!isWalkId(id)) return null;
    const record = await jobs.record(id);
    return record && tokenMatches(c.req.query('t'), record.token) ? id : null;
  };
  const expired = 'This walk link is not complete or no longer exists. Scan the code on your computer again.';
  return new Hono()
    .get('/:id', async (c) => {
      if (!(await allowed(c))) return c.text(expired, 404);
      const html = await phonePage();
      if (!html) return c.redirect(`/phone.html?id=${c.req.param('id')}&t=${encodeURIComponent(c.req.query('t') ?? '')}`);
      return c.html(html, 200, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    })
    .get('/:id/info', async (c) => {
      const id = await allowed(c);
      if (!id) return c.json({ error: expired }, 404);
      const meta = await readJson<Meta>(walkDir(id), 'meta.json');
      const timeline = await readJson<Timeline>(walkDir(id), 'timeline.json');
      if (!meta || !timeline) return c.json({ error: 'This walk is still being made. Try again in a minute.' }, 409);
      return c.json({
        title: meta.title,
        actualSeconds: meta.actualSeconds,
        halfwaySeconds: meta.halfwaySeconds,
        threeQuarterSeconds: meta.threeQuarterSeconds ?? null,
        bytes: meta.bytes,
        fileName: meta.fileName,
        chapters: timeline.segments.filter((s) => s.kind === 'source').map((s) => ({ label: s.label, start: s.start })),
        // A playlist lists its pieces; a single source has one, which the page does not repeat.
        pieces: (meta.pieces ?? []).length > 1 ? meta.pieces!.map((p) => ({ title: p.title, start: p.start, seconds: p.seconds })) : [],
      });
    })
    .on(['GET', 'HEAD'], '/:id/audio', async (c) => {
      const id = await allowed(c);
      if (!id) return c.text(expired, 404);
      return sendAudio(c, id, c.req.query('download') === '1');
    })
    .on(['GET', 'HEAD'], '/:id/audiobook', async (c) => {
      const id = await allowed(c);
      if (!id) return c.text(expired, 404);
      return sendAudiobook(c, id);
    });
}
