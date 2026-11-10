// Minimal iCalendar parsing for remote_calendar, plus generated fixtures that
// stand in for Google / Outlook share links when developing offline.
import { DateTime } from 'luxon';
import type { CalendarStore } from './calendar.ts';

export class InvalidIcs extends Error {}

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function unescape(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseIcsDate(value: string, params: Record<string, string>, tz: string): { allDay: boolean; wall: string } {
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    return { allDay: true, wall: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` };
  }
  const zone = value.endsWith('Z') ? 'utc' : params.TZID || tz;
  const d = DateTime.fromFormat(value.replace('Z', ''), "yyyyMMdd'T'HHmmss", { zone });
  if (!d.isValid) throw new InvalidIcs(`bad date ${value}`);
  return { allDay: false, wall: d.setZone(tz).toFormat("yyyy-MM-dd'T'HH:mm:ss") };
}

/** Parse ICS text into the store (replacing its contents). Throws InvalidIcs. */
export function loadIcs(text: string, store: CalendarStore): void {
  const lines = unfold(text.trim());
  if (lines[0]?.trim() !== 'BEGIN:VCALENDAR') throw new InvalidIcs('not a VCALENDAR');
  if (!lines.some((l) => l.trim() === 'END:VCALENDAR')) throw new InvalidIcs('unterminated VCALENDAR');
  store.events.clear();
  let cur: Record<string, { value: string; params: Record<string, string> }> | null = null;
  let depth = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === 'BEGIN:VEVENT') {
      cur = {};
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('BEGIN:')) depth++;
    else if (line.startsWith('END:') && line !== 'END:VEVENT') depth--;
    else if (line === 'END:VEVENT') {
      const s = cur.DTSTART;
      if (!s) throw new InvalidIcs('VEVENT without DTSTART');
      const start = parseIcsDate(s.value, s.params, store.tz);
      const e = cur.DTEND ? parseIcsDate(cur.DTEND.value, cur.DTEND.params, store.tz) : null;
      const end = e?.wall ?? (start.allDay ? DateTime.fromISO(start.wall).plus({ days: 1 }).toISODate()! : start.wall);
      const rrule = cur.RRULE?.value;
      store.add(
        {
          summary: unescape(cur.SUMMARY?.value ?? ''),
          description: cur.DESCRIPTION ? unescape(cur.DESCRIPTION.value) : undefined,
          location: cur.LOCATION ? unescape(cur.LOCATION.value) : undefined,
          allDay: start.allDay,
          start: start.wall,
          end,
          rrule: rrule && /FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.test(rrule) ? rrule : undefined,
        },
        cur.UID?.value ?? undefined,
      );
      cur = null;
      continue;
    }
    if (depth > 0) continue; // skip VALARM etc.
    const m = /^([A-Z-]+)((?:;[^:]+)*):(.*)$/.exec(line);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (const p of m[2].split(';').filter(Boolean)) {
      const [k, v] = p.split('=');
      params[k] = (v ?? '').replace(/^"|"$/g, '');
    }
    cur[m[1]] = { value: m[3], params };
  }
}

// ---------------------------------------------------------------------------
// Fixture feeds. Dates are generated relative to "today" so they are visible.

function icsDate(d: DateTime): string {
  return d.toFormat('yyyyMMdd');
}
function icsUtc(d: DateTime): string {
  return d.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
}

function vcal(prodid: string, name: string, events: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${prodid}`, `X-WR-CALNAME:${name}`, ...events, 'END:VCALENDAR', ''].join('\r\n');
}

export function googleFeed(tz: string): string {
  const today = DateTime.now().setZone(tz).startOf('day');
  return vcal('-//Google Inc//Google Calendar 70.9054//EN', 'School events', [
    ['BEGIN:VEVENT', `UID:g-assembly@google.com`, `DTSTART:${icsUtc(today.plus({ days: 2, hours: 9 }))}`, `DTEND:${icsUtc(today.plus({ days: 2, hours: 10 }))}`, 'SUMMARY:School assembly', 'LOCATION:Main gym', 'END:VEVENT'].join('\r\n'),
    ['BEGIN:VEVENT', `UID:g-pd-day@google.com`, `DTSTART;VALUE=DATE:${icsDate(today.plus({ days: 5 }))}`, `DTEND;VALUE=DATE:${icsDate(today.plus({ days: 6 }))}`, 'SUMMARY:PD day - no school', 'END:VEVENT'].join('\r\n'),
    ['BEGIN:VEVENT', `UID:g-club@google.com`, `DTSTART:${icsUtc(today.plus({ hours: 15, minutes: 30 }))}`, `DTEND:${icsUtc(today.plus({ hours: 16, minutes: 30 }))}`, 'RRULE:FREQ=WEEKLY;COUNT=8', 'SUMMARY:Robotics club', 'END:VEVENT'].join('\r\n'),
  ]);
}

export function outlookFeed(tz: string): string {
  const today = DateTime.now().setZone(tz).startOf('day');
  return vcal('-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN', 'Team calendar', [
    ['BEGIN:VEVENT', `UID:o-offsite`, `DTSTART;TZID=${tz}:${today.plus({ days: 3, hours: 13 }).toFormat("yyyyMMdd'T'HHmmss")}`, `DTEND;TZID=${tz}:${today.plus({ days: 3, hours: 17 }).toFormat("yyyyMMdd'T'HHmmss")}`, 'SUMMARY:Team offsite', 'END:VEVENT'].join('\r\n'),
    ['BEGIN:VEVENT', `UID:o-sync`, `DTSTART:${icsUtc(today.plus({ days: 1, hours: 11 }))}`, `DTEND:${icsUtc(today.plus({ days: 1, hours: 11, minutes: 30 }))}`, 'RRULE:FREQ=WEEKLY;BYDAY=' + ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][today.plus({ days: 1 }).weekday - 1], 'SUMMARY:Weekly sync', 'END:VEVENT'].join('\r\n'),
  ]);
}

