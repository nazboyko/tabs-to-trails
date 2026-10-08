/**
 * The walk list on disk: WALKS_DIR/list/<id>/item.json and source.md, and
 * list/order.json. Links are checked in the background, at most three at a
 * time, with the same adapters and limits a build uses and no model.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type VoiceKey } from '../config.js';
import { effectiveWpm, storedCalibration } from '../audio/calibrate.js';
import { charsPerWord, walkSource } from '../pipeline.js';
import { readSource, type SavedInput, type SourceInput } from '../source/index.js';
import { pieceSections, readPieces, sourceLabel, type Piece } from '../source/pieces.js';
import { SourceError, type SourceDoc } from '../source/types.js';
import { isWalkId, newId, readJson, writeFileAtomic, writeJson } from '../walks/store.js';
import { checked, DEFAULT_WPM, linkKey, MAX_CHECKS, minutesAt, ordered, reorder, rowPace, unreadable, type ListItem } from './items.js';
import { previewFrom, SERIES_FACTOR, seriesFor, type WalkPreview } from './preview.js';
import { partMarkdown } from './series.js';
import { estimateMinutes as minutesOf } from './items.js';

export type ReadFn = (input: SourceInput, signal?: AbortSignal) => Promise<SourceDoc>;

/** The pace minutes are estimated with: the voice's measured pace, or a plain default before it was ever measured. */
export async function listWpm(voice: VoiceKey, sectionsCharsPerWord: number): Promise<number> {
  return (await paceOf(voice))(sectionsCharsPerWord);
}

/** One voice's pace as a function of characters per word, read once. */
export async function paceOf(voice: VoiceKey): Promise<(charsPerWord: number) => number> {
  const cal = await storedCalibration(voice).catch(() => null);
  return (cpw) => (cal ? effectiveWpm(cal, cpw) : DEFAULT_WPM);
}

export class WalkList {
  private writes: Promise<unknown> = Promise.resolve();
  private queue: string[] = [];
  private running = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(
    readonly root = path.join(loadConfig().WALKS_DIR, 'list'),
    private readonly read: ReadFn = readSource,
    private readonly wpm: (cpw: number) => Promise<number> = (cpw) => listWpm(loadConfig().VOICE, cpw),
  ) {}

  /** Runs one change to the order file at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writes.then(fn, fn);
    this.writes = run.catch(() => undefined);
    return run;
  }

  private dir(id: string): string {
    if (!isWalkId(id)) throw new Error('Bad item id');
    return path.join(this.root, id);
  }

  private async order(): Promise<string[]> {
    return (await readJson<string[]>(this.root, 'order.json')) ?? [];
  }

  private async writeOrder(order: string[]): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await writeJson(this.root, 'order.json', order);
  }

  async get(id: string): Promise<ListItem | null> {
    if (!isWalkId(id)) return null;
    return readJson<ListItem>(this.dir(id), 'item.json');
  }

  private async put(item: ListItem): Promise<void> {
    await fs.mkdir(this.dir(item.id), { recursive: true });
    await writeJson(this.dir(item.id), 'item.json', item);
  }

  /**
   * Every row's minutes at this voice's pace: the same number the "Your walk"
   * panel shows for that piece. A row saved before rows kept their figures
   * gets them worked out once from its source.
   */
  async withMinutes(items: ListItem[], voice: VoiceKey): Promise<ListItem[]> {
    const pace = await paceOf(voice);
    const out: ListItem[] = [];
    for (const item of items) {
      if (item.status === 'checking' || item.status === 'unreadable' || !item.doc) {
        out.push(item);
        continue;
      }
      let figures = item.pace;
      if (!figures) {
        const [piece] = await this.pieces([item.id]).catch(() => []);
        if (piece) {
          figures = rowPace(piece.sections, charsPerWord(piece.sections));
          await this.serial(async () => {
            const now = await this.get(item.id);
            if (now) await this.put({ ...now, pace: figures });
          }).catch(() => undefined);
        }
      }
      out.push(figures ? { ...item, pace: figures, minutes: minutesAt(figures, pace(figures.charsPerWord)) } : item);
    }
    return out;
  }

  /** Every item, in list order. */
  async all(): Promise<ListItem[]> {
    let present: string[] = [];
    try {
      present = (await fs.readdir(this.root, { withFileTypes: true })).filter((e) => e.isDirectory() && isWalkId(e.name)).map((e) => e.name);
    } catch {
      return [];
    }
    const ids = ordered(await this.order(), present);
    const items = await Promise.all(ids.map((id) => this.get(id)));
    return items.filter((i): i is ListItem => i !== null);
  }

