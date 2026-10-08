import { Fragment } from 'react';
import { Badge, ScreenTitle } from '../common';
import type { WalkDetail } from '../api';
import { clock, megabytes, plural, words } from '../format';
import { askedLine } from '../lengths';
import { Chevron, Download, Notice } from '../icons';
import { onLink } from '../router';

type ReadyDetail = Extract<WalkDetail, { ready: true }>;

function asked(d: ReadyDetail): string {
  return askedLine({
    targetSeconds: d.plan.targetSeconds,
    actualSeconds: d.meta.actualSeconds,
    mode: d.meta.mode,
    sourceWords: d.meta.sourceWords,
    scriptWords: d.meta.scriptWords,
    fullSeconds: d.plan.fullSeconds,
    pieces: d.pieces.length,
  });
}

/** Where a cue sits on the timeline, as a share kept clear of the ends. */
const place = (at: number, total: number) => Math.min(92, Math.max(8, (at / total) * 100));

function sectionNotes(s: ReadyDetail['sections'][number]): { text: string; check?: boolean }[] {
  const notes: { text: string; check?: boolean }[] = [];
  if (s.adapted.includes('table')) notes.push({ text: 'Table, told as a comparison' });
  if (s.adapted.includes('code')) notes.push({ text: 'Code, described in a sentence' });
  if (s.note) notes.push({ text: 'Part read from the source as written' });
  if (s.checkNumbers.length) notes.push({ text: s.checkNumbers.length === 1 ? 'One number to check' : `${s.checkNumbers.length} numbers to check`, check: true });
  return notes;
}