export function holidaysFeed(tz: string): string {
  const today = DateTime.now().setZone(tz).startOf('day');
  return vcal('-//Mock//Holidays//EN', 'Holidays', [
    ['BEGIN:VEVENT', 'UID:h-1', `DTSTART;VALUE=DATE:${icsDate(today.plus({ days: 8 }))}`, `DTEND;VALUE=DATE:${icsDate(today.plus({ days: 9 }))}`, 'SUMMARY:Civic holiday', 'END:VEVENT'].join('\r\n'),
    ['BEGIN:VEVENT', 'UID:h-2', `DTSTART;VALUE=DATE:${icsDate(today.minus({ days: 6 }))}`, `DTEND;VALUE=DATE:${icsDate(today.minus({ days: 5 }))}`, 'SUMMARY:Founders day', 'END:VEVENT'].join('\r\n'),
  ]);
}

const LOGIN_PAGE = '<!doctype html><html><head><title>Sign in to your account</title></head><body><form action="/login"><input type="password" name="pw"></form></body></html>';
const OUTLOOK_HTML = '<!doctype html><html><head><title>Outlook calendar</title></head><body><div id="calendar">Published calendar</div></body></html>';

export interface FakeResponse {
  status: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

/**
 * Hosts that stand in for real share-link providers while developing offline.
 * Returns null when the URL is not one of them (the caller then does a real fetch).
 */
export function fakeRemote(url: URL, tz: string): FakeResponse | null {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const ics = (body: string): FakeResponse => ({ status: 200, contentType: 'text/calendar; charset=utf-8', body });
  if (host === 'calendar.google.com') {
    if (path.startsWith('/calendar/ical/')) {
      // Google returns 404 for the public feed of a calendar that is not public.
      if (/\/public\/basic\.ics$/.test(path) && /notpublic/i.test(decodeURIComponent(path))) return { status: 404, contentType: 'text/html', body: 'Not Found' };
      if (path.includes('/private-nope')) return { status: 404, contentType: 'text/html', body: 'Not Found' };
      if (path.includes('forbidden')) return { status: 403, contentType: 'text/html', body: 'Forbidden' };
      return ics(googleFeed(tz));
    }
    if (path.startsWith('/calendar/embed') || path.startsWith('/calendar/u/')) return { status: 200, contentType: 'text/html', body: LOGIN_PAGE };
    return { status: 404, contentType: 'text/html', body: 'Not Found' };
  }
  if (host === 'outlook.office365.com' || host === 'outlook.live.com' || host === 'outlook.office.com') {
    if (path.endsWith('.ics')) return ics(outlookFeed(tz));
    if (path.endsWith('.html')) return { status: 200, contentType: 'text/html', body: OUTLOOK_HTML };
    return { status: 404, contentType: 'text/html', body: 'Not Found' };
  }
  if (host === 'feeds.mock.test') {
    if (path === '/holidays.ics') return ics(holidaysFeed(tz));
    if (path === '/login') return { status: 200, contentType: 'text/html', body: LOGIN_PAGE };
    if (path === '/basic.ics') return { status: 401, contentType: 'text/plain', body: 'auth', headers: { 'www-authenticate': 'Basic realm="cal"' } };
    if (path === '/broken.ics') return { status: 200, contentType: 'text/calendar', body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' };
    return { status: 404, contentType: 'text/plain', body: 'Not Found' };
  }
  return null;
}

export async function fetchRemote(rawUrl: string, tz: string): Promise<FakeResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('invalid url');
  }
  const fake = fakeRemote(url, tz);
  if (fake) return fake;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text(), headers: Object.fromEntries(res.headers) };
}
