/**
 * Copies a finished walk into samples/<name>/: the MP3, the script, the
 * read-along timings and the run metrics.
 * Usage: npx tsx scripts/save-sample.ts <walk-id> <name>
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { walkTimings } from '../src/server/routes/walk.js';
import { walkDir } from '../src/server/walks/store.js';
import type { Meta } from '../src/server/pipeline.js';

const [id, name] = process.argv.slice(2);
if (!id || !name || !/^[a-z0-9-]+$/.test(name)) {
  console.error('Usage: npx tsx scripts/save-sample.ts <walk-id> <name>');
  process.exit(1);
}
const from = walkDir(id);
const to = path.join('samples', name);
const meta = JSON.parse(await fs.readFile(path.join(from, 'meta.json'), 'utf8')) as Meta;
await fs.mkdir(to, { recursive: true });
await fs.copyFile(path.join(from, 'final.mp3'), path.join(to, meta.fileName));
await fs.copyFile(path.join(from, 'script.txt'), path.join(to, 'script.txt'));
const timings = await walkTimings(id);
if (timings) await fs.writeFile(path.join(to, 'timings.json'), JSON.stringify(timings) + '\n');
const { id: _id, ...kept } = meta;
await fs.writeFile(path.join(to, 'meta.json'), JSON.stringify(kept, null, 2) + '\n');
console.log(`samples/${name}/${meta.fileName}`);
