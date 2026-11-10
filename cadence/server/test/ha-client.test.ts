import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startHarness, until, type Harness } from './helpers.ts';

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(() => h.close());

test('lists calendars with features, platform and config entry', async () => {
  const cals = await h.app.ctx.ha.listCalendars();
  assert.deepEqual(cals.map((c) => c.entity_id), ['calendar.family', 'calendar.holidays', 'calendar.work']);
  const fam = cals.find((c) => c.entity_id === 'calendar.family')!;
  assert.equal(fam.supported_features, 7);
  assert.equal(fam.platform, 'local_calendar');
  assert.ok(fam.config_entry_id);
  const hol = cals.find((c) => c.entity_id === 'calendar.holidays')!;
  assert.equal(hol.supported_features, 0);
  assert.equal(hol.platform, 'remote_calendar');
});

test('GET /api/calendars merges Cadence metadata with distinct colours', async () => {
  const res = await h.inject({ method: 'GET', url: '/api/calendars' });
  assert.equal(res.statusCode, 200);
  const { calendars } = res.json();
  assert.equal(calendars.length, 3);
  assert.equal(new Set(calendars.map((c: any) => c.color)).size, 3);
  const hol = calendars.find((c: any) => c.entity_id === 'calendar.holidays');
  assert.equal(hol.kind, 'link');
  assert.equal(hol.can_create, false);
});

test('GET /api/info reports HA timezone and version', async () => {
  const res = await h.inject({ method: 'GET', url: '/api/info' });
  const info = res.json();
  assert.equal(info.time_zone, 'America/Toronto');
  assert.equal(info.mode, 'mock');
  assert.equal(info.connected, true);
});

test('websocket reconnects and re-establishes subscriptions', async () => {
  const ha = h.app.ctx.ha;
  const seen: number[] = [];
  const now = Date.now();
  await ha.subscribeCalendar('calendar.family', new Date(now - 864e5).toISOString(), new Date(now + 864e5 * 3).toISOString(), (evs) => seen.push(evs?.length ?? -1));
  await until(() => seen.length >= 1);
  // Drop the connection from the client side; the client must reconnect and resubscribe.
  const disconnected = new Promise((r) => ha.socket.once('disconnected', r));
  (ha.socket as any).ws.close();
  await disconnected;
  await until(() => ha.socket.connected, 5000);
  // The re-created subscription gets its own initial push...
  await until(() => seen.length >= 2, 5000);
  const before = seen.length;
  // ...and later changes are still pushed to it.
  await ha.createEvent('calendar.family', { summary: 'After reconnect', dtstart: new Date(now + 3600e3).toISOString(), dtend: new Date(now + 7200e3).toISOString() });
  await until(() => seen.length > before, 5000);
  assert.equal(seen.at(-1), seen[0] + 1);
});
