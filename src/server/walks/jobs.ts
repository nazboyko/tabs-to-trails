import fs from 'node:fs/promises';
import path from 'node:path';
import { ModelMissing, OllamaUnreachable, PromptTooLarge } from '../ollama.js';
import { runPipeline, type BuildRequest, type Meta, type Progress, type StageName } from '../pipeline.js';
import { SourceError } from '../source/types.js';
import { listWalkIds, newId, newToken, readJson, walkDir, writeJson } from './store.js';

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export const STAGES: StageName[] = ['read', 'plan', 'rewrite', 'voice', 'pack'];

export interface StageStatus {
  state: 'waiting' | 'active' | 'done';
  done?: number;
  total?: number;
  detail?: string;
}

export interface JobError {
  message: string;
  stage: StageName;
  /** The script is finished; retrying redoes only the audio. */
  audioOnly: boolean;
  /** The link could not be read; the Build screen offers the Text tab. */
  suggestPaste: boolean;
}

export interface Status {
  state: JobState;
  stages: Record<StageName, StageStatus>;
  error?: JobError;
  updatedAt: string;
}

/** Saved when a walk is created; everything a restart needs to resume it. */
export interface WalkRecord {
  id: string;
  token: string;
  createdAt: string;
  request: BuildRequest;
}

export type Listener = (status: Status, meta?: Meta) => void;

