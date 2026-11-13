import type { FastifyInstance } from 'fastify';
import { FEATURE_CREATE, FEATURE_DELETE, FEATURE_UPDATE, type FlowResult, type HaCalendar } from '../ha/client.ts';
import { LinkError, normalizeLink } from '../links/normalize.ts';
import { checkLink } from '../links/validate.ts';
import type { CalendarMeta, ReminderRule } from '../store/db.ts';
import { ApiError, sendError, str, type Ctx } from './context.ts';

const MANAGED = new Set(['local_calendar', 'remote_calendar']);

export function calendarView(c: HaCalendar, m: CalendarMeta | undefined) {
  const f = c.supported_features;
  return {
    entity_id: c.entity_id,
    ha_name: c.name,
    name: m?.display_name || c.name,
    display_name: m?.display_name ?? null,
    color: m?.color ?? '#3b82f6',
    visible: m?.visible ?? true,
    sort: m?.sort ?? 0,
    platform: c.platform,
    kind: c.platform === 'local_calendar' ? 'local' : c.platform === 'remote_calendar' ? 'link' : 'other',
    can_create: (f & FEATURE_CREATE) !== 0,
    can_update: (f & FEATURE_UPDATE) !== 0,
    can_delete_events: (f & FEATURE_DELETE) !== 0,
    removable: !!c.config_entry_id && MANAGED.has(c.platform ?? ''),
    default_reminders: m?.default_reminders ?? [],
    notify_targets: m?.notify_targets ?? null,
  };
}

export function validRules(v: unknown): ReminderRule[] {
  if (!Array.isArray(v)) throw new ApiError(400, 'invalid_request', 'reminders must be a list');
  if (v.length > 10) throw new ApiError(400, 'invalid_request', 'at most 10 reminders');
  return v.map((r) => {
    const off = Number((r as any)?.offset_minutes);
    if (!Number.isFinite(off) || off < 0 || off > 60 * 24 * 28) throw new ApiError(400, 'invalid_request', 'invalid reminder offset');
    const targets = (r as any)?.targets;
    if (targets != null && (!Array.isArray(targets) || targets.some((t) => typeof t !== 'string' || !t.startsWith('notify.')))) throw new ApiError(400, 'invalid_request', 'invalid notify target');
    return { offset_minutes: Math.round(off), targets: targets?.length ? targets : null };
  });
}

/** Wait for the entity created by a config entry to appear (HA sets the entry up asynchronously). */
async function waitForEntity(ctx: Ctx, entry_id: string, timeoutMs = 8000): Promise<HaCalendar | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const cals = await ctx.ha.listCalendars();
    const c = cals.find((x) => x.config_entry_id === entry_id);
    if (c) return c;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

const FLOW_ERRORS: Record<string, string> = {
  forbidden: 'The calendar server refused access to Home Assistant.',
  cannot_connect: 'Home Assistant could not download the calendar. Check the link, and that Home Assistant can reach the internet.',
  timeout_connect: 'Home Assistant timed out downloading the calendar.',
  invalid_ics_file: 'Home Assistant could not read the calendar data.',
  invalid_auth: 'The username or password was rejected.',
};

async function finishFlow(ctx: Ctx, res: FlowResult, color: string | undefined) {
  if (res.type === 'create_entry' && res.result?.entry_id) {
    const cal = await waitForEntity(ctx, res.result.entry_id);
    if (!cal) return { pending: true, title: res.title };
    ctx.store.ensureMeta([cal.entity_id]);
    if (color) ctx.store.updateMeta(cal.entity_id, { color });
    await ctx.live.resync();
    ctx.live.broadcast('calendars');
    return { calendar: calendarView(cal, ctx.store.getMeta(cal.entity_id) ?? undefined) };
  }
  if (res.type === 'abort') {
    if (res.reason === 'already_configured') throw new ApiError(409, 'already_exists', 'A calendar with this name or link already exists in Home Assistant.');
    throw new ApiError(400, res.reason ?? 'aborted', `Home Assistant stopped the setup (${res.reason}).`);
  }
  if (res.type === 'form') {
    await ctx.ha.abortFlow(res.flow_id);
    if (res.step_id === 'auth') throw new ApiError(400, 'needs_auth', 'This calendar needs a username and password. Add it from Home Assistant → Settings → Integrations → Remote Calendar.');
    const code = res.errors?.base ?? Object.values(res.errors ?? {})[0] ?? 'unknown';
    throw new ApiError(400, code, FLOW_ERRORS[code] ?? `Home Assistant could not add the calendar (${code}).`);
  }
  throw new ApiError(502, 'unexpected_flow', 'Home Assistant returned an unexpected answer.');
}

