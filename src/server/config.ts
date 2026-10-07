import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const VOICE_KEYS = ['heart', 'michael', 'emma', 'george'] as const;
export type VoiceKey = (typeof VOICE_KEYS)[number];

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().min(1).default('gemma4:e4b'),
  OLLAMA_NUM_CTX: z.coerce.number().int().min(4096).default(16384),
  VOICE: z.enum(VOICE_KEYS).default('heart'),
  WALKS_DIR: z.string().min(1).default('walks'),
  /** Host name or address the QR code uses instead of the detected network address. */
  SHARE_HOST: z
    .string()
    .regex(/^[A-Za-z0-9.-]{1,253}$/)
    .optional(),
});

export type Config = z.infer<typeof schema> & { modelsDir: string };

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid settings in the environment or .env: ${issues}`);
  }
  cached = {
    ...parsed.data,
    WALKS_DIR: path.resolve(parsed.data.WALKS_DIR),
    modelsDir: path.join(os.homedir(), '.cache', 'tabs-to-trails', 'models'),
  };
  return cached;
}
