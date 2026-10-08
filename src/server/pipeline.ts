import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type VoiceKey } from './config.js';
import { calibration, effectiveWpm, spokenChars } from './audio/calibrate.js';
import { encodeMp3, makeChime } from './audio/assemble.js';
import { decideFit, needsScores, type FitDecision, type FitSection } from './audio/fit.js';
import { DTYPE, VOICES, voiceText } from './audio/kokoro.js';
import { clock, placeCues, type CueItem, type Segment } from './audio/timeline.js';
import { concatAudio, decodeWav, encodeWav, SAMPLE_RATE, seconds, silence } from './audio/wav.js';
import { readSource, type SourceInput } from './source/index.js';
import { bridgeText, readPieces, threeQuarterText, walkTitle, wantsThreeQuarter, type Skipped } from './source/pieces.js';
import { countWords, sectionLabel, type Section } from './source/sections.js';
import type { SourceDoc } from './source/types.js';
import { carriedTarget, groupSections, planWalk, SECTION_GAP, walkMode, wordsToSeconds, type Plan } from './script/budget.js';
import { scoreSections } from './script/importance.js';
import { closingQuestion, fitsQuestionRequest } from './script/question.js';
import { readAsWritten, rewriteSection, type ScriptSection } from './script/rewrite.js';
import { readJson, slugify, writeFileAtomic, writeJson } from './walks/store.js';

export interface BuildRequest {
  /** One source (every walk before playlists, and still the usual case). */
  source?: SourceInput;
  /** Up to 8 sources, read one after another into one walk. */
  sources?: SourceInput[];
  /** null means "Whole thing". */
  minutes: number | null;
  voice: VoiceKey;
}

export function requestSources(req: BuildRequest): SourceInput[] {
  if (req.sources?.length) return req.sources;
  if (req.source) return [req.source];
  throw new Error('The request has no source.');
}

export type StageName = 'read' | 'plan' | 'rewrite' | 'voice' | 'pack';

export interface Progress {
  stage: StageName;
  state: 'active' | 'done';
  done?: number;
  total?: number;
  detail?: string;
}

export type OnProgress = (p: Progress) => void;

export interface PieceInfo {
  title: string;
  kind: SourceDoc['kind'];
  url?: string;
  byline?: string;
  words: number;
  sections: number;
}

export interface SourceInfo {
  kind: SourceDoc['kind'] | 'playlist';
  title: string;
  url?: string;
  byline?: string;
  words: number;
  sections: number;
  /** Headings of reference and link lists that were left out. */
  leftOut: string[];
  /** Every piece read, in order (one for a single-source walk). */
  pieces?: PieceInfo[];
  /** Sources of a playlist that could not be used. */
  skipped?: Skipped[];
}

/** The title of the piece a section belongs to, for prompts and bridges. */
function pieceTitle(info: SourceInfo, piece: number | undefined): string {
  return info.pieces?.[piece ?? 0]?.title ?? info.title;
}

export interface Script {
  title: string;
  sections: ScriptSection[];
  question: string | null;
}

interface VoicedFile {
  file: string;
  samples: number;
  boundaries: number[];
  text: string;
}

interface VoiceState {
  sections: Record<string, VoicedFile>;
  /** The app's own lines: intro, halfway, threequarter, question, outro and bridge-N. */
  app: Partial<Record<string, VoicedFile>>;
  seconds: number;
}

export interface Meta {
  id: string;
  title: string;
  createdAt: string;
  finishedAt: string;
  source: { kind: string; url?: string; byline?: string };
  mode: Plan['mode'];
  targetSeconds: number | null;
  actualSeconds: number;
  halfwaySeconds: number | null;
  fullSeconds: number;
  sourceWords: number;
  scriptWords: number;
  sections: number;
  coverage: { full: number; condensed: number; brief: number };
  checkNumbers: number;
  voice: string;
  voiceName: string;
  dtype: string;
  wordsPerMinute: number;
  model: string;
  numCtx: number;
  modelCalls: number;
  rewriteSeconds: number;
  voiceSeconds: number;
  packSeconds: number;
  fileName: string;
  bytes: number;
  machine: string;
  /** The fit pass: which section was shortened and how long the walk was before. */
  fit: { sectionId: string; beforeSeconds: number } | null;
  leftOut: string[];
  scored: boolean;
  question: boolean;
  // The three fields below are missing from walks made before playlists.
  /** The second cue on walks of 45 minutes or more. */
  threeQuarterSeconds?: number | null;
  /** The pieces of the walk in order, with where each starts and how long it runs. */
  pieces?: MetaPiece[];
  /** Sources of a playlist that could not be used. */
  skipped?: Skipped[];
}

export interface MetaPiece {
  title: string;
  kind: string;
  url?: string;
  start: number;
  seconds: number;
}

