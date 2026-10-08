export type StageName = 'read' | 'plan' | 'rewrite' | 'voice' | 'pack';
export type VoiceKey = 'heart' | 'michael' | 'emma' | 'george';
export type Coverage = 'Full' | 'Condensed' | 'Brief';

export interface StageStatus {
  state: 'waiting' | 'active' | 'done';
  done?: number;
  total?: number;
  detail?: string;
}

export interface Status {
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  stages: Record<StageName, StageStatus>;
  error?: { message: string; stage: StageName; audioOnly: boolean; suggestPaste: boolean };
}

export interface Health {
  ready: boolean;
  ollama: 'unreachable' | 'model-missing' | 'ready';
  model: string;
  voice: 'ready' | 'download';
  ffmpeg: boolean;
}

export interface Voice {
  key: VoiceKey;
  name: string;
  accent: string;
}

export interface WalkSummary {
  id: string;
  title: string;
  actualSeconds: number;
  targetSeconds: number | null;
  createdAt: string;
}

export interface WalkList {
  walks: WalkSummary[];
  active: { id: string; title: string | null } | null;
  total: number;
  lan: boolean;
}

export interface Meta {
  title: string;
  mode: 'full' | 'condensed';
  targetSeconds: number | null;
  actualSeconds: number;
  halfwaySeconds: number | null;
  fullSeconds: number;
  sourceWords: number;
  scriptWords: number;
  sections: number;
  coverage: { full: number; condensed: number; brief: number };
  checkNumbers: number;
  voice: string;
  voiceName: string;
  model: string;
  rewriteSeconds: number;
  voiceSeconds: number;
  packSeconds: number;
  fileName: string;
  bytes: number;
  createdAt: string;
  finishedAt: string;
  source: { kind: string; url?: string; byline?: string };
  threeQuarterSeconds?: number | null;
}

export interface Piece {
  title: string;
  kind: string;
  url?: string;
  start: number;
  seconds: number;
}

export interface Skipped {
  label: string;
  reason: string;
}

export interface ScriptSection {
  id: string;
  label: string;
  piece: number;
  coverage: Coverage;
  adapted: ('code' | 'table')[];
  checkNumbers: string[];
  note: string | null;
  text: string;
  words: number;
  sourceWords: number;
  start: number;
  seconds: number;
}

export interface AppLine {
  text: string;
  start: number | null;
}

export interface Segment {
  kind: 'app' | 'source';
  label: string;
  sectionId?: string;
  piece?: number;
  role?: 'intro' | 'halfway' | 'threequarter' | 'bridge' | 'question' | 'outro';
  start: number;
  end: number;
}

export type WalkDetail =
  | {
      id: string;
      ready: false;
      status: Status | null;
      title: string | null;
      request: { minutes: number | null; voice: VoiceKey; url: string | null } | null;
    }
  | {
      id: string;
      ready: true;
      status: Status | null;
      title: string;
      meta: Meta;
      plan: { mode: 'full' | 'condensed'; targetSeconds: number | null; fullSeconds: number; tooLong: boolean };
      sections: ScriptSection[];
      app: {
        intro: AppLine;
        halfway: AppLine | null;
        threeQuarter: AppLine | null;
        bridges: { piece: number; text: string; start: number }[];
        question: AppLine | null;
        outro: AppLine;
      };
      segments: Segment[];
      leftOut: string[];
      pieces: Piece[];
      skipped: Skipped[];
      share: { url: string; qr: string } | null;
    };

export interface ListItem {
  id: string;
  kind: 'link' | 'text' | 'file';
  title: string;
  label: string;
  url?: string;
  words: number;
  minutes: number;
  status: 'checking' | 'ready' | 'unreadable' | 'in_walk';
  reason?: string;
  savedAt: string;
  seriesId?: string;
  part?: number;
  parts?: number;
}

export type SourcePayload =
  | { kind: 'url'; url: string }
  | { kind: 'text'; text: string; title?: string }
  | { kind: 'file'; name: string; text: string };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('The app on this computer is not answering. Is it still running?', 0, {});
  }
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(String((body as { error?: string }).error ?? `Request failed (${res.status})`), res.status, body as Record<string, unknown>);
  return body as T;
}

export const api = {
  health: () => call<Health>('/api/health'),
  voices: () => call<Voice[]>('/api/voices'),
  walks: () => call<WalkList>('/api/walks'),
  walk: (id: string) => call<WalkDetail>(`/api/walks/${id}`),
  // One source goes as `source`, as it always has; several make a playlist walk.
  build: (sources: SourcePayload[], minutes: number | null, voice: VoiceKey) =>
    call<{ id: string }>('/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sources.length === 1 ? { source: sources[0], minutes, voice } : { sources, minutes, voice }),
    }),
  list: () => call<{ items: ListItem[] }>('/api/list'),
  save: (sources: SourcePayload[]) =>
    call<{ added: ListItem[]; existing: ListItem[] }>('/api/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources }),
    }),
  pasteInto: (id: string, text: string, title?: string) =>
    call<ListItem>(`/api/list/${id}/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, title }),
    }),
  removeItem: (id: string) => call<unknown>(`/api/list/${id}`, { method: 'DELETE' }),
  reorder: (ids: string[]) =>
    call<unknown>('/api/list/order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }),
  /** A walk from list items, in the order given. */
  buildItems: (items: string[], minutes: number | null, voice: VoiceKey) =>
    call<{ id: string }>('/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, minutes, voice }),
    }),
  retry: (id: string) => call<{ id: string }>(`/api/build/${id}/retry`, { method: 'POST' }),
  cancel: (id: string) => call<unknown>(`/api/build/${id}`, { method: 'DELETE' }),
};

/** Live job status over server-sent events. Returns a function that stops listening. */
export function watchBuild(id: string, onStatus: (status: Status) => void, onLost: () => void): () => void {
  const source = new EventSource(`/api/build/${id}/events`);
  let finished = false;
  source.addEventListener('status', (e) => {
    const { status } = JSON.parse((e as MessageEvent<string>).data) as { status: Status };
    if (status.state === 'done' || status.state === 'failed' || status.state === 'cancelled') {
      finished = true;
      source.close();
    }
    onStatus(status);
  });
  source.onerror = () => {
    if (finished) return;
    if (source.readyState === EventSource.CLOSED) onLost();
  };
  return () => {
    finished = true;
    source.close();
  };
}
