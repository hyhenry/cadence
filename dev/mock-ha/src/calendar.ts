// In-memory calendar store that mirrors the behaviour of HA's local_calendar
// (ical library) closely enough for Cadence to be developed against it:
// floating local times, recurrence_id = local "YYYYMMDDTHHMMSS" (or
// "YYYYMMDD" for all-day), recurrence_range only honoured when it is the
// literal "THISANDFUTURE".
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import rrulePkg from 'rrule';

const { RRule } = rrulePkg;

export const VALID_FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

export interface StoredEvent {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  allDay: boolean;
  /** Floating local wall time ("yyyy-MM-ddTHH:mm:ss") or date ("yyyy-MM-dd"). */
  start: string;
  end: string;
  rrule?: string;
  exdates: Set<string>;
  overrides: Map<string, Override>;
}

interface Override {
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
}

export interface Instance {
  uid: string;
  recurrence_id: string | null;
  rrule: string | null;
  summary: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  start: DateTime; // zoned in HA tz
  end: DateTime;
}

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

const WALL = "yyyy-MM-dd'T'HH:mm:ss";

export interface EventInput {
  dtstart: string;
  dtend: string;
  summary: string;
  description?: string;
  location?: string;
  rrule?: string;
}

/** Validate + normalise an incoming WS event the way WEBSOCKET_EVENT_SCHEMA does. */
export function parseEventInput(raw: unknown, tz: string): Omit<StoredEvent, 'uid' | 'exdates' | 'overrides'> {
  if (!raw || typeof raw !== 'object') throw new ValidationError('expected a dictionary for dictionary value @ data[\'event\']');
  const e = raw as Record<string, unknown>;
  for (const k of ['dtstart', 'dtend', 'summary']) {
    if (e[k] === undefined) throw new ValidationError(`required key not provided @ data['event']['${k}']`);
  }
  const allowed = new Set(['dtstart', 'dtend', 'summary', 'description', 'location', 'rrule']);
  for (const k of Object.keys(e)) {
    if (!allowed.has(k)) throw new ValidationError(`extra keys not allowed @ data['event']['${k}']`);
  }
  if (typeof e.summary !== 'string') throw new ValidationError('expected str for summary');
  const s = parseDateOrDateTime(String(e.dtstart), tz);
  const en = parseDateOrDateTime(String(e.dtend), tz);
  if (s.kind !== en.kind) throw new ValidationError("Expected all values to be the same type: ('dtstart', 'dtend')");
  if (s.kind === 'datetime' && en.kind === 'datetime' && s.hasZone !== en.hasZone) {
    throw new ValidationError("Expected all values to have the same timezone: ('dtstart', 'dtend')");
  }
  if (en.value.toMillis() - s.value.toMillis() < 1000) {
    throw new ValidationError(`Expected minimum event duration of 0:00:01 ('dtstart', 'dtend')`);
  }
  let rrule: string | undefined;
  if (e.rrule !== undefined) {
    rrule = validateRrule(e.rrule);
  }
  const allDay = s.kind === 'date';
  return {
    summary: e.summary,
    description: typeof e.description === 'string' ? e.description : undefined,
    location: typeof e.location === 'string' ? e.location : undefined,
    allDay,
    start: allDay ? s.value.toISODate()! : s.value.toFormat(WALL),
    end: allDay ? en.value.toISODate()! : en.value.toFormat(WALL),
    rrule,
  };
}

export function validateRrule(value: unknown): string {
  if (value === null || value === undefined) throw new ValidationError('rrule value is None');
  if (typeof value !== 'string') throw new ValidationError('rrule value expected a string');
  if (value === '') return value; // HA accepts an empty string only via its own flows; treat as none
  const parts = Object.fromEntries(value.split(';').map((p) => p.split('=', 2) as [string, string]));
  if (!parts.FREQ) throw new ValidationError('rrule did not contain FREQ');
  if (!VALID_FREQS.has(parts.FREQ)) throw new ValidationError(`Invalid frequency for rule: ${value}`);
  try {
    RRule.parseString(value);
  } catch (err) {
    throw new ValidationError(`Invalid rrule '${value}': ${(err as Error).message}`);
  }
  return value;
}

function parseDateOrDateTime(v: string, tz: string): { kind: 'date' | 'datetime'; value: DateTime; hasZone: boolean } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = DateTime.fromISO(v, { zone: tz });
    if (!d.isValid) throw new ValidationError(`Invalid date specified: ${v}`);
    return { kind: 'date', value: d, hasZone: false };
  }
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(v);
  const d = DateTime.fromISO(v, { zone: tz, setZone: false });
  if (!d.isValid) throw new ValidationError(`Invalid datetime specified: ${v}`);
  return { kind: 'datetime', value: d.setZone(tz), hasZone };
}

