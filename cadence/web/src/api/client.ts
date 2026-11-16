// Typed client for the Cadence server. Every URL is relative ("api/...") so
// the app works under the HA Ingress prefix.

export interface ReminderRule {
  offset_minutes: number;
  targets?: string[] | null;
}

export interface Calendar {
  entity_id: string;
  ha_name: string;
  name: string;
  display_name: string | null;
  color: string;
  visible: boolean;
  sort: number;
  platform: string | null;
  kind: 'local' | 'link' | 'other';
  can_create: boolean;
  can_update: boolean;
  can_delete_events: boolean;
  removable: boolean;
  default_reminders: ReminderRule[];
  notify_targets: string[] | null;
}

export interface CadenceEvent {
  entity_id: string;
  uid: string | null;
  recurrence_id: string | null;
  rrule: string | null;
  summary: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string;
  all_day: boolean;
}

export interface EventInput {
  summary: string;
  dtstart: string;
  dtend: string;
  description?: string;
  location?: string;
  rrule?: string;
}

export interface Info {
  version: string;
  mode: 'supervisor' | 'env' | 'mock';
  connected: boolean;
  ha_version: string | null;
  time_zone: string;
  location_name: string | null;
  remote_calendar: boolean | null;
}

export interface Settings {
  notify_targets: string[];
  refresh_minutes: number;
  default_calendar: string | null;
  week_start: number;
  default_view: string;
  default_duration_minutes: number;
}

export type Scope = 'this' | 'future' | 'all';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Waits between retries of a request that HA Ingress turned away with a 401.
 *
 * The Cadence server never answers 401 (it reports HA's own refusals as 502),
 * so a 401 means the request never got past Ingress: the `ingress_session`
 * cookie has lapsed. The HA frontend around the app renews that cookie every
 * 60 s, and right away when its tab becomes visible again. But after 5 minutes
 * hidden it suspends its connection, and a sleeping phone runs no timers, so
 * the session (15 min) can run out. Coming back, the app's own refetch races
 * HA's reconnect and renewal. Retrying, writes included (they never reached
 * Cadence), covers the reconnect and one more keepalive tick: about 75 s.
 */
export const SESSION_RETRY_MS = [1000, 2000, 4000, 8000, 15_000, 15_000, 15_000, 15_000];

export const SESSION_EXPIRED_MESSAGE = 'Your Home Assistant session has ended. Reload the page to continue.';

let sessionExpired = false;
const sessionListeners = new Set<(expired: boolean) => void>();
function setSessionExpired(expired: boolean) {
  if (sessionExpired === expired) return;
  sessionExpired = expired;
  for (const l of sessionListeners) l(expired);
}

