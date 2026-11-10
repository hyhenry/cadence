import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { scopeToHa } from '../src/routes/events.ts';
import { startHarness, type Harness } from './helpers.ts';

let h: Harness;
before(async () => {
  h = await startHarness({ seed: true });
});
after(() => h.close());

const DAY = 864e5;
// A fixed local week far from "now" so seeded events do not interfere: Mon 2027-03-01 (EST).
const at = (day: number, hour: number) => new Date(Date.UTC(2027, 2, 1 + day, hour + 5)).toISOString();

async function list(entity = 'calendar.family', from = at(-7, 0), to = at(60, 0)) {
  const res = await h.inject({ method: 'GET', url: `/api/events?start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}&calendars=${entity}` });
  return res.json().events as any[];
}

async function create(event: Record<string, unknown>, entity_id = 'calendar.family', reminders?: unknown) {
  const res = await h.inject({ method: 'POST', url: '/api/events', payload: { entity_id, event, reminders } });
  return res;
}

test('scope mapping to recurrence_id / recurrence_range', () => {
  assert.deepEqual(scopeToHa('all', '20270301T090000'), {});
  assert.deepEqual(scopeToHa('this', '20270301T090000'), { recurrence_id: '20270301T090000' });
  assert.deepEqual(scopeToHa('future', '20270301T090000'), { recurrence_id: '20270301T090000', recurrence_range: 'THISANDFUTURE' });
  assert.deepEqual(scopeToHa('this', null), {});
});

test('create returns the new uid and stores reminders for it', async () => {
  const res = await create({ summary: 'Haircut', dtstart: at(0, 15), dtend: at(0, 16), location: 'Main St' }, 'calendar.family', [{ offset_minutes: 30 }]);
  assert.equal(res.statusCode, 200, res.body);
  const { uid } = res.json();
  assert.ok(uid);
  const evs = await list();
  const ev = evs.find((e) => e.uid === uid);
  assert.equal(ev.summary, 'Haircut');
  assert.equal(ev.location, 'Main St');
  const rem = (await h.inject({ method: 'GET', url: `/api/reminders/event?entity_id=calendar.family&uid=${uid}` })).json();
  assert.deepEqual(rem.series, [{ offset_minutes: 30, targets: null }]);
});

test('invalid events are rejected before reaching HA', async () => {
  assert.equal((await create({ summary: '', dtstart: at(0, 9), dtend: at(0, 10) })).statusCode, 400);
  assert.equal((await create({ summary: 'x', dtstart: at(0, 10), dtend: at(0, 9) })).statusCode, 400);
  assert.equal((await create({ summary: 'x', dtstart: '2027-03-01', dtend: at(0, 9) })).statusCode, 400);
  const hourly = await create({ summary: 'x', dtstart: at(0, 9), dtend: at(0, 10), rrule: 'FREQ=HOURLY' });
  assert.equal(hourly.statusCode, 400);
  assert.match(hourly.json().message, /daily, weekly, monthly or yearly/);
});

test('all-day events use exclusive end dates', async () => {
  const res = await create({ summary: 'Trip', dtstart: '2027-03-05', dtend: '2027-03-08' });
  assert.equal(res.statusCode, 200);
  const ev = (await list()).find((e) => e.summary === 'Trip');
  assert.equal(ev.all_day, true);
  assert.equal(ev.start, '2027-03-05');
  assert.equal(ev.end, '2027-03-08');
});

test('read-only calendars refuse writes with a clear message', async () => {
  const res = await create({ summary: 'Nope', dtstart: at(0, 9), dtend: at(0, 10) }, 'calendar.holidays');
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'not_supported');
});

test('update a single event, and move it to another calendar', async () => {
  const { uid } = (await create({ summary: 'Coffee', dtstart: at(1, 8), dtend: at(1, 9) })).json();
  let res = await h.inject({ method: 'PUT', url: '/api/events', payload: { entity_id: 'calendar.family', uid, scope: 'all', event: { summary: 'Coffee with Sam', dtstart: at(1, 10), dtend: at(1, 11) } } });
  assert.equal(res.statusCode, 200, res.body);
  let ev = (await list()).find((e) => e.uid === uid);
  assert.equal(ev.summary, 'Coffee with Sam');
  assert.equal(Date.parse(ev.start), Date.parse(at(1, 10)));
  res = await h.inject({ method: 'PUT', url: '/api/events', payload: { entity_id: 'calendar.family', uid, scope: 'all', target_entity_id: 'calendar.work', event: { summary: 'Coffee with Sam', dtstart: at(1, 10), dtend: at(1, 11) } } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await list()).find((e) => e.uid === uid), undefined);
  assert.ok((await list('calendar.work')).find((e) => e.summary === 'Coffee with Sam'));
});

