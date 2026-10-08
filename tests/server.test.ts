import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access } from '../src/server/app.js';
import type { Meta, runPipeline } from '../src/server/pipeline.js';
import { applyProgress, freshStatus, Jobs, lockedByOther, type Status } from '../src/server/walks/jobs.js';
import { isLoopback, lanAddress, shareUrl, tokenMatches } from '../src/server/walks/share.js';
import { readJson, walkDir, writeJson } from '../src/server/walks/store.js';

describe('access rule', () => {
  const req = (over: Partial<Parameters<typeof access>[0]>) =>
    access({ path: '/api/health', method: 'GET', remote: '127.0.0.1', host: 'localhost:8787', origin: undefined, ...over });

  it('lets this computer use the API', () => {
    expect(req({})).toBe('ok');
    expect(req({ remote: '::1', host: '[::1]:8787' })).toBe('ok');
    expect(req({ remote: '::ffff:127.0.0.1', method: 'POST', path: '/api/build', host: 'localhost:5173', origin: 'http://localhost:5173' })).toBe('ok');
  });

  it('hides everything but the phone page and assets from the network', () => {
    expect(req({ remote: '192.0.2.10' })).toBe('hidden');
    expect(req({ remote: '192.0.2.10', path: '/' })).toBe('hidden');
    expect(req({ remote: '192.0.2.10', path: '/w/abcdef123456' })).toBe('ok');
    expect(req({ remote: '192.0.2.10', path: '/assets/phone-C3HpgIHh.js' })).toBe('ok');
    expect(req({ remote: '192.0.2.10', path: '/favicon.svg' })).toBe('ok');
    expect(req({ remote: undefined })).toBe('hidden');
  });

  it('refuses a foreign Host (DNS rebinding) and foreign Origin on writes', () => {
    expect(req({ host: 'evil.example:8787' })).toBe('host');
    expect(req({ method: 'POST', path: '/api/build', origin: 'https://evil.example' })).toBe('origin');
    expect(req({ method: 'POST', path: '/api/build', origin: 'http://localhost:3000' })).toBe('origin');
    expect(req({ method: 'POST', path: '/api/build', origin: 'http://localhost:8787' })).toBe('ok');
  });

  it('refuses browser requests that another site started', () => {
    expect(req({ path: '/api/voices/heart/preview', fetchSite: 'cross-site' })).toBe('origin');
    expect(req({ path: '/api/voices/heart/preview', fetchSite: 'same-site' })).toBe('origin');
    expect(req({ path: '/api/voices/heart/preview', fetchSite: 'same-origin' })).toBe('ok');
    expect(req({ path: '/', fetchSite: 'cross-site' })).toBe('ok');
  });

  it('opens only the exact phone routes to the network', () => {
    expect(req({ remote: '192.0.2.10', path: '/w/abcdef123456/info' })).toBe('ok');
    expect(req({ remote: '192.0.2.10', path: '/w/abcdef123456/audio' })).toBe('ok');
    expect(req({ remote: '192.0.2.10', path: '/w/abcdef123456/audiobook' })).toBe('ok');
    expect(req({ remote: '192.0.2.10', path: '/api/walks/abcdef123456/audiobook' })).toBe('hidden');
    expect(req({ remote: '192.0.2.10', path: '/w/..%2fapi/walks' })).toBe('hidden');
    expect(req({ remote: '192.0.2.10', path: '/assets/..%2f..%2findex.html' })).toBe('hidden');
    expect(req({ remote: '192.0.2.10', path: '/w/abcdef123456/other' })).toBe('hidden');
  });
});

describe('share link', () => {
  it('picks a private address on a real interface', () => {
    const ifaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      utun3: [{ address: '172.20.0.9', family: 'IPv4', internal: false }],
      en0: [{ address: '192.0.2.10', family: 'IPv4', internal: false }, { address: '172.20.0.5', family: 'IPv4', internal: false }],
    } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;
    expect(lanAddress(ifaces)).toBe('172.20.0.5');
    const publicOnly = { en0: [{ address: '198.51.100.7', family: 'IPv4', internal: false }] } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;
    expect(lanAddress(publicOnly)).toBe('198.51.100.7');
    expect(lanAddress({} as never)).toBeNull();
  });

  it('builds the phone URL and says when there is no network', () => {
    expect(shareUrl('abcdef123456', 'tok', 8787, '192.0.2.10')).toBe('http://192.0.2.10:8787/w/abcdef123456?t=tok');
    expect(shareUrl('abcdef123456', 'tok', 8787, null)).toBeNull();
  });

  it('compares tokens exactly', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('ab', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('192.0.2.10')).toBe(false);
  });
});

