/**
 * A reminder as an iCalendar file: one event per walk, added to the person's
 * own calendar by their own calendar app. Pure, no account, no request.
 */

export interface Reminder {
  /** Stable across downloads of the same reminder, so a second import updates instead of doubling. */
  uid: string;
  title: string;
  start: Date;
  /** Seconds. */
  seconds: number;
  description: string;
}

/** Text as iCalendar wants it: backslash, semicolon, comma and line breaks escaped. */
export function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** A UTC time as 20261008T000000Z. */
export function icsTime(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Lines longer than 75 bytes go on, after a line break and a space, never inside a character. */
export function fold(line: string): string {
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
  if (bytes(line) <= 75) return line;
  const out: string[] = [];
  let current = '';
  for (const ch of line) {
    const limit = out.length ? 74 : 75;
    if (bytes(current + ch) > limit) {
      out.push(current);
      current = '';
    }
    current += ch;
  }
  out.push(current);
  return out.join('\r\n ');
}

export function icsCalendar(reminders: Reminder[], now: Date = new Date()): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tabs to Trails//Walk reminder//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const r of reminders) {
    const end = new Date(r.start.getTime() + Math.max(60, Math.round(r.seconds)) * 1000);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${r.uid}`,
      `DTSTAMP:${icsTime(now)}`,
      `DTSTART:${icsTime(r.start)}`,
      `DTEND:${icsTime(end)}`,
      `SUMMARY:${icsText(r.title)}`,
      `DESCRIPTION:${icsText(r.description)}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsText(r.title)}`,
      'TRIGGER:PT0S',
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** "Walk: Hiking · 21 min". */
export function reminderTitle(title: string, seconds: number): string {
  return `Walk: ${title} · ${Math.max(1, Math.round(seconds / 60))} min`;
}

/** The same hour on each of the next days, one per part still waiting. */
export function dailyStarts(first: Date, count: number): Date[] {
  return Array.from({ length: count }, (_, i) => new Date(first.getTime() + (i + 1) * 86_400_000));
}
