import type { FastifyInstance } from 'fastify';
import { toHaEvent, validateEventInput, type CadenceEvent, type HaEventInput } from '../ha/events.ts';
import { validRules } from './calendars.ts';
import { ApiError, sendError, str, type Ctx } from './context.ts';

export type Scope = 'this' | 'future' | 'all';

/** Map the UI's scope choice to HA's recurrence_id / recurrence_range. */
export function scopeToHa(scope: Scope | undefined, recurrence_id: string | null | undefined): { recurrence_id?: string; recurrence_range?: string } {
  if (!recurrence_id || !scope || scope === 'all') return {};
  if (scope === 'future') return { recurrence_id, recurrence_range: 'THISANDFUTURE' };
  return { recurrence_id };
}

const DAY = 86_400_000;

function addMs(value: string, ms: number, allDay: boolean): string {
  if (allDay) {
    const d = new Date(`${value}T00:00:00Z`);
    return new Date(d.getTime() + Math.round(ms / DAY) * DAY).toISOString().slice(0, 10);
  }
  // Keep the original offset notation by working in UTC and letting HA localise.
  return new Date(Date.parse(value) + ms).toISOString().replace('.000Z', 'Z');
}

function ms(value: string, allDay: boolean): number {
  return allDay ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
}

/** Earliest instance of a series (its DTSTART, unless that one was deleted). Searches back year by year. */
async function findSeriesStart(ctx: Ctx, entity_id: string, uid: string, before: string): Promise<CadenceEvent | null> {
  let end = Date.parse(before.length === 10 ? `${before}T23:59:59Z` : before) + DAY;
  let earliest: CadenceEvent | null = null;
  for (let i = 0; i < 6; i++) {
    const start = end - 370 * DAY;
    const evs = (await ctx.ha.getEvents(entity_id, new Date(start).toISOString(), new Date(end).toISOString())).filter((e) => e.uid === uid);
    if (!evs.length) break;
    for (const e of evs) if (!earliest || ms(e.start, e.all_day) < ms(earliest.start, earliest.all_day)) earliest = e;
    end = start;
  }
  return earliest;
}

/**
 * Editing "all events" of a series sends the series-level times to HA. The UI
 * edits one instance, so apply the same shift to the series start.
 */
async function seriesEvent(ctx: Ctx, entity_id: string, uid: string, originalStart: string, ev: HaEventInput): Promise<HaEventInput> {
  const allDay = ev.dtstart.length === 10;
  const first = await findSeriesStart(ctx, entity_id, uid, originalStart);
  if (!first || first.all_day !== allDay) return ev;
  const shift = ms(ev.dtstart, allDay) - ms(originalStart, originalStart.length === 10);
  const dur = ms(ev.dtend, allDay) - ms(ev.dtstart, allDay);
  const dtstart = addMs(first.start, shift, allDay);
  return { ...ev, dtstart, dtend: addMs(dtstart, dur, allDay) };
}

/** HA's create command returns no uid; find it by diffing the events around the new event. */
async function uidsAround(ctx: Ctx, entity_id: string, ev: HaEventInput): Promise<Set<string>> {
  const allDay = ev.dtstart.length === 10;
  const s = ms(ev.dtstart, allDay) - DAY;
  const e = ms(ev.dtend, allDay) + DAY;
  const list = await ctx.ha.getEvents(entity_id, new Date(s).toISOString(), new Date(e).toISOString());
  return new Set(list.filter((x) => x.summary === ev.summary).map((x) => x.uid).filter((u): u is string => !!u));
}

async function createAndFindUid(ctx: Ctx, entity_id: string, ev: HaEventInput): Promise<string | null> {
  const before = await uidsAround(ctx, entity_id, ev).catch(() => new Set<string>());
  await ctx.ha.createEvent(entity_id, ev);
  const after = await uidsAround(ctx, entity_id, ev).catch(() => new Set<string>());
  const fresh = [...after].filter((u) => !before.has(u));
  return fresh.length === 1 ? fresh[0] : null;
}

function parseEvent(body: any): HaEventInput {
  const err = validateEventInput(body);
  if (err) throw new ApiError(400, 'invalid_event', err);
  return toHaEvent(body);
}

function changed(ctx: Ctx, ...ids: string[]) {
  for (const id of new Set(ids)) ctx.live.broadcast('events', { entity_id: id });
  ctx.scheduler.poke(300);
}

