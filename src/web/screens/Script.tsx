import { Fragment, useEffect, useRef, useState } from 'react';
import { api, type AppLine, type ScriptSection, type WalkDetail } from '../api';
import { Badge, ScreenTitle } from '../common';
import { clock } from '../format';
import { Back, CodeIcon, Notice, TableIcon } from '../icons';
import { onLink } from '../router';

type ReadyDetail = Extract<WalkDetail, { ready: true }>;

type Item =
  | { kind: 'app'; label: string; line: AppLine; start: number; piece?: number }
  | { kind: 'section'; section: ScriptSection; start: number };

interface Cue {
  label: string;
  line: AppLine;
}

/** Matches a guarded number in the text, with or without thousands separators. */
function numberPattern(n: string): string {
  const [int, dec] = n.split('.');
  const grouped = (int ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',?');
  return `(?<![\\d.,])${grouped}${dec ? `\\.${dec}` : ''}(?![\\d])`;
}

function Marked({ text, numbers }: { text: string; numbers: string[] }) {
  if (!numbers.length) return <>{text}</>;
  const re = new RegExp(`(${numbers.map(numberPattern).join('|')})`, 'g');
  const parts = text.split(re);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="check">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** True when a cue plays in the middle of this section rather than between sections. */
function cueInside(section: ScriptSection, cue: AppLine | null): boolean {
  return cue?.start != null && cue.start > section.start + 1 && cue.start < section.start + section.seconds;
}

/**
 * The script view shows each cue where it plays. The audio knows the exact
 * spot; the text is split at the sentence end nearest the same share of it.
 */
function splitAtCues(section: ScriptSection, cues: Cue[]): { text: string; cue?: Cue }[] {
  const inside = cues.filter((c) => cueInside(section, c.line)).sort((a, b) => a.line.start! - b.line.start!);
  if (!inside.length) return [{ text: section.text }];
  const ends: number[] = [];
  const re = /[.!?]["'’”)]?(\s+)/g;
  for (let m = re.exec(section.text); m; m = re.exec(section.text)) ends.push(m.index + m[0].length);
  const parts: { text: string; cue?: Cue }[] = [];
  // A cue with no sentence end left to split at is shown after the text.
  const late: Cue[] = [];
  let from = 0;
  for (const cue of inside) {
    const target = section.text.length * ((cue.line.start! - section.start) / section.seconds);
    let best = -1;
    for (const at of ends) if (at > from && (best < 0 || Math.abs(at - target) < Math.abs(best - target))) best = at;
    if (best > from && best < section.text.length) {
      parts.push({ text: section.text.slice(from, best).trim() }, { text: '', cue });
      from = best;
    } else late.push(cue);
  }
  parts.push({ text: section.text.slice(from).trim() });
  for (const cue of late) parts.push({ text: '', cue });
  return parts;
}

function quoteList(numbers: string[]): string {
  const q = numbers.map((n) => `“${n}”`);
  return q.length === 1 ? q[0]! : `${q.slice(0, -1).join(', ')} and ${q.at(-1)}`;
}

/** The piece an item starts, when it is the first of a new piece in a playlist. */
function pieceOf(item: Item): number | null {
  if (item.kind === 'section') return item.section.piece;
  return item.piece ?? null;
}

function scriptAsText(d: ReadyDetail, items: Item[], cues: Cue[]): string {
  const lines = [`${d.title}`, `Walk Edition, ${clock(d.meta.actualSeconds)}`, ''];
  const all = [...items];
  for (const cue of cues) {
    if (!items.some((i) => i.kind === 'app' && i.line === cue.line)) all.push({ kind: 'app', label: cue.label, line: cue.line, start: cue.line.start ?? 0 });
  }
  all.sort((a, b) => a.start - b.start);
  let piece = -1;
  for (const item of all) {
    const p = d.pieces.length > 1 ? pieceOf(item) : null;
    if (p !== null && p !== piece) {
      piece = p;
      lines.push(`Piece ${p + 1} of ${d.pieces.length}: ${d.pieces[p]?.title ?? ''} (${clock(d.pieces[p]?.seconds ?? 0)})`, '');
    }
    if (item.kind === 'app') lines.push(`[${clock(item.start)}] The app (${item.label}): ${item.line.text}`, '');
    else lines.push(`[${clock(item.start)}] ${item.section.label} (${item.section.coverage})`, item.section.text, '');
  }
  return lines.join('\n');
}

export function Script({ id }: { id: string }) {
  const [detail, setDetail] = useState<WalkDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api.walk(id).then(setDetail, () => setFailed(true));
    return () => window.clearTimeout(timer.current);
  }, [id]);

  useEffect(() => {
    if (!detail?.ready || !location.hash) return;
    const target = document.getElementById(location.hash.slice(1));
    target?.scrollIntoView({ block: 'start' });
    // "Check it" lands on the flagged section, so the next Tab continues from there.
    target?.querySelector<HTMLElement>('summary')?.focus();
  }, [detail]);

  if (failed) {
    return (
      <div className="page">
        <h1>The script could not be opened.</h1>
        <p className="lede">
          The app on this computer did not answer, or this walk no longer exists. <a href="/">Back to the start</a>.
        </p>
      </div>
    );
  }
  if (!detail) return <div className="page" aria-busy="true" />;
  if (!detail.ready) {
    return (
      <div className="page">
        <ScreenTitle title="Script">The script is not ready yet.</ScreenTitle>
        <p className="lede">
          <a href={`/walk/${id}`} onClick={onLink}>
            See how the Walk Edition is coming along
          </a>
        </p>
      </div>
    );
  }
  const d = detail;
  const cues: Cue[] = [
    ...(d.app.halfway ? [{ label: 'halfway cue, after a chime', line: d.app.halfway }] : []),
    ...(d.app.threeQuarter ? [{ label: 'three-quarter cue, after a chime', line: d.app.threeQuarter }] : []),
  ];
  const items: Item[] = [
    { kind: 'app' as const, label: 'intro', line: d.app.intro, start: d.app.intro.start ?? 0 },
    ...d.sections.map((s) => ({ kind: 'section' as const, section: s, start: s.start })),
    ...d.app.bridges.map((b) => ({ kind: 'app' as const, label: 'next piece', line: { text: b.text, start: b.start }, start: b.start, piece: b.piece })),
    ...cues
      .filter((c) => !d.sections.some((s) => cueInside(s, c.line)))
      .map((c) => ({ kind: 'app' as const, label: c.label, line: c.line, start: c.line.start ?? 0 })),
    ...(d.app.question ? [{ kind: 'app' as const, label: 'a question for the last stretch', line: d.app.question, start: d.app.question.start ?? 0 }] : []),
    { kind: 'app' as const, label: 'sign-off', line: d.app.outro, start: d.app.outro.start ?? d.meta.actualSeconds },
  ].sort((a, b) => a.start - b.start);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(scriptAsText(d, items, cues));
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard access; the script is on screen to select by hand.
    }
  };

  return (
    <div className="page tight">
      <a className="back-link" href={`/walk/${d.id}`} onClick={onLink}>
        <Back />
        Back to the walk
      </a>

      <div className="stack-sm" style={{ marginTop: -12 }}>
        <ScreenTitle title="What the voice will say" className="medium">
          What the voice will say
        </ScreenTitle>
        <p className="lede" style={{ fontSize: 16 }}>
          {d.title} · {clock(d.meta.actualSeconds)}. Written from the source text only. A small model can still get things wrong, so read anything you plan to rely on.
        </p>
      </div>

      <div className="script-list">
        {items.map((item, index) => {
          // In a playlist, each piece opens with its title and length.
          const p = d.pieces.length > 1 ? pieceOf(item) : null;
          const before = index > 0 ? items.slice(0, index).map(pieceOf).filter((x) => x !== null).at(-1) : undefined;
          const head =
            p !== null && p !== (before ?? -1) ? (
              <h2 className="piece-head" key={`piece-${p}`}>
                <span>
                  <span className="n">Piece {p + 1} of {d.pieces.length}</span>
                  {d.pieces[p]?.title}
                </span>
                <span className="mono">{clock(d.pieces[p]?.seconds ?? 0)}</span>
              </h2>
            ) : null;
          const body = item.kind === 'app' ? (
            <div className="app-says" key={`${item.label}-${item.start}`}>
              <div className="head">
                <span>The app · {item.label}</span>
                <span className="mono" style={{ fontWeight: 500 }}>
                  {clock(item.start)}
                </span>
              </div>
              <p>{item.line.text}</p>
            </div>
          ) : (
            <details className="script-section" open key={item.section.id} id={item.section.id}>
              <summary>
                <span className="label">{item.section.label}</span>
                <Badge coverage={item.section.coverage} />
                <span className="mono">{clock(item.start)}</span>
              </summary>
              <div className="text">
                {item.section.adapted.includes('table') && (
                  <div className="was">
                    <TableIcon />
                    Was a table in the source
                  </div>
                )}
                {item.section.adapted.includes('code') && (
                  <div className="was">
                    <CodeIcon />
                    Was code in the source
                  </div>
                )}
                {item.section.checkNumbers.length > 0 && (
                  <div className="check-note">
                    <Notice />
                    <div>
                      <strong>{item.section.checkNumbers.length === 1 ? 'Check this number.' : 'Check these numbers.'}</strong>{' '}
                      {quoteList(item.section.checkNumbers)} {item.section.checkNumbers.length === 1 ? 'is' : 'are'} not in this section of the source. I
                      rewrote the section once and it came back the same.
                    </div>
                  </div>
                )}
                {item.section.note && <div className="plain-note">{item.section.note}</div>}
                {splitAtCues(item.section, cues).map((part, i) =>
                  part.cue ? (
                    <div className="app-says" key={`cue-${i}`}>
                      <div className="head">
                        <span>The app · {part.cue.label}</span>
                        <span className="mono" style={{ fontWeight: 500 }}>
                          {clock(part.cue.line.start ?? 0)}
                        </span>
                      </div>
                      <p>{part.cue.line.text}</p>
                    </div>
                  ) : (
                    part.text.split(/\n\s*\n/).map((para, j) => (
                      <p key={`${i}-${j}`}>
                        <Marked text={para} numbers={item.section.checkNumbers} />
                      </p>
                    ))
                  ),
                )}
              </div>
            </details>
          );
          return (
            <Fragment key={item.kind === 'section' ? item.section.id : `${item.label}-${item.start}`}>
              {head}
              {body}
            </Fragment>
          );
        })}
      </div>

      <p className="small">Generated from the source text only. AI output can still contain mistakes. Review the script for anything important.</p>

      <div className="row">
        <button type="button" className="btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy the script'}
        </button>
        <a className="btn" href={`/api/walks/${d.id}/source`} target="_blank" rel="noopener noreferrer">
          Open the source text
        </a>
      </div>
      <p className="visually-hidden" role="status">
        {copied ? 'The script is copied.' : ''}
      </p>
    </div>
  );
}