const LOCK = 'run.lock';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Which live process, other than this one, is running the walk right now. */
export async function lockedByOther(id: string): Promise<number | null> {
  try {
    const { pid } = JSON.parse(await fs.readFile(path.join(walkDir(id), LOCK), 'utf8')) as { pid: number };
    return pid !== process.pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Takes the walk for this process. The app and the terminal command can run
 * at the same time on one walks folder; a walk is only ever worked on by one.
 */
async function takeLock(id: string): Promise<boolean> {
  const file = path.join(walkDir(id), LOCK);
  const body = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  try {
    await fs.writeFile(file, body, { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  // A lock is there: ours from before a crash, or a stale one from a process that is gone.
  if (await lockedByOther(id)) return false;
  await fs.writeFile(file, body);
  return true;
}

async function dropLock(id: string): Promise<void> {
  await fs.rm(path.join(walkDir(id), LOCK), { force: true });
}

export function freshStatus(): Status {
  return {
    state: 'queued',
    stages: Object.fromEntries(STAGES.map((s) => [s, { state: 'waiting' }])) as Record<StageName, StageStatus>,
    updatedAt: new Date().toISOString(),
  };
}

/** Applies one progress event: earlier stages are done, this one is active or done. */
export function applyProgress(status: Status, p: Progress): Status {
  const stages = { ...status.stages };
  const at = STAGES.indexOf(p.stage);
  STAGES.forEach((name, i) => {
    if (i < at && stages[name].state !== 'done') stages[name] = { ...stages[name], state: 'done' };
  });
  const prev = stages[p.stage];
  stages[p.stage] = {
    state: p.state,
    done: p.done ?? prev.done,
    total: p.total ?? prev.total,
    detail: p.detail ?? (p.state === prev.state ? prev.detail : undefined),
  };
  return { ...status, state: 'running', stages, updatedAt: new Date().toISOString() };
}

function friendlyError(err: unknown, stage: StageName): JobError {
  const audioOnly = stage === 'voice' || stage === 'pack';
  if (err instanceof SourceError) return { message: err.message, stage, audioOnly: false, suggestPaste: err.suggestPaste };
  if (err instanceof OllamaUnreachable || err instanceof ModelMissing) {
    return { message: `${err.message}. Then try again; finished steps are kept.`, stage, audioOnly: false, suggestPaste: false };
  }
  if (err instanceof PromptTooLarge) {
    return { message: 'One part of this source is too large for the model. Paste a shorter part instead.', stage, audioOnly: false, suggestPaste: false };
  }
  if (audioOnly) {
    return { message: 'The voice stopped partway. The script is saved, so only the audio needs to be made again.', stage, audioOnly, suggestPaste: false };
  }
  const detail = err instanceof Error ? err.message : String(err);
  return { message: `Something went wrong while ${stageVerb(stage)}: ${detail}`, stage, audioOnly, suggestPaste: false };
}

function stageVerb(stage: StageName): string {
  return { read: 'reading the source', plan: 'planning the walk', rewrite: 'rewriting for listening', voice: 'recording the voice', pack: 'packing the MP3' }[stage];
}

export class Jobs {
  private queue: string[] = [];
  private running: { id: string; controller: AbortController; status: Status | null } | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private cancelled = new Set<string>();
  private retrying = new Set<string>();

  constructor(private readonly runner: typeof runPipeline = runPipeline) {}

  /**
   * `prepare` builds the request inside the new walk folder (copies of saved
   * sources) before the walk is recorded and queued.
   */
  async create(request: BuildRequest, prepare?: (dir: string, id: string) => Promise<BuildRequest>): Promise<WalkRecord> {
    const id = newId();
    const dir = walkDir(id);
    await fs.mkdir(dir, { recursive: true });
    let final = request;
    try {
      if (prepare) final = await prepare(dir, id);
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true });
      throw err;
    }
    const record: WalkRecord = { id, token: newToken(), createdAt: new Date().toISOString(), request: final };
    await writeJson(dir, 'walk.json', record);
    await this.save(record.id, freshStatus());
    this.enqueue(record.id);
    return record;
  }

  async record(id: string): Promise<WalkRecord | null> {
    return readJson<WalkRecord>(walkDir(id), 'walk.json');
  }

  /** The running walk's status comes from memory; every other walk's from disk, which another process may have changed. */
  async status(id: string): Promise<Status | null> {
    if (this.running?.id === id && this.running.status) return this.running.status;
    return readJson<Status>(walkDir(id), 'status.json');
  }

  subscribe(id: string, fn: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.listeners.delete(id);
    };
  }

  /** Puts a failed walk back in the queue. Finished stages are read from its folder. */
  async retry(id: string): Promise<boolean> {
    if (this.running?.id === id || this.queue.includes(id) || this.retrying.has(id)) return false;
    this.retrying.add(id);
    try {
      const status = await this.status(id);
      if (!status || status.state !== 'failed') return false;
      await this.save(id, { ...status, state: 'queued', error: undefined, updatedAt: new Date().toISOString() });
      this.enqueue(id);
      return true;
    } finally {
      this.retrying.delete(id);
    }
  }

  /** Stops a queued or running walk, tells whoever is watching, and removes its folder. */
  async cancel(id: string): Promise<boolean> {
    const status = await this.status(id);
    if (!status || status.state === 'done') return false;
    this.queue = this.queue.filter((q) => q !== id);
    this.cancelled.add(id);
    if (this.running?.id === id) this.running.controller.abort();
    const gone: Status = { ...status, state: 'cancelled', updatedAt: new Date().toISOString() };
    for (const fn of this.listeners.get(id) ?? []) fn(gone);
    await fs.rm(walkDir(id), { recursive: true, force: true });
    return true;
  }

  /** On start: walks that were queued or running when the process stopped carry on. */
  async resumeAll(): Promise<string[]> {
    const pending: { id: string; createdAt: string }[] = [];
    for (const id of await listWalkIds()) {
      const status = await readJson<Status>(walkDir(id), 'status.json');
      const record = await readJson<WalkRecord>(walkDir(id), 'walk.json');
      if (!record || !status || (status.state !== 'queued' && status.state !== 'running')) continue;
      if (await lockedByOther(id)) continue;
      pending.push({ id, createdAt: record.createdAt });
    }
    pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const p of pending) this.enqueue(p.id);
    return pending.map((p) => p.id);
  }

  isBusy(): boolean {
    return this.running !== null || this.queue.length > 0;
  }

  private enqueue(id: string): void {
    if (!this.queue.includes(id) && this.running?.id !== id) this.queue.push(id);
    void this.next();
  }

  /** Disk first, then listeners, so whoever hears "done" can read the files. */
  private async save(id: string, status: Status, meta?: Meta): Promise<void> {
    if (this.cancelled.has(id)) return;
    if (this.running?.id === id) this.running.status = status;
    try {
      await writeJson(walkDir(id), 'status.json', status);
    } catch {
      // The folder was removed by a cancel; nothing left to record.
    }
    for (const fn of this.listeners.get(id) ?? []) fn(status, meta);
  }

  private async next(): Promise<void> {
    if (this.running || !this.queue.length) return;
    // The slot is claimed before the first await, so two walks never run at once.
    const id = this.queue.shift()!;
    const controller = new AbortController();
    const slot: { id: string; controller: AbortController; status: Status | null } = { id, controller, status: null };
    this.running = slot;
    let current: StageName = 'read';
    let writes = Promise.resolve();
    let status: Status = freshStatus();
    try {
      const record = await this.record(id);
      if (!record || !(await takeLock(id))) return;
      status = { ...((await readJson<Status>(walkDir(id), 'status.json')) ?? status), state: 'running', error: undefined };
      await this.save(id, status);
      const meta = await this.runner(
        id,
        walkDir(id),
        record.request,
        record.createdAt,
        (p) => {
          if (controller.signal.aborted) return;
          current = p.stage;
          status = applyProgress(status, p);
          const snapshot = status;
          writes = writes.then(() => this.save(id, snapshot));
        },
        controller.signal,
      );
      await writes;
      await dropLock(id);
      // The slot is free before anyone hears "done" or "failed", so a retry is accepted at once.
      if (this.running === slot) this.running = null;
      const stages = Object.fromEntries(STAGES.map((s) => [s, { ...status.stages[s], state: 'done' }])) as Status['stages'];
      await this.save(id, { ...status, state: 'done', stages, updatedAt: new Date().toISOString() }, meta);
    } catch (err) {
      await writes.catch(() => undefined);
      await dropLock(id).catch(() => undefined);
      if (this.running === slot) this.running = null;
      if (!controller.signal.aborted) {
        await this.save(id, { ...status, state: 'failed', error: friendlyError(err, current), updatedAt: new Date().toISOString() }).catch(() => undefined);
      }
    } finally {
      await dropLock(id).catch(() => undefined);
      this.cancelled.delete(id);
      if (this.running === slot) this.running = null;
      void this.next();
    }
  }
}
