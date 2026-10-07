/**
 * Builds the GitHub Pages site in docs/ from scripts/landing.html and the
 * walks in samples/. The output is committed; nothing is built in CI.
 * Usage: npm run docs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Meta } from '../src/server/pipeline.js';

const REPO = 'https://github.com/nazboyko/tabs-to-trails';
const ORDER = ['dev-post', 'thoreau-walking'];
const FONTS: [string, string][] = [
  ['figtree', 'figtree-latin-400-normal.woff2'],
  ['figtree', 'figtree-latin-600-normal.woff2'],
  ['figtree', 'figtree-latin-700-normal.woff2'],
  ['newsreader', 'newsreader-latin-400-normal.woff2'],
  ['newsreader', 'newsreader-latin-500-normal.woff2'],
  ['newsreader', 'newsreader-latin-400-italic.woff2'],
  ['jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff2'],
  ['jetbrains-mono', 'jetbrains-mono-latin-500-normal.woff2'],
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function clock(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** script.txt as HTML: the app's own lines on a soft orange, each section with its time. */
export function scriptHtml(script: string): string {
  const blocks = script.trim().split(/\n\s*\n/).slice(1);
  return blocks
    .map((block) => {
      const [first = '', ...rest] = block.split('\n');
      const timed = first.match(/^\[(\d+:\d\d)\] (.*)$/);
      const head = timed ? timed[2]! : first;
      const time = timed ? `${timed[1]} · ` : '';
      if (head.startsWith('The app')) {
        const colon = head.indexOf(': ');
        const label = head.slice(0, colon);
        return `<p class="app"><span class="t">${esc(time + label)}</span>${esc(head.slice(colon + 2))}</p>`;
      }
      return `<p><span class="t">${esc(time + head)}</span>${esc(rest.join(' '))}</p>`;
    })
    .join('\n');
}

function card(meta: Omit<Meta, 'id'>, script: string): string {
  const asked = meta.targetSeconds ? `asked for ${clock(meta.targetSeconds)}` : 'read in full';
  return `    <article class="sample">
      <div>
        <h3>${esc(meta.title)}</h3>
        <p class="meta">${clock(meta.actualSeconds)} measured · ${asked} · read by ${esc(meta.voiceName)}</p>
      </div>
      <audio controls preload="none" src="samples/${esc(meta.fileName)}" aria-label="${esc(meta.title)}, ${clock(meta.actualSeconds)}"></audio>
      <p class="small">${meta.sourceWords.toLocaleString('en-US')} words in the source, ${meta.scriptWords.toLocaleString('en-US')} in the script. Halfway cue at ${meta.halfwaySeconds === null ? 'none' : clock(meta.halfwaySeconds)}. <a href="samples/${esc(meta.fileName)}" download>Download the MP3</a></p>
      <details>
        <summary>Read the script</summary>
        <div class="script">
${scriptHtml(script)}
        </div>
      </details>
    </article>`;
}

async function main() {
  await fs.mkdir('docs/samples', { recursive: true });
  await fs.mkdir('docs/fonts', { recursive: true });
  const cards: string[] = [];
  for (const name of ORDER) {
    const dir = path.join('samples', name);
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')) as Omit<Meta, 'id'>;
    const script = await fs.readFile(path.join(dir, 'script.txt'), 'utf8');
    await fs.copyFile(path.join(dir, meta.fileName), path.join('docs/samples', meta.fileName));
    cards.push(card(meta, script));
  }
  for (const [pkg, file] of FONTS) {
    await fs.copyFile(path.join('node_modules/@fontsource', pkg, 'files', file), path.join('docs/fonts', file));
  }
  await fs.copyFile('src/web/public/favicon.svg', 'docs/favicon.svg');
  await fs.writeFile('docs/.nojekyll', '');
  const template = await fs.readFile('scripts/landing.html', 'utf8');
  await fs.writeFile('docs/index.html', template.replaceAll('{{repo}}', REPO).replace('{{samples}}', cards.join('\n')));
  console.log(`docs/index.html with ${cards.length} samples`);
}

await main();
