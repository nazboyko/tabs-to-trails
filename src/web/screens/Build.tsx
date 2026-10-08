import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Health, type SourcePayload, type Voice, type VoiceKey, type WalkList } from '../api';
import { ScreenTitle } from '../common';
import { clock, countWords, words } from '../format';
import { Arrow, Cross, FileUp, Grip, Lock, MoveDown, MoveUp, Notice, Play, Stop } from '../icons';
import { MAX_PIECES, moveItem, parseLinks, roomFor, sourceName } from '../pieces';
import { navigate, onLink } from '../router';
import { Setup } from './Setup';

type Tab = 'link' | 'text' | 'file';
type Length = '10' | '20' | '30' | '45' | '60' | 'whole';

const LENGTHS: { key: Length; label: string; hint: string }[] = [
  { key: '10', label: '10 min', hint: 'A lap around the block.' },
  { key: '20', label: '20 min', hint: 'Long enough to clear your head.' },
  { key: '30', label: '30 min', hint: 'A proper walk.' },
  { key: '45', label: '45 min', hint: 'Room for a long read, or a few short ones. A second cue says how much is left.' },
  { key: '60', label: '60 min', hint: 'An hour out. A second cue at three quarters says how much is left.' },
  { key: 'whole', label: 'Whole thing', hint: 'As long as it takes. Nothing gets cut.' },
];

interface Queued {
  id: number;
  source: SourcePayload;
}

/** "Link", or "Text · 340 words": what a list item is, next to its name. */
function kindLine(source: SourcePayload): string {
  if (source.kind === 'url') return 'Link';
  return `${source.kind === 'file' ? 'File' : 'Text'} · ${words(countWords(source.text))} words`;
}

const FALLBACK_VOICES: Voice[] = [
  { key: 'heart', name: 'Heart', accent: 'American' },
  { key: 'michael', name: 'Michael', accent: 'American' },
  { key: 'emma', name: 'Emma', accent: 'British' },
  { key: 'george', name: 'George', accent: 'British' },
];

export const LINK_ERROR_KEY = 't2t-link-error';
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows can refuse storage; the choice just is not remembered.
  }
}