/** Called with true when Ingress keeps refusing requests, and false once one gets through again. */
export function onSessionChange(cb: (expired: boolean) => void): () => void {
  sessionListeners.add(cb);
  return () => sessionListeners.delete(cb);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`api/${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'offline', 'The calendar is not reachable. Check your connection.');
    }
    if (res.status !== 401) break;
    // Once given up, later requests fail fast instead of each waiting 75 s.
    if (sessionExpired || attempt >= SESSION_RETRY_MS.length) {
      setSessionExpired(true);
      throw new ApiError(401, 'session_expired', SESSION_EXPIRED_MESSAGE);
    }
    await res.body?.cancel().catch(() => undefined);
    await wait(SESSION_RETRY_MS[attempt]);
  }
  setSessionExpired(false);
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  info: () => call<Info>('GET', 'info'),
  calendars: () => call<{ calendars: Calendar[] }>('GET', 'calendars').then((r) => r.calendars),
  updateCalendar: (entity_id: string, patch: Partial<Pick<Calendar, 'color' | 'visible' | 'sort' | 'display_name' | 'default_reminders' | 'notify_targets'>>) =>
    call<{ meta: unknown }>('PATCH', `calendars/${encodeURIComponent(entity_id)}`, patch),
  createLocalCalendar: (name: string, color?: string) => call<{ calendar?: Calendar; pending?: boolean }>('POST', 'calendars/local', { name, color }),
  checkLink: (url: string) => call<{ url: string; provider: string; changed: boolean; eventCount: number; suggestedName: string | null }>('POST', 'calendars/link/check', { url }),
  addLink: (url: string, name: string, color?: string) => call<{ calendar?: Calendar; pending?: boolean }>('POST', 'calendars/link', { url, name, color }),
  deleteCalendar: (entity_id: string) => call<{ ok: true }>('DELETE', `calendars/${encodeURIComponent(entity_id)}`),
  refreshCalendar: (entity_id: string) => call<{ ok: true }>('POST', `calendars/${encodeURIComponent(entity_id)}/refresh`),

  events: (start: string, end: string, calendars?: string[]) => {
    const q = new URLSearchParams({ start, end });
    if (calendars?.length) q.set('calendars', calendars.join(','));
    return call<{ events: CadenceEvent[]; errors: { entity_id: string; message: string }[] }>('GET', `events?${q}`);
  },
  createEvent: (entity_id: string, event: EventInput, reminders?: ReminderRule[] | null) => call<{ ok: true; uid: string | null }>('POST', 'events', { entity_id, event, reminders }),
  updateEvent: (p: { entity_id: string; uid: string; recurrence_id?: string | null; scope: Scope; event: EventInput; original_start?: string; target_entity_id?: string; reminders?: ReminderRule[] | null }) =>
    call<{ ok: true; uid: string | null; entity_id?: string }>('PUT', 'events', p),
  deleteEvent: (p: { entity_id: string; uid: string; recurrence_id?: string | null; scope: Scope }) => call<{ ok: true }>('POST', 'events/delete', p),

  eventReminders: (entity_id: string, uid: string, recurrence_id?: string | null) => {
    const q = new URLSearchParams({ entity_id, uid });
    if (recurrence_id) q.set('recurrence_id', recurrence_id);
    return call<{ series: ReminderRule[] | null; instance: ReminderRule[] | null; calendar_default: ReminderRule[] }>('GET', `reminders/event?${q}`);
  },
  setEventReminders: (entity_id: string, uid: string, recurrence_id: string | null, rules: ReminderRule[] | null) => call('PUT', 'reminders/event', { entity_id, uid, recurrence_id, rules }),
  upcoming: () => call<{ upcoming: { fire_at: string; offset_minutes: number; entity_id: string; summary: string; start: string; targets: string[] }[]; last_error: string | null }>('GET', 'reminders/upcoming'),

  settings: () => call<{ settings: Settings }>('GET', 'settings').then((r) => r.settings),
  updateSettings: (patch: Partial<Settings>) => call<{ settings: Settings }>('PUT', 'settings', patch).then((r) => r.settings),
  notifyServices: () => call<{ services: { id: string; name: string }[] }>('GET', 'notify/services').then((r) => r.services),
  testNotify: (targets?: string[]) => call<{ sent: string[]; failed: { target: string; message: string }[] }>('POST', 'notify/test', { targets }),
};

export type LiveEvent = { type: 'calendars' } | { type: 'events'; entity_id?: string } | { type: 'connection'; connected: boolean };

/**
 * Server-sent events that keep reconnecting for as long as the app is open.
 *
 * EventSource only retries on its own after a dropped connection. If a
 * reconnect attempt gets a non-stream answer (HA Ingress returns 401/502 while
 * HA or the add-on restarts, or a phone wakes from sleep mid-handshake), it
 * closes for good and never fires `open` again. So when it closes we build a
 * new one ourselves, backing off from 3 s to 30 s, and retry straight away
 * when the page becomes visible or the network comes back.
 */
export function subscribeLive(onEvent: (e: LiveEvent) => void, onStatus?: (ok: boolean) => void): () => void {
  const parse = (ev: MessageEvent) => {
    try {
      return JSON.parse(ev.data);
    } catch {
      return {};
    }
  };
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 3000;
  let stopped = false;

  const connect = () => {
    clearTimeout(retry);
    retry = undefined;
    es?.close();
    const src = new EventSource('api/stream');
    es = src;
    src.addEventListener('calendars', () => onEvent({ type: 'calendars' }));
    src.addEventListener('events', (ev) => onEvent({ type: 'events', entity_id: parse(ev as MessageEvent).entity_id }));
    src.addEventListener('connection', (ev) => onEvent({ type: 'connection', connected: !!parse(ev as MessageEvent).connected }));
    src.onopen = () => {
      delay = 3000;
      setSessionExpired(false); // it got through Ingress
      onStatus?.(true);
    };
    src.onerror = () => {
      if (src !== es) return;
      onStatus?.(false);
      // CONNECTING means the browser is retrying by itself; CLOSED means it gave up.
      if (src.readyState === EventSource.CLOSED && !stopped && retry === undefined) {
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      }
    };
  };

  const nudge = () => {
    if (stopped || document.visibilityState !== 'visible') return;
    if (es && es.readyState !== EventSource.CLOSED) return;
    delay = 3000;
    connect();
  };

  connect();
  document.addEventListener('visibilitychange', nudge);
  window.addEventListener('online', nudge);
  return () => {
    stopped = true;
    clearTimeout(retry);
    es?.close();
    document.removeEventListener('visibilitychange', nudge);
    window.removeEventListener('online', nudge);
  };
}
