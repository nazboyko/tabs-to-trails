import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, VOICE_KEYS, type VoiceKey } from './server/config.js';
import { clock } from './server/audio/timeline.js';
import type { BuildRequest, Meta } from './server/pipeline.js';
import type { SourceInput } from './server/source/index.js';
import { disposeVoiceModel } from './server/audio/kokoro.js';
import { Jobs } from './server/walks/jobs.js';
import { walkDir } from './server/walks/store.js';

const USAGE = `Usage: npm run walk -- <url-or-file> [--minutes 10|20|30|whole] [--voice ${VOICE_KEYS.join('|')}]`;

function parseArgs(argv: string[]): BuildRequest {
  let target: string | undefined;
  let minutes: number | null = 20;
  let voice: VoiceKey = loadConfig().VOICE;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--minutes') {
      const v = argv[++i];
      if (v === 'whole') minutes = null;
      else if (v && /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 120) minutes = Number(v);
      else throw new Error(USAGE);
    } else if (a === '--voice') {
      const v = argv[++i] as VoiceKey | undefined;
      if (!v || !VOICE_KEYS.includes(v)) throw new Error(USAGE);
      voice = v;
    } else if (!a.startsWith('--') && !target) {
      target = a;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!target) throw new Error(USAGE);
  const source: SourceInput = fs.existsSync(target)
    ? { kind: 'file', name: path.basename(target), text: fs.readFileSync(target, 'utf8') }
    : { kind: 'url', url: target };
  return { source, minutes, voice };
}

async function main() {
  const req = parseArgs(process.argv.slice(2));
  const jobs = new Jobs();
  const started = Date.now();
  const record = await jobs.create(req);
  let last = '';
  const meta = await new Promise<Meta>((resolve, reject) => {
    jobs.subscribe(record.id, (status, done) => {
      for (const [name, stage] of Object.entries(status.stages)) {
        if (stage.state !== 'active') continue;
        const line = `${name}${stage.total ? ` ${stage.done ?? 0}/${stage.total}` : ''}${stage.detail ? `: ${stage.detail}` : ''}`;
        if (line !== last) console.log(line);
        last = line;
      }
      if (status.state === 'done' && done) resolve(done);
      if (status.state === 'failed') reject(new Error(status.error?.message ?? 'The walk failed.'));
    });
  });
  const rel = path.relative(process.cwd(), walkDir(record.id));
  console.log('');
  console.log(`${meta.title}`);
  console.log(`  ${clock(meta.actualSeconds)} measured${meta.targetSeconds ? `, asked for ${clock(meta.targetSeconds)}` : ''}; halfway cue at ${meta.halfwaySeconds === null ? 'none' : clock(meta.halfwaySeconds)}`);
  console.log(`  ${meta.sourceWords} source words -> ${meta.scriptWords} script words, ${meta.mode} mode`);
  console.log(`  rewrite ${meta.rewriteSeconds}s, voice ${meta.voiceSeconds}s, total ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`  ${rel}/final.mp3  ${rel}/script.txt`);
  await disposeVoiceModel();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await disposeVoiceModel();
  process.exit(1);
});