export const HALFWAY_TEXT = "You're halfway. If you're walking out and back, turn around now.";
export const OUTRO_TEXT = "That's the end. You should be almost home.";
export const QUESTION_LEAD = 'Here is something to think about on the way back.';

export function introText(minutes: number, title: string, halfway = true, pieces: string[] = []): string {
  const cue = halfway ? " I'll tell you when you're halfway." : '';
  if (pieces.length > 1) return `This is your ${minutes}-minute Walk Edition, with ${pieces.length} pieces. First: ${pieces[0]}. Start walking.${cue}`;
  return `This is your ${minutes}-minute Walk Edition of ${title}. Start walking.${cue}`;
}

/** Pauses around the app's own lines, in seconds. */
const PAUSE = { afterIntro: 0.9, beforeChime: 0.7, afterChime: 0.35, afterCue: 0.9, beforeOutro: 1.4, tail: 0.6, beforeBridge: 1.4, afterBridge: 0.8 };

const nowIso = () => new Date().toISOString();

async function stageRead(dir: string, req: BuildRequest, signal?: AbortSignal) {
  let info = await readJson<SourceInfo>(dir, 'source.json');
  let sections = await readJson<Section[]>(dir, 'sections.json');
  if (info && sections) return { info, sections };
  const { pieces, skipped } = await readPieces(requestSources(req), readSource, signal);
  let n = 0;
  sections = pieces.flatMap((p, piece) =>
    p.sections.map((s) => ({ ...s, id: `s${String(++n).padStart(2, '0')}`, ...(pieces.length > 1 ? { piece } : {}) })),
  );
  const words = sections.reduce((total, s) => total + s.words, 0);
  const first = pieces[0]!.doc;
  const single = pieces.length === 1;
  info = {
    kind: single ? first.kind : 'playlist',
    title: single ? first.title : walkTitle(pieces.map((p) => p.doc.title)),
    url: single ? first.url : undefined,
    byline: single ? first.byline : undefined,
    words,
    sections: sections.length,
    leftOut: pieces.flatMap((p) => p.leftOut),
    pieces: pieces.map((p, piece) => ({
      title: p.doc.title,
      kind: p.doc.kind,
      url: p.doc.url,
      byline: p.doc.byline,
      words: sections!.filter((s) => (s.piece ?? 0) === piece).reduce((total, s) => total + s.words, 0),
      sections: p.sections.length,
    })),
    skipped,
  };
  const markdown = single ? first.markdown : pieces.map((p) => `# ${p.doc.title}\n\n${p.doc.markdown}`).join('\n\n---\n\n');
  await writeFileAtomic(path.join(dir, 'source.md'), markdown);
  await writeJson(dir, 'sections.json', sections);
  await writeJson(dir, 'source.json', info);
  return { info, sections };
}

function fixedSecondsEstimate(info: SourceInfo, wpm: number, targetSeconds: number | null): number {
  const pieces = info.pieces?.map((p) => p.title) ?? [];
  const words = countWords(introText(20, info.title, true, pieces) + HALFWAY_TEXT + QUESTION_LEAD + OUTRO_TEXT) + 18;
  const pauses =
    PAUSE.afterIntro + PAUSE.afterCue + PAUSE.beforeOutro + PAUSE.tail + 2 * (PAUSE.beforeChime + PAUSE.afterChime);
  let seconds = wordsToSeconds(words, wpm) + pauses + 2 * 1.2;
  // Bridges between pieces replace a section gap with their own pauses and words.
  for (const title of pieces.slice(1)) {
    seconds += wordsToSeconds(countWords(bridgeText(title)), wpm) + PAUSE.beforeBridge + PAUSE.afterBridge - SECTION_GAP;
  }
  if (targetSeconds !== null && wantsThreeQuarter(targetSeconds)) {
    seconds += wordsToSeconds(countWords(threeQuarterText(15)), wpm) + PAUSE.beforeChime + PAUSE.afterChime + PAUSE.afterCue + 1.2;
  }
  return seconds;
}

export function planDetail(plan: Plan): string {
  const n = plan.sections.length;
  const target = plan.targetSeconds ? Math.round(plan.targetSeconds / 60) : null;
  const fullMin = Math.max(1, Math.round(plan.fullSeconds / 60));
  if (target === null) return `Read in full, about ${fullMin} min`;
  if (plan.mode === 'full') {
    return fullMin < target * 0.9 ? `This one is a ${fullMin}-minute walk. Nothing gets cut.` : 'Short enough to read in full';
  }
  const shortened = plan.sections.filter((s) => s.treatment !== 'full').length;
  const base = `Too long for ${target} minutes, so ${shortened} of ${n} ${n === 1 ? 'section gets' : 'sections get'} shortened`;
  return plan.tooLong ? `${base}. A longer walk would keep much more of it.` : base;
}

