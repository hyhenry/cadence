// State of the fake Home Assistant: config entries, calendar entities, config
// flows, the event bus and service calls. Shapes follow HA core (Nov 2026).
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { CalendarStore, type Instance } from './calendar.ts';
import { fetchRemote, InvalidIcs, loadIcs } from './ics.ts';

export const FEATURE_CREATE = 1;
export const FEATURE_DELETE = 2;
export const FEATURE_UPDATE = 4;

export interface ConfigEntry {
  entry_id: string;
  domain: string;
  title: string;
  data: Record<string, unknown>;
  created_at: number;
  modified_at: number;
}

export interface CalendarEntity {
  entity_id: string;
  entry_id: string | null;
  platform: string;
  name: string;
  supported_features: number | null;
  store: CalendarStore;
  remoteUrl?: string;
}

interface Flow {
  flow_id: string;
  handler: string;
  step_id: string;
  data: Record<string, unknown>;
}

export interface BusEvent {
  event_type: string;
  data: Record<string, unknown>;
  origin: 'LOCAL';
  time_fired: string;
  context: { id: string; parent_id: null; user_id: null };
}

export interface NotifyRecord {
  service: string;
  data: Record<string, unknown>;
  at: string;
}

export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unnamed';
}

export const NOTIFY_SERVICES = ['mobile_app_pixel_9', 'mobile_app_ipad', 'persistent_notification', 'notify'];

export class FlowError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super('flow error');
    this.status = status;
    this.body = body;
  }
}

export class MockHA {
  readonly tz: string;
  readonly version = '2026.11.1';
  readonly debounceMs: number;
  entries = new Map<string, ConfigEntry>();
  entities = new Map<string, CalendarEntity>();
  flows = new Map<string, Flow>();
  notifications: NotifyRecord[] = [];
  serviceCalls: { domain: string; service: string; data: unknown }[] = [];
  /** Remote URL fetches performed by the remote_calendar integration (for tests). */
  remoteFetches = 0;
  private busListeners = new Set<(e: BusEvent) => void>();
  private calListeners = new Map<string, Set<() => void>>();
  private lastStates = new Map<string, string>();
  private debounce = new Map<string, { timer: NodeJS.Timeout; pending: boolean }>();

  constructor(opts: { tz: string; debounceMs?: number }) {
    this.tz = opts.tz;
    this.debounceMs = opts.debounceMs ?? 1000;
  }

  // ---- bus ---------------------------------------------------------------
  onBus(fn: (e: BusEvent) => void): () => void {
    this.busListeners.add(fn);
    return () => this.busListeners.delete(fn);
  }
  fire(event_type: string, data: Record<string, unknown>): void {
    const e: BusEvent = { event_type, data, origin: 'LOCAL', time_fired: new Date().toISOString(), context: { id: randomUUID().replace(/-/g, ''), parent_id: null, user_id: null } };
    for (const l of this.busListeners) l(e);
  }

