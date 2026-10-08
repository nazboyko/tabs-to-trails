import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Health, type ListItem, type SourcePayload, type Voice, type VoiceKey, type WalkList, type WalkPreview } from '../api';
import { ScreenTitle } from '../common';
import { clock, countWords, words } from '../format';
import { Arrow, Cross, FileUp, Grip, Lock, MoveDown, MoveUp, Notice, Play, Stop } from '../icons';
import { rowTitle, savedAgo, savedLine, things, walkTime } from '../list';
import { pickWalk } from '../pick';
import { MAX_PIECES, moveItem, parseLinks } from '../pieces';
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
  { key: 'whole', label: 'Everything', hint: 'Everything you tick, read in full. Nothing gets cut.' },
];

type Quiet = '0' | '1' | '2' | '3';
const QUIET: { key: Quiet; label: string }[] = [
  { key: '0', label: 'Off' },
  { key: '1', label: '1 min' },
  { key: '2', label: '2 min' },
  { key: '3', label: '3 min' },
];

const FALLBACK_VOICES: Voice[] = [
  { key: 'heart', name: 'Heart', accent: 'American' },
  { key: 'michael', name: 'Michael', accent: 'American' },
  { key: 'emma', name: 'Emma', accent: 'British' },
  { key: 'george', name: 'George', accent: 'British' },
];

