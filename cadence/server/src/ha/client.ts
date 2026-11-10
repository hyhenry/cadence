// High-level Home Assistant client used by Cadence. REST for reads, config
// flows and services; websocket for calendar writes, the entity registry and
// live updates.
import type { HaTarget } from '../config.ts';
import { HaError, HaSocket, type Subscription } from './ws.ts';
import { normalizeEvent, type CadenceEvent, type HaEventInput } from './events.ts';

export const FEATURE_CREATE = 1;
export const FEATURE_DELETE = 2;
export const FEATURE_UPDATE = 4;

export class HaHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, what: string) {
    super(`Home Assistant returned ${status} for ${what}`);
    this.status = status;
    this.body = body;
  }
}

export interface HaCalendar {
  entity_id: string;
  name: string;
  supported_features: number;
  platform: string | null;
  config_entry_id: string | null;
}

export interface HaConfig {
  time_zone: string;
  version: string;
  location_name?: string;
  components?: string[];
}

export interface FlowResult {
  type: 'form' | 'create_entry' | 'abort' | string;
  flow_id: string;
  handler: string;
  step_id?: string;
  errors?: Record<string, string> | null;
  reason?: string;
  result?: { entry_id: string; title: string; domain: string };
  title?: string;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export class HaClient {
  readonly socket: HaSocket;
  private readonly target: HaTarget;
  private configCache: HaConfig | null = null;

  constructor(target: HaTarget, log?: Logger) {
    this.target = target;
    this.socket = new HaSocket({
      url: target.wsUrl,
      token: target.token,
      log: (level, msg) => log?.[level](msg),
    });
  }

  start() {
    return this.socket.start();
  }
  close() {
    this.socket.close();
  }

  /** REST call. `what` is a safe label for errors (never includes query strings or bodies). */
  async rest<T = unknown>(method: string, path: string, body?: unknown, what = `${method} ${path.split('?')[0]}`): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.target.restBase}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.target.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new HaError('cannot_connect', `Cannot reach Home Assistant (${(err as Error).name})`);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* plain text body */
    }
    if (!res.ok) throw new HaHttpError(res.status, parsed, what);
    return parsed as T;
  }

  async config(force = false): Promise<HaConfig> {
    if (!this.configCache || force) this.configCache = await this.rest<HaConfig>('GET', '/config');
    return this.configCache;
  }

  async timeZone(): Promise<string> {
    return (await this.config()).time_zone || 'UTC';
  }

  async listCalendars(): Promise<HaCalendar[]> {
    const [states, registry] = await Promise.all([
      this.rest<any[]>('GET', '/states'),
      this.socket.send<any[]>({ type: 'config/entity_registry/list' }).catch(() => [] as any[]),
    ]);
    const reg = new Map(registry.map((r) => [r.entity_id, r]));
    return states
      .filter((s) => typeof s.entity_id === 'string' && s.entity_id.startsWith('calendar.'))
      .map((s) => {
        const r = reg.get(s.entity_id);
        return {
          entity_id: s.entity_id,
          name: s.attributes?.friendly_name ?? s.entity_id,
          supported_features: Number(s.attributes?.supported_features ?? 0),
          platform: r?.platform ?? null,
          config_entry_id: r?.config_entry_id ?? null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getEvents(entity_id: string, start: string, end: string): Promise<CadenceEvent[]> {
    const q = new URLSearchParams({ start, end });
    const raw = await this.rest<any[]>('GET', `/calendars/${encodeURIComponent(entity_id)}?${q}`, undefined, `events of ${entity_id}`);
    return raw.map((r) => normalizeEvent(entity_id, r));
  }

  createEvent(entity_id: string, event: HaEventInput) {
    return this.socket.send({ type: 'calendar/event/create', entity_id, event });
  }

  updateEvent(entity_id: string, uid: string, event: HaEventInput, recurrence_id?: string | null, recurrence_range?: string | null) {
    const msg: Record<string, unknown> = { type: 'calendar/event/update', entity_id, uid, event };
    if (recurrence_id) msg.recurrence_id = recurrence_id;
    if (recurrence_range) msg.recurrence_range = recurrence_range;
    return this.socket.send(msg);
  }

  deleteEvent(entity_id: string, uid: string, recurrence_id?: string | null, recurrence_range?: string | null) {
    const msg: Record<string, unknown> = { type: 'calendar/event/delete', entity_id, uid };
    if (recurrence_id) msg.recurrence_id = recurrence_id;
    if (recurrence_range) msg.recurrence_range = recurrence_range;
    return this.socket.send(msg);
  }

  subscribeCalendar(entity_id: string, start: string, end: string, onEvents: (events: CadenceEvent[] | null) => void): Promise<Subscription> {
    return this.socket.subscribe({ type: 'calendar/event/subscribe', entity_id, start, end }, (ev) => {
      onEvents(Array.isArray(ev?.events) ? ev.events.map((e: any) => normalizeEvent(entity_id, e)) : null);
    });
  }

  subscribeEvents(event_type: string, cb: (event: any) => void): Promise<Subscription> {
    return this.socket.subscribe({ type: 'subscribe_events', event_type }, cb);
  }

  // ---- config entries / flows ----
  async flowHandlers(): Promise<string[]> {
    return this.rest<string[]>('GET', '/config/config_entries/flow_handlers');
  }
  startFlow(handler: string): Promise<FlowResult> {
    return this.rest<FlowResult>('POST', '/config/config_entries/flow', { handler, show_advanced_options: false }, `start ${handler} flow`);
  }
  submitFlow(flow_id: string, data: Record<string, unknown>): Promise<FlowResult> {
    // Never include `data` in errors/logs: it may contain a calendar share URL.
    return this.rest<FlowResult>('POST', `/config/config_entries/flow/${encodeURIComponent(flow_id)}`, data, 'config flow step');
  }
  abortFlow(flow_id: string) {
    return this.rest('DELETE', `/config/config_entries/flow/${encodeURIComponent(flow_id)}`, undefined, 'abort config flow').catch(() => undefined);
  }
  deleteEntry(entry_id: string) {
    return this.rest('DELETE', `/config/config_entries/entry/${encodeURIComponent(entry_id)}`, undefined, 'delete config entry');
  }

  // ---- services ----
  callService(domain: string, service: string, data: Record<string, unknown>) {
    return this.rest('POST', `/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, data, `service ${domain}.${service}`);
  }
  updateEntity(entity_id: string) {
    return this.callService('homeassistant', 'update_entity', { entity_id });
  }
  async notifyServices(): Promise<{ id: string; name: string }[]> {
    const services = await this.rest<any[]>('GET', '/services');
    const notify = services.find((d) => d.domain === 'notify');
    if (!notify) return [];
    return Object.entries<any>(notify.services)
      .filter(([k]) => k !== 'send_message')
      .map(([k, v]) => ({ id: `notify.${k}`, name: v?.name || k }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  notify(target: string, title: string, message: string, data?: Record<string, unknown>) {
    const [domain, service] = target.split('.', 2);
    if (domain !== 'notify' || !service) throw new HaError('invalid_target', 'Notification target must be notify.<service>');
    return this.callService('notify', service, { title, message, ...(data ? { data } : {}) });
  }
}