function wallToZoned(wall: string, allDay: boolean, tz: string): DateTime {
  return allDay ? DateTime.fromISO(wall, { zone: tz }).startOf('day') : DateTime.fromFormat(wall, WALL, { zone: tz });
}

/** luxon wall time -> "fake UTC" Date for the rrule library (floating semantics). */
function toFake(dt: DateTime): Date {
  return new Date(Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second));
}
function fromFake(d: Date, tz: string): DateTime {
  return DateTime.fromObject(
    { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() },
    { zone: tz },
  );
}

export function recurrenceIdFor(start: DateTime, allDay: boolean): string {
  return allDay ? start.toFormat('yyyyMMdd') : start.toFormat("yyyyMMdd'T'HHmmss");
}

function buildRule(ev: StoredEvent, tz: string) {
  const startWall = wallToZoned(ev.start, ev.allDay, tz);
  const opts = RRule.parseString(ev.rrule!);
  // UNTIL with a trailing Z is a real UTC instant; convert to floating local.
  const untilRaw = /UNTIL=([0-9TZ]+)/.exec(ev.rrule!)?.[1];
  if (untilRaw && opts.until) {
    if (untilRaw.endsWith('Z')) {
      opts.until = toFake(DateTime.fromJSDate(opts.until).setZone(tz));
    } else if (untilRaw.length === 8) {
      // date-only UNTIL: inclusive of that whole day
      opts.until = new Date(opts.until.getTime() + 86_399_000);
    }
  }
  opts.dtstart = toFake(startWall);
  return new RRule(opts);
}

export function expand(ev: StoredEvent, rangeStart: DateTime, rangeEnd: DateTime, tz: string): Instance[] {
  const baseStart = wallToZoned(ev.start, ev.allDay, tz);
  const baseEnd = wallToZoned(ev.end, ev.allDay, tz);
  const durMs = baseEnd.toMillis() - baseStart.toMillis();
  const durDays = Math.max(1, Math.round(baseEnd.diff(baseStart, 'days').days));
  const mk = (start: DateTime, rid: string | null): Instance | null => {
    const ov = rid ? ev.overrides.get(rid) : undefined;
    const s = ov ? wallToZoned(ov.start, ev.allDay, tz) : start;
    const e = ov ? wallToZoned(ov.end, ev.allDay, tz) : ev.allDay ? start.plus({ days: durDays }) : start.plus({ milliseconds: durMs });
    if (!(s < rangeEnd && e > rangeStart)) return null;
    return {
      uid: ev.uid,
      recurrence_id: rid,
      rrule: ev.rrule ?? null,
      summary: ov?.summary ?? ev.summary,
      description: (ov ? ov.description : ev.description) ?? null,
      location: (ov ? ov.location : ev.location) ?? null,
      allDay: ev.allDay,
      start: s,
      end: e,
    };
  };
  if (!ev.rrule) {
    const i = mk(baseStart, null);
    return i ? [i] : [];
  }
  const rule = buildRule(ev, tz);
  // Widen the window by the duration so events that started before the range still show.
  const from = toFake(rangeStart.setZone(tz).minus({ milliseconds: durMs + 86_400_000 }));
  const to = toFake(rangeEnd.setZone(tz).plus({ days: 1 }));
  const out: Instance[] = [];
  for (const d of rule.between(from, to, true)) {
    const start = fromFake(d, tz);
    const rid = recurrenceIdFor(start, ev.allDay);
    if (ev.exdates.has(rid)) continue;
    const i = mk(start, rid);
    if (i) out.push(i);
  }
  return out;
}

export class CalendarStore {
  events = new Map<string, StoredEvent>();
  readonly tz: string;
  constructor(tz: string) {
    this.tz = tz;
  }

  list(rangeStart: DateTime, rangeEnd: DateTime): Instance[] {
    const out: Instance[] = [];
    for (const ev of this.events.values()) out.push(...expand(ev, rangeStart, rangeEnd, this.tz));
    out.sort((a, b) => a.start.toMillis() - b.start.toMillis());
    return out;
  }

  add(input: Omit<StoredEvent, 'uid' | 'exdates' | 'overrides'>, uid: string = randomUUID()): StoredEvent {
    const ev: StoredEvent = { ...input, uid, exdates: new Set(), overrides: new Map() };
    if (!ev.rrule) delete ev.rrule;
    this.events.set(uid, ev);
    return ev;
  }

