import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, VOICE_KEYS, type VoiceKey } from './server/config.js';
import { clock } from './server/audio/timeline.js';
import type { BuildRequest, Meta } from './server/pipeline.js';
import type { SourceInput } from './server/source/index.js';
import { MAX_PIECES } from './server/source/pieces.js';
import { disposeVoiceModel } from './server/audio/kokoro.js';
import { Jobs } from './server/walks/jobs.js';
import { walkDir } from './server/walks/store.js';

const USAGE = `Usage: npm run walk -- <url-or-file> [more, up to ${MAX_PIECES}] [--minutes 10|20|30|45|60|whole] [--quiet 0|1|2|3] [--voice ${VOICE_KEYS.join('|')}]`;

function parseArgs(argv: string[]): BuildRequest {
  const targets: string[] = [];
  let minutes: number | null = 20;
  let voice: VoiceKey = loadConfig().VOICE;
  let quietMinutes = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--minutes') {
      const v = argv[++i];
      if (v === 'whole') minutes = null;
      else if (v && /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 120) minutes = Number(v);
      else throw new Error(USAGE);
    } else if (a === '--quiet') {
      const v = argv[++i];
      if (!v || !/^[0-3]$/.test(v)) throw new Error(USAGE);
      quietMinutes = Number(v);
    } else if (a === '--voice') {
      const v = argv[++i] as VoiceKey | undefined;
      if (!v || !VOICE_KEYS.includes(v)) throw new Error(USAGE);
      voice = v;
    } else if (!a.startsWith('--') && targets.length < MAX_PIECES) {
      targets.push(a);
    } else {
      throw new Error(USAGE);
    }
  }
  if (!targets.length) throw new Error(USAGE);
  const sources: SourceInput[] = targets.map((target) =>
    fs.existsSync(target) ? { kind: 'file', name: path.basename(target), text: fs.readFileSync(target, 'utf8') } : { kind: 'url', url: target },
  );
  // Several sources make one playlist walk, read in the order given.
  return sources.length === 1 ? { source: sources[0]!, minutes, voice, quietMinutes } : { sources, minutes, voice, quietMinutes };
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
  for (const p of meta.pieces && meta.pieces.length > 1 ? meta.pieces : []) console.log(`  ${clock(p.seconds)}  ${p.title}`);
  for (const s of meta.skipped ?? []) console.log(`  skipped ${s.label}: ${s.reason}`);
  if (meta.threeQuarterSeconds) console.log(`  three-quarter cue at ${clock(meta.threeQuarterSeconds)}`);
  console.log(`  rewrite ${meta.rewriteSeconds}s, voice ${meta.voiceSeconds}s, total ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`  ${rel}/final.mp3 (${(meta.bytes / 1e6).toFixed(1)} MB)  ${rel}/script.txt`);
  await disposeVoiceModel();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await disposeVoiceModel();
  process.exit(1);
});