/** Characters per spoken word of the text that is read as written. */
export function charsPerWord(sections: Section[]): number {
  let chars = 0;
  let words = 0;
  for (const s of sections) {
    for (const b of s.blocks) {
      if (b.kind === 'code' || b.kind === 'table') continue;
      chars += spokenChars(b.text) + 1;
      words += countWords(b.text);
    }
  }
  return words >= 50 ? chars / words : 5.6;
}

/** The plan and the sections it works on (the source's, or groups of them for a short walk). */
async function stagePlan(dir: string, req: BuildRequest, info: SourceInfo, sections: Section[]): Promise<{ plan: Plan; planSections: Section[] }> {
  const saved = await readJson<Plan>(dir, 'plan.json');
  const savedSections = await readJson<Section[]>(dir, 'plan-sections.json');
  if (saved && savedSections) return { plan: saved, planSections: savedSections };
  const cal = await calibration(req.voice);
  const wpm = effectiveWpm(cal, charsPerWord(sections));
  const targetSeconds = req.minutes === null ? null : req.minutes * 60;
  const input = { sections, targetSeconds, wpm, fixedSeconds: fixedSecondsEstimate(info, wpm, targetSeconds) };
  let plan = planWalk(input);
  let planSections = sections;
  if (plan.mode === 'condensed') {
    // Grouping and importance stay inside each piece of a playlist.
    const pieceCount = info.pieces?.length ?? 1;
    const ofPiece = (list: Section[], p: number) => list.filter((s) => (s.piece ?? 0) === p);
    const grouped = Array.from({ length: pieceCount }, (_, p) =>
      groupSections(ofPiece(sections, p), plan.pieces?.[p]?.budgetWords ?? plan.budgetWords ?? 0),
    );
    if (grouped.some((g, p) => g !== ofPiece(sections, p) && g.length !== ofPiece(sections, p).length)) {
      planSections = grouped.flat();
      plan = planWalk({ ...input, sections: planSections });
    }
    const scores: Record<string, number> = {};
    let scored = true;
    for (let p = 0; p < pieceCount; p++) {
      const result = await scoreSections(pieceTitle(info, p), ofPiece(planSections, p));
      if (result.scores) Object.assign(scores, result.scores);
      else if (ofPiece(planSections, p).length > 1) scored = false;
    }
    if (scored && Object.keys(scores).length) plan = { ...planWalk({ ...input, sections: planSections, scores }), scored: true };
  }
  await writeJson(dir, 'plan-sections.json', planSections);
  await writeJson(dir, 'plan.json', plan);
  return { plan, planSections };
}

interface RewriteState {
  sections: Record<string, ScriptSection>;
  question?: { text: string | null; seconds: number };
}

/**
 * The text the closing question is drawn from: the source if it fits, else
 * the script. A walk too long for either (an hour of several pieces) asks
 * about its last stretch: the end of the script, as much as fits.
 */
export function questionSource(sections: Section[], script: ScriptSection[], fits = fitsQuestionRequest): { text: string; from: number } {
  const source = sections
    .map((s) => [s.heading, ...s.blocks.map((b) => (b.kind === 'code' || b.kind === 'table' ? '' : readAsWritten(b)))].filter(Boolean).join('\n'))
    .join('\n\n');
  if (fits(source)) return { text: source, from: 0 };
  const whole = script.map((s) => s.text).join('\n\n');
  if (fits(whole)) return { text: whole, from: 0 };
  let from = script.length - 1;
  while (from > 0 && fits(script.slice(from - 1).map((s) => s.text).join('\n\n'))) from--;
  return { text: script.slice(from).map((s) => s.text).join('\n\n'), from };
}

async function stageRewrite(
  dir: string,
  info: SourceInfo,
  sections: Section[],
  plan: Plan,
  onProgress: OnProgress,
  signal?: AbortSignal,
): Promise<Script> {
  const saved = await readJson<Script>(dir, 'script.json');
  if (saved) return saved;
  const state = (await readJson<RewriteState>(dir, 'rewrite.json')) ?? { sections: {} };
  const total = sections.length;
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    onProgress({ stage: 'rewrite', state: 'active', done: i, total, detail: `Section ${i + 1} of ${total} · ${sectionLabel(section)}` });
    if (state.sections[section.id]) continue;
    const planned = plan.sections[i]!;
    // What the sections of this piece written so far came out at; other pieces keep their own time.
    const wordsSoFar = sections
      .slice(0, i)
      .filter((s) => (s.piece ?? 0) === (section.piece ?? 0))
      .reduce((n, s) => n + (state.sections[s.id]?.words ?? 0), 0);
    const targetWords = carriedTarget(plan, i, wordsSoFar);
    state.sections[section.id] = await rewriteSection(section, { ...planned, targetWords }, { title: pieceTitle(info, section.piece), signal });
    await writeJson(dir, 'rewrite.json', state);
  }
  const done = sections.map((s) => ({ ...state.sections[s.id]!, ...(s.piece !== undefined ? { piece: s.piece } : {}) }));
  if (!state.question) {
    onProgress({ stage: 'rewrite', state: 'active', done: total, total, detail: 'A question for the last stretch' });
    const asked = questionSource(sections, done);
    // When only the end of a playlist fits, the question is about the piece it comes from.
    const q = await closingQuestion(asked.from > 0 ? pieceTitle(info, done[asked.from]!.piece) : info.title, asked.text);
    state.question = { text: q.question, seconds: q.seconds };
    await writeJson(dir, 'rewrite.json', state);
  }
  const script: Script = { title: info.title, sections: done, question: state.question?.text ?? null };
  await writeJson(dir, 'script.json', script);
  return script;
}

