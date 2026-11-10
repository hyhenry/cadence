import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startHarness, until, type Harness } from './helpers.ts';

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(() => h.close());

const SECRET = 'private-9f8e7d6c5b4a3f2e1d0c';
const cals = async () => (await h.inject({ method: 'GET', url: '/api/calendars' })).json().calendars as any[];

test('create a local calendar runs the local_calendar config flow', async () => {
  const res = await h.inject({ method: 'POST', url: '/api/calendars/local', payload: { name: 'Kids', color: '#ec4899' } });
  assert.equal(res.statusCode, 200, res.body);
  const { calendar } = res.json();
  assert.equal(calendar.entity_id, 'calendar.kids');
  assert.equal(calendar.kind, 'local');
  assert.equal(calendar.color, '#ec4899');
  assert.equal(calendar.can_create, true);
  const entry = [...h.mock.ha.entries.values()].find((e) => e.title === 'Kids')!;
  assert.deepEqual(entry.data, { calendar_name: 'Kids', import: 'create_empty', storage_key: 'kids' });
});

test('a duplicate local calendar name is reported clearly', async () => {
  const res = await h.inject({ method: 'POST', url: '/api/calendars/local', payload: { name: 'kids' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'already_exists');
  assert.equal(h.mock.ha.flows.size, 0, 'no dangling flows');
});

test('rename in Cadence only changes the display name', async () => {
  await h.inject({ method: 'PATCH', url: '/api/calendars/calendar.kids', payload: { display_name: 'The kids' } });
  const kids = (await cals()).find((c) => c.entity_id === 'calendar.kids');
  assert.equal(kids.name, 'The kids');
  assert.equal(kids.ha_name, 'Kids');
});

test('delete a local calendar removes the config entry and its entity', async () => {
  const res = await h.inject({ method: 'DELETE', url: '/api/calendars/calendar.kids' });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(!(await cals()).some((c) => c.entity_id === 'calendar.kids'));
  assert.ok(![...h.mock.ha.entries.values()].some((e) => e.title === 'Kids'));
});

test('check a Google embed link: normalised, fetched and parsed', async () => {
  const res = await h.inject({ method: 'POST', url: '/api/calendars/link/check', payload: { url: 'https://calendar.google.com/calendar/embed?src=school%40group.calendar.google.com&ctz=America%2FToronto' } });
  assert.equal(res.statusCode, 200, res.body);
  const r = res.json();
  assert.equal(r.provider, 'google');
  assert.equal(r.url, 'https://calendar.google.com/calendar/ical/school%40group.calendar.google.com/public/basic.ics');
  assert.equal(r.eventCount, 3);
  assert.equal(r.suggestedName, 'School events');
});

test('add a private Google calendar by its secret address (no public sharing needed)', async () => {
  const res = await h.inject({ method: 'POST', url: '/api/calendars/link', payload: { name: 'School', url: `webcal://calendar.google.com/calendar/ical/me%40gmail.com/${SECRET}/basic.ics` } });
  assert.equal(res.statusCode, 200, res.body);
  const { calendar } = res.json();
  assert.equal(calendar.entity_id, 'calendar.school');
  assert.equal(calendar.kind, 'link');
  assert.equal(calendar.can_create, false);
  const entry = [...h.mock.ha.entries.values()].find((e) => e.title === 'School')!;
  assert.equal(entry.domain, 'remote_calendar');
  assert.equal(entry.data.url, `https://calendar.google.com/calendar/ical/me%40gmail.com/${SECRET}/basic.ics`);
  assert.equal(entry.data.verify_ssl, true);
  const now = Date.now();
  const evs = (await h.inject({ method: 'GET', url: `/api/events?calendars=calendar.school&start=${encodeURIComponent(new Date(now - 864e5).toISOString())}&end=${encodeURIComponent(new Date(now + 7 * 864e5).toISOString())}` })).json().events;
  assert.ok(evs.some((e: any) => e.summary === 'School assembly'));
});

test('add an Outlook HTML link: rewritten to .ics', async () => {
  const res = await h.inject({ method: 'POST', url: '/api/calendars/link', payload: { name: 'Team', url: 'https://outlook.office365.com/owa/calendar/abc@contoso.com/def/calendar.html' } });
  assert.equal(res.statusCode, 200, res.body);
  const entry = [...h.mock.ha.entries.values()].find((e) => e.title === 'Team')!;
  assert.equal(entry.data.url, 'https://outlook.office365.com/owa/calendar/abc@contoso.com/def/calendar.ics');
});

test('the same link twice is reported as already added', async () => {
  const res = await h.inject({ method: 'POST', url: '/api/calendars/link', payload: { name: 'Team again', url: 'https://outlook.office365.com/owa/calendar/abc@contoso.com/def/calendar.html' } });
  assert.equal(res.statusCode, 409);
});

test('links that are not calendars get specific errors and never reach HA', async () => {
  const before = h.mock.ha.entries.size;
  const err = async (url: string) => (await h.inject({ method: 'POST', url: '/api/calendars/link', payload: { name: 'X', url } })).json().error;
  assert.equal(await err('https://feeds.mock.test/login'), 'login_page');
  assert.equal(await err('https://calendar.google.com/calendar/ical/x/private-nope/basic.ics'), 'not_found');
  assert.equal(await err('https://calendar.google.com/calendar/ical/forbidden/public/basic.ics'), 'google_not_public');
  assert.equal(await err('https://feeds.mock.test/broken.ics'), 'not_ics');
  assert.equal(await err('https://calendar.google.com/calendar/u/0/r'), 'google_unsupported');
  assert.equal(h.mock.ha.entries.size, before);
});

test('Google cid= share links and non-public embeds get the secret-address steps', async () => {
  const before = h.mock.ha.entries.size;
  for (const [url, code] of [
    ['https://calendar.google.com/calendar/u/0?cid=bm90cHVibGljQGdyb3VwLmNhbGVuZGFyLmdvb2dsZS5jb20', 'google_share_link'],
    ['https://calendar.google.com/calendar/embed?src=family-notpublic%40group.calendar.google.com&ctz=America%2FToronto', 'google_not_public'],
  ] as const) {
    for (const path of ['/api/calendars/link/check', '/api/calendars/link']) {
      const res = await h.inject({ method: 'POST', url: path, payload: { name: 'Family', url } });
      assert.equal(res.statusCode, 400, `${path} ${url}`);
      assert.equal(res.json().error, code);
      assert.match(res.json().message, /Secret address in iCal format/);
    }
  }
  assert.equal(h.mock.ha.entries.size, before, 'nothing was added to HA');
});

test('feeds that need a password are explained (HA basic-auth step)', async () => {
  const flow = await h.app.ctx.ha.startFlow('remote_calendar');
  const res = await h.app.ctx.ha.submitFlow(flow.flow_id, { calendar_name: 'Auth', url: 'https://feeds.mock.test/basic.ics', verify_ssl: true });
  assert.equal(res.type, 'form');
  assert.equal(res.step_id, 'auth');
  await h.app.ctx.ha.abortFlow(flow.flow_id);
});

test('calendars from other integrations cannot be deleted from Cadence', async () => {
  h.mock.ha.addEntity({ entry_id: null, platform: 'google', name: 'Work Google', supported_features: 7 });
  h.mock.ha.writeState('calendar.work_google');
  const res = await h.inject({ method: 'DELETE', url: '/api/calendars/calendar.work_google' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'not_removable');
  const c = (await cals()).find((x) => x.entity_id === 'calendar.work_google');
  assert.equal(c.removable, false);
  assert.equal(c.kind, 'other');
});

test('unsubscribe a link calendar', async () => {
  const res = await h.inject({ method: 'DELETE', url: '/api/calendars/calendar.team' });
  assert.equal(res.statusCode, 200);
  assert.ok(![...h.mock.ha.entries.values()].some((e) => e.title === 'Team'));
});

test('link calendars are refreshed through homeassistant.update_entity', async () => {
  await h.app.ctx.live.resync();
  const before = h.mock.ha.remoteFetches;
  await h.app.ctx.live.refreshRemotes();
  const calls = h.mock.ha.serviceCalls.filter((c) => c.domain === 'homeassistant' && c.service === 'update_entity');
  assert.ok(calls.some((c) => (c.data as any).entity_id === 'calendar.school'));
  assert.ok(calls.some((c) => (c.data as any).entity_id === 'calendar.holidays'));
  assert.ok(h.mock.ha.remoteFetches > before);
});

test('remote_calendar missing (old HA) gives a clear message', async () => {
  const orig = h.app.ctx.ha.flowHandlers;
  h.app.ctx.ha.flowHandlers = async () => ['local_calendar'];
  try {
    const res = await h.inject({ method: 'POST', url: '/api/calendars/link', payload: { name: 'Old', url: 'https://feeds.mock.test/holidays.ics' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'remote_calendar_missing');
  } finally {
    h.app.ctx.ha.flowHandlers = orig;
  }
});

test('tokens and share URLs never appear in the logs', async () => {
  await until(() => h.logs.length > 0);
  const all = h.logs.join('\n');
  assert.ok(!all.includes('mock-token'), 'token logged');
  assert.ok(!all.includes(SECRET), 'share URL secret logged');
  assert.ok(!all.includes('contoso'), 'outlook link logged');
  assert.ok(!all.includes('school%40group'), 'google id logged');
  assert.ok(all.includes('POST /api/calendars/link'), 'request lines are still logged');
});
