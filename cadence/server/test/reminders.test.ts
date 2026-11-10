import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CadenceEvent } from '../src/ha/events.ts';
import { eventStartMs, formatReminder, planReminders, reminderKey, rulesFor, zonedMidnight, type PlanInput } from '../src/reminders/plan.ts';
import { GRACE_MS, ReminderScheduler } from '../src/reminders/scheduler.ts';
import { Store } from '../src/store/db.ts';

const TZ = 'America/Toronto';
const ev = (p: Partial<CadenceEvent>): CadenceEvent => ({ entity_id: 'calendar.family', uid: 'u1', recurrence_id: null, rrule: null, summary: 'Dentist', description: null, location: null, start: '2026-11-10T10:00:00-05:00', end: '2026-11-10T11:00:00-05:00', all_day: false, ...p });
const NOW = Date.parse('2026-11-10T09:00:00-05:00');

const input = (p: Partial<PlanInput>): PlanInput => ({
  events: [],
  eventRules: new Map(),
  calendarRules: new Map(),
  calendarTargets: new Map(),
  defaultTargets: ['notify.mobile_app_pixel_9'],
  now: NOW,
  horizonMs: 48 * 3600e3,
  graceMs: GRACE_MS,
  sent: new Set(),
  timeZone: TZ,
  ...p,
});

test('zonedMidnight handles DST in the HA time zone', () => {
  assert.equal(new Date(zonedMidnight('2026-11-10', TZ)).toISOString(), '2026-11-10T05:00:00.000Z'); // EST
  assert.equal(new Date(zonedMidnight('2026-07-01', TZ)).toISOString(), '2026-07-01T04:00:00.000Z'); // EDT
  assert.equal(new Date(zonedMidnight('2026-03-08', TZ)).toISOString(), '2026-03-08T05:00:00.000Z'); // DST day itself
  assert.equal(new Date(zonedMidnight('2026-11-10', 'Asia/Kolkata')).toISOString(), '2026-11-09T18:30:00.000Z');
});

test('all-day events start at local midnight', () => {
  assert.equal(eventStartMs(ev({ all_day: true, start: '2026-11-11', end: '2026-11-12' }), TZ), Date.parse('2026-11-11T00:00:00-05:00'));
});

test('rule precedence: occurrence, then series, then calendar default; [] means none', () => {
  const e = ev({ recurrence_id: '20261110T100000', rrule: 'FREQ=DAILY' });
  const calendarRules = new Map([['calendar.family', [{ offset_minutes: 60 }]]]);
  assert.deepEqual(rulesFor(e, { eventRules: new Map(), calendarRules }), [{ offset_minutes: 60 }]);
  const series = new Map([['calendar.family|u1|', [{ offset_minutes: 15 }]]]);
  assert.deepEqual(rulesFor(e, { eventRules: series, calendarRules }), [{ offset_minutes: 15 }]);
  const inst = new Map([...series, ['calendar.family|u1|20261110T100000', [{ offset_minutes: 5 }]]]);
  assert.deepEqual(rulesFor(e, { eventRules: inst, calendarRules }), [{ offset_minutes: 5 }]);
  assert.deepEqual(rulesFor(e, { eventRules: new Map([['calendar.family|u1|', []]]), calendarRules }), []);
});

test('plans reminders inside the horizon and the grace window only', () => {
  const rules = new Map([['calendar.family', [{ offset_minutes: 0 }, { offset_minutes: 30 }, { offset_minutes: 1440 }, { offset_minutes: 120 }]]]);
  const due = planReminders(input({ events: [ev({})], calendarRules: rules }));
  // 10:00 event at 09:00 now: 0 -> 10:00, 30 -> 09:30, 120 -> 08:00 (60 min ago, outside 15 min grace), 1440 -> yesterday.
  assert.deepEqual(due.map((d) => d.offset_minutes), [30, 0]);
  assert.equal(due[0].fireAt, Date.parse('2026-11-10T09:30:00-05:00'));
  const far = planReminders(input({ events: [ev({ start: '2026-11-13T10:00:00-05:00', end: '2026-11-13T11:00:00-05:00' })], calendarRules: rules }));
  assert.deepEqual(far, [], 'beyond 48 h');
  const late = planReminders(input({ events: [ev({ start: '2026-11-10T09:10:00-05:00' })], calendarRules: new Map([['calendar.family', [{ offset_minutes: 15 }]]]) }));
  assert.equal(late.length, 1, 'missed by 5 minutes (e.g. a restart): still sent');
});

test('targets: rule, then calendar, then the global default; none means no reminder', () => {
  const e = ev({});
  const one = (p: Partial<PlanInput>) => planReminders(input({ events: [e], ...p }))[0]?.targets;
  const cal = new Map([['calendar.family', [{ offset_minutes: 30 }]]]);
  assert.deepEqual(one({ calendarRules: cal }), ['notify.mobile_app_pixel_9']);
  assert.deepEqual(one({ calendarRules: cal, calendarTargets: new Map([['calendar.family', ['notify.mobile_app_ipad']]]) }), ['notify.mobile_app_ipad']);
  assert.deepEqual(one({ calendarRules: new Map([['calendar.family', [{ offset_minutes: 30, targets: ['notify.notify'] }]]]) }), ['notify.notify']);
  assert.equal(one({ calendarRules: cal, defaultTargets: [] }), undefined);
});

