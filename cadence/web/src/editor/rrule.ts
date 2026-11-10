// Recurrence presets <-> RRULE strings. HA only accepts FREQ of DAILY,
// WEEKLY, MONTHLY or YEARLY. All maths is in the HA time zone.
import { DateTime } from 'luxon';

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type DayCode = (typeof DAY_CODES)[number];
const DAY_NAMES: Record<DayCode, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth'];

export type RepeatEnd = { kind: 'never' } | { kind: 'until'; date: string } | { kind: 'count'; count: number };

export interface Repeat {
  freq: Freq | null;
  interval: number;
  /** WEEKLY: days of the week. */
  byDay: DayCode[];
  /** MONTHLY: same day number, the nth weekday, or the last weekday of the month. */
  monthly: 'monthday' | 'weekday' | 'lastweekday';
  end: RepeatEnd;
}

export const NO_REPEAT: Repeat = { freq: null, interval: 1, byDay: [], monthly: 'monthday', end: { kind: 'never' } };

export function dayCode(d: DateTime): DayCode {
  return DAY_CODES[d.weekday - 1];
}
export function nthOfMonth(d: DateTime): number {
  return Math.ceil(d.day / 7);
}
export function isLastOfMonth(d: DateTime): boolean {
  return d.day + 7 > d.daysInMonth!;
}

function sortDays(days: DayCode[]): DayCode[] {
  return [...new Set(days)].sort((a, b) => DAY_CODES.indexOf(a) - DAY_CODES.indexOf(b));
}

/**
 * Build an RRULE (without the "RRULE:" prefix). `start` is the first
 * occurrence in the HA time zone. Returns undefined for "does not repeat".
 */
export function buildRrule(r: Repeat, start: DateTime, allDay: boolean): string | undefined {
  if (!r.freq) return undefined;
  const parts = [`FREQ=${r.freq}`];
  const interval = Math.max(1, Math.floor(r.interval || 1));
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (r.freq === 'WEEKLY') {
    // The first occurrence must match the rule, so always include its weekday.
    const days = sortDays([...(r.byDay.length ? r.byDay : []), dayCode(start)]);
    parts.push(`BYDAY=${days.join(',')}`);
  } else if (r.freq === 'MONTHLY' && r.monthly === 'weekday') {
    parts.push(`BYDAY=${nthOfMonth(start)}${dayCode(start)}`);
  } else if (r.freq === 'MONTHLY' && r.monthly === 'lastweekday') {
    parts.push(`BYDAY=-1${dayCode(start)}`);
  }
  if (r.end.kind === 'count') {
    parts.push(`COUNT=${Math.max(1, Math.floor(r.end.count))}`);
  } else if (r.end.kind === 'until') {
    const until = DateTime.fromISO(r.end.date, { zone: start.zone });
    if (allDay) parts.push(`UNTIL=${until.toFormat('yyyyMMdd')}`);
    // Timed events: include the whole "until" day, expressed in UTC.
    else parts.push(`UNTIL=${until.endOf('day').set({ millisecond: 0 }).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'")}`);
  }
  return parts.join(';');
}

