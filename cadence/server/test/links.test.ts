import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinkError, normalizeLink, redactLink } from '../src/links/normalize.ts';
import { checkLink, inspectIcs } from '../src/links/validate.ts';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as LinkError).code;
  }
  return null;
};

test('webcal:// becomes https://', () => {
  const r = normalizeLink('webcal://p42-caldav.icloud.com/published/2/abc');
  assert.equal(r.url, 'https://p42-caldav.icloud.com/published/2/abc');
  assert.equal(r.provider, 'icloud');
  assert.equal(r.changed, true);
  assert.equal(normalizeLink('webcals://example.com/cal.ics').url, 'https://example.com/cal.ics');
});

test('Google embed links become the public iCal feed, with the id encoded', () => {
  const r = normalizeLink('https://calendar.google.com/calendar/embed?src=family123%40group.calendar.google.com&ctz=America%2FToronto');
  assert.equal(r.url, 'https://calendar.google.com/calendar/ical/family123%40group.calendar.google.com/public/basic.ics');
  assert.equal(r.provider, 'google');
});

test('Google "shareable link" (cid=) is detected and answered with the secret-address steps', () => {
  for (const u of ['https://calendar.google.com/calendar/u/0?cid=YWJjQGdyb3VwLmNhbGVuZGFyLmdvb2dsZS5jb20', 'https://calendar.google.com/calendar/r?cid=someone@gmail.com', 'https://calendar.google.com/calendar/embed?cid=abc']) {
    try {
      normalizeLink(u);
      assert.fail('should throw');
    } catch (e) {
      assert.equal((e as LinkError).code, 'google_share_link', u);
      assert.match((e as Error).message, /Secret address in iCal format/);
      assert.match((e as Error).message, /Integrate calendar/);
    }
  }
});

test('a bare Google calendar id is accepted', () => {
  assert.equal(normalizeLink('en.canadian#holiday@group.v.calendar.google.com').url, 'https://calendar.google.com/calendar/ical/en.canadian%23holiday%40group.v.calendar.google.com/public/basic.ics');
});

test('Google secret addresses (private-…/basic.ics) are kept as they are', () => {
  const secret = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-0123abcd4567ef/basic.ics';
  assert.deepEqual(normalizeLink(secret), { url: secret, provider: 'google', changed: false });
  // webcal:// and http:// variants of the secret address are fixed up, not rejected.
  assert.equal(normalizeLink(secret.replace('https://', 'webcal://')).url, secret);
  assert.equal(normalizeLink(secret.replace('https://', 'http://')).url, secret);
});

test('other Google pages get the secret-address steps', () => {
  assert.equal(code(() => normalizeLink('https://calendar.google.com/calendar/u/0/r/week')), 'google_unsupported');
  try {
    normalizeLink('https://calendar.google.com/calendar/u/0/r/week');
  } catch (e) {
    assert.match((e as Error).message, /Secret address in iCal format/);
  }
});

test('Outlook published HTML pages become the ICS link', () => {
  const r = normalizeLink('https://outlook.office365.com/owa/calendar/1a2b@contoso.com/3c4d/calendar.html');
  assert.equal(r.url, 'https://outlook.office365.com/owa/calendar/1a2b@contoso.com/3c4d/calendar.ics');
  assert.equal(r.provider, 'outlook');
  assert.equal(normalizeLink('https://outlook.live.com/owa/calendar/00000000-0000/abcd/cid-XYZ/calendar.ics').changed, false);
  assert.equal(code(() => normalizeLink('https://outlook.live.com/calendar/0/view/month')), 'outlook_unsupported');
});

test('junk input is rejected', () => {
  assert.equal(code(() => normalizeLink('   ')), 'empty');
  assert.equal(code(() => normalizeLink('ftp://example.com/x.ics')), 'invalid_url');
  assert.equal(code(() => normalizeLink('http://exa mple.com')), 'invalid_url');
});

test('missing scheme defaults to https and fragments are dropped', () => {
  assert.equal(normalizeLink('example.com/team.ics#x').url, 'https://example.com/team.ics');
});

test('redactLink keeps only the host', () => {
  assert.equal(redactLink('https://calendar.google.com/calendar/ical/x/private-secret/basic.ics'), 'calendar.google.com');
});

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Team\\, A\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20261110T100000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:2\r\nDTSTART:20261111T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

test('inspectIcs counts events and reads the calendar name', () => {
  assert.deepEqual(inspectIcs(ICS, 'text/calendar', 'ical'), { eventCount: 2, suggestedName: 'Team, A' });
  assert.deepEqual(inspectIcs('﻿' + ICS, 'text/calendar', 'ical').eventCount, 2);
});

test('inspectIcs recognises HTML and sign-in pages', () => {
  const ics = (body: string, ct = 'text/html') => code(() => inspectIcs(body, ct, 'google'));
  assert.equal(ics('<!doctype html><html><body>Hello</body></html>'), 'html');
  assert.equal(ics('<html><form><input type="password"></form></html>'), 'login_page');
  assert.equal(ics('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n', 'text/calendar'), 'not_ics');
  assert.equal(ics('hello', 'text/plain'), 'not_ics');
});

test('checkLink maps HTTP failures to specific errors', async () => {
  const f = (status: number, body = '', headers: Record<string, string> = {}) => async () => new Response(body, { status, headers });
  const err = async (p: Promise<unknown>) => p.then(() => null, (e: LinkError) => e.code);
  assert.equal(await err(checkLink('https://x/y.ics', 'google', f(404))), 'not_found');
  assert.equal(await err(checkLink('https://x/y.ics', 'google', f(403))), 'forbidden');
  // The public feed of a calendar that is not public: 404/403 or a sign-in page -> secret-address steps.
  const pub = 'https://calendar.google.com/calendar/ical/team%40group.calendar.google.com/public/basic.ics';
  assert.equal(await err(checkLink(pub, 'google', f(404))), 'google_not_public');
  assert.equal(await err(checkLink(pub, 'google', f(403))), 'google_not_public');
  assert.equal(await err(checkLink(pub, 'google', f(200, '<html><input type="password"></html>', { 'content-type': 'text/html' }))), 'google_not_public');
  assert.equal(await err(checkLink('https://x/y.ics', 'ical', f(500))), 'http_error');
  assert.equal(await err(checkLink('https://x/y.ics', 'ical', async () => { throw new TypeError('fetch failed'); })), 'network');
  assert.equal(await err(checkLink('https://x/y.ics', 'ical', async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; })), 'timeout');
  assert.deepEqual(await checkLink('https://x/y.ics', 'ical', f(200, ICS, { 'content-type': 'text/calendar' })), { eventCount: 2, suggestedName: 'Team, A' });
});
