import { useEffect, useRef, useState } from 'react';
import { api, type Health } from '../api';
import { ScreenTitle } from '../common';
import { Check } from '../icons';

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Without clipboard access the command is still there to select by hand.
    }
  };
  return (
    <div className="command">
      <code>{command}</code>
      <button type="button" className="btn" onClick={copy} aria-label={copied ? `Copied: ${command}` : `Copy ${command}`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

interface Item {
  ok: boolean | null;
  title: string;
  text: string;
  command?: string;
}

function items(h: Health): Item[] {
  const ollamaUp = h.ollama !== 'unreachable';
  return [
    ollamaUp
      ? { ok: true, title: 'Ollama is running', text: 'It runs the model that rewrites text for listening.' }
      : {
          ok: false,
          title: "Ollama isn't running",
          text: 'It runs the model that rewrites text for listening. If it is installed, start it in a terminal. If not, install it from ollama.com first.',
          command: 'ollama serve',
        },
    h.ollama === 'ready'
      ? { ok: true, title: 'Gemma 4 is downloaded', text: `The model ${h.model} is on this computer.` }
      : h.ollama === 'model-missing'
        ? {
            ok: false,
            title: "Gemma 4 isn't downloaded yet",
            text: 'Open a terminal and run this. It is a large download, so start it and come back.',
            command: `ollama pull ${h.model}`,
          }
        : { ok: null, title: 'Gemma 4', text: 'Checked as soon as Ollama is running.' },
    h.voice === 'ready'
      ? { ok: true, title: 'The voice is ready', text: 'Kokoro, downloaded once and kept on this computer.' }
      : { ok: null, title: 'The voice downloads on your first walk', text: 'Kokoro, about 330 MB, once. It stays on this computer after that.' },
    h.ffmpeg
      ? { ok: true, title: 'The audio packer is ready', text: 'ffmpeg, bundled with the app.' }
      : { ok: false, title: 'The audio packer is missing', text: 'It comes with the app. Run this in the project folder, then check again.', command: 'npm ci' },
  ];
}

export function Setup({ health, onReady }: { health: Health; onReady: (h: Health) => void }) {
  const [current, setCurrent] = useState(health);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState('');

  const check = async (byUser: boolean) => {
    if (byUser) setChecking(true);
    try {
      const h = await api.health();
      setCurrent(h);
      if (h.ready) onReady(h);
      else if (byUser) setNote('Still missing. The list above shows what to do.');
    } catch {
      if (byUser) setNote('The app on this computer is not answering. Is it still running?');
    } finally {
      if (byUser) setChecking(false);
    }
  };

  useEffect(() => {
    const timer = window.setInterval(() => void check(false), 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = items(current);
  const missing = list.filter((i) => i.ok === false).length;

  return (
    <div className="page" style={{ gap: 32 }}>
      <div className="stack" style={{ gap: 12 }}>
        <ScreenTitle title="Almost ready" className="setup-title">
          Almost ready.
        </ScreenTitle>
        <p className="lede">
          Everything runs on this computer, so it needs a few pieces installed once.{' '}
          {missing === 1 ? 'One is still missing.' : `${missing} are still missing.`}
        </p>
      </div>
      <ul className="checklist">
        {list.map((item) => (
          <li key={item.title} className={item.ok === false ? 'missing' : undefined}>
            {item.ok === true && (
              <span className="marker done" aria-hidden="true">
                <Check />
              </span>
            )}
            {item.ok === false && (
              <span className="marker missing" aria-hidden="true">
                !
              </span>
            )}
            {item.ok === null && <span className="marker waiting" aria-hidden="true" />}
            <div className="stack" style={{ gap: 10, flex: 1, minWidth: 0 }}>
              <div>
                <div className="name">
                  <span className="visually-hidden">{item.ok === true ? 'Done: ' : item.ok === false ? 'Missing: ' : ''}</span>
                  {item.title}
                </div>
                <div className="small">{item.text}</div>
              </div>
              {item.command && <CopyCommand command={item.command} />}
            </div>
          </li>
        ))}
      </ul>
      <div className="stack" style={{ gap: 10 }}>
        <button type="button" className="btn primary block" onClick={() => void check(true)} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
        <p className="small center" role="status">
          {note}
        </p>
      </div>
    </div>
  );
}