export function parseRrule(rule: string | null | undefined, start: DateTime): Repeat {
  if (!rule) return { ...NO_REPEAT };
  const p = Object.fromEntries(
    rule
      .replace(/^RRULE:/i, '')
      .split(';')
      .filter(Boolean)
      .map((kv) => {
        const [k, v = ''] = kv.split('=');
        return [k.toUpperCase(), v];
      }),
  ) as Record<string, string>;
  const freq = (['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const).find((f) => f === p.FREQ) ?? null;
  const r: Repeat = { ...NO_REPEAT, freq, interval: Number(p.INTERVAL) || 1, byDay: [] };
  if (p.BYDAY) {
    const items = p.BYDAY.split(',');
    if (freq === 'WEEKLY') r.byDay = sortDays(items.map((d) => d.slice(-2) as DayCode).filter((d) => DAY_CODES.includes(d)));
    if (freq === 'MONTHLY') r.monthly = items[0].startsWith('-1') ? 'lastweekday' : 'weekday';
  }
  if (freq === 'WEEKLY' && !r.byDay.length) r.byDay = [dayCode(start)];
  if (p.COUNT) r.end = { kind: 'count', count: Number(p.COUNT) };
  else if (p.UNTIL) {
    const u = p.UNTIL;
    const date = u.endsWith('Z')
      ? DateTime.fromFormat(u, "yyyyMMdd'T'HHmmss'Z'", { zone: 'utc' }).setZone(start.zone)
      : DateTime.fromFormat(u.slice(0, 8), 'yyyyMMdd', { zone: start.zone });
    if (date.isValid) r.end = { kind: 'until', date: date.toISODate()! };
  }
  return r;
}

/** True when the rule uses parts this editor cannot represent (so it should not be rewritten blindly). */
export function isComplexRrule(rule: string | null | undefined): boolean {
  if (!rule) return false;
  const known = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL', 'WKST']);
  const parts = rule.replace(/^RRULE:/i, '').split(';').filter(Boolean);
  if (parts.some((kv) => !known.has(kv.split('=')[0].toUpperCase()))) return true;
  const freq = /FREQ=(\w+)/.exec(rule)?.[1];
  const byday = /BYDAY=([^;]+)/.exec(rule)?.[1];
  if (byday && (freq === 'DAILY' || freq === 'YEARLY')) return true;
  if (byday && freq === 'MONTHLY' && byday.includes(',')) return true;
  return false;
}

export function describeRepeat(r: Repeat, start: DateTime): string {
  if (!r.freq) return 'Does not repeat';
  const n = r.interval > 1 ? r.interval : 1;
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.freq];
  let s = n > 1 ? `Every ${n} ${unit}s` : { DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Yearly' }[r.freq];
  if (r.freq === 'WEEKLY') {
    const days = sortDays(r.byDay.length ? r.byDay : [dayCode(start)]);
    if (days.join(',') === 'MO,TU,WE,TH,FR' && n === 1) s = 'Every weekday';
    else s += ` on ${days.map((d) => DAY_NAMES[d].slice(0, 3)).join(', ')}`;
  } else if (r.freq === 'MONTHLY') {
    if (r.monthly === 'weekday') s += ` on the ${ORDINALS[nthOfMonth(start)]} ${DAY_NAMES[dayCode(start)]}`;
    else if (r.monthly === 'lastweekday') s += ` on the last ${DAY_NAMES[dayCode(start)]}`;
    else s += ` on day ${start.day}`;
  } else if (r.freq === 'YEARLY') {
    s += ` on ${start.toFormat('LLLL d')}`;
  }
  if (r.end.kind === 'count') s += `, ${r.end.count} time${r.end.count === 1 ? '' : 's'}`;
  if (r.end.kind === 'until') s += `, until ${DateTime.fromISO(r.end.date).toFormat('LLL d, yyyy')}`;
  return s;
}

export interface Preset {
  id: string;
  label: string;
  repeat: Repeat;
}

/** Presets offered in the editor, relative to the event's start. */
export function presets(start: DateTime): Preset[] {
  const base = { ...NO_REPEAT };
  const list: Preset[] = [
    { id: 'none', label: 'Does not repeat', repeat: base },
    { id: 'daily', label: 'Every day', repeat: { ...base, freq: 'DAILY' } },
    { id: 'weekdays', label: 'Every weekday (Mon–Fri)', repeat: { ...base, freq: 'WEEKLY', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] } },
    { id: 'weekly', label: `Weekly on ${DAY_NAMES[dayCode(start)]}`, repeat: { ...base, freq: 'WEEKLY', byDay: [dayCode(start)] } },
    { id: 'biweekly', label: `Every 2 weeks on ${DAY_NAMES[dayCode(start)]}`, repeat: { ...base, freq: 'WEEKLY', interval: 2, byDay: [dayCode(start)] } },
    { id: 'monthday', label: `Monthly on day ${start.day}`, repeat: { ...base, freq: 'MONTHLY', monthly: 'monthday' } },
  ];
  if (nthOfMonth(start) <= 4) list.push({ id: 'monthweekday', label: `Monthly on the ${ORDINALS[nthOfMonth(start)]} ${DAY_NAMES[dayCode(start)]}`, repeat: { ...base, freq: 'MONTHLY', monthly: 'weekday' } });
  if (isLastOfMonth(start)) list.push({ id: 'monthlast', label: `Monthly on the last ${DAY_NAMES[dayCode(start)]}`, repeat: { ...base, freq: 'MONTHLY', monthly: 'lastweekday' } });
  list.push({ id: 'yearly', label: `Yearly on ${start.toFormat('LLLL d')}`, repeat: { ...base, freq: 'YEARLY' } });
  return list;
}

/** Which preset (if any) a repeat matches, ignoring its end. */
export function matchPreset(r: Repeat, start: DateTime): string {
  const b = buildRrule({ ...r, end: { kind: 'never' } }, start, false);
  for (const p of presets(start)) if (buildRrule(p.repeat, start, false) === b) return p.id;
  return 'custom';
}
