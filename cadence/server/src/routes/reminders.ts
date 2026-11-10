import type { FastifyInstance } from 'fastify';
import type { Settings } from '../store/db.ts';
import { validRules } from './calendars.ts';
import { ApiError, sendError, str, type Ctx } from './context.ts';

const VIEWS = new Set(['dayGridMonth', 'timeGridWeek', 'timeGridDay', 'listWeek', 'timeGrid3Day']);

export function reminderRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/settings', async () => ({ settings: ctx.store.getSettings() }));

  app.put<{ Body: any }>('/api/settings', async (req, reply) => {
    try {
      const b: any = req.body ?? {};
      const patch: Partial<Settings> = {};
      if (b.notify_targets !== undefined) {
        if (!Array.isArray(b.notify_targets) || b.notify_targets.some((t: unknown) => typeof t !== 'string' || !t.startsWith('notify.'))) throw new ApiError(400, 'invalid_request', 'notify_targets must be notify.* services');
        patch.notify_targets = [...new Set<string>(b.notify_targets)];
      }
      if (b.refresh_minutes !== undefined) {
        const n = Math.round(Number(b.refresh_minutes));
        if (!Number.isFinite(n) || n < 1 || n > 1440) throw new ApiError(400, 'invalid_request', 'refresh_minutes must be 1–1440');
        patch.refresh_minutes = n;
      }
      if (b.default_calendar !== undefined) patch.default_calendar = b.default_calendar ? String(b.default_calendar) : null;
      if (b.week_start !== undefined) patch.week_start = Number(b.week_start) === 1 ? 1 : Number(b.week_start) === 6 ? 6 : 0;
      if (b.default_view !== undefined) {
        if (!VIEWS.has(b.default_view)) throw new ApiError(400, 'invalid_request', 'unknown view');
        patch.default_view = b.default_view;
      }
      if (b.default_duration_minutes !== undefined) {
        const n = Math.round(Number(b.default_duration_minutes));
        if (!Number.isFinite(n) || n < 5 || n > 1440) throw new ApiError(400, 'invalid_request', 'invalid default duration');
        patch.default_duration_minutes = n;
      }
      const settings = ctx.store.updateSettings(patch);
      if (patch.refresh_minutes) ctx.live.rescheduleRemoteRefresh();
      ctx.scheduler.poke(200);
      return { settings };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/notify/services', async (_req, reply) => {
    try {
      return { services: await ctx.ha.notifyServices() };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: any }>('/api/notify/test', async (req, reply) => {
    try {
      const targets: string[] = Array.isArray((req.body as any)?.targets) && (req.body as any).targets.length ? (req.body as any).targets : ctx.store.getSettings().notify_targets;
      if (!targets.length) throw new ApiError(400, 'no_targets', 'Choose at least one device to notify first.');
      const results = await Promise.allSettled(targets.map((t) => ctx.ha.notify(t, 'Calendar', 'Test notification: reminders will arrive like this.')));
      const failed = results.map((r, i) => ({ r, t: targets[i] })).filter((x) => x.r.status === 'rejected');
      return { sent: targets.filter((_, i) => results[i].status === 'fulfilled'), failed: failed.map((f) => ({ target: f.t, message: 'Home Assistant could not send to this target.' })) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Querystring: { entity_id?: string; uid?: string; recurrence_id?: string } }>('/api/reminders/event', async (req, reply) => {
    try {
      const entity_id = str(req.query.entity_id, 'entity_id', 255);
      const uid = str(req.query.uid, 'uid', 1024);
      const all = ctx.store.allEventReminders();
      const rid = req.query.recurrence_id || '';
      return {
        series: all.get(`${entity_id}|${uid}|`) ?? null,
        instance: rid ? (all.get(`${entity_id}|${uid}|${rid}`) ?? null) : null,
        calendar_default: ctx.store.getMeta(entity_id)?.default_reminders ?? [],
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put<{ Body: any }>('/api/reminders/event', async (req, reply) => {
    try {
      const b: any = req.body ?? {};
      const entity_id = str(b.entity_id, 'entity_id', 255);
      const uid = str(b.uid, 'uid', 1024);
      ctx.store.setEventReminders(entity_id, uid, b.recurrence_id || null, b.rules === null ? null : validRules(b.rules));
      ctx.scheduler.poke(200);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/reminders/upcoming', async () => ({
    upcoming: ctx.scheduler.upcoming.slice(0, 50).map((d) => ({ fire_at: new Date(d.fireAt).toISOString(), offset_minutes: d.offset_minutes, entity_id: d.event.entity_id, summary: d.event.summary, start: d.event.start, targets: d.targets })),
    last_error: ctx.scheduler.lastError,
  }));
}