  /**
   * Saves sources to the end of the list. Pasted text and files are read at
   * once (no network); links are saved as "checking" and read in the
   * background. A link already waiting in the list is not saved twice.
   */
  async add(inputs: SourceInput[]): Promise<{ added: ListItem[]; existing: ListItem[] }> {
    const now = new Date().toISOString();
    const added: ListItem[] = [];
    const existing: ListItem[] = [];
    const current = await this.all();
    const known = new Map(current.filter((i) => i.url && i.status !== 'in_walk').map((i) => [linkKey(i.url!), i]));
    // Text and files are read first, so a mistake in one is said at once and nothing is saved.
    const docs = new Map<SourceInput, SourceDoc>();
    for (const input of inputs) {
      if (input.kind !== 'text' && input.kind !== 'file') continue;
      const doc = await this.read(input);
      if (!pieceSections(doc).sections.length) throw new SourceError('There is no text to read in it.', false);
      docs.set(input, doc);
    }
    for (const input of inputs) {
      if (input.kind === 'saved') continue;
      if (input.kind === 'url') {
        const same = known.get(linkKey(input.url));
        if (same) {
          existing.push(same);
          continue;
        }
      }
      const base: ListItem = {
        id: newId(),
        kind: input.kind === 'url' ? 'link' : input.kind,
        title: sourceLabel(input),
        label: sourceLabel(input),
        url: input.kind === 'url' ? input.url.trim() : undefined,
        words: 0,
        minutes: 0,
        status: 'checking',
        savedAt: now,
      };
      const doc = docs.get(input);
      const item = doc ? await this.withDoc(base, doc) : base;
      await this.put(item);
      if (item.url) known.set(linkKey(item.url), item);
      added.push(item);
    }
    await this.serial(async () => this.writeOrder([...(await this.order()), ...added.map((i) => i.id)]));
    for (const item of added) if (item.status === 'checking') this.enqueue(item.id);
    return { added, existing };
  }

  private async withDoc(item: ListItem, doc: SourceDoc): Promise<ListItem> {
    const { sections, dropped } = pieceSections(doc);
    if (!sections.length) throw new SourceError('There is no text to read in it.');
    await fs.mkdir(this.dir(item.id), { recursive: true });
    await writeFileAtomic(path.join(this.dir(item.id), 'source.md'), doc.markdown);
    const saved = { kind: doc.kind, title: doc.title, url: doc.url, byline: doc.byline, leftOut: [...(doc.leftOut ?? []), ...dropped] };
    const cpw = charsPerWord(sections);
    return checked(item, saved, sections, await this.wpm(cpw), new Date().toISOString(), cpw);
  }

  /** Pasted text in place of a row that could not be read. The row keeps its place and its link. */
  async paste(id: string, text: string, title?: string): Promise<ListItem | null> {
    const item = await this.get(id);
    if (!item) return null;
    const read = await this.read({ kind: 'text', text, title: title?.trim() || undefined });
    // Untitled text pasted over a link keeps the link's name rather than "your pasted text".
    const doc = read.title === 'your pasted text' ? { ...read, title: item.label } : read;
    const next = await this.withDoc({ ...item, kind: 'text' }, { ...doc, url: item.url });
    await this.put(next);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const item = await this.get(id);
    if (!item) return false;
    this.queue = this.queue.filter((q) => q !== id);
    await this.serial(async () => {
      await this.writeOrder((await this.order()).filter((o) => o !== id));
      await fs.rm(this.dir(id), { recursive: true, force: true });
    });
    return true;
  }

  async reorder(ids: string[]): Promise<void> {
    await this.serial(async () => {
      const present = (await this.all()).map((i) => i.id);
      await this.writeOrder(reorder(ordered(await this.order(), present), ids));
    });
  }

  /** Marks items as gone into a walk. */
  async markInWalk(ids: string[], walkId: string): Promise<void> {
    for (const id of ids) {
      const item = await this.get(id);
      if (item) await this.put({ ...item, status: 'in_walk', walkId });
    }
  }

  /** What a build reads instead of the network: the item's doc, copied into the walk folder. */
  async copyInto(id: string, walkDirPath: string, file: string): Promise<SavedInput> {
    const item = await this.get(id);
    if (!item?.doc) throw new Error('That item has not been read yet.');
    await fs.copyFile(path.join(this.dir(id), 'source.md'), path.join(walkDirPath, file));
    return { kind: 'saved', itemId: id, file, doc: item.doc };
  }

  /** Saved items read the way a build reads their copies: one piece each, in the order given. */
  async pieces(ids: string[]): Promise<Piece[]> {
    const inputs: SavedInput[] = [];
    for (const id of ids) {
      const item = await this.get(id);
      if (!item?.doc) throw new SourceError(`${item?.title ?? 'That item'} has not been read yet.`, false);
      inputs.push({ kind: 'saved', itemId: id, file: 'source.md', doc: item.doc });
    }
    const read: ReadFn = async (input) => {
      const saved = input as SavedInput;
      return { ...saved.doc, markdown: await fs.readFile(path.join(this.dir(saved.itemId), 'source.md'), 'utf8') };
    };
    return (await readPieces(inputs, read)).pieces;
  }

