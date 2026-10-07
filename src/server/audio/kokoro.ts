import fs from 'node:fs';
import path from 'node:path';
import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { phonemize } from 'phonemizer';
import { splitSentences } from '../source/sections.js';
import { loadConfig, type VoiceKey } from '../config.js';
import { chunkText } from './speakable.js';
import { concatAudio, SAMPLE_RATE, silence } from './wav.js';

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const DTYPE = 'fp32';

export const VOICES: Record<VoiceKey, { id: 'af_heart' | 'am_michael' | 'bf_emma' | 'bm_george'; name: string; accent: string }> = {
  heart: { id: 'af_heart', name: 'Heart', accent: 'American' },
  michael: { id: 'am_michael', name: 'Michael', accent: 'American' },
  emma: { id: 'bf_emma', name: 'Emma', accent: 'British' },
  george: { id: 'bm_george', name: 'George', accent: 'British' },
};

/**
 * Kokoro reads at most 510 phoneme tokens per call and silently drops the
 * rest. Numbers expand a lot ("$1,234,567" is dozens of phonemes), so every
 * chunk is measured and split until it fits with a margin.
 */
export const MAX_PHONEMES = 440;

async function phonemeLength(text: string): Promise<number> {
  return (await phonemize(text, 'en-us')).join(' ').length;
}

function halves(text: string): [string, string] {
  const sentences = splitSentences(text);
  if (sentences.length > 1) {
    const mid = Math.ceil(sentences.length / 2);
    return [sentences.slice(0, mid).join(' '), sentences.slice(mid).join(' ')];
  }
  const clauses = text.split(/(?<=[,;:])\s+/);
  if (clauses.length > 1) {
    const mid = Math.ceil(clauses.length / 2);
    return [clauses.slice(0, mid).join(' '), clauses.slice(mid).join(' ')];
  }
  const words = text.split(/\s+/);
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

/** Pieces of `text` that each fit Kokoro's phoneme limit. */
export async function fitPhonemes(text: string, measure = phonemeLength, depth = 0): Promise<string[]> {
  if (depth > 8 || text.split(/\s+/).length < 2 || (await measure(text)) <= MAX_PHONEMES) return [text];
  const [a, b] = halves(text);
  return [...(await fitPhonemes(a, measure, depth + 1)), ...(await fitPhonemes(b, measure, depth + 1))];
}

/** Pauses between sentence groups and between paragraphs, in seconds. */
export const CHUNK_GAP = 0.2;
/** Pause where one chunk had to be split to fit the phoneme limit. */
export const PIECE_GAP = 0.1;
export const PARAGRAPH_GAP = 0.45;

let loading: Promise<KokoroTTS> | null = null;

export function loadVoiceModel(): Promise<KokoroTTS> {
  if (!loading) {
    env.cacheDir = loadConfig().modelsDir;
    loading = KokoroTTS.from_pretrained(MODEL_ID, { dtype: DTYPE, device: 'cpu' }).catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** Frees the ONNX session so a short-lived process (the terminal command) can exit cleanly. */
export async function disposeVoiceModel(): Promise<void> {
  if (!loading) return;
  const tts = await loading.catch(() => null);
  loading = null;
  await tts?.model.dispose().catch(() => undefined);
}

export function voiceModelLoaded(): boolean {
  return loading !== null;
}

/** True once the weights are in the local cache, so no download is needed. */
export function voiceModelCached(): boolean {
  return fs.existsSync(path.join(loadConfig().modelsDir, ...MODEL_ID.split('/'), 'onnx', DTYPE === 'fp32' ? 'model.onnx' : `model_${DTYPE}.onnx`));
}

let queue: Promise<unknown> = Promise.resolve();

/** One voice call at a time: a preview and a running build share the model. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function speakChunk(tts: KokoroTTS, text: string, voice: VoiceKey): Promise<Float32Array> {
  return exclusive(() => speakOnce(tts, text, voice));
}

async function speakOnce(tts: KokoroTTS, text: string, voice: VoiceKey): Promise<Float32Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await tts.generate(text, { voice: VOICES[voice].id });
      if (out.sampling_rate !== SAMPLE_RATE) throw new Error(`Unexpected sample rate ${out.sampling_rate}`);
      return out.audio;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export interface Voiced {
  samples: Float32Array;
  /** Sample offsets where one sentence group ends and the next begins. */
  boundaries: number[];
  chunks: number;
}

/** Voices text in sentence groups with short pauses between them. */
export async function voiceText(text: string, voice: VoiceKey, signal?: AbortSignal): Promise<Voiced> {
  const tts = await loadVoiceModel();
  const parts: Float32Array[] = [];
  const boundaries: number[] = [];
  const chunks = chunkText(text);
  let length = 0;
  for (let i = 0; i < chunks.length; i++) {
    signal?.throwIfAborted();
    const chunk = chunks[i]!;
    const pieces = await fitPhonemes(chunk.text);
    for (let p = 0; p < pieces.length; p++) {
      if (p > 0) {
        const pause = silence(PIECE_GAP);
        parts.push(pause);
        length += pause.length;
      }
      const audio = await speakChunk(tts, pieces[p]!, voice);
      parts.push(audio);
      length += audio.length;
    }
    if (i < chunks.length - 1) {
      const gap = silence(chunk.paragraphEnd ? PARAGRAPH_GAP : CHUNK_GAP);
      parts.push(gap);
      length += gap.length;
      boundaries.push(length);
    }
  }
  return { samples: concatAudio(parts), boundaries, chunks: chunks.length };
}
