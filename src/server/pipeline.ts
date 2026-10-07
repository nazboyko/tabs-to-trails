import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type VoiceKey } from './config.js';
import { calibration, effectiveWpm, spokenChars } from './audio/calibrate.js';
import { encodeMp3, makeChime } from './audio/assemble.js';
import { decideFit, type FitDecision } from './audio/fit.js';
import { DTYPE, VOICES, voiceText } from './audio/kokoro.js';
import { clock, placeHalfway, type Segment } from './audio/timeline.js';
import { concatAudio, decodeWav, encodeWav, SAMPLE_RATE, seconds, silence } from './audio/wav.js';
import { readSource, type SourceInput } from './source/index.js';
import { countWords, dropBackMatter, sectionLabel, splitSections, type Section } from './source/sections.js';
import type { SourceDoc } from './source/types.js';
import { carriedTarget, groupSections, planWalk, SECTION_GAP, wordsToSeconds, type Plan } from './script/budget.js';
import { scoreSections } from './script/importance.js';
import { closingQuestion, fitsQuestionRequest } from './script/question.js';
import { readAsWritten, rewriteSection, type ScriptSection } from './script/rewrite.js';
import { readJson, slugify, writeFileAtomic, writeJson } from './walks/store.js';

export interface BuildRequest {
  source: SourceInput;
  /** null means "Whole thing". */
  minutes: number | null;
  voice: VoiceKey;
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

export interface SourceInfo {
  kind: SourceDoc['kind'];
  title: string;
  url?: string;
  byline?: string;
  words: number;
  sections: number;
  /** Headings of reference and link lists that were left out. */
  leftOut: string[];
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
  app: Partial<Record<'halfway' | 'question' | 'outro' | 'intro', VoicedFile>>;
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
}

export const HALFWAY_TEXT = "You're halfway. If you're walking out and back, turn around now.";
export const OUTRO_TEXT = "That's the end. You should be almost home.";
export const QUESTION_LEAD = 'Here is something to think about on the way back.';

export function introText(minutes: number, title: string, halfway = true): string {
  return `This is your ${minutes}-minute Walk Edition of ${title}. Start walking.${halfway ? " I'll tell you when you're halfway." : ''}`;
}

/** Pauses around the app's own lines, in seconds. */
const PAUSE = { afterIntro: 0.9, beforeChime: 0.7, afterChime: 0.35, afterCue: 0.9, beforeOutro: 1.4, tail: 0.6 };

const nowIso = () => new Date().toISOString();

async function stageRead(dir: string, req: BuildRequest, signal?: AbortSignal) {
  let info = await readJson<SourceInfo>(dir, 'source.json');
  let sections = await readJson<Section[]>(dir, 'sections.json');
  if (info && sections) return { info, sections };
  const doc = await readSource(req.source, signal);
  const { kept, dropped } = dropBackMatter(splitSections(doc.markdown));
  sections = kept.map((s, i) => ({ ...s, id: `s${String(i + 1).padStart(2, '0')}` }));
  // A text with no headings at all is not an "Opening": one section carries the title, parts are numbered.
  if (sections.every((s) => s.heading === 'Opening')) {
    sections = sections.length === 1 ? [{ ...sections[0]!, heading: doc.title }] : sections.map((s) => ({ ...s, heading: '' }));
  }
  const words = sections.reduce((n, s) => n + s.words, 0);
  info = {
    kind: doc.kind,
    title: doc.title,
    url: doc.url,
    byline: doc.byline,
    words,
    sections: sections.length,
    leftOut: [...(doc.leftOut ?? []), ...dropped],
  };
  await writeFileAtomic(path.join(dir, 'source.md'), doc.markdown);
  await writeJson(dir, 'sections.json', sections);
  await writeJson(dir, 'source.json', info);
  return { info, sections };
}

function fixedSecondsEstimate(title: string, wpm: number): number {
  const words = countWords(introText(20, title) + HALFWAY_TEXT + QUESTION_LEAD + OUTRO_TEXT) + 18;
  const pauses = Object.values(PAUSE).reduce((a, b) => a + b, 0) + PAUSE.beforeChime + PAUSE.afterChime;
  return wordsToSeconds(words, wpm) + pauses + 2 * 1.2;
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
  const input = {
    sections,
    targetSeconds: req.minutes === null ? null : req.minutes * 60,
    wpm,
    fixedSeconds: fixedSecondsEstimate(info.title, wpm),
  };
  let plan = planWalk(input);
  let planSections = sections;
  if (plan.mode === 'condensed') {
    planSections = groupSections(sections, plan.budgetWords ?? 0);
    if (planSections !== sections) plan = planWalk({ ...input, sections: planSections });
    const { scores } = await scoreSections(info.title, planSections);
    if (scores) plan = { ...planWalk({ ...input, sections: planSections, scores }), scored: true };
  }
  await writeJson(dir, 'plan-sections.json', planSections);
  await writeJson(dir, 'plan.json', plan);
  return { plan, planSections };
}

interface RewriteState {
  sections: Record<string, ScriptSection>;
  question?: { text: string | null; seconds: number };
}

/** The text the closing question is drawn from: the source if it fits, else the script. */
function questionSource(sections: Section[], script: ScriptSection[]): string {
  const source = sections
    .map((s) => [s.heading, ...s.blocks.map((b) => (b.kind === 'code' || b.kind === 'table' ? '' : readAsWritten(b)))].filter(Boolean).join('\n'))
    .join('\n\n');
  if (fitsQuestionRequest(source)) return source;
  return script.map((s) => s.text).join('\n\n');
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
    const wordsSoFar = sections.slice(0, i).reduce((n, s) => n + (state.sections[s.id]?.words ?? 0), 0);
    const targetWords = carriedTarget(plan, i, wordsSoFar);
    state.sections[section.id] = await rewriteSection(section, { ...planned, targetWords }, { title: info.title, signal });
    await writeJson(dir, 'rewrite.json', state);
  }
  const done = sections.map((s) => state.sections[s.id]!);
  if (!state.question) {
    onProgress({ stage: 'rewrite', state: 'active', done: total, total, detail: 'A question for the last stretch' });
    const q = await closingQuestion(info.title, questionSource(sections, done));
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
  const app: [keyof VoiceState['app'], string][] = [
    ['halfway', HALFWAY_TEXT],
    ['outro', OUTRO_TEXT],
  ];
  if (script.question) app.push(['question', `${QUESTION_LEAD} ${script.question}`]);
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

/** Lengths in samples of everything around the content, from what is already voiced. */
function layout(voice: VoiceState, script: Script, chime: number, title: string, wpm: number) {
  const content =
    script.sections.reduce((n, s) => n + (voice.sections[s.id]?.samples ?? 0), 0) + toSamples(SECTION_GAP) * (script.sections.length - 1);
  const cue = toSamples(PAUSE.beforeChime) + chime + toSamples(PAUSE.afterChime) + (voice.app.halfway?.samples ?? 0) + toSamples(PAUSE.afterCue);
  const after =
    toSamples(PAUSE.beforeChime) + chime + toSamples(PAUSE.afterChime) +
    (voice.app.question ? voice.app.question.samples + toSamples(PAUSE.beforeOutro) : 0) +
    (voice.app.outro?.samples ?? 0) + toSamples(PAUSE.tail);
  const intro = toSamples(wordsToSeconds(countWords(introText(20, title)), wpm) + PAUSE.afterIntro);
  return { content, cue, after, intro, total: content + cue + after + intro };
}

interface FitState {
  decision: FitDecision | null;
  beforeSeconds: number;
  done: boolean;
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
    const beforeSeconds = layout(voice, script, chime.length, info.title, plan.wpm).total / SAMPLE_RATE;
    const decision = decideFit(
      plan.targetSeconds,
      beforeSeconds,
      script.sections.map((s, i) => ({
        id: s.id,
        treatment: s.treatment,
        words: s.words,
        fullWords: plan.sections[i]?.fullWords ?? s.words,
        seconds: (voice.sections[s.id]?.samples ?? 0) / SAMPLE_RATE,
      })),
    );
    fit = { decision, beforeSeconds: Math.round(beforeSeconds * 10) / 10, done: decision === null };
    await writeJson(dir, 'fit.json', fit);
    if (!decision) return { script, fit };
  }
  const decision = fit.decision!;
  const i = script.sections.findIndex((s) => s.id === decision.sectionId);
  const old = script.sections[i]!;
  const verb = decision.toWords < decision.fromWords ? 'Shortening' : 'Lengthening';
  onProgress({ stage: 'voice', state: 'active', done: script.sections.length, total: script.sections.length, detail: `${verb} ${sectionLabel(old)} to fit the walk` });
  const redone = await rewriteSection(sections[i]!, { ...plan.sections[i]!, treatment: 'condensed', targetWords: decision.toWords }, { title: info.title, signal });
  fit = { ...fit, done: true, section: { ...redone, modelSeconds: old.modelSeconds + redone.modelSeconds, modelCalls: old.modelCalls + redone.modelCalls } };
  await writeJson(dir, 'fit.json', fit);
  const next = applyFit(script, fit);
  await writeJson(dir, 'script.json', next);
  return { script: next, fit };
}

async function loadSamples(dir: string, v: VoicedFile): Promise<Float32Array> {
  return decodeWav(await fs.readFile(path.join(dir, v.file))).samples;
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

  const lengths = layout(voice, script, chime.length, info.title, plan.wpm);
  const cueLength = lengths.cue;
  const afterLength = lengths.after;
  // The intro names the length, so it is voiced once the rest is measured.
  const minutes = Math.max(1, Math.round(lengths.total / SAMPLE_RATE / 60));
  const first = voice.sections[script.sections[0]!.id]!;
  const hasHalfway = script.sections.length > 1 || first.boundaries.length > 0;
  const intro = introText(minutes, info.title, hasHalfway);
  if (voice.app.intro?.text !== intro) {
    const started = Date.now();
    voice.app.intro = await voiceTo(dir, 'app-intro.wav', intro, req.voice, signal);
    voice.seconds += (Date.now() - started) / 1000;
    await writeJson(dir, 'voice.json', voice);
  }
  onProgress({ stage: 'voice', state: 'done', done: script.sections.length, total: script.sections.length });
  onProgress({ stage: 'pack', state: 'active' });
  const introAudio = await loadSamples(dir, voice.app.intro);
  const pieces = await Promise.all(script.sections.map((s) => loadSamples(dir, voice.sections[s.id]!)));

  const spot = placeHalfway({
    before: introAudio.length + toSamples(PAUSE.afterIntro),
    pieces: pieces.map((p, i) => ({ length: p.length, boundaries: voice.sections[script.sections[i]!.id]!.boundaries })),
    gap: toSamples(SECTION_GAP),
    cue: cueLength,
    after: afterLength,
  });

  const parts: Float32Array[] = [];
  const segments: Segment[] = [];
  let at = 0;
  const push = (audio: Float32Array, seg?: Omit<Segment, 'start' | 'end'>) => {
    if (seg) segments.push({ ...seg, start: at / SAMPLE_RATE, end: (at + audio.length) / SAMPLE_RATE });
    parts.push(audio);
    at += audio.length;
  };
  const cueAt: { seconds: number | null } = { seconds: null };
  const pushCue = () => {
    push(silence(PAUSE.beforeChime));
    cueAt.seconds = at / SAMPLE_RATE;
    push(concatAudio([chime, silence(PAUSE.afterChime), halfwayAudio]), { kind: 'app', role: 'halfway', label: 'Halfway cue' });
    push(silence(PAUSE.afterCue));
  };

  push(introAudio, { kind: 'app', role: 'intro', label: 'Intro' });
  push(silence(PAUSE.afterIntro));
  script.sections.forEach((s, i) => {
    if (i > 0) push(silence(SECTION_GAP));
    const audio = pieces[i]!;
    const label = sectionLabel(s);
    if (spot && spot.piece === i && spot.offset > 0) {
      push(audio.subarray(0, spot.offset), { kind: 'source', label, sectionId: s.id });
      pushCue();
      push(audio.subarray(spot.offset), { kind: 'source', label, sectionId: s.id });
    } else {
      if (spot && spot.piece === i && i > 0) pushCue();
      push(audio, { kind: 'source', label, sectionId: s.id });
    }
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

  const halfwaySeconds = cueAt.seconds;
  const finalAudio = concatAudio(parts);
  const actualSeconds = seconds(finalAudio);
  const wavPath = path.join(dir, 'final.wav');
  await writeFileAtomic(wavPath, encodeWav(finalAudio));
  const date = createdAt.slice(0, 10);
  await encodeMp3(wavPath, path.join(dir, 'final.mp3'), { title: info.title, date, comment: 'Made on this computer with Gemma and Kokoro' });
  await fs.rm(wavPath, { force: true });
  const bytes = (await fs.stat(path.join(dir, 'final.mp3'))).size;
  await writeJson(dir, 'timeline.json', { seconds: actualSeconds, halfwaySeconds, segments });

  const scriptText = [
    `${info.title}`,
    `Walk Edition, ${clock(actualSeconds)}${halfwaySeconds !== null ? `, halfway cue at ${clock(halfwaySeconds)}` : ''}`,
    '',
    `[${clock(0)}] The app: ${intro}`,
    '',
    ...script.sections.flatMap((s) => {
      const seg = segments.find((g) => g.sectionId === s.id);
      const head = `[${clock(seg?.start ?? 0)}] ${sectionLabel(s)} (${s.coverage})${s.checkNumbers.length ? ` check numbers: ${s.checkNumbers.join(', ')}` : ''}`;
      return [head, s.text, ''];
    }),
    ...(halfwaySeconds !== null ? [`[${clock(halfwaySeconds)}] The app, after a chime: ${HALFWAY_TEXT}`, ''] : []),
    ...(script.question ? [`The app, a question for the last stretch: ${QUESTION_LEAD} ${script.question}`, ''] : []),
    `The app: ${OUTRO_TEXT}`,
    '',
  ].join('\n');
  await writeFileAtomic(path.join(dir, 'script.txt'), scriptText);

  const cfg = loadConfig();
  // The file name says how long the walk is: the target when it was condensed to fit, else the measured length.
  const fileMinutes = plan.mode === 'condensed' && req.minutes ? req.minutes : Math.max(1, Math.round(actualSeconds / 60));
  const meta: Meta = {
    id,
    title: info.title,
    createdAt,
    finishedAt: nowIso(),
    source: { kind: info.kind, url: info.url, byline: info.byline },
    mode: plan.mode,
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

  let voice = await stageVoice(dir, req, script, onProgress, signal);
  const fitted = await stageFit(dir, info, planSections, plan, script, voice, onProgress, signal);
  if (fitted.script !== script) voice = await stageVoice(dir, req, fitted.script, onProgress, signal);
  return stagePack(id, dir, req, info, plan, fitted.script, voice, createdAt, fitted.fit, onProgress, signal);
}