export function Build() {
  const params = new URLSearchParams(location.search);
  const [health, setHealth] = useState<Health | null>(null);
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'text' ? 'text' : 'link');
  const [links, setLinks] = useState(params.get('url') ?? '');
  const [queue, setQueue] = useState<Queued[]>([]);
  const [queueNote, setQueueNote] = useState('');
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);
  const [linkError, setLinkError] = useState<string | null>(() => {
    try {
      const msg = sessionStorage.getItem(LINK_ERROR_KEY);
      sessionStorage.removeItem(LINK_ERROR_KEY);
      return msg;
    } catch {
      return null;
    }
  });
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [length, setLength] = useState<Length>(() => remembered('t2t-length', ['10', '20', '30', '45', '60', 'whole'] as const, '20'));
  const [voice, setVoice] = useState<VoiceKey>(() => remembered('t2t-voice', ['heart', 'michael', 'emma', 'george'] as const, 'heart'));
  const [voices, setVoices] = useState<Voice[]>(FALLBACK_VOICES);
  const [preview, setPreview] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [list, setList] = useState<WalkList | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [bookmarkHint, setBookmarkHint] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const bookmarkRef = useRef<HTMLAnchorElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(1);
  // After a move or a removal, focus goes to this element (by id), so the keyboard stays in the list.
  const focusNext = useRef<string | null>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    api.health().then(setHealth, () => setHealth({ ready: false, ollama: 'unreachable', model: 'gemma4:e4b', voice: 'download', ffmpeg: true }));
    api.voices().then(setVoices, () => undefined);
    api.walks().then(setList, () => undefined);
    return () => audioRef.current?.pause();
  }, []);

  useEffect(() => {
    // The bookmarklet is a javascript: link, which React will not render as an href.
    const link = bookmarkRef.current;
    if (!link) return;
    const code = `javascript:(()=>{window.open('${location.origin}/?url='+encodeURIComponent(location.href))})()`;
    link.setAttribute('href', code);
  }, [health]);

  useEffect(() => {
    if (!focusNext.current) return;
    document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  }, [queue]);

  useEffect(() => {
    if (!params.get('url') || !health?.ready) return;
    // Back from a link that could not be read: the field and its error come first.
    // Arriving from the bookmarklet: the link is filled in, so the button is next.
    if (linkError) urlInput.current?.focus();
    else submitRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health?.ready]);

  if (!health) return <div className="page" aria-busy="true" />;
  if (!health.ready) return <Setup health={health} onReady={setHealth} />;

  const voiceName = voices.find((v) => v.key === voice)?.name ?? 'Heart';
  const lengthHint = LENGTHS.find((l) => l.key === length)!.hint;

  const pickTab = (t: Tab) => {
    setTab(t);
    setFormError(null);
  };

  const pickLength = (l: Length) => {
    setLength(l);
    remember('t2t-length', l);
  };

  const pickVoice = (v: VoiceKey) => {
    setVoice(v);
    remember('t2t-voice', v);
    audioRef.current?.pause();
    setPreview('idle');
  };

  const togglePreview = async () => {
    setPreviewError(null);
    if (preview !== 'idle') {
      audioRef.current?.pause();
      setPreview('idle');
      return;
    }
    setPreview('loading');
    const audio = new Audio(`/api/voices/${voice}/preview`);
    audioRef.current?.pause();
    audioRef.current = audio;
    audio.onended = () => setPreview('idle');
    audio.onerror = () => {
      setPreview('idle');
      setPreviewError(`${voiceName} couldn't start. The voice downloads on first use, so check the connection and try again.`);
    };
    try {
      await audio.play();
      setPreview('playing');
    } catch {
      setPreview('idle');
    }
  };

  const readFile = async (f: File) => {
    setFileError(null);
    if (!/\.(md|markdown|txt)$/i.test(f.name)) {
      setFile(null);
      setFileError('Only .md and .txt files can be read. Paste the text instead.');
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      setFile(null);
      setFileError('That file is larger than 2 MB. Paste a part of it instead.');
      return;
    }
    setFile({ name: f.name, text: await f.text() });
  };

  /** What is typed or chosen in the open tab, not yet in the list. */
  const pending = (): SourcePayload[] => {
    if (tab === 'link') return parseLinks(links).map((url) => ({ kind: 'url', url }));
    if (tab === 'text') return countWords(pasteText) ? [{ kind: 'text', text: pasteText, title: pasteTitle.trim() || undefined }] : [];
    return file ? [{ kind: 'file', name: file.name, text: file.text }] : [];
  };

  const emptyMessage = tab === 'link' ? 'Paste a link to an article first.' : tab === 'text' ? 'Paste some text first.' : 'Choose a .md or .txt file first.';
  const focusField = () => (tab === 'link' ? urlInput : tab === 'text' ? textInput : chooseRef).current?.focus();

  const clearPending = () => {
    if (tab === 'link') setLinks('');
    else if (tab === 'text') {
      setPasteText('');
      setPasteTitle('');
    } else setFile(null);
  };

  const addToWalk = () => {
    const adding = pending();
    const problem = adding.length ? roomFor(queue.length, adding.length) : emptyMessage;
    if (problem) {
      setFormError(problem);
      focusField();
      return;
    }
    setFormError(null);
    setLinkError(null);
    const added = adding.map((source) => ({ id: nextId.current++, source }));
    setQueue([...queue, ...added]);
    clearPending();
    const what = added.length === 1 ? sourceName(added[0]!.source) : `${added.length} links`;
    setQueueNote(`Added ${what}. ${queue.length + added.length} of ${MAX_PIECES} pieces in this walk.`);
    focusField();
  };

  const move = (from: number, to: number, keep?: 'up' | 'down') => {
    if (to < 0 || to >= queue.length || from === to) return;
    const item = queue[from]!;
    const next = moveItem(queue, from, to);
    // The button that was pressed keeps focus, unless the item reached the end it was moving to.
    if (keep) {
      const atEnd = keep === 'up' ? to === 0 : to === next.length - 1;
      focusNext.current = `queued-${item.id}-${atEnd ? (keep === 'up' ? 'down' : 'up') : keep}`;
    }
    setQueue(next);
    setQueueNote(`Moved ${sourceName(item.source)} to number ${to + 1} of ${next.length}.`);
  };

  const remove = (index: number) => {
    const item = queue[index]!;
    const next = queue.filter((_, i) => i !== index);
    const neighbour = next[index] ?? next[index - 1];
    focusNext.current = neighbour ? `queued-${neighbour.id}-remove` : null;
    setQueue(next);
    setQueueNote(`Removed ${sourceName(item.source)}. ${next.length ? `${next.length} left in this walk.` : 'The list is empty.'}`);
    if (!neighbour) focusField();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const extra = pending();
    // Whatever is still in the open tab goes at the end of the list.
    const problem = extra.length ? roomFor(queue.length, extra.length) : queue.length ? null : emptyMessage;
    if (problem) {
      setFormError(problem);
      focusField();
      return;
    }
    const sources = [...queue.map((q) => q.source), ...extra];
    setBusy(true);
    setFormError(null);
    setLinkError(null);
    try {
      const { id } = await api.build(sources, length === 'whole' ? null : Number(length), voice);
      navigate(`/walk/${id}`);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.body.setup) {
        setHealth(await api.health().catch(() => health));
        return;
      }
      const message = err instanceof Error ? err.message : 'Something went wrong. Try again.';
      if (tab === 'link' && !queue.length && extra.length === 1 && err instanceof ApiError && err.status === 400) setLinkError(message);
      else setFormError(message);
    }
  };

  const pendingCount = pending().length;
  const addLabel = tab === 'link' && pendingCount > 1 ? `Add ${pendingCount} links to the walk` : 'Add to the walk';
  const addButton = (
    <button type="button" className="btn add" onClick={addToWalk} disabled={queue.length >= MAX_PIECES}>
      {addLabel}
    </button>
  );

  const recent = list?.walks.slice(0, 5) ?? [];
  const textWords = countWords(pasteText);

  return (
    <div className="page">
      <div className="stack hero">
        <ScreenTitle title="Build a Walk Edition">Turn your reading backlog into a walk.</ScreenTitle>
        <p className="lede">Give it something you keep meaning to read. It makes an MP3 sized to your walk, right here on this computer.</p>
      </div>

      {list?.active && (
        <p className="small" role="status">
          Still making {list.active.title ?? 'a Walk Edition'}.{' '}
          <a href={`/walk/${list.active.id}`} onClick={onLink}>
            See how it's going
          </a>
        </p>
      )}

      <form className="card stack" style={{ gap: 28 }} onSubmit={submit} noValidate>
        <div className="stack" style={{ gap: 16 }}>
          <div className="segmented" role="group" aria-label="What to read">
            {(
              [
                ['link', 'Link'],
                ['text', 'Text'],
                ['file', 'File'],
              ] as const
            ).map(([key, label]) => (
              <button key={key} type="button" aria-pressed={tab === key} onClick={() => pickTab(key)}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'link' && (
            <div className="field">
              <label htmlFor="src-url">Link to an article</label>
              <textarea
                ref={urlInput}
                id="src-url"
                className="input links"
                rows={Math.min(MAX_PIECES, Math.max(1, links.split('\n').length))}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://"
                value={links}
                aria-describedby={linkError ? 'link-error' : 'link-help'}
                aria-invalid={linkError ? true : undefined}
                onChange={(e) => {
                  setLinks(e.target.value);
                  setLinkError(null);
                }}
                onKeyDown={(e) => {
                  // Enter starts a new line for the next link; Ctrl or Cmd with Enter makes the walk.
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              {linkError ? (
                <div className="alert-box" role="alert" id="link-error">
                  <div className="msg">
                    <Notice size={20} />
                    <div>
                      {linkError.startsWith("I couldn't find a readable article") ? (
                        <>
                          <strong>I couldn't find a readable article on this page.</strong> It may need a login or load its text with scripts.
                          Copy the text from the page and paste it instead.
                        </>
                      ) : (
                        linkError
                      )}
                    </div>
                  </div>
                  <button type="button" className="btn" onClick={() => pickTab('text')}>
                    Paste the text instead
                  </button>
                </div>
              ) : (
                <p className="small" id="link-help">
                  Up to {MAX_PIECES} links, one per line, read in that order. Each page is fetched once. After that everything happens offline.
                </p>
              )}
              {addButton}
            </div>
          )}

          {tab === 'text' && (
            <div className="field">
              <label htmlFor="src-title">
                Title <span className="optional">(optional)</span>
              </label>
              <input id="src-title" className="input" type="text" style={{ height: 48 }} value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} />
              <label htmlFor="src-text" style={{ marginTop: 6 }}>
                Text
              </label>
              <textarea ref={textInput} id="src-text" className="textarea" rows={6} value={pasteText} aria-describedby="text-help" onChange={(e) => setPasteText(e.target.value)} />
              <div className="field-foot" id="text-help">
                <span>
                  <Lock />
                  Works with the internet off. What you paste stays here.
                </span>
                <span className="mono" style={{ fontSize: 13 }}>
                  {words(textWords)} {textWords === 1 ? 'word' : 'words'}
                </span>
              </div>
              {addButton}
            </div>
          )}

          {tab === 'file' && (
            <div
              className={`dropzone${dragOver ? ' over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files[0];
                if (f) void readFile(f);
              }}
            >
              <FileUp />
              {file ? (
                <>
                  <strong>{file.name}</strong>
                  <span className="mono" style={{ fontSize: 13, color: 'var(--muted)' }}>
                    {words(countWords(file.text))} words
                  </span>
                </>
              ) : (
                <strong>Drop a .md or .txt file here</strong>
              )}
              <input
                ref={fileInput}
                id="src-file"
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                className="visually-hidden"
                tabIndex={-1}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void readFile(f);
                  e.target.value = '';
                }}
              />
              <button ref={chooseRef} type="button" className="btn" style={{ minHeight: 44, fontSize: 15 }} onClick={() => fileInput.current?.click()}>
                {file ? 'Choose another file' : 'Choose a file'}
              </button>
              {fileError ? (
                <p className="small" role="alert" style={{ color: 'var(--error-text)' }}>
                  {fileError}
                </p>
              ) : (
                <p className="small">Notes, drafts, docs you're allowed to process on your own machine.</p>
              )}
            </div>
          )}
          {tab === 'file' && addButton}
        </div>

        {queue.length > 0 && (
          <section className="queue" aria-labelledby="queue-title">
            <h2 id="queue-title" className="legend">
              In this walk, in this order <span className="optional">({queue.length} of {MAX_PIECES})</span>
            </h2>
            <ol>
              {queue.map((q, i) => {
                const name = sourceName(q.source);
                return (
                  <li
                    key={q.id}
                    className={dragFrom === i ? 'dragging' : dragTo === i && dragFrom !== null ? (dragFrom < i ? 'over-below' : 'over-above') : undefined}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', String(i));
                      setDragFrom(i);
                    }}
                    onDragOver={(e) => {
                      if (dragFrom === null) return;
                      e.preventDefault();
                      setDragTo(i);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragFrom !== null) move(dragFrom, i);
                      setDragFrom(null);
                      setDragTo(null);
                    }}
                    onDragEnd={() => {
                      setDragFrom(null);
                      setDragTo(null);
                    }}
                  >
                    <span className="grip" aria-hidden="true">
                      <Grip color="#8C9488" />
                    </span>
                    <span className="n" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className="what">
                      <span className="name">{name}</span>
                      <span className="kind">{kindLine(q.source)}</span>
                    </span>
                    <span className="moves">
                      <button id={`queued-${q.id}-up`} type="button" className="icon-btn" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, i - 1, 'up')}>
                        <MoveUp />
                      </button>
                      <button
                        id={`queued-${q.id}-down`}
                        type="button"
                        className="icon-btn"
                        aria-label={`Move ${name} down`}
                        disabled={i === queue.length - 1}
                        onClick={() => move(i, i + 1, 'down')}
                      >
                        <MoveDown />
                      </button>
                      <button id={`queued-${q.id}-remove`} type="button" className="icon-btn" aria-label={`Remove ${name}`} onClick={() => remove(i)}>
                        <Cross />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="small">
              Drag to change the order, or use the arrows. {pendingCount > 0 ? 'What is still in the box above goes last.' : 'Each piece gets a share of the time that matches its length.'}
            </p>
          </section>
        )}
        <p className="visually-hidden" aria-live="polite">
          {queueNote}
        </p>

        <fieldset>
          <legend className="legend">How long is your walk?</legend>
          <div className="pills lengths">
            {LENGTHS.map((l) => (
              <button key={l.key} type="button" className="pill" aria-pressed={length === l.key} onClick={() => pickLength(l.key)}>
                {l.label}
              </button>
            ))}
          </div>
          <p className="small" aria-live="polite">
            {lengthHint}
          </p>
        </fieldset>

        <fieldset>
          <legend className="legend">Voice</legend>
          <div className="pills">
            {voices.map((v) => (
              <button key={v.key} type="button" className="pill voice" aria-pressed={voice === v.key} onClick={() => pickVoice(v.key)}>
                <span>{v.name}</span>
                <small>{v.accent}</small>
              </button>
            ))}
          </div>
          <button type="button" className="link-button" style={{ alignSelf: 'flex-start' }} onClick={togglePreview} aria-live="polite">
            {preview === 'idle' && (
              <>
                <Play /> Hear {voiceName} for ten seconds
              </>
            )}
            {preview === 'loading' && <>Getting {voiceName} ready…</>}
            {preview === 'playing' && (
              <>
                <Stop /> Stop {voiceName}
              </>
            )}
          </button>
          {previewError && (
            <p className="small" role="alert">
              {previewError}
            </p>
          )}
        </fieldset>

        <div className="stack" style={{ gap: 12 }}>
          {formError && (
            <p className="small" role="alert" style={{ color: 'var(--error-text)', fontWeight: 600 }}>
              {formError}
            </p>
          )}
          <button ref={submitRef} type="submit" className="btn primary block" disabled={busy}>
            {busy ? 'Starting…' : 'Make my Walk Edition'}
            {!busy && <Arrow />}
          </button>
          <p className="small center">Takes a few minutes. Enough time to find your shoes.</p>
        </div>
      </form>

      <section className="stack recent" style={{ gap: 12 }} aria-labelledby="recent-title">
        <h2 id="recent-title" className="section-title">
          Recent walks
        </h2>
        {list && recent.length === 0 && <p className="empty">No Walk Editions yet. Your first one will appear here.</p>}
        {recent.length > 0 && (
          <ul>
            {recent.map((w) => (
              <li key={w.id}>
                <a href={`/walk/${w.id}`} onClick={onLink}>
                  <span className="title">{w.title}</span>
                  <span className="time">{clock(w.actualSeconds)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bookmarklet" aria-label="Bookmarklet">
        <a
          ref={bookmarkRef}
          draggable
          onClick={(e) => {
            e.preventDefault();
            setBookmarkHint(true);
          }}
        >
          <Grip />
          Walk this tab
        </a>
        <p>
          {bookmarkHint ? (
            <span role="status">Drag the button to your bookmarks bar instead of clicking it here. Then click it on any article.</span>
          ) : (
            'Drag this button to your bookmarks bar. Click it on any article to send that tab here.'
          )}
        </p>
      </section>

      <p className="small center">No account. No cloud. The model and the voice both run on this computer.</p>
    </div>
  );
}
