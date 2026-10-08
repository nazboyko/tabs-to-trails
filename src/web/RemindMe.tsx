import { useState } from 'react';
import { eveningStart, hourOf, morningStart, pickedStart } from './remind';

/**
 * "Remind me": three ways to pick when, and a calendar file for the
 * person's own calendar. Nothing leaves this computer.
 */
export function RemindMe({ href, seriesLeft, open: openHow = 'download' }: { href: (start: Date, daily: boolean) => string; seriesLeft: number; open?: 'download' | 'navigate' }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState('');
  const [daily, setDaily] = useState(false);
  const [note, setNote] = useState('');
  const now = new Date();
  const evening = eveningStart(now);
  const morning = morningStart(now);
  const when = pickedStart(picked);

  const go = (start: Date) => {
    const url = href(start, daily);
    if (openHow === 'navigate') {
      // On a phone the calendar app takes the file from here.
      window.location.href = url;
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    const day = start.toDateString() === now.toDateString() ? 'today' : start.toLocaleDateString([], { weekday: 'long' });
    setNote(`A reminder for ${day} at ${hourOf(start)}${daily && seriesLeft ? `, and one a day for the ${seriesLeft === 1 ? 'part' : `${seriesLeft} parts`} left` : ''}. Open the file to add it to your calendar.`);
  };

  // The button sits in its row; the choices open as a line of their own under it.
  return (
    <>
      <div className="remind">
        <button type="button" className="btn" style={{ minHeight: 52 }} aria-expanded={open} aria-controls="remind-box" onClick={() => setOpen(!open)}>
          Remind me
        </button>
        <p className="small remind-line">Adds an event to your own calendar. Nothing is sent anywhere.</p>
      </div>
      {open && (
        <div className="remind-box" id="remind-box">
          <div className="row">
            {evening && (
              <button type="button" className="btn" onClick={() => go(evening)}>
                This evening <span className="when">{hourOf(evening)}</span>
              </button>
            )}
            <button type="button" className="btn" onClick={() => go(morning)}>
              Tomorrow morning <span className="when">{hourOf(morning)}</span>
            </button>
          </div>
          <div className="field">
            <label htmlFor="remind-at">Pick a time</label>
            <div className="row">
              <input id="remind-at" className="input" type="datetime-local" value={picked} onChange={(e) => setPicked(e.target.value)} />
              <button type="button" className="btn" disabled={!when} onClick={() => when && go(when)}>
                Add this time
              </button>
            </div>
          </div>
          {seriesLeft > 0 && (
            <label className="remind-daily">
              <input type="checkbox" checked={daily} onChange={(e) => setDaily(e.target.checked)} />
              One reminder a day for the parts that are left
            </label>
          )}
          <p className="small" role="status">
            {note}
          </p>
        </div>
      )}
    </>
  );
}
