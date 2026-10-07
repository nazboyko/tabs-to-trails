import { useEffect, useRef, useState } from 'react';
import { api, type AppLine, type ScriptSection, type WalkDetail } from '../api';
import { Badge, ScreenTitle } from '../common';
import { clock } from '../format';
import { Back, CodeIcon, Notice, TableIcon } from '../icons';
import { onLink } from '../router';

type ReadyDetail = Extract<WalkDetail, { ready: true }>;

type Item =
  | { kind: 'app'; label: string; line: AppLine; start: number }
  | { kind: 'section'; section: ScriptSection; start: number };

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

/** True when the halfway cue plays in the middle of this section rather than between sections. */
function cueInside(section: ScriptSection, halfway: AppLine | null): boolean {
  return halfway?.start != null && halfway.start > section.start + 1 && halfway.start < section.start + section.seconds;
}

/**
 * The script view shows the cue where it plays. The audio knows the exact
 * spot; the text is split at the sentence end nearest the same share of it.
 */
function splitAtCue(section: ScriptSection, halfway: AppLine | null): { text: string; cue?: AppLine }[] {
  if (!halfway || !cueInside(section, halfway)) return [{ text: section.text }];
  const share = (halfway.start! - section.start) / section.seconds;
  const target = section.text.length * share;
  let best = -1;
  const ends = /[.!?]["'’”)]?(\s+)/g;
  for (let m = ends.exec(section.text); m; m = ends.exec(section.text)) {
    const at = m.index + m[0].length;
    if (best < 0 || Math.abs(at - target) < Math.abs(best - target)) best = at;
  }
  if (best <= 0 || best >= section.text.length) return [{ text: section.text }, { text: '', cue: halfway }];
  return [{ text: section.text.slice(0, best).trim() }, { text: '', cue: halfway }, { text: section.text.slice(best).trim() }];
}

function quoteList(numbers: string[]): string {
  const q = numbers.map((n) => `“${n}”`);
  return q.length === 1 ? q[0]! : `${q.slice(0, -1).join(', ')} and ${q.at(-1)}`;
}

function scriptAsText(d: ReadyDetail, items: Item[]): string {
  const lines = [`${d.title}`, `Walk Edition, ${clock(d.meta.actualSeconds)}`, ''];
  const all = [...items];
  if (d.app.halfway && !items.some((i) => i.kind === 'app' && i.line === d.app.halfway)) {
    all.push({ kind: 'app', label: 'halfway cue, after a chime', line: d.app.halfway, start: d.app.halfway.start ?? 0 });
    all.sort((a, b) => a.start - b.start);
  }
  for (const item of all) {
    if (item.kind === 'app') lines.push(`[${clock(item.start)}] The app (${item.label}): ${item.line.text}`, '');
    else lines.push(`[${clock(item.start)}] ${item.section.label} (${item.section.coverage})`, item.section.text, '');
  }
  return lines.join('\n');
}

export function Script({ id }: { id: string }) {
  const [detail, setDetail] = useState<WalkDetail | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api.walk(id).then(setDetail, () => setDetail(null));
    return () => window.clearTimeout(timer.current);
  }, [id]);

  useEffect(() => {
    if (!detail?.ready || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [detail]);

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
  const items: Item[] = [
    { kind: 'app' as const, label: 'intro', line: d.app.intro, start: d.app.intro.start ?? 0 },
    ...d.sections.map((s) => ({ kind: 'section' as const, section: s, start: s.start })),
    ...(d.app.halfway && !d.sections.some((s) => cueInside(s, d.app.halfway))
      ? [{ kind: 'app' as const, label: 'halfway cue, after a chime', line: d.app.halfway, start: d.app.halfway.start ?? 0 }]
      : []),
    ...(d.app.question ? [{ kind: 'app' as const, label: 'a question for the last stretch', line: d.app.question, start: d.app.question.start ?? 0 }] : []),
    { kind: 'app' as const, label: 'sign-off', line: d.app.outro, start: d.app.outro.start ?? d.meta.actualSeconds },
  ].sort((a, b) => a.start - b.start);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(scriptAsText(d, items));
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
        {items.map((item) =>
          item.kind === 'app' ? (
            <div className="app-says" key={item.label}>
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
                {splitAtCue(item.section, d.app.halfway).map((part, i) =>
                  part.cue ? (
                    <div className="app-says" key={`cue-${i}`}>
                      <div className="head">
                        <span>The app · halfway cue, after a chime</span>
                        <span className="mono" style={{ fontWeight: 500 }}>
                          {clock(part.cue.start ?? 0)}
                        </span>
                      </div>
                      <p>{part.cue.text}</p>
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
          ),
        )}
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
