import './fonts';
import './styles.css';
import './phone.css';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clock, megabytes } from './format';
import { Back, Download, Logo, Pause, Play, PlayFilled, Tick } from './icons';
import { lineAt } from './readalong';

interface Info {
  title: string;
  actualSeconds: number;
  halfwaySeconds: number | null;
  threeQuarterSeconds?: number | null;
  bytes: number;
  fileName: string;
  chapters: { label: string; start: number }[];
  /** The pieces of a playlist walk; empty for a single source. */
  pieces?: { title: string; start: number; seconds: number }[];
}

type View = 'home' | 'downloaded' | 'loading' | 'playing';

interface Timings {
  sections: { id: string; label: string; start: number }[];
  lines: { start: number; end: number; text: string; speaker: 'source' | 'app'; section?: string; para?: number }[];
}

/** Where this walk was left, kept on the phone so a reopened page can offer to continue. */
const placeKey = (id: string) => `t2t-place-${id}`;

function savedPlace(id: string): number | null {
  try {
    const t = Number(localStorage.getItem(placeKey(id)));
    return Number.isFinite(t) && t > 10 ? t : null;
  } catch {
    return null;
  }
}

function keepPlace(id: string, t: number | null): void {
  try {
    if (t === null) localStorage.removeItem(placeKey(id));
    else localStorage.setItem(placeKey(id), String(Math.round(t)));
  } catch {
    // Private windows can refuse storage; the walk plays from the start next time.
  }
}

function walkFromLocation(): { id: string; token: string } {
  const path = location.pathname.match(/^\/w\/([a-f0-9]{12})/);
  const q = new URLSearchParams(location.search);
  return { id: path?.[1] ?? q.get('id') ?? '', token: q.get('t') ?? '' };
}

/** 0.1 s of silence, played inside the tap so the browser lets the real audio start later. */
function silentWav(): string {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function Brand() {
  return (
    <div className="brand">
      <Logo size={24} />
      Tabs to Trails
    </div>
  );
}

function useFocusHeading(view: View) {
  const ref = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    ref.current?.focus();
  }, [view]);
  return ref;
}