test('recurring: edit this occurrence only', async () => {
  const { uid } = (await create({ summary: 'Gym', dtstart: at(0, 7), dtend: at(0, 8), rrule: 'FREQ=WEEKLY;BYDAY=MO' })).json();
  const inst = (await list()).filter((e) => e.uid === uid);
  assert.ok(inst.length >= 8);
  const second = inst[1];
  const res = await h.inject({ method: 'PUT', url: '/api/events', payload: { entity_id: 'calendar.family', uid, recurrence_id: second.recurrence_id, scope: 'this', event: { summary: 'Gym (late)', dtstart: at(7, 19), dtend: at(7, 20), rrule: 'FREQ=WEEKLY;BYDAY=MO' } } });
  assert.equal(res.statusCode, 200, res.body);
  const after = (await list()).filter((e) => e.uid === uid);
  assert.equal(after.length, inst.length);
  assert.equal(after.filter((e) => e.summary === 'Gym (late)').length, 1);
  assert.equal(Date.parse(after.find((e) => e.summary === 'Gym (late)').start), Date.parse(at(7, 19)));
});

test('recurring: delete this and following', async () => {
  const { uid } = (await create({ summary: 'Piano', dtstart: at(1, 16), dtend: at(1, 17), rrule: 'FREQ=WEEKLY;BYDAY=TU' })).json();
  const inst = (await list()).filter((e) => e.uid === uid);
  const third = inst[2];
  const res = await h.inject({ method: 'POST', url: '/api/events/delete', payload: { entity_id: 'calendar.family', uid, recurrence_id: third.recurrence_id, scope: 'future' } });
  assert.equal(res.statusCode, 200, res.body);
  const after = (await list()).filter((e) => e.uid === uid);
  assert.equal(after.length, 2);
});

test('recurring: delete this occurrence only', async () => {
  const { uid } = (await create({ summary: 'Yoga', dtstart: at(2, 18), dtend: at(2, 19), rrule: 'FREQ=WEEKLY;BYDAY=WE' })).json();
  const inst = (await list()).filter((e) => e.uid === uid);
  await h.inject({ method: 'POST', url: '/api/events/delete', payload: { entity_id: 'calendar.family', uid, recurrence_id: inst[1].recurrence_id, scope: 'this' } });
  const after = (await list()).filter((e) => e.uid === uid);
  assert.equal(after.length, inst.length - 1);
  assert.ok(!after.some((e) => e.recurrence_id === inst[1].recurrence_id));
});

test('recurring: editing all events from a later occurrence keeps the series start', async () => {
  const { uid } = (await create({ summary: 'Swim', dtstart: at(3, 17), dtend: at(3, 18), rrule: 'FREQ=WEEKLY;BYDAY=TH' })).json();
  const inst = (await list()).filter((e) => e.uid === uid);
  const third = inst[2];
  // User drags the third occurrence one hour later and picks "All events".
  const res = await h.inject({
    method: 'PUT',
    url: '/api/events',
    payload: { entity_id: 'calendar.family', uid, recurrence_id: third.recurrence_id, scope: 'all', original_start: third.start, event: { summary: 'Swim', dtstart: new Date(Date.parse(third.start) + 3600e3).toISOString(), dtend: new Date(Date.parse(third.end) + 3600e3).toISOString(), rrule: 'FREQ=WEEKLY;BYDAY=TH' } },
  });
  assert.equal(res.statusCode, 200, res.body);
  const after = (await list()).filter((e) => e.uid === uid);
  assert.equal(after.length, inst.length, 'no occurrences lost');
  assert.equal(Date.parse(after[0].start), Date.parse(at(3, 18)), 'first occurrence moved by one hour, same day');
});

test('recurring: this and following with a new time splits the series', async () => {
  const { uid } = (await create({ summary: 'Lunch', dtstart: at(4, 12), dtend: at(4, 13), rrule: 'FREQ=WEEKLY;BYDAY=FR' })).json();
  const inst = (await list()).filter((e) => e.uid === uid);
  const third = inst[2];
  const res = await h.inject({
    method: 'PUT',
    url: '/api/events',
    payload: { entity_id: 'calendar.family', uid, recurrence_id: third.recurrence_id, scope: 'future', event: { summary: 'Late lunch', dtstart: new Date(Date.parse(third.start) + 3600e3).toISOString(), dtend: new Date(Date.parse(third.end) + 3600e3).toISOString(), rrule: 'FREQ=WEEKLY;BYDAY=FR' } },
  });
  assert.equal(res.statusCode, 200, res.body);
  const evs = await list();
  assert.equal(evs.filter((e) => e.uid === uid).length, 2);
  assert.ok(evs.filter((e) => e.summary === 'Late lunch').length >= inst.length - 2);
});

test('HA errors come back as readable 4xx responses', async () => {
  const res = await h.inject({ method: 'PUT', url: '/api/events', payload: { entity_id: 'calendar.family', uid: 'does-not-exist', scope: 'all', event: { summary: 'x', dtstart: at(0, 9), dtend: at(0, 10) } } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'failed');
  void DAY;
});