async function voiceTo(dir: string, file: string, text: string, voice: VoiceKey, signal?: AbortSignal): Promise<VoicedFile> {
  const voiced = await voiceText(text, voice, signal);
  await writeFileAtomic(path.join(dir, file), encodeWav(voiced.samples));
  return { file, samples: voiced.samples.length, boundaries: voiced.boundaries, text };
}

async function stageVoice(
  dir: string,
  req: BuildRequest,
  info: SourceInfo,
  script: Script,
  onProgress: OnProgress,
  signal?: AbortSignal,
): Promise<VoiceState> {
  const state = (await readJson<VoiceState>(dir, 'voice.json')) ?? { sections: {}, app: {}, seconds: 0 };
  const total = script.sections.length;
  for (let i = 0; i < total; i++) {
    const s = script.sections[i]!;
    onProgress({ stage: 'voice', state: 'active', done: i, total, detail: `Section ${i + 1} of ${total} · ${sectionLabel(s)}` });
    const known = state.sections[s.id];
    if (known && known.text === s.text) continue;
    const started = Date.now();
    state.sections[s.id] = await voiceTo(dir, `section-${String(i + 1).padStart(2, '0')}.wav`, s.text, req.voice, signal);
    state.seconds += (Date.now() - started) / 1000;
    await writeJson(dir, 'voice.json', state);
  }
  const app: [string, string][] = [
    ['halfway', HALFWAY_TEXT],
    ['outro', OUTRO_TEXT],
  ];
  if (script.question) app.push(['question', `${QUESTION_LEAD} ${script.question}`]);
  (info.pieces ?? []).forEach((p, piece) => {
    if (piece > 0) app.push([`bridge-${piece}`, bridgeText(p.title)]);
  });
  for (const [key, text] of app) {
    if (state.app[key]?.text === text) continue;
    const started = Date.now();
    state.app[key] = await voiceTo(dir, `app-${key}.wav`, text, req.voice, signal);
    state.seconds += (Date.now() - started) / 1000;
    await writeJson(dir, 'voice.json', state);
  }
  return state;
}

const toSamples = (s: number) => Math.round(s * SAMPLE_RATE);

/** Pause, chime, pause, the spoken cue and a pause after it. */
function cueBlockLength(chime: number, spoken: number): number {
  return toSamples(PAUSE.beforeChime) + chime + toSamples(PAUSE.afterChime) + spoken + toSamples(PAUSE.afterCue);
}

/** Lengths in samples of everything around the content, from what is already voiced. */
function layout(voice: VoiceState, script: Script, chime: number, info: SourceInfo, wpm: number) {
  let content = 0;
  script.sections.forEach((s, i) => {
    content += voice.sections[s.id]?.samples ?? 0;
    if (i === 0) return;
    const piece = s.piece ?? 0;
    const bridge = piece !== (script.sections[i - 1]!.piece ?? 0) ? voice.app[`bridge-${piece}`] : undefined;
    content += bridge ? toSamples(PAUSE.beforeBridge) + bridge.samples + toSamples(PAUSE.afterBridge) : toSamples(SECTION_GAP);
  });
  const cue = cueBlockLength(chime, voice.app.halfway?.samples ?? 0);
  const after =
    toSamples(PAUSE.beforeChime) + chime + toSamples(PAUSE.afterChime) +
    (voice.app.question ? voice.app.question.samples + toSamples(PAUSE.beforeOutro) : 0) +
    (voice.app.outro?.samples ?? 0) + toSamples(PAUSE.tail);
  const pieces = info.pieces?.map((p) => p.title) ?? [];
  const intro = toSamples(wordsToSeconds(countWords(introText(20, info.title, true, pieces)), wpm) + PAUSE.afterIntro);
  const base = content + cue + after + intro;
  // Long walks get a second cue; its length is estimated until it is voiced.
  const threeQuarter = wantsThreeQuarter(base / SAMPLE_RATE)
    ? cueBlockLength(chime, voice.app.threequarter?.samples ?? toSamples(wordsToSeconds(countWords(threeQuarterText(15)), wpm)))
    : 0;
  return { content, cue, after, intro, threeQuarter, total: base + threeQuarter };
}

