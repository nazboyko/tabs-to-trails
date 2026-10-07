import { Hono } from 'hono';
import { loadConfig } from '../config.js';
import { ffmpegReady } from '../audio/assemble.js';
import { voiceModelCached } from '../audio/kokoro.js';
import { ollamaState, type OllamaState } from '../ollama.js';

export interface Health {
  ready: boolean;
  ollama: OllamaState;
  model: string;
  /** "download" means the voice downloads on the first walk (about 330 MB). */
  voice: 'ready' | 'download';
  ffmpeg: boolean;
}

let ffmpegOk: boolean | null = null;

export async function health(): Promise<Health> {
  const [ollama, ffmpeg] = await Promise.all([ollamaState(), ffmpegOk ?? ffmpegReady()]);
  if (ffmpeg) ffmpegOk = true;
  return {
    ready: ollama === 'ready' && ffmpeg,
    ollama,
    model: loadConfig().OLLAMA_MODEL,
    voice: voiceModelCached() ? 'ready' : 'download',
    ffmpeg,
  };
}

export const healthRoutes = new Hono().get('/', async (c) => c.json(await health()));
