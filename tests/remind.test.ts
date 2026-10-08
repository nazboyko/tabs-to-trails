import { describe, expect, it } from 'vitest';
import { dailyStarts, fold, icsCalendar, icsText, icsTime, reminderTitle } from '../src/server/remind/ics.js';
import { eveningStart, morningStart, pickedStart, remindHref } from '../src/web/remind.js';

describe('the calendar file', () => {
  const start = new Date(Date.UTC(2026, 9, 8, 23, 0, 0));
  const ics = icsCalendar(
    [{ uid: 'abcdef123456@tabs-to-trails', title: reminderTitle('Walking, part one; with notes', 1179), start, seconds: 1179, description: 'The walk is the MP3 walking-20min-walk.mp3.\nTake water.' }],
    new Date(Date.UTC(2026, 9, 7, 22, 0, 0)),
  );

  it('uses CRLF line endings throughout', () => {
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('writes UTC times, the walk length and an alert at the start', () => {
    expect(ics).toContain('DTSTART:20261008T230000Z');
    expect(ics).toContain('DTEND:20261008T231939Z');
    expect(ics).toContain('DTSTAMP:20261007T220000Z');
    expect(ics).toContain('UID:abcdef123456@tabs-to-trails');
    expect(ics).toMatch(/BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:.*\r\nTRIGGER:PT0S\r\nEND:VALARM/);
  });

  it('escapes text and names the walk with its minutes', () => {
    expect(icsText('a, b; c\\d\ne')).toBe('a\\, b\\; c\\\\d\\ne');
    expect(ics).toContain('SUMMARY:Walk: Walking\\, part one\\; with notes · 20 min');
    expect(ics).not.toContain('http');
  });

  it('folds long lines at 75 bytes without splitting a character', () => {
    const long = `SUMMARY:${'Walk · '.repeat(30)}`;
    const folded = fold(long);
    for (const line of folded.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.split('\r\n').slice(1).every((l) => l.startsWith(' '))).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
    expect(icsTime(start)).toBe('20261008T230000Z');
  });

  it('gives the parts that are left one day each, at the same hour', () => {
    expect(dailyStarts(start, 2).map((d) => d.toISOString())).toEqual(['2026-10-09T23:00:00.000Z', '2026-10-10T23:00:00.000Z']);
  });
});

describe('when the reminder starts', () => {
  it('offers this evening at six, later the next quarter hour, and nothing late at night', () => {
    expect(eveningStart(new Date(2026, 9, 8, 10, 0))).toEqual(new Date(2026, 9, 8, 18, 0));
    expect(eveningStart(new Date(2026, 9, 8, 17, 40))).toEqual(new Date(2026, 9, 8, 18, 15));
    expect(eveningStart(new Date(2026, 9, 8, 19, 5))).toEqual(new Date(2026, 9, 8, 19, 45));
    expect(eveningStart(new Date(2026, 9, 8, 21, 30))).toBeNull();
  });

  it('offers tomorrow at eight, and reads a picked time as local', () => {
    expect(morningStart(new Date(2026, 9, 31, 23, 50))).toEqual(new Date(2026, 10, 1, 8, 0));
    expect(pickedStart('2026-10-09T07:30')).toEqual(new Date(2026, 9, 9, 7, 30));
    expect(pickedStart('tomorrow')).toBeNull();
  });

  it('asks for the file with the start in UTC', () => {
    const at = new Date(Date.UTC(2026, 9, 9, 13, 0));
    expect(remindHref('/api/walks/abcdef123456', at, false)).toBe('/api/walks/abcdef123456/remind.ics?start=2026-10-09T13%3A00%3A00.000Z');
    expect(remindHref('/w/abcdef123456', at, true, 't=tok')).toBe('/w/abcdef123456/remind.ics?t=tok&start=2026-10-09T13%3A00%3A00.000Z&daily=1');
  });
});
