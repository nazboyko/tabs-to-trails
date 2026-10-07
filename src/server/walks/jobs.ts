import fs from 'node:fs/promises';
import { ModelMissing, OllamaUnreachable, PromptTooLarge } from '../ollama.js';
import { runPipeline, type BuildRequest, type Meta, type Progress, type StageName } from '../pipeline.js';
import { SourceError } from '../source/types.js';
import { listWalkIds, newId, newToken, readJson, walkDir, writeJson } from './store.js';

export type JobState = 'queued' | 'running' | 'done' | 'failed';

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
  private running: { id: string; controller: AbortController } | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private statuses = new Map<string, Status>();

  constructor(private readonly runner: typeof runPipeline = runPipeline) {}

  async create(request: BuildRequest): Promise<WalkRecord> {
    const record: WalkRecord = { id: newId(), token: newToken(), createdAt: new Date().toISOString(), request };
    const dir = walkDir(record.id);
    await fs.mkdir(dir, { recursive: true });
    await writeJson(dir, 'walk.json', record);
    await this.save(record.id, freshStatus());
    this.enqueue(record.id);
    return record;
  }

  async record(id: string): Promise<WalkRecord | null> {
    return readJson<WalkRecord>(walkDir(id), 'walk.json');
  }

  async status(id: string): Promise<Status | null> {
    return this.statuses.get(id) ?? (await readJson<Status>(walkDir(id), 'status.json'));
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
    const status = await this.status(id);
    if (!status || status.state !== 'failed') return false;
    await this.save(id, { ...status, state: 'queued', error: undefined, updatedAt: new Date().toISOString() });
    this.enqueue(id);
    return true;
  }

  /** Stops a queued or running walk and removes its folder. */
  async cancel(id: string): Promise<boolean> {
    const status = await this.status(id);
    if (!status || status.state === 'done') return false;
    this.queue = this.queue.filter((q) => q !== id);
    if (this.running?.id === id) this.running.controller.abort();
    this.statuses.delete(id);
    await fs.rm(walkDir(id), { recursive: true, force: true });
    return true;
  }

  /** On start: walks that were queued or running when the process stopped carry on. */
  async resumeAll(): Promise<string[]> {
    const pending: { id: string; createdAt: string }[] = [];
    for (const id of await listWalkIds()) {
      const status = await readJson<Status>(walkDir(id), 'status.json');
      const record = await readJson<WalkRecord>(walkDir(id), 'walk.json');
      if (record && status && (status.state === 'queued' || status.state === 'running')) pending.push({ id, createdAt: record.createdAt });
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
    this.statuses.set(id, status);
    try {
      await writeJson(walkDir(id), 'status.json', status);
    } catch {
      // The folder was removed by a cancel; nothing left to record.
    }
    for (const fn of this.listeners.get(id) ?? []) fn(status, meta);
  }

  private async next(): Promise<void> {
    if (this.running || !this.queue.length) return;
    const id = this.queue.shift()!;
    const record = await this.record(id);
    if (!record) return void this.next();
    const controller = new AbortController();
    this.running = { id, controller };
    let status = (await this.status(id)) ?? freshStatus();
    status = { ...status, state: 'running', error: undefined };
    await this.save(id, status);
    let current: StageName = 'read';
    let writes = Promise.resolve();
    try {
      const meta = await this.runner(
        id,
        walkDir(id),
        record.request,
        record.createdAt,
        (p) => {
          current = p.stage;
          status = applyProgress(status, p);
          const snapshot = status;
          writes = writes.then(() => this.save(id, snapshot));
        },
        controller.signal,
      );
      await writes;
      const stages = Object.fromEntries(STAGES.map((s) => [s, { ...status.stages[s], state: 'done' }])) as Status['stages'];
      await this.save(id, { ...status, state: 'done', stages, updatedAt: new Date().toISOString() }, meta);
    } catch (err) {
      await writes;
      if (!controller.signal.aborted) {
        await this.save(id, { ...status, state: 'failed', error: friendlyError(err, current), updatedAt: new Date().toISOString() });
      }
    } finally {
      this.running = null;
      void this.next();
    }
  }
}
