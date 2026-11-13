import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { mockAwareFetcher } from '../src/links/validate.ts';
import { startHarness, until, type Harness } from './helpers.ts';

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(() => h.close());

test('lists notify services from HA', async () => {
  const res = await h.inject({ method: 'GET', url: '/api/notify/services' });
  const ids = res.json().services.map((s: any) => s.id);
  assert.ok(ids.includes('notify.mobile_app_pixel_9'));
  assert.ok(ids.includes('notify.persistent_notification'));
});

test('send test needs a target, then delivers through notify.*', async () => {
  let res = await h.inject({ method: 'POST', url: '/api/notify/test', payload: {} });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'no_targets');
  res = await h.inject({ method: 'PUT', url: '/api/settings', payload: { notify_targets: ['notify.mobile_app_pixel_9'] } });
  assert.deepEqual(res.json().settings.notify_targets, ['notify.mobile_app_pixel_9']);
  res = await h.inject({ method: 'POST', url: '/api/notify/test', payload: {} });
  assert.deepEqual(res.json(), { sent: ['notify.mobile_app_pixel_9'], failed: [] });
  assert.equal(h.mock.ha.notifications.at(-1)!.service, 'notify.mobile_app_pixel_9');
  res = await h.inject({ method: 'POST', url: '/api/notify/test', payload: { targets: ['notify.gone'] } });
  assert.equal(res.json().failed[0].target, 'notify.gone');
});

test('settings are validated', async () => {
  assert.equal((await h.inject({ method: 'PUT', url: '/api/settings', payload: { notify_targets: ['light.kitchen'] } })).statusCode, 400);
  assert.equal((await h.inject({ method: 'PUT', url: '/api/settings', payload: { refresh_minutes: 0 } })).statusCode, 400);
  assert.equal((await h.inject({ method: 'PUT', url: '/api/settings', payload: { refresh_minutes: 30, week_start: 1 } })).json().settings.week_start, 1);
  assert.equal((await h.inject({ method: 'PUT', url: '/api/settings', payload: { default_view: 'nope' } })).statusCode, 400);
});

test('every view the web app offers can be the default view', async () => {
  for (const v of ['dayGridMonth', 'timeGridWeek', 'timeGrid3Day', 'timeGridDay', 'listAgenda']) {
    const res = await h.inject({ method: 'PUT', url: '/api/settings', payload: { default_view: v } });
    assert.equal(res.statusCode, 200, v);
    assert.equal(res.json().settings.default_view, v);
  }
  // The old name of the agenda view is stored as the new one.
  assert.equal((await h.inject({ method: 'PUT', url: '/api/settings', payload: { default_view: 'listWeek' } })).json().settings.default_view, 'listAgenda');
  await h.inject({ method: 'PUT', url: '/api/settings', payload: { default_view: 'timeGridWeek' } });
});

test('per-calendar default reminders are stored and validated', async () => {
  let res = await h.inject({ method: 'PATCH', url: '/api/calendars/calendar.work', payload: { default_reminders: [{ offset_minutes: 10 }] } });
  assert.equal(res.statusCode, 200);
  res = await h.inject({ method: 'PATCH', url: '/api/calendars/calendar.work', payload: { default_reminders: [{ offset_minutes: -5 }] } });
  assert.equal(res.statusCode, 400);
  const work = (await h.inject({ method: 'GET', url: '/api/calendars' })).json().calendars.find((c: any) => c.entity_id === 'calendar.work');
  assert.deepEqual(work.default_reminders, [{ offset_minutes: 10, targets: null }]);
});

test('a per-event reminder fires against HA notify, once, even across a restart', async () => {
  h.mock.ha.notifications = [];
  // Event starting in 4 minutes with a 5-minute reminder: due now.
  const start = new Date(Date.now() + 4 * 60e3);
  start.setSeconds(0, 0);
  const res = await h.inject({ method: 'POST', url: '/api/events', payload: { entity_id: 'calendar.family', event: { summary: 'Leave for school', dtstart: start.toISOString(), dtend: new Date(start.getTime() + 30 * 60e3).toISOString() }, reminders: [{ offset_minutes: 5 }] } });
  assert.equal(res.statusCode, 200, res.body);
  await h.app.ctx.scheduler.refresh();
  await until(() => h.mock.ha.notifications.some((n) => n.data.title === 'Leave for school'), 5000);
  const n = h.mock.ha.notifications.find((x) => x.data.title === 'Leave for school')!;
  assert.equal(n.service, 'notify.mobile_app_pixel_9');
  assert.match(String(n.data.message), /^In 5 minutes · .* · Family$/);
  await h.app.ctx.scheduler.refresh();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.mock.ha.notifications.filter((x) => x.data.title === 'Leave for school').length, 1);

  // Restart Cadence against the same database.
  const config = h.app.ctx.config;
  const second = await buildApp({ config, logStream: { write: () => undefined }, fetcher: mockAwareFetcher(h.mock.url), startBackground: false });
  try {
    await second.ctx.ha.start();
    await second.ctx.scheduler.refresh();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.mock.ha.notifications.filter((x) => x.data.title === 'Leave for school').length, 1);
  } finally {
    await second.close();
  }
});

test('reminders can be read back and cleared for an event', async () => {
  const start = new Date(Date.now() + 3 * 3600e3).toISOString();
  const { uid } = (await h.inject({ method: 'POST', url: '/api/events', payload: { entity_id: 'calendar.family', event: { summary: 'Recital', dtstart: start, dtend: new Date(Date.parse(start) + 3600e3).toISOString() }, reminders: [{ offset_minutes: 60 }] } })).json();
  let r = (await h.inject({ method: 'GET', url: `/api/reminders/event?entity_id=calendar.family&uid=${uid}` })).json();
  assert.deepEqual(r.series, [{ offset_minutes: 60, targets: null }]);
  await h.inject({ method: 'PUT', url: '/api/reminders/event', payload: { entity_id: 'calendar.family', uid, recurrence_id: null, rules: null } });
  r = (await h.inject({ method: 'GET', url: `/api/reminders/event?entity_id=calendar.family&uid=${uid}` })).json();
  assert.equal(r.series, null);
  await h.app.ctx.scheduler.refresh();
  const up = (await h.inject({ method: 'GET', url: '/api/reminders/upcoming' })).json();
  assert.ok(Array.isArray(up.upcoming));
});