export function eventRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get<{ Querystring: { start?: string; end?: string; calendars?: string } }>('/api/events', async (req, reply) => {
    try {
      const start = str(req.query.start, 'start', 40);
      const end = str(req.query.end, 'end', 40);
      if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) throw new ApiError(400, 'invalid_request', 'invalid range');
      const ids = req.query.calendars ? req.query.calendars.split(',').filter(Boolean) : (await ctx.ha.listCalendars()).map((c) => c.entity_id);
      const results = await Promise.allSettled(ids.map((id) => ctx.ha.getEvents(id, start, end)));
      const events: CadenceEvent[] = [];
      const errors: { entity_id: string; message: string }[] = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') events.push(...r.value);
        else errors.push({ entity_id: ids[i], message: 'Could not load events from Home Assistant.' });
      });
      return { events, errors };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: any }>('/api/events', async (req, reply) => {
    try {
      const entity_id = str((req.body as any)?.entity_id, 'entity_id', 255);
      const ev = parseEvent((req.body as any)?.event);
      const reminders = (req.body as any)?.reminders === undefined || (req.body as any)?.reminders === null ? null : validRules((req.body as any).reminders);
      const uid = await createAndFindUid(ctx, entity_id, ev);
      if (uid && reminders) ctx.store.setEventReminders(entity_id, uid, null, reminders);
      changed(ctx, entity_id);
      return { ok: true, uid };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put<{ Body: any }>('/api/events', async (req, reply) => {
    try {
      const b: any = req.body ?? {};
      const entity_id = str(b.entity_id, 'entity_id', 255);
      const uid = str(b.uid, 'uid', 1024);
      const scope: Scope = b.scope === 'this' || b.scope === 'future' ? b.scope : 'all';
      const rid: string | null = b.recurrence_id || null;
      let ev = parseEvent(b.event);
      const target: string = b.target_entity_id && b.target_entity_id !== entity_id ? String(b.target_entity_id) : entity_id;
      if (scope === 'this' && rid) delete ev.rrule; // a single occurrence cannot carry its own rule
      if (scope === 'all' && rid && b.original_start) ev = await seriesEvent(ctx, entity_id, uid, String(b.original_start), ev);

      if (target !== entity_id) {
        if (rid && scope !== 'all') throw new ApiError(400, 'invalid_request', 'Only a whole series can be moved to another calendar.');
        const newUid = await createAndFindUid(ctx, target, ev);
        await ctx.ha.deleteEvent(entity_id, uid);
        if (newUid) ctx.store.moveEventReminders({ entity_id, uid }, { entity_id: target, uid: newUid });
        else ctx.store.deleteEventReminders(entity_id, uid);
        if (newUid && Array.isArray(b.reminders)) ctx.store.setEventReminders(target, newUid, null, validRules(b.reminders));
        changed(ctx, entity_id, target);
        return { ok: true, uid: newUid, entity_id: target };
      }

      const ha = scopeToHa(scope, rid);
      await ctx.ha.updateEvent(entity_id, uid, ev, ha.recurrence_id, ha.recurrence_range);
      if (scope === 'all') ctx.store.clearInstanceReminders(entity_id, uid);
      if (b.reminders !== undefined) {
        const rules = b.reminders === null ? null : validRules(b.reminders);
        // "this" edits store an instance override; "all" and plain events store on the series.
        ctx.store.setEventReminders(entity_id, uid, scope === 'this' ? rid : null, rules);
      }
      changed(ctx, entity_id);
      return { ok: true, uid };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: any }>('/api/events/delete', async (req, reply) => {
    try {
      const b: any = req.body ?? {};
      const entity_id = str(b.entity_id, 'entity_id', 255);
      const uid = str(b.uid, 'uid', 1024);
      const scope: Scope = b.scope === 'this' || b.scope === 'future' ? b.scope : 'all';
      const ha = scopeToHa(scope, b.recurrence_id);
      await ctx.ha.deleteEvent(entity_id, uid, ha.recurrence_id, ha.recurrence_range);
      if (scope === 'all') ctx.store.deleteEventReminders(entity_id, uid);
      else if (scope === 'this' && b.recurrence_id) ctx.store.setEventReminders(entity_id, uid, b.recurrence_id, null);
      changed(ctx, entity_id);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
