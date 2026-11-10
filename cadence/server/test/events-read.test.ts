import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { normalizeEvent } from '../src/ha/events.ts';
import { startHarness, until, type Harness } from './helpers.ts';

let h: Harness;
before(async () => {
  h = await startHarness({ background: true });
});
after(() => h.close());

const range = () => {
  const now = Date.now();
  return { start: new Date(now - 2 * 864e5).toISOString(), end: new Date(now + 8 * 864e5).toISOString() };
};

test('normalizeEvent handles the REST shape ({dateTime}/{date})', () => {
  const t = normalizeEvent('calendar.x', { start: { dateTime: '2026-11-10T09:00:00-05:00' }, end: { dateTime: '2026-11-10T10:00:00-05:00' }, summary: 'A', description: null, location: null, uid: 'u', recurrence_id: null, rrule: null });
  assert.equal(t.all_day, false);
  assert.equal(t.start, '2026-11-10T09:00:00-05:00');
  const d = normalizeEvent('calendar.x', { start: { date: '2026-11-10' }, end: { date: '2026-11-11' }, summary: 'B', uid: 'v' });
  assert.equal(d.all_day, true);
  assert.equal(d.end, '2026-11-11');
});

test('normalizeEvent handles the websocket as_dict shape (strings + all_day)', () => {
  const e = normalizeEvent('calendar.x', { start: '2026-11-10', end: '2026-11-11', summary: 'C', uid: 'w', all_day: true });
  assert.equal(e.all_day, true);
  assert.equal(e.recurrence_id, null);
});

test('GET /api/events expands recurrences across calendars', async () => {
  const { start, end } = range();
  const res = await h.inject({ method: 'GET', url: `/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` });
  assert.equal(res.statusCode, 200);
  const { events, errors } = res.json();
  assert.deepEqual(errors, []);
  const standups = events.filter((e: any) => e.summary === 'Standup');
  assert.ok(standups.length >= 5, 'weekday standups are expanded');
  assert.ok(standups.every((e: any) => /^\d{8}T\d{6}$/.test(e.recurrence_id)), 'recurrence_id is floating local');
  assert.ok(events.some((e: any) => e.entity_id === 'calendar.holidays'));
  const grandma = events.find((e: any) => e.summary === 'Grandma visiting');
  assert.equal(grandma.all_day, true);
});

test('GET /api/events can be limited to some calendars and reports per-calendar errors', async () => {
  const { start, end } = range();
  const res = await h.inject({ method: 'GET', url: `/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&calendars=calendar.work,calendar.nope` });
  const { events, errors } = res.json();
  assert.ok(events.every((e: any) => e.entity_id === 'calendar.work'));
  assert.deepEqual(errors.map((e: any) => e.entity_id), ['calendar.nope']);
});

test('GET /api/events validates the range', async () => {
  const res = await h.inject({ method: 'GET', url: '/api/events?start=nope&end=2026-01-01' });
  assert.equal(res.statusCode, 400);
});

test('hidden calendars are remembered in Cadence metadata', async () => {
  const res = await h.inject({ method: 'PATCH', url: '/api/calendars/calendar.work', payload: { visible: false, color: '#123456' } });
  assert.equal(res.statusCode, 200);
  const cals = (await h.inject({ method: 'GET', url: '/api/calendars' })).json().calendars;
  const work = cals.find((c: any) => c.entity_id === 'calendar.work');
  assert.equal(work.visible, false);
  assert.equal(work.color, '#123456');
  const bad = await h.inject({ method: 'PATCH', url: '/api/calendars/calendar.work', payload: { color: 'red' } });
  assert.equal(bad.statusCode, 400);
});

test('changes made in HA reach browsers over SSE', async () => {
  await h.app.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (h.app.app.server.address() as any).port;
  await h.app.ctx.live.resync();
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body!.getReader();
  let text = '';
  const read = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  })().catch(() => undefined);
  await until(() => text.includes('event: connection'));
  // Someone edits the calendar directly in Home Assistant.
  const now = Date.now();
  await h.app.ctx.ha.createEvent('calendar.family', { summary: 'Made in HA', dtstart: new Date(now + 3600e3).toISOString(), dtend: new Date(now + 7200e3).toISOString() });
  await until(() => text.includes('event: events\ndata: {"entity_id":"calendar.family"}'), 5000);
  ctrl.abort();
  await read;
});
