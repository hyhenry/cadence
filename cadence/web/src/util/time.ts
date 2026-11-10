// Time helpers. All calendar maths happens in the Home Assistant time zone,
// not the browser's.
import { DateTime } from 'luxon';

export function inZone(iso: string, tz: string): DateTime {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return DateTime.fromISO(iso, { zone: tz }).startOf('day');
  return DateTime.fromISO(iso, { setZone: true }).setZone(tz);
}

/** ISO with offset, second precision (what HA's websocket expects). */
export function isoOut(d: DateTime): string {
  return d.set({ millisecond: 0 }).toISO({ suppressMilliseconds: true })!;
}

export function dateOut(d: DateTime): string {
  return d.toISODate()!;
}

export function nextRoundHour(tz: string): DateTime {
  return DateTime.now().setZone(tz).plus({ hours: 1 }).startOf('hour');
}

export function formatRange(start: DateTime, end: DateTime, allDay: boolean, locale?: string): string {
  const day = (d: DateTime) => d.setLocale(locale ?? 'en').toFormat('ccc, LLL d');
  const time = (d: DateTime) => d.setLocale(locale ?? 'en').toLocaleString(DateTime.TIME_SIMPLE);
  if (allDay) {
    const last = end.minus({ days: 1 });
    return last.hasSame(start, 'day') ? `${day(start)} · All day` : `${day(start)} – ${day(last)} · All day`;
  }
  if (start.hasSame(end, 'day')) return `${day(start)} · ${time(start)} – ${time(end)}`;
  return `${day(start)} ${time(start)} – ${day(end)} ${time(end)}`;
}
