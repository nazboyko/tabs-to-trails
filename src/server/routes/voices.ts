import fs from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { loadConfig, VOICE_KEYS, type VoiceKey } from '../config.js';
import { VOICES, voiceText } from '../audio/kokoro.js';
import { encodeWav } from '../audio/wav.js';
import { exists, writeFileAtomic } from '../walks/store.js';

export function previewText(name: string): string {
  return `Hi, I'm ${name}. Give me something you keep meaning to read, and I'll read it to you on your walk. I'll tell you when you're halfway, so you know when to turn around.`;
}

const making = new Map<VoiceKey, Promise<string>>();

async function previewFile(key: VoiceKey): Promise<string> {
  const dir = path.join(loadConfig().WALKS_DIR, '.previews');
  const file = path.join(dir, `${VOICES[key].id}.wav`);
  if (await exists(file)) return file;
  let job = making.get(key);
  if (!job) {
    job = (async () => {
      const voiced = await voiceText(previewText(VOICES[key].name), key);
      await fs.mkdir(dir, { recursive: true });
      await writeFileAtomic(file, encodeWav(voiced.samples));
      return file;
    })().finally(() => making.delete(key));
    making.set(key, job);
  }
  return job;
}

export const voiceRoutes = new Hono()
  .get('/', (c) => c.json(VOICE_KEYS.map((key) => ({ key, name: VOICES[key].name, accent: VOICES[key].accent }))))
  .get('/:key/preview', async (c) => {
    const key = c.req.param('key') as VoiceKey;
    if (!VOICE_KEYS.includes(key)) return c.json({ error: 'There is no voice with that name.' }, 404);
    try {
      const body = await fs.readFile(await previewFile(key));
      return c.body(body, 200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-cache' });
    } catch {
      return c.json({ error: "The voice couldn't start. Check the setup screen, then try again." }, 503);
    }
  });