  /** The panel's plan for these items and this length, at the pace minutes are estimated with. */
  async preview(ids: string[], minutes: number | null, voice: VoiceKey, quietMinutes = 0): Promise<WalkPreview> {
    const pieces = await this.pieces(ids);
    const pace = await paceOf(voice);
    const wpm = pace(charsPerWord(walkSource(pieces, []).sections));
    // Each piece at its own pace, as the build plans it and as its row shows it.
    const pieceWpm = pieces.map((p) => pace(charsPerWord(p.sections)));
    const preview = previewFrom(pieces, ids, minutes, wpm, quietMinutes, pieceWpm);
    // A piece much longer than the walk can become a series instead of being squeezed.
    if (minutes !== null) {
      for (const [i, p] of preview.pieces.entries()) {
        const item = await this.get(ids[i]!);
        if (item?.parts || p.fullMinutes <= minutes * SERIES_FACTOR) continue;
        const parts = seriesFor(pieces[i]!, minutes, pieceWpm[i]!).length;
        if (parts > 1) p.splitParts = parts;
      }
    }
    return preview;
  }

  /**
   * Replaces one row with its parts, in its place: "Part 1 of 3", "Part 2 of
   * 3"... each saved as its own source, so each is built as its own walk.
   */
  async split(id: string, minutes: number, voice: VoiceKey): Promise<ListItem[]> {
    const item = await this.get(id);
    if (!item?.doc || item.parts) throw new SourceError('That one cannot be split.', false);
    const [piece] = await this.pieces([id]);
    const sections = walkSource([piece!], []).sections;
    const wpm = await listWpm(voice, charsPerWord(sections));
    const parts = seriesFor(piece!, minutes, wpm);
    if (parts.length < 2) throw new SourceError('That one fits in one walk.', false);
    const made: ListItem[] = [];
    for (const [i, part] of parts.entries()) {
      const n = i + 1;
      const next: ListItem = {
        ...item,
        id: newId(),
        words: part.reduce((w, s) => w + s.words, 0),
        minutes: minutesOf(part, wpm),
        pace: rowPace(part, charsPerWord(part)),
        status: 'ready',
        walkId: undefined,
        seriesId: item.id,
        part: n,
        parts: parts.length,
        // The part's own name, for the walk it becomes and for the bridges of a playlist.
        doc: { ...item.doc, title: `${item.title}, part ${n} of ${parts.length}` },
      };
      await this.put(next);
      await writeFileAtomic(path.join(this.dir(next.id), 'source.md'), partMarkdown(part));
      made.push(next);
    }
    await this.serial(async () => {
      const order = await this.order();
      const at = order.indexOf(id);
      const ids = made.map((m) => m.id);
      await this.writeOrder(at < 0 ? [...order, ...ids] : [...order.slice(0, at), ...ids, ...order.slice(at + 1)]);
      await fs.rm(this.dir(id), { recursive: true, force: true });
    });
    return made;
  }

  /** On start: rows that were being checked when the process stopped are checked again. */
  async resume(): Promise<number> {
    const waiting = (await this.all()).filter((i) => i.status === 'checking');
    for (const i of waiting) this.enqueue(i.id);
    return waiting.length;
  }

  /** Resolves when no check is queued or running (for tests and the terminal). */
  idle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private enqueue(id: string): void {
    if (!this.queue.includes(id)) this.queue.push(id);
    this.pump();
  }

  private pump(): void {
    while (this.running < MAX_CHECKS && this.queue.length) {
      const id = this.queue.shift()!;
      this.running++;
      void this.check(id).finally(() => {
        this.running--;
        this.pump();
        if (!this.running && !this.queue.length) this.idleWaiters.splice(0).forEach((fn) => fn());
      });
    }
  }

  /** One link: read it, or say why not. One failure never touches the other rows. */
  private async check(id: string): Promise<void> {
    const item = await this.get(id).catch(() => null);
    if (!item || item.status !== 'checking' || !item.url) return;
    let next: ListItem;
    try {
      next = await this.withDoc(item, await this.read({ kind: 'url', url: item.url }));
    } catch (err) {
      next = unreadable(item, err instanceof SourceError ? err.message : 'It could not be read.', new Date().toISOString());
    }
    // Removed while it was being read: nothing to save. Removal runs in the same queue, so this cannot race it.
    await this.serial(async () => {
      if (await this.get(id)) await this.put(next);
    }).catch(() => undefined);
  }
}