describe('applyProgress', () => {
  it('marks earlier stages done and keeps counts', () => {
    let s = freshStatus();
    s = applyProgress(s, { stage: 'rewrite', state: 'active', done: 2, total: 5, detail: 'Section 3 of 5' });
    expect(s.stages.read.state).toBe('done');
    expect(s.stages.plan.state).toBe('done');
    expect(s.stages.rewrite).toEqual({ state: 'active', done: 2, total: 5, detail: 'Section 3 of 5' });
    expect(s.stages.voice.state).toBe('waiting');
  });
});

describe('Jobs', () => {
  let tmp = '';
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 't2t-jobs-'));
    process.env.WALKS_DIR = tmp;
  });
  afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

  const meta = { title: 'T', actualSeconds: 60 } as Meta;
  const waitFor = (jobs: Jobs, id: string, state: Status['state']) =>
    new Promise<Status>((resolve) => {
      jobs.subscribe(id, (s) => s.state === state && resolve(s));
      void jobs.status(id).then((s) => s?.state === state && resolve(s));
    });

  it('runs a walk and reports each stage', async () => {
    const runner: typeof runPipeline = async (_id, _dir, _req, _at, onProgress) => {
      onProgress?.({ stage: 'read', state: 'done', detail: '10 words in 1 section' });
      onProgress?.({ stage: 'voice', state: 'active', done: 0, total: 1 });
      return meta;
    };
    const jobs = new Jobs(runner);
    const record = await jobs.create({ source: { kind: 'text', text: 'Hello there.' }, minutes: 10, voice: 'heart' });
    const done = await waitFor(jobs, record.id, 'done');
    expect(Object.values(done.stages).every((s) => s.state === 'done')).toBe(true);
    expect((await readJson<Status>(walkDir(record.id), 'status.json'))?.state).toBe('done');
    expect(record.token.length).toBeGreaterThanOrEqual(20);
  });

  it('fails with a calm message and can retry only the audio', async () => {
    let calls = 0;
    const runner: typeof runPipeline = async (_id, _dir, _req, _at, onProgress) => {
      calls++;
      onProgress?.({ stage: 'voice', state: 'active', done: 1, total: 3 });
      if (calls === 1) throw new Error('onnx exploded');
      return meta;
    };
    const jobs = new Jobs(runner);
    const record = await jobs.create({ source: { kind: 'text', text: 'Hello there.' }, minutes: 10, voice: 'heart' });
    const failed = await waitFor(jobs, record.id, 'failed');
    expect(failed.error).toMatchObject({ stage: 'voice', audioOnly: true });
    expect(failed.error?.message).toMatch(/script is saved/);
    const again = waitFor(jobs, record.id, 'done');
    expect(await jobs.retry(record.id)).toBe(true);
    await again;
    expect(calls).toBe(2);
  });

  it('picks up a walk that was running when the process stopped', async () => {
    const id = 'aaaaaaaaaaaa';
    await fs.mkdir(walkDir(id), { recursive: true });
    await writeJson(walkDir(id), 'walk.json', { id, token: 't'.repeat(24), createdAt: new Date().toISOString(), request: { source: { kind: 'text', text: 'x y z' }, minutes: 10, voice: 'heart' } });
    await writeJson(walkDir(id), 'status.json', { ...freshStatus(), state: 'running' });
    const seen: string[] = [];
    const jobs = new Jobs(async (runId) => {
      seen.push(runId);
      return meta;
    });
    const done = waitFor(jobs, id, 'done');
    expect(await jobs.resumeAll()).toEqual([id]);
    await done;
    expect(seen).toEqual([id]);
  });

  it('leaves a walk alone while another live process holds it', async () => {
    const id = 'bbbbbbbbbbbb';
    await fs.mkdir(walkDir(id), { recursive: true });
    await writeJson(walkDir(id), 'walk.json', { id, token: 't'.repeat(24), createdAt: new Date().toISOString(), request: { source: { kind: 'text', text: 'x y z' }, minutes: 10, voice: 'heart' } });
    await writeJson(walkDir(id), 'status.json', { ...freshStatus(), state: 'running' });
    // The parent of the test runner is alive and is not this process.
    await fs.writeFile(path.join(walkDir(id), 'run.lock'), JSON.stringify({ pid: process.ppid }));
    expect(await lockedByOther(id)).toBe(process.ppid);
    const jobs = new Jobs(async () => meta);
    expect(await jobs.resumeAll()).toEqual([]);
    await fs.writeFile(path.join(walkDir(id), 'run.lock'), JSON.stringify({ pid: 999999 }));
    expect(await lockedByOther(id)).toBeNull();
    const done = waitFor(jobs, id, 'done');
    expect(await jobs.resumeAll()).toEqual([id]);
    await done;
    await expect(fs.access(path.join(walkDir(id), 'run.lock'))).rejects.toThrow();
  });

  it('runs queued walks one at a time and in order', async () => {
    let active = 0;
    let most = 0;
    const order: string[] = [];
    const runner: typeof runPipeline = async (runId) => {
      active++;
      most = Math.max(most, active);
      order.push(runId);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return meta;
    };
    const jobs = new Jobs(runner);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `c${i}`.padEnd(12, 'c');
      ids.push(id);
      await fs.mkdir(walkDir(id), { recursive: true });
      await writeJson(walkDir(id), 'walk.json', { id, token: 't'.repeat(24), createdAt: `2026-10-07T10:00:0${i}.000Z`, request: { source: { kind: 'text', text: 'x' }, minutes: 10, voice: 'heart' } });
      await writeJson(walkDir(id), 'status.json', { ...freshStatus(), state: 'queued' });
    }
    const all = Promise.all(ids.map((id) => waitFor(jobs, id, 'done')));
    await jobs.resumeAll();
    await all;
    expect(most).toBe(1);
    expect(order).toEqual(ids);
  });

  it('runs a walk once when retry is pressed twice', async () => {
    let calls = 0;
    const jobs = new Jobs(async (_id, _dir, _req, _at, onProgress) => {
      calls++;
      onProgress?.({ stage: 'voice', state: 'active' });
      if (calls === 1) throw new Error('first try fails');
      await new Promise((r) => setTimeout(r, 15));
      return meta;
    });
    const record = await jobs.create({ source: { kind: 'text', text: 'Hello there.' }, minutes: 10, voice: 'heart' });
    await waitFor(jobs, record.id, 'failed');
    const done = waitFor(jobs, record.id, 'done');
    const answers = await Promise.all([jobs.retry(record.id), jobs.retry(record.id)]);
    await done;
    expect(answers.filter(Boolean)).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('tells watchers when a walk is cancelled', async () => {
    let release: () => void = () => undefined;
    const jobs = new Jobs(() => new Promise<Meta>((resolve) => (release = () => resolve(meta))));
    const record = await jobs.create({ source: { kind: 'text', text: 'one' }, minutes: 10, voice: 'heart' });
    const heard = waitFor(jobs, record.id, 'cancelled');
    await new Promise((r) => setTimeout(r, 10));
    expect(await jobs.cancel(record.id)).toBe(true);
    expect((await heard).state).toBe('cancelled');
    release();
  });

  it('cancels a queued walk and removes its folder', async () => {
    let release: () => void = () => undefined;
    const jobs = new Jobs(
      () =>
        new Promise<Meta>((resolve) => {
          release = () => resolve(meta);
        }),
    );
    const first = await jobs.create({ source: { kind: 'text', text: 'one' }, minutes: 10, voice: 'heart' });
    const second = await jobs.create({ source: { kind: 'text', text: 'two' }, minutes: 10, voice: 'heart' });
    expect(await jobs.cancel(second.id)).toBe(true);
    await expect(fs.access(walkDir(second.id))).rejects.toThrow();
    release();
    await waitFor(jobs, first.id, 'done');
  });
});

describe('slugify', () => {
  it('cuts long titles between words', async () => {
    const { slugify } = await import('../src/server/walks/store.js');
    expect(slugify("My Six-Year-Old Can't Do Five Things at Once, So His Screen Shows One")).toBe('my-six-year-old-cant-do-five-things-at-once-so-his-screen');
    expect(slugify('Walking, part one, by Henry David Thoreau')).toBe('walking-part-one-by-henry-david-thoreau');
    expect(slugify('Café déjà vu')).toBe('cafe-deja-vu');
    expect(slugify('???')).toBe('walk');
  });
});
