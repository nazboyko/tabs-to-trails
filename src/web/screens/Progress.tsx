import { useEffect, useRef, useState } from 'react';
import { api, ApiError, watchBuild, type StageName, type StageStatus, type Status, type WalkDetail } from '../api';
import { ScreenTitle } from '../common';
import { Check, Notice } from '../icons';
import { navigate } from '../router';
import { LINK_ERROR_KEY } from './Build';

type NotReady = Extract<WalkDetail, { ready: false }>;

const STAGES: StageName[] = ['read', 'plan', 'rewrite', 'voice', 'pack'];

const NAMES: Record<StageName, Record<StageStatus['state'], string>> = {
  read: { waiting: 'Read the source', active: 'Reading the source', done: 'Read the source' },
  plan: { waiting: 'Plan the walk', active: 'Planning the walk', done: 'Planned the walk' },
  rewrite: { waiting: 'Rewriting for listening', active: 'Rewriting for listening', done: 'Rewritten for listening' },
  voice: { waiting: 'Recording the voice', active: 'Recording the voice', done: 'Recorded the voice' },
  pack: { waiting: 'Packing the MP3', active: 'Packing the MP3', done: 'Packed the MP3' },
};

const WAITING_NOTE: Partial<Record<StageName, string>> = {
  voice: 'The longest step',
  pack: 'Adds the halfway cue and the closing question',
};

const VOICE_NAMES: Record<string, string> = { heart: 'Heart, American', michael: 'Michael, American', emma: 'Emma, British', george: 'George, British' };

function announcement(status: Status | null): string {
  if (!status) return '';
  if (status.state === 'failed') return '';
  const active = STAGES.find((s) => status.stages[s].state === 'active');
  return active ? `${NAMES[active].active}.` : '';
}

