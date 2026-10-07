import { loadConfig } from './config.js';

export class OllamaUnreachable extends Error {
  constructor(url: string) {
    super(`Ollama is not reachable at ${url}. Start it with: ollama serve`);
  }
}

export class ModelMissing extends Error {
  constructor(model: string) {
    super(`The model ${model} is not downloaded. Run: ollama pull ${model}`);
  }
}

export class PromptTooLarge extends Error {}

export interface ChatRequest {
  system: string;
  user: string;
  temperature?: number;
  /** Upper bound on generated tokens. */
  maxTokens?: number;
  /** JSON schema for a structured reply. */
  format?: object;
  signal?: AbortSignal;
}

export interface ChatReply {
  text: string;
  promptTokens: number;
  outputTokens: number;
  seconds: number;
}

/** Rough token estimate, on the high side for English prose and code. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export async function chat(req: ChatRequest): Promise<ChatReply> {
  const cfg = loadConfig();
  const maxTokens = req.maxTokens ?? 1024;
  const estimate = estimateTokens(req.system) + estimateTokens(req.user) + 32;
  if (estimate + maxTokens > cfg.OLLAMA_NUM_CTX) {
    throw new PromptTooLarge(
      `A request of about ${estimate} tokens plus ${maxTokens} for the reply does not fit num_ctx ${cfg.OLLAMA_NUM_CTX}`,
    );
  }
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${cfg.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: req.signal,
      body: JSON.stringify({
        model: cfg.OLLAMA_MODEL,
        stream: false,
        think: false,
        keep_alive: '30m',
        format: req.format,
        options: {
          temperature: req.temperature ?? 0.2,
          num_ctx: cfg.OLLAMA_NUM_CTX,
          num_predict: maxTokens,
        },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
    });
  } catch (err) {
    if (req.signal?.aborted) throw err;
    throw new OllamaUnreachable(cfg.OLLAMA_URL);
  }
  if (res.status === 404) throw new ModelMissing(cfg.OLLAMA_MODEL);
  if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  const promptTokens = body.prompt_eval_count ?? 0;
  if (promptTokens >= cfg.OLLAMA_NUM_CTX - maxTokens) {
    throw new PromptTooLarge(`Ollama read ${promptTokens} prompt tokens, too close to num_ctx ${cfg.OLLAMA_NUM_CTX}`);
  }
  return {
    text: (body.message?.content ?? '').trim(),
    promptTokens,
    outputTokens: body.eval_count ?? 0,
    seconds: (Date.now() - started) / 1000,
  };
}

export type OllamaState = 'unreachable' | 'model-missing' | 'ready';

export async function ollamaState(): Promise<OllamaState> {
  const cfg = loadConfig();
  let res: Response;
  try {
    res = await fetch(`${cfg.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
  } catch {
    return 'unreachable';
  }
  if (!res.ok) return 'unreachable';
  const body = (await res.json()) as { models?: { name: string; model?: string }[] };
  const wanted = cfg.OLLAMA_MODEL.includes(':') ? cfg.OLLAMA_MODEL : `${cfg.OLLAMA_MODEL}:latest`;
  const found = (body.models ?? []).some((m) => m.name === wanted || m.model === wanted);
  return found ? 'ready' : 'model-missing';
}