interface FitState {
  decision: FitDecision | null;
  beforeSeconds: number;
  done: boolean;
  /** Importance scores fetched for a walk read in full that ran over. */
  scores?: Record<string, number> | null;
  /** The shortened section, kept here so a crash before script.json is written loses nothing. */
  section?: ScriptSection;
}

function applyFit(script: Script, fit: FitState): Script {
  if (!fit.section) return script;
  const i = script.sections.findIndex((s) => s.id === fit.section!.id);
  if (i < 0 || script.sections[i]!.text === fit.section.text) return script;
  const sections = [...script.sections];
  sections[i] = fit.section;
  return { ...script, sections };
}

async function stageFit(
  dir: string,
  info: SourceInfo,
  sections: Section[],
  plan: Plan,
  script: Script,
  voice: VoiceState,
  onProgress: OnProgress,
  signal?: AbortSignal,
): Promise<{ script: Script; fit: FitState }> {
  let fit = await readJson<FitState>(dir, 'fit.json');
  if (fit?.done) {
    const applied = applyFit(script, fit);
    if (applied !== script) await writeJson(dir, 'script.json', applied);
    return { script: applied, fit };
  }
  if (!fit) {
    const chime = await makeChime();
    const beforeSeconds = layout(voice, script, chime.length, info, plan.wpm).total / SAMPLE_RATE;
    const fitSections: FitSection[] = script.sections.map((s, i) => ({
      id: s.id,
      treatment: s.treatment,
      words: s.words,
      fullWords: plan.sections[i]?.fullWords ?? s.words,
      seconds: (voice.sections[s.id]?.samples ?? 0) / SAMPLE_RATE,
      score: plan.scored ? plan.sections[i]?.score : undefined,
    }));
    // A walk read in full that runs over condenses its least important section; ask once how they rank.
    let scores: Record<string, number> | null | undefined;
    if (!plan.scored && needsScores(plan.targetSeconds, beforeSeconds, fitSections)) {
      onProgress({ stage: 'voice', state: 'active', done: script.sections.length, total: script.sections.length, detail: 'Choosing a part to shorten' });
      scores = {};
      for (let p = 0; p < (info.pieces?.length ?? 1); p++) {
        const result = await scoreSections(pieceTitle(info, p), sections.filter((sec) => (sec.piece ?? 0) === p));
        Object.assign(scores, result.scores ?? {});
      }
      for (const f of fitSections) f.score = scores?.[f.id];
    }
    const decision = decideFit(plan.targetSeconds, beforeSeconds, fitSections);
    fit = { decision, beforeSeconds: Math.round(beforeSeconds * 10) / 10, done: decision === null, scores };
    await writeJson(dir, 'fit.json', fit);
    if (!decision) return { script, fit };
  }
  const decision = fit.decision!;
  const i = script.sections.findIndex((s) => s.id === decision.sectionId);
  const old = script.sections[i]!;
  const verb = decision.toWords < decision.fromWords ? 'Shortening' : 'Lengthening';
  onProgress({ stage: 'voice', state: 'active', done: script.sections.length, total: script.sections.length, detail: `${verb} ${sectionLabel(old)} to fit the walk` });
  const redone = await rewriteSection(sections[i]!, { ...plan.sections[i]!, treatment: 'condensed', targetWords: decision.toWords }, { title: pieceTitle(info, sections[i]!.piece), signal });
  fit = {
    ...fit,
    done: true,
    section: { ...redone, piece: old.piece, modelSeconds: old.modelSeconds + redone.modelSeconds, modelCalls: old.modelCalls + redone.modelCalls },
  };
  await writeJson(dir, 'fit.json', fit);
  const next = applyFit(script, fit);
  await writeJson(dir, 'script.json', next);
  return { script: next, fit };
}

async function loadSamples(dir: string, v: VoicedFile): Promise<Float32Array> {
  return decodeWav(await fs.readFile(path.join(dir, v.file))).samples;
}

interface Item extends Omit<CueItem, 'length'> {
  audio: Float32Array;
  seg?: Omit<Segment, 'start' | 'end'>;
}