export function Progress({ detail, onDone, onGone }: { detail: NotReady; onDone: () => void; onGone: () => void }) {
  const [status, setStatus] = useState<Status | null>(detail.status);
  const [title, setTitle] = useState(detail.title);
  const [lost, setLost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [spoken, setSpoken] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [retryError, setRetryError] = useState<string | null>(null);
  const lastStage = useRef('');

  useEffect(() => {
    let stop = () => {};
    let retry: number | undefined;
    const connect = () => {
      stop = watchBuild(
        detail.id,
        (s) => {
          setLost(false);
          if (s.state === 'cancelled') {
            navigate('/', true);
            return;
          }
          setStatus(s);
          if (s.state === 'done') onDone();
        },
        () => {
          // Gone for good (cancelled in another tab), or the app is restarting.
          api.walk(detail.id).then(
            () => {
              setLost(true);
              retry = window.setTimeout(connect, 2000);
            },
            (err: unknown) => {
              if (err instanceof ApiError && err.status === 404) onGone();
              else {
                setLost(true);
                retry = window.setTimeout(connect, 2000);
              }
            },
          );
        },
      );
    };
    connect();
    return () => {
      stop();
      window.clearTimeout(retry);
    };
  }, [detail.id, onDone, onGone, attempt]);

  useEffect(() => {
    if (!title && status && status.stages.read.state === 'done') {
      api.walk(detail.id).then((d) => setTitle(d.title), () => undefined);
    }
  }, [status, title, detail.id]);

  useEffect(() => {
    const now = announcement(status);
    if (now && now !== lastStage.current) {
      lastStage.current = now;
      setSpoken(now);
    }
  }, [status]);

  const failed = status?.state === 'failed' ? status.error : undefined;
  const minutes = detail.request?.minutes;
  const sub = detail.request
    ? `${minutes === null ? 'Whole thing' : `${minutes} min walk`} · ${VOICE_NAMES[detail.request.voice] ?? detail.request.voice}`
    : '';

  const cancel = async () => {
    setBusy(true);
    await api.cancel(detail.id).catch(() => undefined);
    navigate('/', true);
  };

  const retry = async () => {
    setBusy(true);
    setRetryError(null);
    try {
      await api.retry(detail.id);
      setStatus((s) => (s ? { ...s, state: 'queued', error: undefined } : s));
      setAttempt((n) => n + 1);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'That did not start. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  const pasteInstead = async () => {
    await api.cancel(detail.id).catch(() => undefined);
    try {
      if (failed) sessionStorage.setItem(LINK_ERROR_KEY, failed.message);
    } catch {
      // The Build screen still opens; it just cannot repeat the message.
    }
    const url = detail.request?.url;
    navigate(url ? `/?url=${encodeURIComponent(url)}` : '/?tab=text', true);
  };

  return (
    <div className="page" style={{ gap: 36 }}>
      <div className="stack-sm">
        <div className="eyebrow">Making your Walk Edition</div>
        <ScreenTitle title="Making your Walk Edition" className="medium">
          {title ?? 'Your Walk Edition'}
        </ScreenTitle>
        {sub && <div style={{ fontSize: 15, color: 'var(--muted)' }}>{sub}</div>}
      </div>

      <p className="visually-hidden" aria-live="polite">
        {spoken}
      </p>

      <ol className="trail">
        {STAGES.map((name, i) => {
          const st = status?.stages[name] ?? { state: 'waiting' as const };
          const isFailed = failed && failed.stage === name;
          const state = isFailed ? 'failed' : st.state;
          const next = status?.stages[STAGES[i + 1] ?? 'pack'];
          const solid = st.state === 'done' && next && next.state !== 'waiting';
          const label = NAMES[name][st.state];
          return (
            <li key={name} className={state === 'waiting' ? 'waiting-step' : undefined} aria-current={state === 'active' ? 'step' : undefined}>
              <div className="rail">
                <div className={`marker ${state}`} aria-hidden="true">
                  {state === 'done' && <Check />}
                  {state === 'failed' && '!'}
                </div>
                {i < STAGES.length - 1 && <div className={`line${solid ? ' solid' : ''}`} />}
              </div>
              <div className="body">
                <div>
                  <div className="name">
                    {label}
                    <span className="visually-hidden">{state === 'done' ? ', done' : state === 'active' ? ', in progress' : state === 'failed' ? ', stopped' : ''}</span>
                  </div>
                  {st.state === 'waiting' && WAITING_NOTE[name] && !isFailed && <div className="detail">{WAITING_NOTE[name]}</div>}
                  {st.state !== 'waiting' && st.detail && <div className="detail">{st.detail}</div>}
                </div>
                {st.state === 'active' && st.total ? (
                  <div
                    className="bar"
                    role="progressbar"
                    aria-label={`${NAMES[name].active} progress`}
                    aria-valuemin={0}
                    aria-valuemax={st.total}
                    aria-valuenow={st.done ?? 0}
                    aria-valuetext={`${st.done ?? 0} of ${st.total} sections`}
                  >
                    <div style={{ width: `${Math.round(((st.done ?? 0) / st.total) * 100)}%` }} />
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {failed ? (
        <div className="alert-box" role="alert">
          <div className="msg">
            <Notice size={20} />
            <div>{failed.message}</div>
          </div>
          <div className="row">
            {failed.suggestPaste ? (
              <button type="button" className="btn" onClick={pasteInstead}>
                Paste the text instead
              </button>
            ) : (
              <button type="button" className="btn" onClick={retry} disabled={busy}>
                {failed.audioOnly ? 'Make the audio again' : 'Try again'}
              </button>
            )}
            <button type="button" className="btn" onClick={cancel} disabled={busy}>
              Start over
            </button>
          </div>
          {retryError && <div style={{ fontSize: 14 }}>{retryError}</div>}
        </div>
      ) : (
        <div className="card lace">
          <div className="big">Lace up.</div>
          <p>This takes a few minutes on a laptop. Leave this tab open and go get ready. If something stops, it picks up where it left off.</p>
        </div>
      )}

      {lost && (
        <p className="small center" role="status">
          Lost touch with the app on this computer. Trying again…
        </p>
      )}

      {!failed && (
        <button type="button" className="link-button" style={{ alignSelf: 'center' }} onClick={cancel} disabled={busy}>
          Cancel
        </button>
      )}
    </div>
  );
}