function Timeline({ d }: { d: ReadyDetail }) {
  const total = d.meta.actualSeconds;
  const order: string[] = [];
  for (const seg of d.segments) if (seg.sectionId && !order.includes(seg.sectionId)) order.push(seg.sectionId);
  // Sections alternate in shade; in a playlist, whole pieces do.
  const shade = (seg: ReadyDetail['segments'][number]) =>
    d.pieces.length > 1 ? (seg.piece ?? 0) % 2 === 1 : !!seg.sectionId && order.indexOf(seg.sectionId) % 2 === 1;
  const cues = [
    { label: 'Halfway cue', start: d.app.halfway?.start ?? null },
    { label: '3/4 cue', start: d.app.threeQuarter?.start ?? null },
  ].filter((c): c is { label: string; start: number } => c.start !== null);
  return (
    <div className="timeline">
      <div className="segs" aria-hidden="true">
        {d.segments.map((seg, i) => (
          <div
            key={i}
            title={seg.label}
            className={`seg ${seg.kind === 'app' ? 'app' : 'src'}${shade(seg) ? ' alt' : ''}`}
            style={{ flex: `${Math.max(seg.end - seg.start, 1)} 1 0` }}
          />
        ))}
      </div>
      <div className="t" style={{ left: 0 }} aria-hidden="true">
        0:00
      </div>
      <div className="t" style={{ right: 0 }} aria-hidden="true">
        {clock(total)}
      </div>
      {cues.map((c) => (
        <div key={c.label}>
          <div className="cue-line" style={{ left: `${place(c.start, total)}%` }} aria-hidden="true" />
          <div className="cue-label" style={{ left: `${place(c.start, total)}%` }}>
            {c.label}
            <br />
            <span className="mono" style={{ fontWeight: 500 }}>
              {clock(c.start)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function legend(d: ReadyDetail): string {
  const parts = [
    'the intro',
    d.app.bridges.length ? '“Next:” before each piece' : '',
    'the halfway cue',
    d.app.threeQuarter ? 'the three-quarter cue' : '',
    d.app.question ? 'one question for the last stretch' : '',
  ].filter(Boolean);
  const source = d.pieces.length > 1 ? 'Green is the reading, one shade per piece.' : 'Green is the article.';
  return `${source} Orange is the app talking: ${parts.join(', ')}, and the sign-off.`;
}

export function Ready({ detail: d, arrived = false }: { detail: ReadyDetail; arrived?: boolean }) {
  const flagged = d.sections.filter((s) => s.checkNumbers.length);
  const flaggedCount = flagged.reduce((n, s) => n + s.checkNumbers.length, 0);
  const counts = [
    d.meta.coverage.full ? `${d.meta.coverage.full} in full` : '',
    d.meta.coverage.condensed ? `${d.meta.coverage.condensed} condensed` : '',
    d.meta.coverage.brief ? `${d.meta.coverage.brief} brief` : '',
  ].filter(Boolean);
  const audio = `/api/walks/${d.id}/audio`;

  return (
    <div className="page tight">
      <div className="stack" style={{ gap: 10 }}>
        <div className="eyebrow orange">Ready to walk</div>
        <ScreenTitle title="Ready to walk" focus={arrived}>
          {d.title}
        </ScreenTitle>
        {arrived && (
          <p className="visually-hidden" role="status">
            Your Walk Edition is ready.
          </p>
        )}
        <div className="duration">
          <span className="mono">
            <span className="visually-hidden">Measured length </span>
            {clock(d.meta.actualSeconds)}
          </span>
          <span>{asked(d)}</span>
        </div>
      </div>

      {d.skipped.length > 0 && (
        <div className="skipped">
          <Notice />
          <div>
            <strong>{d.skipped.length === 1 ? 'One piece was left out of this walk.' : `${d.skipped.length} pieces were left out of this walk.`}</strong>
            <ul>
              {d.skipped.map((s, i) => (
                <li key={i}>
                  <span className="label">{s.label}</span>: {s.reason}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {d.share ? (
        <section className="qr-card" aria-labelledby="qr-title">
          <img src={d.share.qr} alt="QR code that opens this walk on your phone" width={168} height={168} />
          <div className="steps">
            <h2 id="qr-title">Scan it with your phone</h2>
            <ol>
              <li>
                Tap <strong>Download MP3</strong>.
              </li>
              <li>Press play.</li>
              <li>Pocket the phone and go.</li>
            </ol>
            <p className="small">Works while your phone and this computer are on the same Wi-Fi.</p>
          </div>
        </section>
      ) : (
        <section className="qr-card" aria-labelledby="qr-title">
          <div className="steps">
            <h2 id="qr-title">No phone link right now</h2>
            <p style={{ margin: 0 }}>This computer isn't on a network, so a QR code would lead nowhere. Download the MP3 and copy it to your phone instead.</p>
            <p className="small">QR needs your phone and computer on the same network.</p>
          </div>
        </section>
      )}

      <div className="stack" style={{ gap: 10 }}>
        <div className="row">
          <a className="btn dark" href={audio} download={d.meta.fileName}>
            <Download />
            Download MP3
          </a>
          <a className="btn" href={`/walk/${d.id}/script`} onClick={onLink} style={{ minHeight: 52 }}>
            Read the script
          </a>
        </div>
        <div className="file-line">
          {d.meta.fileName} · {megabytes(d.meta.bytes)}
        </div>
      </div>

      {flaggedCount > 0 && (
        <a className="needs-look" href={`/walk/${d.id}/script#${flagged[0]!.id}`} onClick={onLink}>
          <Notice />
          <span>
            {flaggedCount === 1 ? 'One number in the script needs a look.' : `${flaggedCount} numbers in the script need a look.`}{' '}
            <span className="u">Check it</span>
          </span>
        </a>
      )}

      <div className="divider" />

      <section className="stack" aria-labelledby="hear-title">
        <h2 id="hear-title" className="section-title">
          What you'll hear
        </h2>
        {d.pieces.length > 1 && (
          <ol className="pieces">
            {d.pieces.map((p, i) => (
              <li key={i}>
                <span className="n" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="title">{p.title}</span>
                <span className="time">
                  <span className="visually-hidden">runs </span>
                  {clock(p.seconds)}
                  <span className="from">
                    {' '}
                    from {clock(p.start)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
        <Timeline d={d} />
        <p className="small">{legend(d)}</p>
      </section>

      <details className="made">
        <summary>
          <span className="stack" style={{ gap: 0 }}>
            <span style={{ fontWeight: 600 }}>How this Walk Edition was made</span>
            <span className="small">
              {plural(d.sections.length, 'section', 'sections')}: {counts.join(', ')}
            </span>
          </span>
          <Chevron />
        </summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Section</th>
                <th scope="col">Kept</th>
                <th scope="col" style={{ textAlign: 'right', paddingRight: 0 }}>
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              {d.sections.map((s, i) => (
                <Fragment key={s.id}>
                  {d.pieces.length > 1 && (i === 0 || d.sections[i - 1]!.piece !== s.piece) && (
                    <tr className="piece-row">
                      <th scope="colgroup" colSpan={3}>
                        {s.piece + 1}. {d.pieces[s.piece]?.title}
                      </th>
                    </tr>
                  )}
                <tr>
                  <td>
                    {s.label}
                    {sectionNotes(s).map((n) => (
                      <div key={n.text} className={`sub${n.check ? ' check' : ''}`}>
                        {n.text}
                      </div>
                    ))}
                  </td>
                  <td>
                    <Badge coverage={s.coverage} />
                  </td>
                  <td className="num">{clock(s.seconds)}</td>
                </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <p className="facts">
          {words(d.meta.sourceWords)} words in the source, {words(d.meta.scriptWords)} in the script. Rewritten by {d.meta.model} in{' '}
          {Math.round(d.meta.rewriteSeconds)} s and read by {d.meta.voiceName} (Kokoro) in {Math.round(d.meta.voiceSeconds)} s, on this computer.
          {d.leftOut.length > 0 && ` Left out: ${d.leftOut.join(', ')}.`}
        </p>
      </details>

      <div className="foot-row">
        <p className="small">Stay aware of traffic and your surroundings.</p>
        <a href="/" onClick={onLink} style={{ display: 'flex', alignItems: 'center', minHeight: 44, fontSize: 15, fontWeight: 600 }}>
          Make another
        </a>
      </div>
    </div>
  );
}
