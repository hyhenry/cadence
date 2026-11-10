// Live updates: keeps HA subscriptions per calendar, fans changes out to
// browsers over SSE, and refreshes link (remote_calendar) calendars on a timer.
import type { ServerResponse } from 'node:http';
import type { HaCalendar, HaClient, Logger } from './ha/client.ts';
import type { Subscription } from './ha/ws.ts';
import type { ReminderScheduler } from './reminders/scheduler.ts';
import type { Store } from './store/db.ts';

export class LiveHub {
  private clients = new Set<ServerResponse>();
  private calSubs = new Map<string, Subscription>();
  private stateSub: Subscription | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private rewindow: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;
  calendars: HaCalendar[] = [];
  private readonly ha: HaClient;
  private readonly store: Store;
  private readonly scheduler: ReminderScheduler | null;
  private readonly log: Logger;

  constructor(ha: HaClient, store: Store, scheduler: ReminderScheduler | null, log: Logger) {
    this.ha = ha;
    this.store = store;
    this.scheduler = scheduler;
    this.log = log;
  }

  start() {
    this.ha.socket.on('connected', () => {
      this.broadcast('connection', { connected: true });
      void this.resync(true);
    });
    this.ha.socket.on('disconnected', () => this.broadcast('connection', { connected: false }));
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.write(': ping\n\n');
    }, 20_000);
    this.heartbeat.unref();
    // Re-centre the subscription windows twice a day.
    this.rewindow = setInterval(() => void this.resync(true), 12 * 3600_000);
    this.rewindow.unref();
    this.scheduleRemoteRefresh();
    if (this.ha.socket.connected) void this.resync(true);
  }

  stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.rewindow) clearInterval(this.rewindow);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  addClient(res: ServerResponse) {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
    this.send(res, 'connection', { connected: this.ha.socket.connected });
  }

  private send(res: ServerResponse, type: string, data: unknown) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(type: string, data: unknown = {}) {
    for (const c of this.clients) this.send(c, type, data);
  }

  /** Re-read the calendar list and make the per-calendar subscriptions match it. */
  resync(rewindow = false): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.doResync(rewindow)
      .catch((err) => this.log.warn(`live resync failed: ${(err as Error).message}`))
      .finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async doResync(rewindow: boolean) {
    const before = JSON.stringify(this.calendars);
    this.calendars = await this.ha.listCalendars();
    this.store.ensureMeta(this.calendars.map((c) => c.entity_id));
    if (JSON.stringify(this.calendars) !== before) this.broadcast('calendars');
    if (!this.stateSub) {
      this.stateSub = await this.ha.subscribeEvents('state_changed', (ev) => this.onStateChanged(ev));
    }
    const wanted = new Set(this.calendars.map((c) => c.entity_id));
    for (const [id, sub] of this.calSubs) {
      if (!wanted.has(id) || rewindow) {
        await sub.unsubscribe();
        this.calSubs.delete(id);
      }
    }
    const now = Date.now();
    const start = new Date(now - 24 * 3600_000).toISOString();
    const end = new Date(now + 3 * 24 * 3600_000).toISOString();
    for (const id of wanted) {
      if (this.calSubs.has(id)) continue;
      let first = true;
      try {
        const sub = await this.ha.subscribeCalendar(id, start, end, () => {
          // HA pushes the current events right after subscribing; only later pushes mean "changed".
          if (first) {
            first = false;
            return;
          }
          this.broadcast('events', { entity_id: id });
          this.scheduler?.poke();
        });
        this.calSubs.set(id, sub);
      } catch (err) {
        this.log.warn(`could not subscribe to ${id}: ${(err as Error).message}`);
      }
    }
    this.scheduler?.poke(200);
  }

  private onStateChanged(ev: any) {
    const id: string | undefined = ev?.data?.entity_id;
    if (!id?.startsWith('calendar.')) return;
    const added = ev.data.old_state == null;
    const removed = ev.data.new_state == null;
    const renamed = !added && !removed && ev.data.old_state?.attributes?.friendly_name !== undefined && ev.data.old_state.attributes.friendly_name !== ev.data.new_state?.attributes?.friendly_name;
    if (added || removed || renamed) void this.resync();
  }

  /** Link calendars: HA only polls them daily, so ask for an update on Cadence's own interval. */
  private scheduleRemoteRefresh() {
    const minutes = Math.max(1, Number(this.store.getSettings().refresh_minutes) || 15);
    this.refreshTimer = setTimeout(async () => {
      await this.refreshRemotes().catch(() => undefined);
      this.scheduleRemoteRefresh();
    }, minutes * 60_000);
    this.refreshTimer.unref();
  }

  rescheduleRemoteRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.scheduleRemoteRefresh();
  }

  async refreshRemotes() {
    for (const c of this.calendars.filter((c) => c.platform === 'remote_calendar')) {
      await this.ha.updateEntity(c.entity_id).catch((err) => this.log.warn(`refresh of ${c.entity_id} failed: ${(err as Error).message}`));
    }
  }
}