export const LINK_ERROR_KEY = 't2t-link-error';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Rows shown before "Show all". */
const SHOWN = 20;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Home() {
  const params = useRef(new URLSearchParams(location.search)).current;
  const [health, setHealth] = useState<Health | null>(null);
  const [items, setItems] = useState<ListItem[] | null>(null);
  // Until the person ticks or unticks a row, the length picks the rows.
  const [manual, setManual] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  // After a manual change, rows saved in this visit are ticked once their check comes back, while there is room.
  const autoTick = useRef(new Set<string>());
  const [preview, setWalkPreview] = useState<WalkPreview | null>(null);
  const [splitting, setSplitting] = useState(false);
  const [fresh, setFresh] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [addOpen, setAddOpen] = useState(params.get('tab') === 'text');
  const [pasteFor, setPasteFor] = useState<ListItem | null>(null);
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'text' ? 'text' : 'link');
  const [links, setLinks] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [addError, setAddError] = useState<string | null>(() => {
    try {
      const msg = sessionStorage.getItem(LINK_ERROR_KEY);
      sessionStorage.removeItem(LINK_ERROR_KEY);
      return msg;
    } catch {
      return null;
    }
  });
  const [saving, setSaving] = useState(false);
  const [length, setLength] = useState<Length>(() => remembered('t2t-length', ['10', '20', '30', '45', '60', 'whole'] as const, '20'));
  const [voice, setVoice] = useState<VoiceKey>(() => remembered('t2t-voice', ['heart', 'michael', 'emma', 'george'] as const, 'heart'));
  const [quiet, setQuiet] = useState<Quiet>(() => remembered('t2t-quiet', ['0', '1', '2', '3'] as const, '0'));
  const [voices, setVoices] = useState<Voice[]>(FALLBACK_VOICES);
  const [hear, setHear] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [recent, setRecent] = useState<WalkList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const [bookmarkHint, setBookmarkHint] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const bookmarkRef = useRef<HTMLAnchorElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLTextAreaElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<string | null>(null);
  const savedFromUrl = useRef(false);
  // The rows as last shown, so a refresh can tell which checks just finished.
  const shownItems = useRef<ListItem[]>([]);

  const show = (next: ListItem[]) => {
    shownItems.current = next;
    setItems(next);
  };

  const refresh = async (): Promise<ListItem[]> => {
    const { items: next } = await api.list();
    announceChecks(shownItems.current, next);
    show(next);
    return next;
  };

  /** Says what a finished check found, once per row. */
  const announceChecks = (before: ListItem[], next: ListItem[]) => {
    const was = new Map(before.map((i) => [i.id, i.status]));
    const lines: string[] = [];
    const tick: string[] = [];
    for (const i of next) {
      if (was.get(i.id) !== 'checking' || i.status === 'checking') continue;
      lines.push(i.status === 'ready' ? `${i.title}, ${walkTime(i.minutes)}.` : `${i.label}: couldn't read.`);
      if (i.status === 'ready' && autoTick.current.has(i.id)) tick.push(i.id);
      autoTick.current.delete(i.id);
    }
    if (lines.length) setNote(lines.join(' '));
    if (tick.length) setTicked((t) => [...t, ...tick.filter((id) => !t.includes(id))].slice(0, MAX_PIECES));
  };

  useEffect(() => {
    api.health().then(setHealth, () => setHealth({ ready: false, ollama: 'unreachable', model: 'gemma4:e4b', voice: 'download', ffmpeg: true }));
    api.voices().then(setVoices, () => undefined);
    api.walks().then(setRecent, () => undefined);
    refresh().catch(() => setItems([]));
    return () => audioRef.current?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While a row says "Checking...", ask again every second.
  const checking = items?.some((i) => i.status === 'checking') ?? false;
  useEffect(() => {
    if (!checking) return;
    const timer = window.setTimeout(() => void refresh().catch(() => undefined), 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, checking]);

  useEffect(() => {
    if (!focusNext.current) return;
    document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  }, [items]);

  useEffect(() => {
    // The bookmarklet is a javascript: link, which React will not render as an href.
    const link = bookmarkRef.current;
    if (!link) return;
    const code = `javascript:(()=>{window.open('${location.origin}/?url='+encodeURIComponent(location.href),'tabs-to-trails')})()`;
    link.setAttribute('href', code);
  }, [health]);

  // Arriving from the bookmarklet: the tab is saved to the list, nothing is built.
  useEffect(() => {
    const url = params.get('url');
    if (!url || !health?.ready || savedFromUrl.current) return;
    savedFromUrl.current = true;
    history.replaceState(null, '', '/');
    void api
      .save(parseLinks(url).map((u) => ({ kind: 'url' as const, url: u })))
      .then(async ({ added, existing }) => {
        const next = await refresh();
        added.forEach((i) => autoTick.current.add(i.id));
        setFresh([...added, ...existing].map((i) => i.id));
        setStatus(savedLine(added.length, existing.length, next.length));
      })
      .catch((err: unknown) => setStatus(err instanceof Error ? err.message : 'That tab could not be saved.'));
  }, [health?.ready, params]);

  const target = length === 'whole' ? null : Number(length);
  // "Everything" has no target to end before, so it has no quiet ending.
  const quietMinutes = target === null ? 0 : Number(quiet);
  const proposal = useMemo(() => pickWalk(items ?? [], target), [items, target]);
  const chosenIds = manual ? ticked : proposal;
  // The ticked rows in list order: the order the walk will play them.
  const chosenKey = (items ?? [])
    .filter((i) => i.status === 'ready' && chosenIds.includes(i.id))
    .map((i) => i.id)
    .join(',');

  // The panel shows the build's own first plan for what is ticked.
  useEffect(() => {
    const ids = chosenKey ? chosenKey.split(',') : [];
    if (!ids.length) {
      setWalkPreview(null);
      return;
    }
    let stale = false;
    const timer = window.setTimeout(() => {
      api.preview(ids, target, voice, quietMinutes).then(
        (p) => !stale && setWalkPreview(p),
        () => !stale && setWalkPreview(null),
      );
    }, 120);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [chosenKey, target, voice, quietMinutes]);

  if (!health) return <div className="page" aria-busy="true" />;
  if (!health.ready) return <Setup health={health} onReady={setHealth} />;

  const waiting = items ?? [];
  const shown = showAll ? waiting : waiting.slice(0, SHOWN);
  const chosen = waiting.filter((i) => i.status === 'ready' && chosenIds.includes(i.id));
  const readyMinutes = waiting.filter((i) => i.status === 'ready').reduce((n, i) => n + i.minutes, 0);
  // A preview for rows that are no longer ticked is not shown.
  const shownPreview = preview && chosen.every((i) => preview.pieces.some((p) => p.id === i.id)) && preview.targetMinutes === target ? preview : null;
  const sumLine = chosen.length && shownPreview ? `about ${walkTime(shownPreview.minutes)}${target === null ? '' : ` for ${target}`}` : '';
  const tooLittle = target !== null && shownPreview !== null && chosen.length > 0 && shownPreview.minutes < target * 0.9;
  const voiceName = voices.find((v) => v.key === voice)?.name ?? 'Heart';
  const lengthHint = LENGTHS.find((l) => l.key === length)!.hint;
  const empty = items !== null && waiting.length === 0;
  const showAdd = addOpen || empty || pasteFor !== null;

  const pickTab = (t: Tab) => {
    setTab(t);
    setAddError(null);
  };

  const pickLength = (l: Length) => {
    setLength(l);
    remember('t2t-length', l);
    // A new length makes a new proposal, over any ticks made by hand.
    setManual(false);
  };

  const pickQuiet = (q: Quiet) => {
    setQuiet(q);
    remember('t2t-quiet', q);
  };

  const pickVoice = (v: VoiceKey) => {
    setVoice(v);
    remember('t2t-voice', v);
    audioRef.current?.pause();
    setHear('idle');
  };

  const togglePreview = async () => {
    setPreviewError(null);
    if (hear !== 'idle') {
      audioRef.current?.pause();
      setHear('idle');
      return;
    }
    setHear('loading');
    const audio = new Audio(`/api/voices/${voice}/preview`);
    audioRef.current?.pause();
    audioRef.current = audio;
    audio.onended = () => setHear('idle');
    audio.onerror = () => {
      setHear('idle');
      setPreviewError(`${voiceName} couldn't start. The voice downloads on first use, so check the connection and try again.`);
    };
    try {
      await audio.play();
      setHear('playing');
    } catch {
      setHear('idle');
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

  /** What is typed or chosen in the add box, not yet saved. */
  const pending = (): SourcePayload[] => {
    if (!showAdd || pasteFor) return [];
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

  /** Saves what is in the add box; returns the rows it saved or found already there. */
  const saveBox = async (): Promise<ListItem[] | null> => {
    const sources = pending();
    if (!sources.length) {
      setAddError(emptyMessage);
      focusField();
      return null;
    }
    setSaving(true);
    setAddError(null);
    try {
      const { added, existing } = await api.save(sources);
      added.forEach((i) => (i.status === 'checking' ? autoTick.current.add(i.id) : undefined));
      const readyNow = added.filter((i) => i.status === 'ready').map((i) => i.id);
      setTicked((t) => [...t, ...readyNow.filter((id) => !t.includes(id))].slice(0, MAX_PIECES));
      clearPending();
      const next = await refresh();
      setFresh([...added, ...existing].map((i) => i.id));
      setNote(savedLine(added.length, existing.length, next.length));
      return [...added, ...existing];
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'That could not be saved.');
      focusField();
      return null;
    } finally {
      setSaving(false);
    }
  };

  const savePaste = async () => {
    if (!pasteFor) return;
    if (!countWords(pasteText)) {
      setAddError('Paste some text first.');
      textInput.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const item = await api.pasteInto(pasteFor.id, pasteText, pasteTitle.trim() || undefined);
      setTicked((t) => (t.includes(item.id) || t.length >= MAX_PIECES ? t : [...t, item.id]));
      setPasteFor(null);
      setPasteText('');
      setPasteTitle('');
      setAddError(null);
      focusNext.current = `tick-${item.id}`;
      await refresh();
      setNote(`${item.title}, ${walkTime(item.minutes)}. Ready for a walk.`);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'That text could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const openPaste = (item: ListItem) => {
    setPasteFor(item);
    setTab('text');
    setPasteText('');
    setPasteTitle('');
    setAddError(null);
    window.setTimeout(() => textInput.current?.focus(), 0);
  };

  const toggle = (item: ListItem) => {
    setFormError(null);
    const base = chosen.map((i) => i.id);
    if (base.includes(item.id)) {
      setTicked(base.filter((id) => id !== item.id));
      setManual(true);
      return;
    }
    if (base.length >= MAX_PIECES) {
      setNote(`A walk holds up to ${MAX_PIECES} pieces. Untick one first.`);
      return;
    }
    setTicked([...base, item.id]);
    setManual(true);
  };

  const move = (from: number, to: number, keep?: 'up' | 'down') => {
    if (to < 0 || to >= waiting.length || from === to) return;
    const item = waiting[from]!;
    const next = moveItem(waiting, from, to);
    if (keep) {
      const atEnd = keep === 'up' ? to === 0 : to === next.length - 1;
      focusNext.current = `row-${item.id}-${atEnd ? (keep === 'up' ? 'down' : 'up') : keep}`;
    }
    show(next);
    setNote(`Moved ${item.title} to number ${to + 1} of ${next.length}.`);
    void api.reorder(next.map((i) => i.id)).catch(() => void refresh());
  };

  const remove = async (index: number) => {
    const item = waiting[index]!;
    const neighbour = waiting[index + 1] ?? waiting[index - 1];
    focusNext.current = neighbour ? `row-${neighbour.id}-remove` : null;
    setTicked((t) => t.filter((id) => id !== item.id));
    show(waiting.filter((i) => i.id !== item.id));
    if (pasteFor?.id === item.id) setPasteFor(null);
    setNote(`Removed ${item.title}. ${things(waiting.length - 1)} waiting.`);
    if (!neighbour) window.setTimeout(() => addButton.current?.focus() ?? urlInput.current?.focus(), 0);
    await api.removeItem(item.id).catch(() => undefined);
    void refresh().catch(() => undefined);
  };

  /** A long read becomes a series: its row is replaced by its parts, and part 1 goes into this walk. */
  const splitInto = async (item: ListItem, parts: number) => {
    if (target === null) return;
    setSplitting(true);
    try {
      const { parts: made } = await api.split(item.id, target, voice);
      setManual(false);
      const next = await refresh();
      setFresh(made.map((m) => m.id));
      setNote(`Split into ${made.length} walks. Part 1 is in this walk; the other ${made.length - 1 === 1 ? 'part waits' : 'parts wait'} in your list, first in line.`);
      void next;
    } catch (err) {
      setFormError(err instanceof Error ? err.message : `${item.title} could not be split into ${parts} walks.`);
    } finally {
      setSplitting(false);
    }
  };

  /** Waits for the given rows to finish their check, for a walk made straight from the add box. */
  const settle = async (ids: string[]): Promise<ListItem[]> => {
    for (let i = 0; i < 60; i++) {
      const list = await refresh();
      const mine = list.filter((r) => ids.includes(r.id));
      if (mine.every((r) => r.status !== 'checking')) return mine;
      await sleep(700);
    }
    return (await refresh()).filter((r) => ids.includes(r.id));
  };

  const make = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setFormError(null);
    let ids = chosen.map((i) => i.id);
    // Something still in the add box goes into the walk: one link and the button, as before the list.
    if (pending().length) {
      setBusy('Saving…');
      const saved = await saveBox();
      if (!saved) {
        setBusy(null);
        return;
      }
      setBusy('Checking…');
      const settled = await settle(saved.map((i) => i.id));
      const bad = settled.find((i) => i.status === 'unreadable');
      const good = settled.filter((i) => i.status === 'ready').map((i) => i.id);
      if (!good.length && bad) {
        setBusy(null);
        setFormError(`${bad.label}: ${bad.reason ?? "couldn't read."}`);
        focusNext.current = null;
        window.setTimeout(() => document.getElementById(`row-${bad.id}-paste`)?.focus(), 0);
        return;
      }
      ids = [...ids, ...good.filter((id) => !ids.includes(id))];
    }
    if (!ids.length) {
      setFormError(waiting.length ? 'Tick what you want to hear first.' : 'Add something to read first.');
      return;
    }
    if (ids.length > MAX_PIECES) {
      setFormError(`A walk holds up to ${MAX_PIECES} pieces. Untick ${ids.length - MAX_PIECES} first.`);
      return;
    }
    // The walk follows the list's order.
    const order = (items ?? []).map((i) => i.id);
    ids.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    setBusy('Starting…');
    try {
      const { id } = await api.buildItems(ids, target, voice, quietMinutes);
      navigate(`/walk/${id}`);
    } catch (err) {
      setBusy(null);
      if (err instanceof ApiError && err.body.setup) {
        setHealth(await api.health().catch(() => health));
        return;
      }
      setFormError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
      void refresh().catch(() => undefined);
    }
  };

  const recentWalks = recent?.walks.slice(0, 5) ?? [];
  const textWords = countWords(pasteText);
  const pendingCount = pending().length;

  return (
    <div className="page">
      <div className="stack hero">
        <ScreenTitle title="Your walk list">Turn your reading backlog into a walk.</ScreenTitle>
        <p className="lede">Save tabs now. Walk them later.</p>
      </div>

      {recent?.active && (
        <p className="small" role="status">
          Still making {recent.active.title ?? 'a Walk Edition'}.{' '}
          <a href={`/walk/${recent.active.id}`} onClick={onLink}>
            See how it's going
          </a>
        </p>
      )}
      <p className="small saved-status" role="status">
        {status}
      </p>

      <form className="card stack home" style={{ gap: 32 }} onSubmit={make} noValidate>
        <section className="stack" style={{ gap: 12 }} aria-labelledby="waiting-title">
          <h2 id="waiting-title" className="step-head">
            <span className="n" aria-hidden="true">
              1
            </span>
            Waiting for a walk
            {waiting.length > 0 && (
              <span className="sum">
                {things(waiting.length)}
                {readyMinutes > 0 && ` · ${walkTime(readyMinutes)}`}
              </span>
            )}
          </h2>

          {empty && <p className="empty-line">Nothing waiting yet. Add something you keep meaning to read.</p>}

          {waiting.length > 0 && (
            <ol className="waiting">
              {shown.map((item, i) => {
                const ready = item.status === 'ready';
                return (
                  <li
                    key={item.id}
                    className={[
                      item.status,
                      fresh.includes(item.id) ? 'fresh' : '',
                      dragFrom === i ? 'dragging' : dragTo === i && dragFrom !== null ? (dragFrom < i ? 'over-below' : 'over-above') : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
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
                    <span className="tick">
                      {ready ? (
                        <input
                          id={`tick-${item.id}`}
                          type="checkbox"
                          checked={chosenIds.includes(item.id)}
                          onChange={() => toggle(item)}
                          aria-describedby={`row-note-${item.id}`}
                        />
                      ) : (
                        <span className="tick-space" aria-hidden="true" />
                      )}
                    </span>
                    <span className="what">
                      {ready ? (
                        <label htmlFor={`tick-${item.id}`} className="name">
                          {rowTitle(item)}
                        </label>
                      ) : (
                        <span className="name">{rowTitle(item)}</span>
                      )}
                      <span className="note" id={`row-note-${item.id}`}>
                        {item.status === 'checking' && 'Checking…'}
                        {ready && savedAgo(item.savedAt)}
                        {item.status === 'unreadable' && (
                          <>
                            couldn't read ·{' '}
                            <button
                              id={`row-${item.id}-paste`}
                              type="button"
                              className="link-button inline"
                              aria-label={`Paste the text instead: ${item.label}`}
                              onClick={() => openPaste(item)}
                            >
                              Paste the text instead
                            </button>
                          </>
                        )}
                      </span>
                    </span>
                    <span className="mins">{ready ? walkTime(item.minutes) : ''}</span>
                    <span className="moves">
                      <button id={`row-${item.id}-up`} type="button" className="icon-btn" aria-label={`Move up: ${rowTitle(item)}`} disabled={i === 0} onClick={() => move(i, i - 1, 'up')}>
                        <MoveUp />
                      </button>
                      <button
                        id={`row-${item.id}-down`}
                        type="button"
                        className="icon-btn"
                        aria-label={`Move down: ${rowTitle(item)}`}
                        disabled={i === waiting.length - 1}
                        onClick={() => move(i, i + 1, 'down')}
                      >
                        <MoveDown />
                      </button>
                      <button id={`row-${item.id}-remove`} type="button" className="icon-btn" aria-label={`Remove: ${rowTitle(item)}`} onClick={() => void remove(i)}>
                        <Cross />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          {waiting.length > SHOWN && (
            <button type="button" className="link-button" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show the first 20' : `Show all ${waiting.length}`}
            </button>
          )}

          {!showAdd && (
            <button ref={addButton} type="button" className="link-button add-open" aria-expanded={false} onClick={() => setAddOpen(true)}>
              + Add links, text or a file
            </button>
          )}

          {showAdd && (
            <div className="add-box stack" style={{ gap: 14 }}>
              {pasteFor ? (
                <div className="paste-for">
                  <strong>Text for {pasteFor.label}</strong>
                  {pasteFor.reason && <span className="small">{pasteFor.reason}</span>}
                </div>
              ) : (
                <div className="segmented" role="group" aria-label="What to save">
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
              )}

              {tab === 'link' && !pasteFor && (
                <div className="field">
                  <label htmlFor="src-url">Links to articles</label>
                  <textarea
                    ref={urlInput}
                    id="src-url"
                    className="input links"
                    rows={Math.min(8, Math.max(1, links.split('\n').length))}
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://"
                    value={links}
                    aria-describedby={addError ? 'add-error' : 'link-help'}
                    aria-invalid={addError ? true : undefined}
                    onChange={(e) => {
                      setLinks(e.target.value);
                      setAddError(null);
                    }}
                    onKeyDown={(e) => {
                      // Enter starts a new line for the next link; Ctrl or Cmd with Enter saves them.
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void saveBox();
                      }
                    }}
                  />
                  <p className="small" id="link-help">
                    One per line, as many as you like. Each page is fetched once, now, and kept on this computer.
                  </p>
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
                  <textarea
                    ref={textInput}
                    id="src-text"
                    className="textarea"
                    rows={6}
                    value={pasteText}
                    aria-describedby={addError ? 'add-error text-help' : 'text-help'}
                    onChange={(e) => {
                      setPasteText(e.target.value);
                      setAddError(null);
                    }}
                  />
                  <div className="field-foot" id="text-help">
                    <span>
                      <Lock />
                      Works with the internet off. What you paste stays here.
                    </span>
                    <span className="mono" style={{ fontSize: 13 }}>
                      {words(textWords)} {textWords === 1 ? 'word' : 'words'}
                    </span>
                  </div>
                </div>
              )}

              {tab === 'file' && !pasteFor && (
                <div
                  className={`dropzone${dragOver ? ' over' : ''}`}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes('Files')) return;
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

              {addError && (
                <div className="alert-box" role="alert" id="add-error">
                  <div className="msg">
                    <Notice size={20} />
                    <div>{addError}</div>
                  </div>
                </div>
              )}

              <div className="row add-actions">
                {pasteFor ? (
                  <>
                    <button type="button" className="btn add" disabled={saving} onClick={() => void savePaste()}>
                      {saving ? 'Saving…' : 'Save the text'}
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        const id = pasteFor.id;
                        setPasteFor(null);
                        setAddError(null);
                        window.setTimeout(() => document.getElementById(`row-${id}-paste`)?.focus(), 0);
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn add" disabled={saving} onClick={() => void saveBox()}>
                    {saving ? 'Saving…' : tab === 'link' && pendingCount > 1 ? `Save ${pendingCount} links for a walk` : 'Save for a walk'}
                  </button>
                )}
              </div>
            </div>
          )}
        </section>

        <fieldset>
          <legend className="step-head">
            <span className="n" aria-hidden="true">
              2
            </span>
            How long is your walk?
          </legend>
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

        <section className="stack" style={{ gap: 14 }} aria-labelledby="your-walk-title">
          <h2 id="your-walk-title" className="step-head">
            <span className="n" aria-hidden="true">
              3
            </span>
            Your walk
            {sumLine && <span className="sum">{sumLine}</span>}
          </h2>
          {chosen.length > 0 ? (
            <ul className="your-walk">
              {chosen.map((i) => {
                const planned = shownPreview?.pieces.find((p) => p.id === i.id);
                return (
                  <li key={i.id}>
                    <span className="name">{rowTitle(i)}</span>
                    <span className="mins">{walkTime(planned?.minutes ?? i.minutes)}</span>
                    <span className="how">
                      {planned ? (planned.treatment === 'full' ? (i.part ? `part ${i.part} of ${i.parts}` : 'in full') : `condensed from ${walkTime(planned.fullMinutes)}`) : ''}
                    </span>
                    {planned?.splitParts && target !== null && (
                      <fieldset className="series-choice">
                        <legend className="visually-hidden">How to walk {i.title}</legend>
                        <label>
                          <input type="radio" name={`how-${i.id}`} checked onChange={() => undefined} />
                          Condense to {target} min
                        </label>
                        <label>
                          <input type="radio" name={`how-${i.id}`} checked={false} disabled={splitting} onChange={() => void splitInto(i, planned.splitParts!)} />
                          Split into {planned.splitParts} walks
                        </label>
                      </fieldset>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="small">
              {pendingCount
                ? 'What is in the box above goes into this walk.'
                : target === null
                  ? 'Tick what you want to hear. Everything ticked is read in full.'
                  : 'Tick what you want to hear.'}
            </p>
          )}
          {shownPreview && shownPreview.quietMinutes > 0 && chosen.length > 0 && (
            <p className="small quiet-line">
              Then {shownPreview.quietMinutes === 1 ? 'a minute' : `${shownPreview.quietMinutes} minutes`} of quiet before the last chime.
            </p>
          )}
          {tooLittle && (
            <p className="small too-little">
              This is a {Math.max(1, Math.round(shownPreview!.minutes))}-minute walk. Add something, or pick a shorter length.
            </p>
          )}

          <details className="options">
            <summary>
              Options: voice {voiceName}
              {target !== null && ` · quiet ending ${quiet === '0' ? 'off' : `${quiet} min`}`}
              <span className="chev" aria-hidden="true" />
            </summary>
            {target !== null && (
              <fieldset className="stack" style={{ gap: 10, marginTop: 12 }}>
                <legend className="legend">Quiet ending</legend>
                <div className="pills">
                  {QUIET.map((q) => (
                    <button key={q.key} type="button" className="pill" aria-pressed={quiet === q.key} onClick={() => pickQuiet(q.key)}>
                      {q.label}
                    </button>
                  ))}
                </div>
                <p className="small">The reading ends early and you walk the rest in silence.</p>
              </fieldset>
            )}
            <fieldset className="stack" style={{ gap: 10, marginTop: 12 }}>
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
                {hear === 'idle' && (
                  <>
                    <Play /> Hear {voiceName} for ten seconds
                  </>
                )}
                {hear === 'loading' && <>Getting {voiceName} ready…</>}
                {hear === 'playing' && (
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
          </details>

          <div className="stack" style={{ gap: 12 }}>
            {formError && (
              <p className="small" role="alert" style={{ color: 'var(--error-text)', fontWeight: 600 }}>
                {formError}
              </p>
            )}
            <button type="submit" className="btn primary block" disabled={busy !== null}>
              {busy ?? 'Make my walk'}
              {!busy && <Arrow />}
            </button>
            <p className="small center">Takes a few minutes. Enough time to find your shoes.</p>
          </div>
        </section>
      </form>
      <p className="visually-hidden" aria-live="polite">
        {note}
      </p>

      <section className="stack recent" style={{ gap: 12 }} aria-labelledby="recent-title">
        <h2 id="recent-title" className="section-title">
          {recent && recent.walked.count > 0
            ? `Walked: ${recent.walked.count} ${recent.walked.count === 1 ? 'walk' : 'walks'} · ${walkTime(recent.walked.seconds / 60)}`
            : 'Walked'}
        </h2>
        {recent && recentWalks.length === 0 && <p className="empty">No Walk Editions yet. Your first one will appear here.</p>}
        {recentWalks.length > 0 && (
          <ul>
            {recentWalks.map((w) => (
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
            'Drag this button to your bookmarks bar. Click it on any article to save that tab for a walk.'
          )}
        </p>
      </section>

      <p className="small center">No account. No cloud. The model and the voice both run on this computer.</p>
    </div>
  );
}
