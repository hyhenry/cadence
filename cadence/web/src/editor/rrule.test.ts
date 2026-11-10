import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DateTime } from 'luxon';
import { buildRrule, describeRepeat, isComplexRrule, matchPreset, NO_REPEAT, parseRrule, presets, type Repeat } from './rrule.ts';

const TZ = 'America/Toronto';
// Tuesday 10 November 2026, 17:30 in Toronto.
const tue = DateTime.fromISO('2026-11-10T17:30', { zone: TZ });

const rep = (r: Partial<Repeat>): Repeat => ({ ...NO_REPEAT, ...r });

test('no repeat builds nothing', () => {
  assert.equal(buildRrule(NO_REPEAT, tue, false), undefined);
});

test('daily / yearly / interval', () => {
  assert.equal(buildRrule(rep({ freq: 'DAILY' }), tue, false), 'FREQ=DAILY');
  assert.equal(buildRrule(rep({ freq: 'YEARLY' }), tue, false), 'FREQ=YEARLY');
  assert.equal(buildRrule(rep({ freq: 'DAILY', interval: 3 }), tue, false), 'FREQ=DAILY;INTERVAL=3');
});

test('weekly always includes the start weekday and sorts days', () => {
  assert.equal(buildRrule(rep({ freq: 'WEEKLY', byDay: ['TH'] }), tue, false), 'FREQ=WEEKLY;BYDAY=TU,TH');
  assert.equal(buildRrule(rep({ freq: 'WEEKLY', byDay: ['FR', 'MO', 'TU'] }), tue, false), 'FREQ=WEEKLY;BYDAY=MO,TU,FR');
});

test('monthly by day number, nth weekday and last weekday', () => {
  assert.equal(buildRrule(rep({ freq: 'MONTHLY' }), tue, false), 'FREQ=MONTHLY');
  assert.equal(buildRrule(rep({ freq: 'MONTHLY', monthly: 'weekday' }), tue, false), 'FREQ=MONTHLY;BYDAY=2TU');
  const lastFri = DateTime.fromISO('2026-11-27T09:00', { zone: TZ });
  assert.equal(buildRrule(rep({ freq: 'MONTHLY', monthly: 'lastweekday' }), lastFri, false), 'FREQ=MONTHLY;BYDAY=-1FR');
  assert.ok(presets(lastFri).some((p) => p.id === 'monthlast'));
  assert.ok(!presets(tue).some((p) => p.id === 'monthlast'));
});

test('count end', () => {
  assert.equal(buildRrule(rep({ freq: 'WEEKLY', byDay: ['TU'], end: { kind: 'count', count: 10 } }), tue, false), 'FREQ=WEEKLY;BYDAY=TU;COUNT=10');
});

test('until for timed events covers the whole day, in UTC', () => {
  // Dec 15 23:59:59 in Toronto (EST, UTC-5) is Dec 16 04:59:59Z.
  assert.equal(buildRrule(rep({ freq: 'DAILY', end: { kind: 'until', date: '2026-12-15' } }), tue, false), 'FREQ=DAILY;UNTIL=20261216T045959Z');
  // Across the spring DST change (EDT, UTC-4).
  assert.equal(buildRrule(rep({ freq: 'DAILY', end: { kind: 'until', date: '2027-04-01' } }), tue, false), 'FREQ=DAILY;UNTIL=20270402T035959Z');
});

test('until for all-day events is a date', () => {
  const d = DateTime.fromISO('2026-11-10', { zone: TZ });
  assert.equal(buildRrule(rep({ freq: 'YEARLY', end: { kind: 'until', date: '2030-11-10' } }), d, true), 'FREQ=YEARLY;UNTIL=20301110');
});

test('parse round-trips what build produces', () => {
  const cases: Repeat[] = [
    rep({ freq: 'DAILY', interval: 2 }),
    rep({ freq: 'WEEKLY', byDay: ['TU', 'TH'], end: { kind: 'count', count: 5 } }),
    rep({ freq: 'MONTHLY', monthly: 'weekday' }),
    rep({ freq: 'YEARLY', end: { kind: 'until', date: '2028-01-31' } }),
  ];
  for (const c of cases) {
    const s = buildRrule(c, tue, false)!;
    assert.equal(buildRrule(parseRrule(s, tue), tue, false), s, s);
  }
});

test('parse reads UNTIL in UTC back as the local date', () => {
  const r = parseRrule('FREQ=DAILY;UNTIL=20261216T045959Z', tue);
  assert.deepEqual(r.end, { kind: 'until', date: '2026-12-15' });
});

test('describe and presets', () => {
  assert.equal(describeRepeat(rep({ freq: 'WEEKLY', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] }), tue), 'Every weekday');
  assert.equal(describeRepeat(rep({ freq: 'WEEKLY', byDay: ['TU', 'TH'] }), tue), 'Weekly on Tue, Thu');
  assert.equal(describeRepeat(rep({ freq: 'MONTHLY', monthly: 'weekday' }), tue), 'Monthly on the second Tuesday');
  assert.equal(describeRepeat(rep({ freq: 'DAILY', interval: 2, end: { kind: 'count', count: 3 } }), tue), 'Every 2 days, 3 times');
  assert.equal(matchPreset(parseRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', tue), tue), 'weekdays');
  assert.equal(matchPreset(parseRrule('FREQ=WEEKLY;BYDAY=TU', tue), tue), 'weekly');
  assert.equal(matchPreset(parseRrule('FREQ=WEEKLY;BYDAY=TU,TH', tue), tue), 'custom');
});

test('complex rules from other apps are detected', () => {
  assert.equal(isComplexRrule('FREQ=WEEKLY;BYDAY=TU'), false);
  assert.equal(isComplexRrule('FREQ=MONTHLY;BYMONTHDAY=1,15'), true);
  assert.equal(isComplexRrule('FREQ=YEARLY;BYMONTH=3;BYDAY=2SU'), true);
});

test('every preset produces a FREQ HA accepts', () => {
  for (const p of presets(tue)) {
    const s = buildRrule(p.repeat, tue, false);
    if (p.id === 'none') assert.equal(s, undefined);
    else assert.match(s!, /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/);
  }
});
