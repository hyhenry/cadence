// Turn whatever people paste (webcal links, Google embed/share pages, Outlook
// published HTML pages, bare Google calendar IDs) into a fetchable .ics URL.
// Share URLs are secrets: nothing here logs them.

export type Provider = 'google' | 'outlook' | 'icloud' | 'ical';

export class LinkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface NormalizedLink {
  url: string;
  provider: Provider;
  /** True when the pasted text was rewritten. */
  changed: boolean;
}

/** Plain steps to the secret iCal address, which works without making the calendar public. */
export const GOOGLE_SECRET_STEPS =
  'To add a private Google calendar without making it public, use its secret address: 1. Open Google Calendar on a computer. 2. Settings (gear) → Settings for my calendars → choose the calendar. 3. Integrate calendar → copy "Secret address in iCal format" (it ends in /basic.ics). 4. Paste that here.';
export const OUTLOOK_ICS_STEPS = 'In Outlook on the web: Settings → Calendar → Shared calendars → Publish a calendar → choose the calendar → Publish, then copy the ICS link.';

const GOOGLE_ID = /^[^\s/@]+@(?:group\.calendar\.google\.com|gmail\.com|googlemail\.com|import\.calendar\.google\.com|[a-z0-9.-]+\.[a-z]{2,})$/i;
const OUTLOOK_HOSTS = new Set(['outlook.office365.com', 'outlook.live.com', 'outlook.office.com']);

function googleIcs(calendarId: string): string {
  return `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`;
}

function decodeCid(cid: string): string {
  if (cid.includes('@')) return cid;
  try {
    const b64 = cid.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64').toString('utf8');
    if (/^[\x20-\x7e]+@[\x20-\x7e]+$/.test(decoded)) return decoded;
  } catch {
    /* fall through */
  }
  return cid;
}

export function normalizeLink(input: string): NormalizedLink {
  const original = (input ?? '').trim().replace(/^<|>$/g, '').trim();
  if (!original) throw new LinkError('empty', 'Paste a calendar link first.');

  // A bare Google calendar ID ("abc123@group.calendar.google.com").
  if (!original.includes('://') && GOOGLE_ID.test(original) && /google|gmail/i.test(original)) {
    return { url: googleIcs(original), provider: 'google', changed: true };
  }

  let text = original;
  if (/^webcals?:\/\//i.test(text)) text = text.replace(/^webcals?:\/\//i, 'https://');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new LinkError('invalid_url', "That doesn't look like a link.");
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new LinkError('invalid_url', 'Only http(s) and webcal links are supported.');
  url.hash = '';
  const host = url.hostname.toLowerCase();

  if (host === 'calendar.google.com' || host === 'www.google.com') {
    url.protocol = 'https:';
    const p = url.pathname;
    if (/^\/calendar\/ical\//.test(p)) {
      return { url: url.toString(), provider: 'google', changed: url.toString() !== original };
    }
    // "Shareable link" (…/calendar/u/0?cid=…): it only opens the calendar for a signed-in Google user.
    if (url.searchParams.get('cid')) {
      throw new LinkError('google_share_link', `This is Google's shareable link, which only works for people signed in to Google. ${GOOGLE_SECRET_STEPS}`);
    }
    // Embed links point at the public feed; that only works if the calendar is public (checked when fetched).
    const src = url.searchParams.get('src');
    if (src && (/^\/calendar\/(embed|render)/.test(p) || p === '/calendar' || p === '/calendar/')) {
      return { url: googleIcs(decodeCid(src)), provider: 'google', changed: true };
    }
    throw new LinkError('google_unsupported', `This Google Calendar link cannot be read. ${GOOGLE_SECRET_STEPS}`);
  }

  if (OUTLOOK_HOSTS.has(host)) {
    url.protocol = 'https:';
    if (/\/calendar\.html$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/calendar\.html$/i, 'calendar.ics');
      return { url: url.toString(), provider: 'outlook', changed: true };
    }
    if (/\.ics$/i.test(url.pathname)) return { url: url.toString(), provider: 'outlook', changed: url.toString() !== original };
    throw new LinkError(
      'outlook_unsupported',
      `This Outlook link cannot be read. ${OUTLOOK_ICS_STEPS}`,
    );
  }

  const provider: Provider = /(^|\.)icloud\.com$/.test(host) ? 'icloud' : 'ical';
  if (provider === 'icloud') url.protocol = 'https:';
  const out = url.toString();
  return { url: out, provider, changed: out !== original };
}

/** A short, non-secret label for a link (for UI and logs): provider + host only. */
export function redactLink(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return 'invalid link';
  }
}