export function calendarRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/calendars', async (_req, reply) => {
    try {
      const cals = await ctx.ha.listCalendars();
      const meta = ctx.store.ensureMeta(cals.map((c) => c.entity_id));
      const out = cals.map((c) => calendarView(c, meta.get(c.entity_id)));
      out.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
      return { calendars: out };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch<{ Params: { entity_id: string }; Body: any }>('/api/calendars/:entity_id', async (req, reply) => {
    try {
      const b: any = req.body ?? {};
      const patch: Partial<CalendarMeta> = {};
      if (b.color !== undefined) {
        if (typeof b.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(b.color)) throw new ApiError(400, 'invalid_request', 'color must be #rrggbb');
        patch.color = b.color;
      }
      if (b.visible !== undefined) patch.visible = !!b.visible;
      if (b.sort !== undefined) patch.sort = Number(b.sort) || 0;
      if (b.display_name !== undefined) patch.display_name = b.display_name ? str(b.display_name, 'name', 100) : null;
      if (b.default_reminders !== undefined) patch.default_reminders = validRules(b.default_reminders);
      if (b.notify_targets !== undefined) patch.notify_targets = Array.isArray(b.notify_targets) && b.notify_targets.length ? b.notify_targets.filter((t: unknown) => typeof t === 'string' && t.startsWith('notify.')) : null;
      const meta = ctx.store.updateMeta(req.params.entity_id, patch);
      ctx.scheduler.poke(200);
      ctx.live.broadcast('calendars');
      return { meta };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: any }>('/api/calendars/local', async (req, reply) => {
    try {
      const name = str((req.body as any)?.name, 'Calendar name', 100);
      const flow = await ctx.ha.startFlow('local_calendar');
      if (flow.type !== 'form') return await finishFlow(ctx, flow, (req.body as any)?.color);
      const res = await ctx.ha.submitFlow(flow.flow_id, { calendar_name: name, import: 'create_empty' });
      return await finishFlow(ctx, res, (req.body as any)?.color);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: any }>('/api/calendars/link/check', async (req, reply) => {
    try {
      const link = normalizeLink(String((req.body as any)?.url ?? ''));
      const check = await checkLink(link.url, link.provider, ctx.fetcher);
      return { url: link.url, provider: link.provider, changed: link.changed, ...check };
    } catch (err) {
      if (err instanceof LinkError) return reply.code(400).send({ error: err.code, message: err.message });
      return sendError(reply, err);
    }
  });

  app.post<{ Body: any }>('/api/calendars/link', async (req, reply) => {
    try {
      const name = str((req.body as any)?.name, 'Calendar name', 100);
      const link = normalizeLink(String((req.body as any)?.url ?? ''));
      await checkLink(link.url, link.provider, ctx.fetcher);
      const handlers = await ctx.ha.flowHandlers().catch(() => null);
      if (handlers && !handlers.includes('remote_calendar')) {
        throw new ApiError(400, 'remote_calendar_missing', 'This Home Assistant does not have the Remote Calendar integration (it needs Home Assistant 2025.4 or newer). Update Home Assistant to add link calendars.');
      }
      const flow = await ctx.ha.startFlow('remote_calendar');
      if (flow.type !== 'form') return await finishFlow(ctx, flow, (req.body as any)?.color);
      const res = await ctx.ha.submitFlow(flow.flow_id, { calendar_name: name, url: link.url, verify_ssl: true });
      return await finishFlow(ctx, res, (req.body as any)?.color);
    } catch (err) {
      if (err instanceof LinkError) return reply.code(400).send({ error: err.code, message: err.message });
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { entity_id: string } }>('/api/calendars/:entity_id', async (req, reply) => {
    try {
      const cal = (await ctx.ha.listCalendars()).find((c) => c.entity_id === req.params.entity_id);
      if (!cal) throw new ApiError(404, 'not_found', 'Calendar not found.');
      if (!cal.config_entry_id || !MANAGED.has(cal.platform ?? '')) {
        throw new ApiError(400, 'not_removable', `This calendar comes from the "${cal.platform ?? 'unknown'}" integration. Remove it in Home Assistant → Settings → Devices & services.`);
      }
      await ctx.ha.deleteEntry(cal.config_entry_id);
      ctx.store.deleteCalendarData(cal.entity_id);
      await ctx.live.resync();
      ctx.live.broadcast('calendars');
      ctx.scheduler.poke(200);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { entity_id: string } }>('/api/calendars/:entity_id/refresh', async (req, reply) => {
    try {
      await ctx.ha.updateEntity(req.params.entity_id);
      ctx.live.broadcast('events', { entity_id: req.params.entity_id });
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
