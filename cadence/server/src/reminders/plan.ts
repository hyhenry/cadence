// Pure reminder planning: given events, rules and "now", decide which
// reminders are due and when. No I/O, so it is unit tested directly.
import type { CadenceEvent } from '../ha/events.ts';
import type { ReminderRule } from '../store/db.ts';

export interface DueReminder {
  key: string;
  fireAt: number;
  offset_minutes: number;
  targets: string[];
  event: CadenceEvent;
  startMs: number;
}

export interface PlanInput {
  events: CadenceEvent[];
  /** `${entity_id}|${uid}|${recurrence_id ?? ''}` -> rules (an empty list means "no reminders"). */
  eventRules: Map<string, ReminderRule[]>;
  /** entity_id -> default rules for that calendar. */
  calendarRules: Map<string, ReminderRule[]>;
  /** entity_id -> calendar-specific default notify targets. */
  calendarTargets: Map<string, string[] | null>;
  defaultTargets: string[];
  now: number;
  horizonMs: number;
  /** Reminders whose time passed less than this long ago are still sent (e.g. after a restart). */
  graceMs: number;
  sent: Set<string>;
  timeZone: string;
}

/** Start of an event as epoch ms. All-day dates are local midnight in the HA time zone. */
export function eventStartMs(e: CadenceEvent, timeZone: string): number {
  if (!e.all_day) return Date.parse(e.start);
  return zonedMidnight(e.start, timeZone);
}

/** Epoch ms of 00:00 on `date` (YYYY-MM-DD) in `timeZone`. */
export function zonedMidnight(date: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  // Start from UTC midnight and correct by the zone offset (twice, for DST edges).
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMs(guess, timeZone);
    guess = Date.UTC(y, m - 1, d) - off;
  }
  return guess;
}

export function tzOffsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(at / 1000) * 1000;
}

export function reminderKey(e: CadenceEvent, startMs: number, offset: number): string {
  const id = e.uid ?? `nouid:${e.summary}`;
  return `${e.entity_id}|${id}|${new Date(startMs).toISOString()}|${offset}`;
}

export function rulesFor(e: CadenceEvent, input: Pick<PlanInput, 'eventRules' | 'calendarRules'>): ReminderRule[] {
  if (e.uid) {
    const inst = e.recurrence_id ? input.eventRules.get(`${e.entity_id}|${e.uid}|${e.recurrence_id}`) : undefined;
    if (inst) return inst;
    const series = input.eventRules.get(`${e.entity_id}|${e.uid}|`);
    if (series) return series;
  }
  return input.calendarRules.get(e.entity_id) ?? [];
}

export function planReminders(input: PlanInput): DueReminder[] {
  const out: DueReminder[] = [];
  const seen = new Set<string>();
  for (const e of input.events) {
    const startMs = eventStartMs(e, input.timeZone);
    if (Number.isNaN(startMs)) continue;
    for (const rule of rulesFor(e, input)) {
      const offset = Math.max(0, Math.round(Number(rule.offset_minutes) || 0));
      const fireAt = startMs - offset * 60_000;
      if (fireAt > input.now + input.horizonMs) continue;
      if (fireAt < input.now - input.graceMs) continue;
      const key = reminderKey(e, startMs, offset);
      if (input.sent.has(key) || seen.has(key)) continue;
      const targets = rule.targets?.length ? rule.targets : input.calendarTargets.get(e.entity_id)?.length ? input.calendarTargets.get(e.entity_id)! : input.defaultTargets;
      if (!targets.length) continue;
      seen.add(key);
      out.push({ key, fireAt, offset_minutes: offset, targets: [...new Set(targets)], event: e, startMs });
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt);
}

export function describeOffset(min: number): string {
  if (min === 0) return 'Now';
  if (min % 10080 === 0) return `In ${min / 10080} week${min === 10080 ? '' : 's'}`;
  if (min % 1440 === 0) return min === 1440 ? 'Tomorrow' : `In ${min / 1440} days`;
  if (min % 60 === 0) return `In ${min / 60} hour${min === 60 ? '' : 's'}`;
  return `In ${min} minute${min === 1 ? '' : 's'}`;
}

/** Notification title + message for a due reminder, formatted in the HA time zone. */
export function formatReminder(d: DueReminder, timeZone: string, calendarName: string): { title: string; message: string } {
  const e = d.event;
  const parts: string[] = [];
  if (e.all_day) {
    parts.push(d.offset_minutes === 0 ? 'Today (all day)' : `${describeOffset(d.offset_minutes)} (all day)`);
  } else {
    const t = new Intl.DateTimeFormat('en', { timeZone, hour: 'numeric', minute: '2-digit' });
    const day = new Intl.DateTimeFormat('en', { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
    const sameDay = day.format(new Date(d.fireAt)) === day.format(new Date(d.startMs));
    const when = `${sameDay ? '' : day.format(new Date(d.startMs)) + ', '}${t.format(new Date(d.startMs))}–${t.format(new Date(Date.parse(e.end)))}`;
    parts.push(`${describeOffset(d.offset_minutes)} · ${when}`);
  }
  if (e.location) parts.push(e.location);
  parts.push(calendarName);
  return { title: e.summary || 'Event', message: parts.join(' · ') };
}