async function stagePack(
  id: string,
  dir: string,
  req: BuildRequest,
  info: SourceInfo,
  plan: Plan,
  script: Script,
  voice: VoiceState,
  createdAt: string,
  fit: FitState,
  onProgress: OnProgress,
  signal?: AbortSignal,
): Promise<Meta> {
  const packStarted = Date.now();
  const chime = await makeChime();
  const halfwayAudio = await loadSamples(dir, voice.app.halfway!);
  const outroAudio = await loadSamples(dir, voice.app.outro!);
  const questionAudio = voice.app.question ? await loadSamples(dir, voice.app.question) : null;
  const pieceTitles = info.pieces?.map((p) => p.title) ?? [];
  const playlist = pieceTitles.length > 1;
  const voiceApp = async (key: string, text: string) => {
    if (voice.app[key]?.text === text) return;
    const started = Date.now();
    voice.app[key] = await voiceTo(dir, `app-${key}.wav`, text, req.voice, signal);
    voice.seconds += (Date.now() - started) / 1000;
    await writeJson(dir, 'voice.json', voice);
  };

  // The intro names the length, so it is voiced once the rest is measured.
  let lengths = layout(voice, script, chime.length, info, plan.wpm);
  const minutes = Math.max(1, Math.round(lengths.total / SAMPLE_RATE / 60));
  const first = voice.sections[script.sections[0]!.id]!;
  const hasHalfway = script.sections.length > 1 || first.boundaries.length > 0;
  const intro = introText(minutes, info.title, hasHalfway, pieceTitles);
  await voiceApp('intro', intro);
  // About a quarter of the walk is left at the second cue; the number is checked once the cue is placed.
  const longWalk = lengths.threeQuarter > 0;
  let threeQuarter = longWalk ? threeQuarterText((lengths.total / SAMPLE_RATE) * 0.25 / 60) : null;
  if (threeQuarter) await voiceApp('threequarter', threeQuarter);
  onProgress({ stage: 'voice', state: 'done', done: script.sections.length, total: script.sections.length });
  onProgress({ stage: 'pack', state: 'active' });
  const introAudio = await loadSamples(dir, voice.app.intro!);
  const sectionAudio = await Promise.all(script.sections.map((s) => loadSamples(dir, voice.sections[s.id]!)));

  // The walk between intro and closing lines, as items a cue may sit before or inside.
  const items: Item[] = [];
  for (let i = 0; i < script.sections.length; i++) {
    const s = script.sections[i]!;
    const piece = s.piece ?? 0;
    const newPiece = i > 0 && piece !== (script.sections[i - 1]!.piece ?? 0);
    if (newPiece && voice.app[`bridge-${piece}`]) {
      const bridge = await loadSamples(dir, voice.app[`bridge-${piece}`]!);
      items.push({ audio: silence(PAUSE.beforeBridge), boundaries: [], cueBefore: false });
      // A cue between two pieces goes before the bridge, never between "Next: ..." and the piece.
      items.push({ audio: bridge, boundaries: [], cueBefore: true, seg: { kind: 'app', role: 'bridge', label: bridgeText(pieceTitles[piece] ?? ''), piece } });
      items.push({ audio: silence(PAUSE.afterBridge), boundaries: [], cueBefore: false });
    } else if (i > 0) {
      items.push({ audio: silence(SECTION_GAP), boundaries: [], cueBefore: false });
    }
    items.push({
      audio: sectionAudio[i]!,
      boundaries: voice.sections[s.id]!.boundaries,
      cueBefore: i > 0 && !newPiece,
      seg: { kind: 'source', label: sectionLabel(s), sectionId: s.id, ...(playlist ? { piece } : {}) },
    });
  }

  const before = introAudio.length + toSamples(PAUSE.afterIntro);
  const place = () =>
    placeCues({
      before,
      items: items.map((it) => ({ length: it.audio.length, boundaries: it.boundaries, cueBefore: it.cueBefore })),
      after: lengths.after,
      cues: [
        { fraction: 0.5, length: lengths.cue },
        ...(threeQuarter ? [{ fraction: 0.75, length: cueBlockLength(chime.length, voice.app.threequarter!.samples) }] : []),
      ],
    });
  let spots = place();
  const second = () => spots.find((spot) => spot.cue === 1);
  // Now that the walk is laid out, say how much is really left at the second cue.
  if (threeQuarter && second()) {
    const left = (second()!.total - second()!.cueStart) / SAMPLE_RATE / 60;
    const checked = threeQuarterText(left);
    if (checked !== threeQuarter) {
      threeQuarter = checked;
      await voiceApp('threequarter', threeQuarter);
      lengths = layout(voice, script, chime.length, info, plan.wpm);
      spots = place();
    }
  }
  const threeQuarterAudio = threeQuarter && second() ? await loadSamples(dir, voice.app.threequarter!) : null;

  const parts: Float32Array[] = [];
  const segments: Segment[] = [];
  let at = 0;
  const push = (audio: Float32Array, seg?: Omit<Segment, 'start' | 'end'>) => {
    if (seg) segments.push({ ...seg, start: at / SAMPLE_RATE, end: (at + audio.length) / SAMPLE_RATE });
    parts.push(audio);
    at += audio.length;
  };
  const cueAt: { half: number | null; threeQuarter: number | null } = { half: null, threeQuarter: null };
  const pushCue = (cue: number) => {
    push(silence(PAUSE.beforeChime));
    if (cue === 0) {
      cueAt.half = at / SAMPLE_RATE;
      push(concatAudio([chime, silence(PAUSE.afterChime), halfwayAudio]), { kind: 'app', role: 'halfway', label: 'Halfway cue' });
    } else {
      cueAt.threeQuarter = at / SAMPLE_RATE;
      push(concatAudio([chime, silence(PAUSE.afterChime), threeQuarterAudio!]), { kind: 'app', role: 'threequarter', label: 'Three-quarter cue' });
    }
    push(silence(PAUSE.afterCue));
  };

  push(introAudio, { kind: 'app', role: 'intro', label: 'Intro' });
  push(silence(PAUSE.afterIntro));
  items.forEach((it, i) => {
    let from = 0;
    for (const spot of spots.filter((sp) => sp.item === i)) {
      if (spot.offset > from) push(it.audio.subarray(from, spot.offset), it.seg);
      pushCue(spot.cue);
      from = spot.offset;
    }
    if (from < it.audio.length) push(from ? it.audio.subarray(from) : it.audio, it.seg);
  });
  push(silence(PAUSE.beforeChime));
  if (questionAudio) {
    push(concatAudio([chime, silence(PAUSE.afterChime), questionAudio]), { kind: 'app', role: 'question', label: 'A question for the last stretch' });
    push(silence(PAUSE.beforeOutro));
  } else {
    push(chime);
    push(silence(PAUSE.afterChime));
  }
  push(outroAudio, { kind: 'app', role: 'outro', label: 'Sign-off' });
  push(silence(PAUSE.tail));

  const halfwaySeconds = cueAt.half;
  const threeQuarterSeconds = cueAt.threeQuarter;
  const finalAudio = concatAudio(parts);
  const actualSeconds = seconds(finalAudio);
  const wavPath = path.join(dir, 'final.wav');
  await writeFileAtomic(wavPath, encodeWav(finalAudio));
  const date = createdAt.slice(0, 10);
  await encodeMp3(wavPath, path.join(dir, 'final.mp3'), { title: info.title, date, comment: 'Made on this computer with Gemma and Kokoro' });
  await fs.rm(wavPath, { force: true });
  const bytes = (await fs.stat(path.join(dir, 'final.mp3'))).size;
  await writeJson(dir, 'timeline.json', { seconds: actualSeconds, halfwaySeconds, threeQuarterSeconds, segments });

  // Where each piece starts (its bridge, or its first section) and how long it runs.
  const pieces = (info.pieces ?? [{ title: info.title, kind: info.kind as SourceDoc['kind'], url: info.url, words: info.words, sections: info.sections }]).map(
    (p, piece) => {
      const own = segments.filter((g) => (playlist ? g.piece === piece : g.kind === 'source'));
      const start = own.length ? Math.min(...own.map((g) => g.start)) : 0;
      const end = own.length ? Math.max(...own.map((g) => g.end)) : 0;
      return { title: p.title, kind: p.kind, url: p.url, start: Math.round(start * 10) / 10, seconds: Math.round((end - start) * 10) / 10 };
    },
  );

  const scriptText = [
    `${info.title}`,
    `Walk Edition, ${clock(actualSeconds)}${halfwaySeconds !== null ? `, halfway cue at ${clock(halfwaySeconds)}` : ''}${threeQuarterSeconds !== null ? `, three-quarter cue at ${clock(threeQuarterSeconds)}` : ''}`,
    ...(playlist ? ['', ...pieces.map((p, i) => `${i + 1}. ${p.title} (${clock(p.seconds)}, from ${clock(p.start)})`)] : []),
    '',
    `[${clock(0)}] The app: ${intro}`,
    '',
    ...script.sections.flatMap((s, i) => {
      const seg = segments.find((g) => g.sectionId === s.id);
      const piece = s.piece ?? 0;
      const bridge = playlist && i > 0 && piece !== (script.sections[i - 1]!.piece ?? 0) ? segments.find((g) => g.role === 'bridge' && g.piece === piece) : undefined;
      const head = `[${clock(seg?.start ?? 0)}] ${sectionLabel(s)} (${s.coverage})${s.checkNumbers.length ? ` check numbers: ${s.checkNumbers.join(', ')}` : ''}`;
      return [...(bridge ? [`[${clock(bridge.start)}] The app: ${bridge.label}`, ''] : []), head, s.text, ''];
    }),
    ...(halfwaySeconds !== null ? [`[${clock(halfwaySeconds)}] The app, after a chime: ${HALFWAY_TEXT}`, ''] : []),
    ...(threeQuarterSeconds !== null && threeQuarter ? [`[${clock(threeQuarterSeconds)}] The app, after a chime: ${threeQuarter}`, ''] : []),
    ...(script.question ? [`The app, a question for the last stretch: ${QUESTION_LEAD} ${script.question}`, ''] : []),
    `The app: ${OUTRO_TEXT}`,
    '',
  ].join('\n');
  await writeFileAtomic(path.join(dir, 'script.txt'), scriptText);

  const cfg = loadConfig();
  // The file name says how long the walk is: the target when it was condensed to fit, else the measured length.
  const mode = walkMode(script.sections);
  const fileMinutes = mode === 'condensed' && req.minutes ? req.minutes : Math.max(1, Math.round(actualSeconds / 60));
  const meta: Meta = {
    id,
    title: info.title,
    createdAt,
    finishedAt: nowIso(),
    source: { kind: info.kind, url: info.url, byline: info.byline },
    mode,
    targetSeconds: plan.targetSeconds,
    actualSeconds: Math.round(actualSeconds * 100) / 100,
    halfwaySeconds: halfwaySeconds === null ? null : Math.round(halfwaySeconds * 100) / 100,
    fullSeconds: Math.round(plan.fullSeconds),
    sourceWords: plan.fullWords,
    scriptWords: script.sections.reduce((n, s) => n + s.words, 0),
    sections: script.sections.length,
    coverage: {
      full: script.sections.filter((s) => s.coverage === 'Full').length,
      condensed: script.sections.filter((s) => s.coverage === 'Condensed').length,
      brief: script.sections.filter((s) => s.coverage === 'Brief').length,
    },
    checkNumbers: script.sections.reduce((n, s) => n + s.checkNumbers.length, 0),
    voice: VOICES[req.voice].id,
    voiceName: VOICES[req.voice].name,
    dtype: DTYPE,
    wordsPerMinute: plan.wpm,
    model: cfg.OLLAMA_MODEL,
    numCtx: cfg.OLLAMA_NUM_CTX,
    modelCalls: script.sections.reduce((n, s) => n + s.modelCalls, 0),
    rewriteSeconds: Math.round(script.sections.reduce((n, s) => n + s.modelSeconds, 0) * 10) / 10,
    voiceSeconds: Math.round(voice.seconds * 10) / 10,
    packSeconds: Math.round((Date.now() - packStarted) / 100) / 10,
    fileName: `${slugify(info.title)}-${fileMinutes}min-walk.mp3`,
    bytes,
    machine: `${os.cpus()[0]?.model ?? os.arch()}, ${Math.round(os.totalmem() / 2 ** 30)} GB`,
    fit: fit.decision ? { sectionId: fit.decision.sectionId, beforeSeconds: fit.beforeSeconds } : null,
    leftOut: info.leftOut ?? [],
    scored: plan.scored ?? false,
    question: script.question !== null,
    threeQuarterSeconds: threeQuarterSeconds === null ? null : Math.round(threeQuarterSeconds * 100) / 100,
    pieces,
    skipped: info.skipped ?? [],
  };
  await writeJson(dir, 'meta.json', meta);

  onProgress({ stage: 'pack', state: 'done' });
  return meta;
}