function Phone() {
  const { id, token } = walkFromLocation();
  const base = `/w/${id}`;
  const query = `t=${encodeURIComponent(token)}`;
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('home');
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);
  const [timings, setTimings] = useState<Timings | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [resumeAt, setResumeAt] = useState<number | null>(() => savedPlace(walkFromLocation().id));
  // Where to start once the audio can seek: a continue, or a jump chosen before it loaded.
  const startAt = useRef<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const blobUrl = useRef<string | null>(null);
  const loader = useRef<AbortController | null>(null);
  const heading = useFocusHeading(view);

  useEffect(() => {
    fetch(`${base}/info?${query}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? 'This walk could not be opened.');
        setInfo(body as Info);
        document.title = `${(body as Info).title} · Tabs to Trails`;
        // Fetched now, on the home Wi-Fi, so "Find my place" works on the walk.
        fetch(`${base}/timings?${query}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((t: Timings | null) => setTimings(t), () => undefined);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'This walk could not be opened.'));
    return () => {
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.body.classList.toggle('walking', view === 'playing');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', view === 'playing' ? '#1E3A2B' : '#F5F0E6');
  }, [view]);

  const element = (): HTMLAudioElement => {
    if (audio.current) return audio.current;
    const a = new Audio();
    a.preload = 'auto';
    let lastKept = 0;
    a.addEventListener('timeupdate', () => {
      setNow(a.currentTime);
      // Every five seconds, so a page closed by accident can offer to continue.
      if (Math.abs(a.currentTime - lastKept) >= 5 && !a.src.startsWith('data:')) {
        lastKept = a.currentTime;
        keepPlace(id, a.currentTime);
      }
    });
    a.addEventListener('loadedmetadata', () => {
      // Not on the silent clip that unlocks playback: only the walk itself can seek.
      if (startAt.current !== null && !a.src.startsWith('data:')) {
        a.currentTime = startAt.current;
        startAt.current = null;
      }
    });
    a.addEventListener('play', () => setPlaying(true));
    a.addEventListener('pause', () => {
      setPlaying(false);
      if (a.currentTime > 1 && !a.ended) keepPlace(id, a.currentTime);
    });
    a.addEventListener('ended', () => {
      setPlaying(false);
      keepPlace(id, null);
      setResumeAt(null);
    });
    audio.current = a;
    return a;
  };

  const startPlaying = (a: HTMLAudioElement, src: string) => {
    a.src = src;
    setView('playing');
    if (info && 'mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: info.title, artist: 'Tabs to Trails', album: 'Walk Edition' });
      navigator.mediaSession.setActionHandler('play', () => void a.play());
      navigator.mediaSession.setActionHandler('pause', () => a.pause());
      navigator.mediaSession.setActionHandler('seekbackward', () => (a.currentTime = Math.max(0, a.currentTime - 15)));
      navigator.mediaSession.setActionHandler('seekforward', () => (a.currentTime = Math.min(a.duration || Infinity, a.currentTime + 15)));
    }
    void a.play().catch(() => setPlaying(false));
  };

  const playHere = async (from: number | null = null) => {
    const a = element();
    startAt.current = from;
    if (blobUrl.current) {
      startPlaying(a, blobUrl.current);
      return;
    }
    // Inside the tap: unlock playback, since the real start comes after the download.
    // A fast download can start the walk before this resolves; only the silence is paused.
    const silent = silentWav();
    a.src = silent;
    void a.play().then(() => {
      if (a.src === silent) a.pause();
    }, () => undefined);
    setView('loading');
    setReceived(0);
    const controller = new AbortController();
    loader.current = controller;
    try {
      const res = await fetch(`${base}/audio?${query}`, { signal: controller.signal });
      if (res.status === 404) {
        setError('This walk is no longer on the computer. Make it again there and scan the new code.');
        return;
      }
      if (!res.ok || !res.body) throw new Error('download failed');
      const size = Number(res.headers.get('content-length')) || info?.bytes || 0;
      setTotal(size);
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        setReceived(got);
      }
      const blob = new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
      blobUrl.current = URL.createObjectURL(blob);
      setLoaded(true);
      setStreaming(false);
      startPlaying(a, blobUrl.current);
    } catch {
      if (controller.signal.aborted) {
        setView('home');
        return;
      }
      // The phone would not hold the file; play over the network and say so.
      setStreaming(true);
      startPlaying(a, `${base}/audio?${query}`);
    }
  };

  const cancelLoading = () => {
    loader.current?.abort();
    setView('home');
  };

  const leavePlayer = () => {
    audio.current?.pause();
    setView('home');
  };

  const skip = (delta: number) => {
    const a = audio.current;
    if (!a) return;
    a.currentTime = Math.min(Math.max(0, a.currentTime + delta), a.duration || a.currentTime + delta);
  };

  const jumpTo = (t: number) => {
    const a = audio.current;
    if (!a) return;
    a.currentTime = t;
    setNow(t);
    if (a.paused) void a.play();
  };

  const togglePlay = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };

  if (error) {
    return (
      <div className="phone">
        <Brand />
        <div className="middle">
          <h1 className="smaller">This walk can't be opened.</h1>
          <p className="lede">{error}</p>
        </div>
      </div>
    );
  }
  if (!info) return <div className="phone" aria-busy="true" />;

  const download = `${base}/audio?${query}&download=1`;

  if (view === 'playing') {
    const length = audio.current?.duration && Number.isFinite(audio.current.duration) ? audio.current.duration : info.actualSeconds;
    const pct = Math.min(100, (now / length) * 100);
    const half = info.halfwaySeconds === null ? null : (info.halfwaySeconds / length) * 100;
    const threeQuarter = info.threeQuarterSeconds ? (info.threeQuarterSeconds / length) * 100 : null;
    const pieces = info.pieces ?? [];
    // In a playlist, "Now" names the piece; in a single source, the section.
    const pieceNow = pieces.findLastIndex((p) => p.start <= now + 0.5);
    const chapter = pieces.length
      ? pieceNow >= 0
        ? { label: `${pieces[pieceNow]!.title} (${pieceNow + 1} of ${pieces.length})` }
        : undefined
      : [...info.chapters].reverse().find((c) => c.start <= now + 0.5);
    return (
      <div className="phone">
        <div className="top">
          <button type="button" className="icon-btn" onClick={leavePlayer} aria-label="Back to the walk page">
            <Back color="#F5F0E6" />
          </button>
          <span style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500 }}>Tabs to Trails</span>
          <span style={{ width: 32 }} />
        </div>
        <div className="middle" style={{ gap: 20 }}>
          <h1 ref={heading} tabIndex={-1} className="pocket">
            Pocket your phone.
          </h1>
          <p className="quiet">I'll tell you when you're halfway. There's nothing else to look at here.</p>
        </div>
        <div className="stack" style={{ gap: 20 }}>
          <div className="stack" style={{ gap: 4 }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>{info.title}</div>
            {chapter && <div style={{ fontSize: 14, color: 'var(--forest-muted)' }}>Now: {chapter.label}</div>}
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <div className="track" aria-hidden="true">
              <div className="rail" />
              <div className="done" style={{ width: `${pct}%` }} />
              {half !== null && <div className="half" style={{ left: `${half}%` }} />}
              {threeQuarter !== null && <div className="half" style={{ left: `${threeQuarter}%` }} />}
              <div className="knob" style={{ left: `${pct}%` }} />
            </div>
            <div className="times">
              <span>
                <span className="visually-hidden">Played </span>
                {clock(now)}
              </span>
              {info.halfwaySeconds !== null && <span className="h">halfway {clock(info.halfwaySeconds)}</span>}
              <span>
                <span className="visually-hidden">Total </span>
                {clock(length)}
              </span>
            </div>
          </div>
          <div className="controls">
            <button type="button" className="skip" aria-label="Back 15 seconds" onClick={() => skip(-15)}>
              -15
            </button>
            <button type="button" className="main-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
              {playing ? <Pause /> : <PlayFilled />}
            </button>
            <button type="button" className="skip" aria-label="Forward 15 seconds" onClick={() => skip(15)}>
              +15
            </button>
          </div>
          <button type="button" className="link-button find-place" aria-expanded={findOpen} onClick={() => setFindOpen(!findOpen)}>
            {findOpen ? 'Close' : 'Find my place'}
          </button>
          {findOpen && timings && (
            <FindPlace timings={timings} now={now} onJump={jumpTo} />
          )}
          {findOpen && !timings && <p className="quiet small">The list of sections did not load. The player above still works.</p>}
          {loaded && !streaming ? (
            <div className="loaded" role="status">
              <Tick />
              <div>The whole walk is loaded on this phone. Wi-Fi isn't needed any more. Keep this tab open until you're home.</div>
            </div>
          ) : (
            <div className="warn" role="status">
              Playing over Wi-Fi. It may stop once you walk out of range. Download it first to be safe.
            </div>
          )}
        </div>
      </div>
    );
  }

  if (view === 'loading') {
    const pct = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
    return (
      <div className="phone">
        <Brand />
        <div className="middle" style={{ gap: 28 }}>
          <div className="stack" style={{ gap: 10 }}>
            <div className="eyebrow orange">Getting it onto this phone</div>
            <h1 ref={heading} tabIndex={-1} className="smaller">
              {info.title}
            </h1>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <div className="load-bar" role="progressbar" aria-label="Loading the audio" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <div style={{ width: `${pct}%` }} />
            </div>
            <div className="load-nums">
              <span>
                {megabytes(received)} of {megabytes(total || info.bytes)}
              </span>
              <span>{pct}%</span>
            </div>
          </div>
          <p style={{ margin: 0, fontSize: 17 }}>Stay near your computer for a few more seconds. Once the whole walk is on this phone, you won't need Wi-Fi.</p>
        </div>
        <button type="button" className="link-button" style={{ alignSelf: 'center' }} onClick={cancelLoading}>
          Cancel
        </button>
      </div>
    );
  }

  if (view === 'downloaded') {
    return (
      <div className="phone">
        <Brand />
        <div className="middle" style={{ gap: 24 }}>
          <div className="stack" style={{ gap: 10 }}>
            <div className="eyebrow orange">Download started</div>
            <h1 ref={heading} tabIndex={-1} className="smaller">
              Three more taps and you're out the door.
            </h1>
          </div>
          <ol className="steps-list">
            <li>
              <span className="n" aria-hidden="true">
                1
              </span>
              <span>Open the file from your downloads.</span>
            </li>
            <li>
              <span className="n" aria-hidden="true">
                2
              </span>
              <span>Press play.</span>
            </li>
            <li>
              <span className="n" aria-hidden="true">
                3
              </span>
              <span>Pocket the phone.</span>
            </li>
          </ol>
          <p style={{ margin: 0, fontSize: 15, color: 'var(--muted)' }}>
            I can't see your downloads from this page, so check the file is there before you leave. Once it is, you don't need Wi-Fi or this tab.
          </p>
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <a className="btn secondary" href={download} download={info.fileName}>
            Download again
          </a>
          <button type="button" className="link-button" style={{ alignSelf: 'center', minHeight: 48 }} onClick={() => void playHere()}>
            Play it here instead
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="phone">
      <Brand />
      <div className="middle" style={{ paddingBottom: 72 }}>
        <div className="eyebrow orange">Your walk is ready</div>
        <h1 ref={heading} tabIndex={-1}>
          {info.title}
        </h1>
        <div className="when">
          <span className="mono">{clock(info.actualSeconds)}</span>
          {info.halfwaySeconds !== null && <span>Halfway cue at {clock(info.halfwaySeconds)}</span>}
        </div>
        {(info.pieces?.length ?? 0) > 1 && (
          <ol className="phone-pieces">
            {info.pieces!.map((p, i) => (
              <li key={i}>
                <span className="title">{p.title}</span>
                <span className="mono">
                  <span className="visually-hidden">runs </span>
                  {clock(p.seconds)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="actions">
        <a className="btn primary" href={download} download={info.fileName} onClick={() => setView('downloaded')}>
          <Download color="#FFFFFF" size={20} />
          Download MP3
        </a>
        <p className="small center">{megabytes(info.bytes)}. Do this before you leave, while you're still on home Wi-Fi.</p>
        {resumeAt !== null && (
          <>
            <button type="button" className="btn secondary" style={{ marginTop: 4 }} onClick={() => void playHere(resumeAt)}>
              <Play />
              Continue from {clock(resumeAt)}
            </button>
            <p className="small center" style={{ marginTop: -4 }}>
              If this page closes away from home it cannot reopen until you are back on your Wi-Fi. The downloaded file always works.
            </p>
          </>
        )}
        <button type="button" className="btn secondary" style={{ marginTop: 4 }} onClick={() => void playHere()}>
          <Play />
          {resumeAt !== null ? 'Play from the start' : 'Play it here instead'}
        </button>
        <a className="link-button" style={{ alignSelf: 'center', minHeight: 48 }} href={`${base}/audiobook?${query}`} download={info.fileName.replace(/\.mp3$/, '.m4b')} onClick={() => setView('downloaded')}>
          Download as audiobook
        </a>
        <p className="small center" style={{ marginTop: -8 }}>
          Remembers your place and lets you skip by section in an audiobook app.
        </p>
      </div>
      <p className="small center" style={{ marginTop: 28, fontSize: 13 }}>
        Made on your computer. Nothing was uploaded.
      </p>
    </div>
  );
}

/** "Find my place": the sections with their times, and the text with the sentence being spoken. */
function FindPlace({ timings, now, onJump }: { timings: Timings; now: number; onJump: (t: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const current = lineAt(timings.lines, now);
  const section = [...timings.sections].reverse().find((s) => s.start <= now + 0.5);
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-line="${current}"]`);
    const parent = box.current;
    if (!el || !parent) return;
    const top = el.offsetTop - parent.offsetTop;
    if (top < parent.scrollTop || top > parent.scrollTop + parent.clientHeight - 40) parent.scrollTop = Math.max(0, top - parent.clientHeight / 3);
  }, [current]);
  return (
    <div className="find">
      <ol className="find-sections">
        {timings.sections.map((s) => (
          <li key={s.id}>
            <button type="button" aria-current={section?.id === s.id ? 'true' : undefined} onClick={() => onJump(s.start)}>
              <span>{s.label}</span>
              <span className="mono">{clock(s.start)}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="find-text" ref={box}>
        {timings.lines.map((l, i) => (
          <a
            key={i}
            href={`#t=${l.start.toFixed(1)}`}
            data-line={i}
            className={`${l.speaker === 'app' ? 'app ' : ''}${i === current ? 'on' : ''}`}
            aria-current={i === current ? 'true' : undefined}
            onClick={(e) => {
              e.preventDefault();
              onJump(l.start);
            }}
          >
            {l.text}
          </a>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Phone />
  </StrictMode>,
);
