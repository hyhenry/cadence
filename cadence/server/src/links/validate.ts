// Fetch a normalised link and check it is really an iCalendar feed before
// handing it to HA's remote_calendar config flow.
import { GOOGLE_SECRET_STEPS, LinkError, OUTLOOK_ICS_STEPS, type Provider } from './normalize.ts';

export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface LinkCheck {
  eventCount: number;
  suggestedName: string | null;
}

const MAX_BYTES = 10 * 1024 * 1024;

function hint(provider: Provider): string {
  if (provider === 'google') return ` ${GOOGLE_SECRET_STEPS}`;
  if (provider === 'outlook') return ` ${OUTLOOK_ICS_STEPS}`;
  return '';
}

/** Google answers 403/404 or a sign-in page for the public feed of a calendar that is not public. */
export function isGooglePublicFeed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'calendar.google.com' && /^\/calendar\/ical\/[^/]+\/public\/basic\.ics$/.test(u.pathname);
  } catch {
    return false;
  }
}

const NOT_PUBLIC = `This Google calendar is not public, so Google will not share it at this address. ${GOOGLE_SECRET_STEPS}`;

export function inspectIcs(body: string, contentType: string, provider: Provider): LinkCheck {
  const head = body.slice(0, 2048).trimStart();
  const looksHtml = /^<(!doctype|html|head|body)/i.test(head) || contentType.includes('text/html');
  if (looksHtml) {
    const login = /type=["']?password|sign[ -]?in|log[ -]?in|accounts\.google\.com|login\.microsoftonline/i.test(body.slice(0, 20000));
    if (login) throw new LinkError('login_page', `The link opens a sign-in page, so the calendar is not shared publicly.${hint(provider)}`);
    throw new LinkError('html', `The link opens a web page, not a calendar file.${hint(provider)}`);
  }
  if (!/^BEGIN:VCALENDAR/i.test(head.replace(/^﻿/, ''))) throw new LinkError('not_ics', 'The link does not return calendar data (iCalendar).');
  if (!/END:VCALENDAR/i.test(body)) throw new LinkError('not_ics', 'The calendar data is incomplete.');
  const eventCount = (body.match(/^BEGIN:VEVENT/gim) ?? []).length;
  const name = /^X-WR-CALNAME:(.+)$/im.exec(body)?.[1]?.trim() ?? null;
  return { eventCount, suggestedName: name ? name.replace(/\\,/g, ',').replace(/\\;/g, ';') : null };
}

export async function checkLink(url: string, provider: Provider, fetcher: Fetcher = fetch, timeoutMs = 15_000): Promise<LinkCheck> {
  let res: Response;
  try {
    res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new LinkError('timeout', 'The calendar server did not answer in time.');
    throw new LinkError('network', 'Could not connect to the calendar server. Check the link.');
  }
  const googlePublic = provider === 'google' && isGooglePublicFeed(url);
  if (googlePublic && (res.status === 401 || res.status === 403 || res.status === 404)) throw new LinkError('google_not_public', NOT_PUBLIC);
  if (res.status === 401 || res.status === 403) throw new LinkError('forbidden', `The calendar server refused access.${hint(provider)}`);
  if (res.status === 404 || res.status === 410) throw new LinkError('not_found', `The calendar was not found. The link may be wrong or no longer shared.${hint(provider)}`);
  if (!res.ok) throw new LinkError('http_error', `The calendar server returned an error (${res.status}).`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new LinkError('too_large', 'The calendar file is too large.');
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new LinkError('too_large', 'The calendar file is too large.');
  try {
    return inspectIcs(body, (res.headers.get('content-type') ?? '').toLowerCase(), provider);
  } catch (err) {
    if (googlePublic && err instanceof LinkError && (err.code === 'login_page' || err.code === 'html')) throw new LinkError('google_not_public', NOT_PUBLIC);
    throw err;
  }
}

/** In mock mode, route the share-link hosts the mock fakes (Google, Outlook, feeds.mock.test) to it. */
export function mockAwareFetcher(mockUrl: string | null): Fetcher {
  if (!mockUrl) return fetch;
  const fakeHosts = new Set(['calendar.google.com', 'outlook.office365.com', 'outlook.live.com', 'outlook.office.com', 'feeds.mock.test']);
  return (url, init) => {
    const u = new URL(url);
    if (fakeHosts.has(u.hostname)) return fetch(`${mockUrl}/mock/remote/${u.hostname}${u.pathname}${u.search}`, init);
    return fetch(url, init);
  };
}
