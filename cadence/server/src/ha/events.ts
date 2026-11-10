// Calendar event shapes. HA returns two different shapes:
//  - REST /api/calendars/{id}: start/end are {dateTime} or {date} objects.
//  - WS calendar/event/subscribe: start/end are plain ISO strings plus all_day.
// Both are normalised into CadenceEvent.

export interface CadenceEvent {
  entity_id: string;
  uid: string | null;
  recurrence_id: string | null;
  rrule: string | null;
  summary: string;
  description: string | null;
  location: string | null;
  /** ISO datetime with offset, or YYYY-MM-DD for all-day events. */
  start: string;
  end: string;
  all_day: boolean;
}

/** Event payload for calendar/event/create and update (HA field names). */
export interface HaEventInput {
  summary: string;
  dtstart: string;
  dtend: string;
  description?: string;
  location?: string;
  rrule?: string;
}

type ApiDate = { date: string } | { dateTime: string } | string;

function dateOf(v: ApiDate): { value: string; allDay: boolean } {
  if (typeof v === 'string') return { value: v, allDay: /^\d{4}-\d{2}-\d{2}$/.test(v) };
  if ('dateTime' in v) return { value: v.dateTime, allDay: false };
  return { value: v.date, allDay: true };
}

export function normalizeEvent(entity_id: string, raw: Record<string, any>): CadenceEvent {
  const s = dateOf(raw.start);
  const e = dateOf(raw.end);
  return {
    entity_id,
    uid: raw.uid ?? null,
    recurrence_id: raw.recurrence_id || null,
    rrule: raw.rrule || null,
    summary: raw.summary ?? '',
    description: raw.description ?? null,
    location: raw.location ?? null,
    start: s.value,
    end: e.value,
    all_day: typeof raw.all_day === 'boolean' ? raw.all_day : s.allDay,
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Validate an event coming from the browser before sending it to HA. Returns an error string or null. */
export function validateEventInput(e: unknown): string | null {
  if (!e || typeof e !== 'object') return 'event is required';
  const ev = e as Record<string, unknown>;
  if (typeof ev.summary !== 'string' || !ev.summary.trim()) return 'A title is required';
  if (typeof ev.dtstart !== 'string' || typeof ev.dtend !== 'string') return 'Start and end are required';
  const sDate = DATE.test(ev.dtstart);
  const eDate = DATE.test(ev.dtend);
  if (sDate !== eDate) return 'Start and end must both be dates or both be times';
  if (!sDate && (!DATETIME.test(ev.dtstart) || !DATETIME.test(ev.dtend))) return 'Times must include a UTC offset';
  const s = Date.parse(ev.dtstart);
  const en = Date.parse(ev.dtend);
  if (Number.isNaN(s) || Number.isNaN(en)) return 'Invalid date';
  if (en - s < 1000) return 'The event must end after it starts';
  if (ev.rrule !== undefined && ev.rrule !== null) {
    if (typeof ev.rrule !== 'string') return 'Invalid repeat rule';
    const freq = /(?:^|;)FREQ=([A-Z]+)/.exec(ev.rrule)?.[1];
    if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return 'Repeat must be daily, weekly, monthly or yearly';
  }
  for (const k of ['description', 'location']) {
    if (ev[k] !== undefined && ev[k] !== null && typeof ev[k] !== 'string') return `Invalid ${k}`;
  }
  return null;
}

/** Strip empty optional fields: HA's schema rejects null for description/location/rrule. */
export function toHaEvent(e: Record<string, any>): HaEventInput {
  const out: HaEventInput = { summary: String(e.summary).trim(), dtstart: e.dtstart, dtend: e.dtend };
  if (e.description) out.description = String(e.description);
  if (e.location) out.location = String(e.location);
  if (e.rrule) out.rrule = String(e.rrule);
  return out;
}
