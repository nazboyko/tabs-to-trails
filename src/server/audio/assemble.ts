import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { ffmetadata, type Chapter } from './chapters.js';
import { decodeWav, SAMPLE_RATE } from './wav.js';

const run = promisify(execFile);

export function ffmpegBinary(): string {
  if (!ffmpegPath) throw new Error('ffmpeg-static has no binary for this platform');
  return ffmpegPath as unknown as string;
}

let chime: Promise<Float32Array> | null = null;

/** Two soft sine notes, made by ffmpeg. No audio assets ship with the app. */
export function makeChime(): Promise<Float32Array> {
  if (!chime) {
    chime = (async () => {
      const filter =
        '[0]afade=t=in:d=0.01,afade=t=out:st=0.08:d=0.62,volume=0.22[a];' +
        '[1]afade=t=in:d=0.01,afade=t=out:st=0.08:d=0.92,volume=0.2,adelay=170[b];' +
        '[a][b]amix=inputs=2:duration=longest:normalize=0';
      const { stdout } = await run(
        ffmpegBinary(),
        [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'sine=frequency=659.25:duration=0.7',
          '-f', 'lavfi', '-i', 'sine=frequency=987.77:duration=1.0',
          '-filter_complex', filter,
          '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1',
        ],
        { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
      );
      return decodeWav(stdout).samples;
    })().catch((err: unknown) => {
      chime = null;
      throw err;
    });
  }
  return chime;
}

export interface Tags {
  title: string;
  date: string;
  comment?: string;
}

/** Mono 64 kbps MP3 with title, artist and date tags. */
/** The chapters go in through ffmpeg's metadata file, written next to the output and removed after. */
async function withChapters(out: string, chapters: Chapter[]): Promise<{ args: string[]; done: () => Promise<void> }> {
  if (!chapters.length) return { args: [], done: async () => undefined };
  const file = `${out}.chapters.txt`;
  await fs.writeFile(file, ffmetadata({}, chapters));
  return { args: ['-i', file, '-map', '0:a', '-map_chapters', '1'], done: () => fs.rm(file, { force: true }) };
}

export async function encodeMp3(wavPath: string, mp3Path: string, tags: Tags, chapters: Chapter[] = []): Promise<void> {
  const tmp = `${mp3Path}.part`;
  const meta = await withChapters(mp3Path, chapters);
  try {
    await run(ffmpegBinary(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', wavPath,
      ...meta.args,
      '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k',
      // ID3v2.3 with CHAP and CTOC frames: players that show chapters can skip by section.
      '-id3v2_version', '3',
      '-metadata', `title=${tags.title}`,
      '-metadata', 'artist=Tabs to Trails',
      '-metadata', 'album=Walk Editions',
      '-metadata', `date=${tags.date}`,
      ...(tags.comment ? ['-metadata', `comment=${tags.comment}`] : []),
      '-f', 'mp3', tmp,
    ]);
  } finally {
    await meta.done();
  }
  await fs.rename(tmp, mp3Path);
}

/**
 * The same walk as an audiobook: AAC in an MP4 container, mono, about the
 * MP3's bitrate, with the same chapters. Audiobook apps remember the place
 * and skip by chapter.
 */
export async function encodeAudiobook(mp3Path: string, m4bPath: string, tags: Tags, chapters: Chapter[]): Promise<void> {
  const tmp = `${m4bPath}.part`;
  const meta = await withChapters(m4bPath, chapters);
  try {
    await run(ffmpegBinary(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', mp3Path,
      ...meta.args,
      '-ac', '1', '-c:a', 'aac', '-b:a', '64k',
      '-metadata', `title=${tags.title}`,
      '-metadata', 'artist=Tabs to Trails',
      '-metadata', 'album_artist=Tabs to Trails',
      '-metadata', `album=${tags.title}`,
      '-metadata', 'genre=Audiobook',
      '-metadata', `date=${tags.date}`,
      '-movflags', '+faststart',
      '-f', 'ipod', tmp,
    ]);
  } finally {
    await meta.done();
  }
  await fs.rename(tmp, m4bPath);
}

export async function ffmpegReady(): Promise<boolean> {
  try {
    await run(ffmpegBinary(), ['-hide_banner', '-version']);
    return true;
  } catch {
    return false;
  }
}