  /** Called by WS calendar/event/subscribe: invoked (debounced) whenever the entity writes state. */
  onCalendarWrite(entity_id: string, fn: () => void): () => void {
    let set = this.calListeners.get(entity_id);
    if (!set) this.calListeners.set(entity_id, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private runListeners(entity_id: string) {
    for (const fn of this.calListeners.get(entity_id) ?? []) fn();
  }

  /** Debouncer(immediate=True, cooldown=1s) like CalendarEntity._event_listener_debouncer. */
  private scheduleListeners(entity_id: string) {
    const d = this.debounce.get(entity_id);
    if (d) {
      d.pending = true;
      return;
    }
    this.runListeners(entity_id);
    const entry = { pending: false, timer: undefined as unknown as NodeJS.Timeout };
    const tick = () => {
      if (entry.pending) {
        entry.pending = false;
        this.runListeners(entity_id);
        entry.timer = setTimeout(tick, this.debounceMs);
      } else {
        this.debounce.delete(entity_id);
      }
    };
    entry.timer = setTimeout(tick, this.debounceMs);
    this.debounce.set(entity_id, entry);
  }

  // ---- states --------------------------------------------------------------
  private currentOrNext(ent: CalendarEntity): Instance | undefined {
    const now = DateTime.now().setZone(this.tz);
    return ent.store.list(now.minus({ days: 1 }), now.plus({ days: 366 })).find((i) => i.end > now);
  }

  stateOf(ent: CalendarEntity) {
    const ev = this.currentOrNext(ent);
    const now = DateTime.now().setZone(this.tz);
    const fmt = (d: DateTime) => d.toFormat('yyyy-MM-dd HH:mm:ss');
    const attributes: Record<string, unknown> = ev
      ? { message: ev.summary, all_day: ev.allDay, start_time: fmt(ev.start), end_time: fmt(ev.end), location: ev.location ?? '', description: ev.description ?? '' }
      : {};
    attributes.friendly_name = ent.name;
    if (ent.supported_features != null) attributes.supported_features = ent.supported_features;
    const ts = new Date().toISOString();
    return {
      entity_id: ent.entity_id,
      state: ev && ev.start <= now && now < ev.end ? 'on' : 'off',
      attributes,
      last_changed: ts,
      last_reported: ts,
      last_updated: ts,
      context: { id: randomUUID().replace(/-/g, ''), parent_id: null, user_id: null },
    };
  }

  states() {
    return [...this.entities.values()].map((e) => this.stateOf(e));
  }

  /** Equivalent of async_write_ha_state() on a calendar entity. */
  writeState(entity_id: string) {
    const ent = this.entities.get(entity_id);
    if (!ent) return;
    const st = this.stateOf(ent);
    const key = JSON.stringify([st.state, st.attributes]);
    const prev = this.lastStates.get(entity_id);
    if (prev !== key) {
      this.lastStates.set(entity_id, key);
      this.fire('state_changed', { entity_id, old_state: prev ? { entity_id } : null, new_state: st });
    }
    this.scheduleListeners(entity_id);
  }

  // ---- entities / entries --------------------------------------------------
  private uniqueEntityId(name: string): string {
    const base = `calendar.${slugify(name)}`;
    let id = base;
    for (let n = 2; this.entities.has(id); n++) id = `${base}_${n}`;
    return id;
  }

  addEntity(e: Omit<CalendarEntity, 'entity_id' | 'store'> & { entity_id?: string }): CalendarEntity {
    const ent: CalendarEntity = { ...e, entity_id: e.entity_id ?? this.uniqueEntityId(e.name), store: new CalendarStore(this.tz) };
    this.entities.set(ent.entity_id, ent);
    this.fire('entity_registry_updated', { action: 'create', entity_id: ent.entity_id });
    return ent;
  }

  createEntry(domain: string, title: string, data: Record<string, unknown>): ConfigEntry {
    const now = Date.now() / 1000;
    const entry: ConfigEntry = { entry_id: randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase(), domain, title, data, created_at: now, modified_at: now };
    this.entries.set(entry.entry_id, entry);
    return entry;
  }

  async setupEntry(entry: ConfigEntry): Promise<CalendarEntity> {
    const name = String(entry.data.calendar_name);
    if (entry.domain === 'local_calendar') {
      const ent = this.addEntity({ entry_id: entry.entry_id, platform: 'local_calendar', name, supported_features: FEATURE_CREATE | FEATURE_DELETE | FEATURE_UPDATE });
      this.writeState(ent.entity_id);
      return ent;
    }
    const ent = this.addEntity({ entry_id: entry.entry_id, platform: 'remote_calendar', name, supported_features: null, remoteUrl: String(entry.data.url) });
    await this.refreshRemote(ent).catch(() => undefined);
    this.writeState(ent.entity_id);
    return ent;
  }

  async refreshRemote(ent: CalendarEntity): Promise<void> {
    if (!ent.remoteUrl) return;
    this.remoteFetches++;
    const res = await fetchRemote(ent.remoteUrl, this.tz);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    loadIcs(res.body, ent.store);
  }

  removeEntry(entry_id: string): boolean {
    const entry = this.entries.get(entry_id);
    if (!entry) return false;
    this.entries.delete(entry_id);
    for (const ent of [...this.entities.values()]) {
      if (ent.entry_id === entry_id) {
        this.entities.delete(ent.entity_id);
        this.lastStates.delete(ent.entity_id);
        this.fire('state_changed', { entity_id: ent.entity_id, old_state: { entity_id: ent.entity_id }, new_state: null });
        this.fire('entity_registry_updated', { action: 'remove', entity_id: ent.entity_id });
      }
    }
    return true;
  }

  entryJson(e: ConfigEntry) {
    return {
      created_at: e.created_at,
      entry_id: e.entry_id,
      domain: e.domain,
      modified_at: e.modified_at,
      title: e.title,
      source: 'user',
      state: 'loaded',
      supports_options: false,
      supports_remove_device: false,
      supports_unload: true,
      supports_reconfigure: e.domain === 'remote_calendar',
      supported_subentry_types: {},
      pref_disable_new_entities: false,
      pref_disable_polling: false,
      disabled_by: null,
      reason: null,
      error_reason_translation_domain: null,
      error_reason_translation_key: null,
      error_reason_translation_placeholders: null,
      num_subentries: 0,
    };
  }

  entityRegistry() {
    return [...this.entities.values()].map((e) => ({
      area_id: null,
      categories: {},
      config_entry_id: e.entry_id,
      config_subentry_id: null,
      created_at: 0,
      device_id: null,
      disabled_by: null,
      entity_category: null,
      entity_id: e.entity_id,
      has_entity_name: true,
      hidden_by: null,
      icon: null,
      id: e.entity_id.replace('.', '_'),
      labels: [],
      modified_at: 0,
      name: null,
      options: {},
      original_name: e.name,
      platform: e.platform,
      translation_key: null,
      unique_id: e.entry_id ?? e.entity_id,
    }));
  }

  // ---- config flows (POST /api/config/config_entries/flow[/{id}]) --------------
  private formJson(flow: Flow, errors: Record<string, string> | null, suggested: Record<string, unknown> = {}) {
    let data_schema: unknown[] = [];
    if (flow.handler === 'local_calendar') {
      data_schema = [
        { name: 'calendar_name', required: true, type: 'string' },
        { name: 'import', optional: true, default: 'create_empty', selector: { select: { options: ['create_empty', 'import_ics_file'], translation_key: 'import', multiple: false, custom_value: false, sort: false } } },
      ];
    } else if (flow.step_id === 'auth') {
      data_schema = [
        { name: 'username', required: true, type: 'string' },
        { name: 'password', required: true, type: 'string' },
      ];
    } else {
      data_schema = [
        { name: 'calendar_name', required: true, type: 'string', ...(suggested.calendar_name ? { description: { suggested_value: suggested.calendar_name } } : {}) },
        { name: 'url', required: true, type: 'string', ...(suggested.url ? { description: { suggested_value: suggested.url } } : {}) },
        { name: 'verify_ssl', required: true, default: true, type: 'boolean' },
      ];
    }
    return { type: 'form', flow_id: flow.flow_id, handler: flow.handler, step_id: flow.step_id, data_schema, errors, description_placeholders: null, last_step: null, preview: null };
  }

  private abort(flow: Flow, reason: string) {
    this.flows.delete(flow.flow_id);
    return { type: 'abort', flow_id: flow.flow_id, handler: flow.handler, reason, description_placeholders: null };
  }

  private createEntryResult(flow: Flow, entry: ConfigEntry) {
    this.flows.delete(flow.flow_id);
    return { type: 'create_entry', flow_id: flow.flow_id, handler: flow.handler, title: entry.title, description: null, description_placeholders: null, result: this.entryJson(entry), version: 1, minor_version: 1, options: {}, subentries: [] };
  }

  startFlow(body: Record<string, unknown>) {
    const handler = body.handler;
    if (typeof handler !== 'string') throw new FlowError(400, { message: "Message format incorrect: required key not provided @ data['handler']" });
    if (handler !== 'local_calendar' && handler !== 'remote_calendar') throw new FlowError(404, { message: 'Invalid handler specified' });
    const flow: Flow = { flow_id: randomUUID().replace(/-/g, '').toUpperCase(), handler, step_id: 'user', data: {} };
    this.flows.set(flow.flow_id, flow);
    return this.formJson(flow, null);
  }

  getFlow(flow_id: string) {
    const flow = this.flows.get(flow_id);
    if (!flow) throw new FlowError(404, { message: 'Invalid flow specified' });
    return this.formJson(flow, null);
  }

  deleteFlow(flow_id: string) {
    if (!this.flows.delete(flow_id)) throw new FlowError(404, { message: 'Invalid flow specified' });
    return { message: 'Flow aborted' };
  }

  async submitFlow(flow_id: string, input: Record<string, unknown>) {
    const flow = this.flows.get(flow_id);
    if (!flow) throw new FlowError(404, { message: 'Invalid flow specified' });
    const required = (keys: string[]) => {
      const errs: Record<string, string> = {};
      for (const k of keys) if (input[k] === undefined || input[k] === null) errs[k] = 'required key not provided';
      if (Object.keys(errs).length) throw new FlowError(400, { errors: errs });
    };
    if (flow.handler === 'local_calendar') {
      required(['calendar_name']);
      if (typeof input.calendar_name !== 'string') throw new FlowError(400, { errors: { calendar_name: 'expected str' } });
      const key = slugify(input.calendar_name);
      if ([...this.entries.values()].some((e) => e.domain === 'local_calendar' && e.data.storage_key === key)) return this.abort(flow, 'already_configured');
      if ((input.import ?? 'create_empty') === 'import_ics_file') {
        return this.abort(flow, 'not_implemented_in_mock');
      }
      const entry = this.createEntry('local_calendar', input.calendar_name, { calendar_name: input.calendar_name, import: input.import ?? 'create_empty', storage_key: key });
      await this.setupEntry(entry);
      return this.createEntryResult(flow, entry);
    }
    // remote_calendar
    if (flow.step_id === 'auth') {
      required(['username', 'password']);
      return this.formJson(flow, { base: 'invalid_auth' });
    }
    required(['calendar_name', 'url']);
    let url = String(input.url);
    if (url.startsWith('webcal://')) url = url.replace('webcal://', 'https://');
    const data = { calendar_name: String(input.calendar_name), url, verify_ssl: input.verify_ssl ?? true };
    if ([...this.entries.values()].some((e) => e.domain === 'remote_calendar' && e.data.calendar_name === data.calendar_name)) return this.abort(flow, 'already_configured');
    if ([...this.entries.values()].some((e) => e.domain === 'remote_calendar' && e.data.url === url)) return this.abort(flow, 'already_configured');
    let res;
    try {
      this.remoteFetches++;
      res = await fetchRemote(url, this.tz);
    } catch (err) {
      const timeout = (err as Error).name === 'TimeoutError';
      return this.formJson(flow, { base: timeout ? 'timeout_connect' : 'cannot_connect' }, data);
    }
    if (res.status === 401 && (res.headers?.['www-authenticate'] ?? '').toLowerCase().includes('basic')) {
      flow.step_id = 'auth';
      flow.data = data;
      return this.formJson(flow, null);
    }
    if (res.status === 403) return this.formJson(flow, { base: 'forbidden' }, data);
    if (res.status >= 400) return this.formJson(flow, { base: 'cannot_connect' }, data);
    try {
      loadIcs(res.body, new CalendarStore(this.tz));
    } catch (err) {
      if (err instanceof InvalidIcs) return this.formJson(flow, { base: 'invalid_ics_file' }, data);
      throw err;
    }
    const entry = this.createEntry('remote_calendar', data.calendar_name, data);
    await this.setupEntry(entry);
    return this.createEntryResult(flow, entry);
  }

  // ---- services ---------------------------------------------------------------
  services() {
    const notify: Record<string, unknown> = {};
    for (const s of NOTIFY_SERVICES) {
      notify[s] = { name: s === 'notify' ? 'Send a notification with notify' : `Send a notification via ${s}`, description: '', fields: { message: { required: true, selector: { text: {} } }, title: { selector: { text: {} } }, data: { selector: { object: {} } } } };
    }
    return [
      { domain: 'homeassistant', services: { update_entity: { name: 'Update entity', description: '', fields: { entity_id: { required: true } } } } },
      { domain: 'calendar', services: { create_event: { name: 'Create event', description: '', fields: {} }, get_events: { name: 'Get events', description: '', fields: {} } } },
      { domain: 'notify', services: notify },
    ];
  }

  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown[]> {
    this.serviceCalls.push({ domain, service, data });
    if (domain === 'notify') {
      if (!NOTIFY_SERVICES.includes(service)) throw new FlowError(400, { message: `Service ${domain}.${service} not found.` });
      if (typeof data.message !== 'string') throw new FlowError(400, { message: "required key not provided @ data['message']" });
      this.notifications.push({ service: `notify.${service}`, data, at: new Date().toISOString() });
      return [];
    }
    if (domain === 'homeassistant' && service === 'update_entity') {
      const ids = ([] as string[]).concat((data.entity_id as string | string[]) ?? []);
      for (const id of ids) {
        const ent = this.entities.get(id);
        if (!ent) continue;
        if (ent.remoteUrl) await this.refreshRemote(ent).catch(() => undefined);
        this.writeState(id);
      }
      return [];
    }
    throw new FlowError(400, { message: `Service ${domain}.${service} not found.` });
  }

  config() {
    return {
      allowlist_external_dirs: [],
      allowlist_external_urls: [],
      components: ['api', 'calendar', 'config', 'http', 'local_calendar', 'notify', 'remote_calendar', 'websocket_api'],
      config_dir: '/config',
      config_source: 'storage',
      country: 'CA',
      currency: 'CAD',
      elevation: 0,
      external_url: null,
      internal_url: null,
      language: 'en',
      latitude: 43.65,
      longitude: -79.38,
      location_name: 'Home',
      radius: 100,
      recovery_mode: false,
      safe_mode: false,
      state: 'RUNNING',
      time_zone: this.tz,
      unit_system: { length: 'km', accumulated_precipitation: 'mm', area: 'm²', mass: 'g', pressure: 'Pa', temperature: '°C', volume: 'L', wind_speed: 'm/s' },
      version: this.version,
      whitelist_external_dirs: [],
    };
  }

  // ---- seed ---------------------------------------------------------------------
  async seed(): Promise<void> {
    const today = DateTime.now().setZone(this.tz).startOf('day');
    const wall = (d: DateTime) => d.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    const fam = await this.setupEntry(this.createEntry('local_calendar', 'Family', { calendar_name: 'Family', import: 'create_empty', storage_key: 'family' }));
    fam.store.add({ summary: 'Swim lessons', allDay: false, start: wall(today.plus({ hours: 17, minutes: 30 })), end: wall(today.plus({ hours: 18, minutes: 15 })), rrule: 'FREQ=WEEKLY;BYDAY=TU,TH', location: 'Community pool' });
    fam.store.add({ summary: 'Dentist', allDay: false, start: wall(today.plus({ days: 1, hours: 10 })), end: wall(today.plus({ days: 1, hours: 11 })), description: 'Bring insurance card' });
    fam.store.add({ summary: 'Grandma visiting', allDay: true, start: today.plus({ days: 3 }).toISODate()!, end: today.plus({ days: 5 }).toISODate()! });
    const work = await this.setupEntry(this.createEntry('local_calendar', 'Work', { calendar_name: 'Work', import: 'create_empty', storage_key: 'work' }));
    work.store.add({ summary: 'Standup', allDay: false, start: wall(today.minus({ days: 14 }).plus({ hours: 9 })), end: wall(today.minus({ days: 14 }).plus({ hours: 9, minutes: 15 })), rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' });
    work.store.add({ summary: 'Project review', allDay: false, start: wall(today.plus({ hours: 14 })), end: wall(today.plus({ hours: 15 })) });
    await this.setupEntry(this.createEntry('remote_calendar', 'Holidays', { calendar_name: 'Holidays', url: 'https://feeds.mock.test/holidays.ics', verify_ssl: true }));
    for (const id of this.entities.keys()) this.writeState(id);
  }
}