  private get(uid: string): StoredEvent {
    const ev = this.events.get(uid);
    if (!ev) throw new NotFoundError(`No existing event with uid ${uid}`);
    return ev;
  }

  private instanceStart(ev: StoredEvent, rid: string): DateTime {
    const fmt = ev.allDay ? 'yyyyMMdd' : "yyyyMMdd'T'HHmmss";
    const d = DateTime.fromFormat(rid, fmt, { zone: this.tz });
    if (!d.isValid) throw new ValidationError(`Invalid recurrence_id ${rid}`);
    return d;
  }

  /** Truncate a series so it ends before the instance `rid`. Returns false if nothing is left. */
  private truncate(ev: StoredEvent, rid: string): boolean {
    const inst = this.instanceStart(ev, rid);
    const first = wallToZoned(ev.start, ev.allDay, this.tz);
    if (inst <= first) return false;
    const until = ev.allDay ? inst.minus({ days: 1 }).toFormat('yyyyMMdd') : inst.minus({ seconds: 1 }).toFormat("yyyyMMdd'T'HHmmss");
    const parts = ev.rrule!.split(';').filter((p) => !p.startsWith('UNTIL=') && !p.startsWith('COUNT='));
    parts.push(`UNTIL=${until}`);
    ev.rrule = parts.join(';');
    return true;
  }

  delete(uid: string, recurrenceId?: string | null, range?: string | null): void {
    const ev = this.get(uid);
    if (!recurrenceId || !ev.rrule) {
      this.events.delete(uid);
      return;
    }
    if (range === 'THISANDFUTURE') {
      if (!this.truncate(ev, recurrenceId)) this.events.delete(uid);
      return;
    }
    ev.exdates.add(recurrenceId);
    ev.overrides.delete(recurrenceId);
  }

  update(uid: string, input: Omit<StoredEvent, 'uid' | 'exdates' | 'overrides'>, recurrenceId?: string | null, range?: string | null): void {
    const ev = this.get(uid);
    if (!recurrenceId || !ev.rrule) {
      // Whole series (or a single event). Keep the uid; drop per-instance edits
      // when the timing of the series changes.
      const timingChanged = ev.start !== input.start || ev.rrule !== input.rrule || ev.allDay !== input.allDay;
      Object.assign(ev, { ...input });
      if (!input.rrule) delete ev.rrule;
      if (timingChanged) {
        ev.exdates.clear();
        ev.overrides.clear();
      }
      return;
    }
    if (range === 'THISANDFUTURE') {
      const remaining = this.truncate(ev, recurrenceId);
      if (!remaining) this.events.delete(uid);
      this.add({ ...input, rrule: input.rrule ?? stripLimits(ev.rrule) });
      return;
    }
    // Single instance override.
    this.instanceStart(ev, recurrenceId);
    ev.overrides.set(recurrenceId, {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: input.start,
      end: input.end,
    });
  }
}

function stripLimits(rrule: string | undefined): string | undefined {
  if (!rrule) return undefined;
  return rrule
    .split(';')
    .filter((p) => !p.startsWith('UNTIL=') && !p.startsWith('COUNT='))
    .join(';');
}

/** REST shape: api_event_dict_factory. */
export function toApiEvent(i: Instance) {
  return {
    start: i.allDay ? { date: i.start.toISODate() } : { dateTime: i.start.toISO({ suppressMilliseconds: true }) },
    end: i.allDay ? { date: i.end.toISODate() } : { dateTime: i.end.toISO({ suppressMilliseconds: true }) },
    summary: i.summary,
    description: i.description,
    location: i.location,
    uid: i.uid,
    recurrence_id: i.recurrence_id,
    rrule: i.rrule,
    status: null,
  };
}

/** WS subscribe shape: CalendarEvent.as_dict() (None values dropped, all_day added). */
export function toDictEvent(i: Instance) {
  const out: Record<string, unknown> = {
    start: i.allDay ? i.start.toISODate() : i.start.toISO({ suppressMilliseconds: true }),
    end: i.allDay ? i.end.toISODate() : i.end.toISO({ suppressMilliseconds: true }),
    summary: i.summary,
  };
  if (i.description != null) out.description = i.description;
  if (i.location != null) out.location = i.location;
  out.uid = i.uid;
  if (i.recurrence_id != null) out.recurrence_id = i.recurrence_id;
  if (i.rrule != null) out.rrule = i.rrule;
  out.all_day = i.allDay;
  return out;
}
