/**
 * When a reminder starts, worked out in the person's own time zone. No
 * imports, so the phone page and the tests share it.
 */

/** Today at 18:00; already evening, the next quarter hour plus half an hour; after 21:00, no evening left. */
export function eveningStart(now: Date): Date | null {
  const six = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0, 0);
  if (now.getTime() < six.getTime() - 30 * 60_000) return six;
  if (now.getHours() >= 21) return null;
  const soon = new Date(now.getTime() + 30 * 60_000);
  soon.setMinutes(Math.ceil(soon.getMinutes() / 15) * 15, 0, 0);
  return soon;
}

/** Tomorrow at 8:00. */
export function morningStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0, 0);
}

/** A value from a datetime-local field ("2026-10-08T07:30") as a time here, or null. */
export function pickedStart(value: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "18:00" or "6:00 PM", the way this device writes times. */
export function hourOf(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The reminder file's address: the start in UTC, and one a day for the parts left when asked. */
export function remindHref(base: string, start: Date, daily: boolean, query = ''): string {
  const params = new URLSearchParams(query);
  params.set('start', start.toISOString());
  if (daily) params.set('daily', '1');
  return `${base}/remind.ics?${params.toString()}`;
}