test('dedupe: one key per event occurrence, start and offset; sent keys are skipped', () => {
  const a = ev({ uid: 's', rrule: 'FREQ=DAILY', recurrence_id: '20261110T100000' });
  const b = ev({ uid: 's', rrule: 'FREQ=DAILY', recurrence_id: '20261111T100000', start: '2026-11-11T10:00:00-05:00', end: '2026-11-11T11:00:00-05:00' });
  const rules = new Map([['calendar.family', [{ offset_minutes: 30 }]]]);
  const due = planReminders(input({ events: [a, b, a], calendarRules: rules }));
  assert.equal(due.length, 2);
  assert.notEqual(due[0].key, due[1].key);
  assert.equal(due[0].key, 'calendar.family|s|2026-11-10T15:00:00.000Z|30');
  const after = planReminders(input({ events: [a, b], calendarRules: rules, sent: new Set([due[0].key]) }));
  assert.deepEqual(after.map((d) => d.key), [due[1].key]);
  // Moving the event creates a new key, so a moved event is reminded again.
  assert.notEqual(reminderKey(a, Date.parse('2026-11-10T11:00:00-05:00'), 30), due[0].key);
});

test('notification text', () => {
  const [d] = planReminders(input({ events: [ev({ location: 'Main St' })], calendarRules: new Map([['calendar.family', [{ offset_minutes: 30 }]]]) }));
  assert.deepEqual(formatReminder(d, TZ, 'Family'), { title: 'Dentist', message: 'In 30 minutes · 10:00 AM–11:00 AM · Main St · Family' });
  const [ad] = planReminders(input({ now: Date.parse('2026-11-10T23:55:00-05:00'), events: [ev({ all_day: true, start: '2026-11-11', end: '2026-11-12', summary: 'Trip' })], calendarRules: new Map([['calendar.family', [{ offset_minutes: 0 }]]]) }));
  assert.equal(formatReminder(ad, TZ, 'Family').message, 'Today (all day) · Family');
});

function fakeScheduler(store: Store, now: { t: number }, sent: string[], opts: { failing?: boolean; events?: CadenceEvent[] } = {}) {
  const timers: { fn: () => void; ms: number }[] = [];
  const s = new ReminderScheduler({
    store,
    listCalendars: async () => [{ entity_id: 'calendar.family', name: 'Family' }],
    getEvents: async () => opts.events ?? [ev({})],
    timeZone: async () => TZ,
    notify: async (target, title) => {
      if (opts.failing) throw new Error('nope');
      sent.push(`${target}:${title}`);
    },
    now: () => now.t,
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => undefined,
  });
  return { s, timers };
}

test('scheduler arms timers, sends once, and never double-sends after a restart', async () => {
  const store = new Store(':memory:');
  store.updateSettings({ notify_targets: ['notify.mobile_app_pixel_9'] });
  store.ensureMeta(['calendar.family']);
  store.updateMeta('calendar.family', { default_reminders: [{ offset_minutes: 30 }] });
  const now = { t: NOW };
  const sent: string[] = [];
  const a = fakeScheduler(store, now, sent);
  await a.s.refresh();
  assert.equal(a.timers.length, 1);
  assert.equal(a.timers[0].ms, 30 * 60e3);
  now.t += 30 * 60e3;
  a.timers[0].fn();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent, ['notify.mobile_app_pixel_9:Dentist']);
  // Same timer firing twice (e.g. two refreshes racing) does not resend.
  assert.equal(await a.s.fire(a.s.upcoming[0] ?? (await planAgain())), false);
  // Restart: a new scheduler with the same database plans nothing for it.
  const b = fakeScheduler(store, now, sent);
  await b.s.refresh();
  assert.equal(b.timers.length, 0);
  assert.equal(sent.length, 1);

  async function planAgain() {
    return planReminders(input({ events: [ev({})], calendarRules: new Map([['calendar.family', [{ offset_minutes: 30 }]]]), now: NOW }))[0];
  }
});

test('a reminder that could not be delivered is retried later', async () => {
  const store = new Store(':memory:');
  store.updateSettings({ notify_targets: ['notify.mobile_app_pixel_9'] });
  store.ensureMeta(['calendar.family']);
  store.updateMeta('calendar.family', { default_reminders: [{ offset_minutes: 30 }] });
  const now = { t: NOW + 30 * 60e3 };
  const sent: string[] = [];
  const failing = fakeScheduler(store, now, sent, { failing: true });
  await failing.s.refresh();
  failing.timers[0].fn();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.sentKeys().size, 0, 'key released');
  const ok = fakeScheduler(store, now, sent);
  await ok.s.refresh();
  ok.timers[0].fn();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1);
});

test('per-event reminders work on read-only calendars too', () => {
  const e = ev({ entity_id: 'calendar.holidays', uid: 'h-1' });
  const due = planReminders(input({ events: [e], eventRules: new Map([['calendar.holidays|h-1|', [{ offset_minutes: 30 }]]]) }));
  assert.equal(due.length, 1);
});