export async function runPipeline(
  id: string,
  dir: string,
  req: BuildRequest,
  createdAt: string,
  onProgress: OnProgress = () => {},
  signal?: AbortSignal,
): Promise<Meta> {
  await fs.mkdir(dir, { recursive: true });
  onProgress({ stage: 'read', state: 'active' });
  const { info, sections } = await stageRead(dir, req, signal);
  onProgress({ stage: 'read', state: 'done', detail: `${info.words.toLocaleString('en-US')} words in ${sections.length} ${sections.length === 1 ? 'section' : 'sections'}` });

  onProgress({ stage: 'plan', state: 'active' });
  const { plan, planSections } = await stagePlan(dir, req, info, sections);
  onProgress({ stage: 'plan', state: 'done', detail: planDetail(plan) });

  const script = await stageRewrite(dir, info, planSections, plan, onProgress, signal);
  onProgress({ stage: 'rewrite', state: 'done', done: planSections.length, total: planSections.length });

  let voice = await stageVoice(dir, req, info, script, onProgress, signal);
  const fitted = await stageFit(dir, info, planSections, plan, script, voice, onProgress, signal);
  if (fitted.script !== script) voice = await stageVoice(dir, req, info, fitted.script, onProgress, signal);
  return stagePack(id, dir, req, info, plan, fitted.script, voice, createdAt, fitted.fit, onProgress, signal);
}
