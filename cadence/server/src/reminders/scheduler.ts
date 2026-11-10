// Reminder scheduler: every few minutes (and whenever calendars or rules
// change) load the next 48 h of events, plan reminders, arm timers, and send
// through notify.*. Sent keys are recorded in SQLite before sending so a
// restart never double-sends.
import type { CadenceEvent } from '../ha/events.ts';
import type { Store } from '../store/db.ts';
import { formatReminder, planReminders, type DueReminder } from './plan.ts';

export interface SchedulerDeps {
  store: Store;
  listCalendars(): Promise<{ entity_id: string; name: string }[]>;
  getEvents(entity_id: string, startIso: string, endIso: string): Promise<CadenceEvent[]>;
  timeZone(): Promise<string>;
  notify(target: string, title: string, message: string): Promise<unknown>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export const HORIZON_MS = 48 * 3600_000;
export const GRACE_MS = 15 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

export class ReminderScheduler {
  private timers = new Map<string, unknown>();
  private interval: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  upcoming: DueReminder[] = [];
  lastError: string | null = null;
  private readonly d: SchedulerDeps;
  private readonly now: () => number;
  private names = new Map<string, string>();
  private tz = 'UTC';

  constructor(deps: SchedulerDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
  }

  start(intervalMs = 5 * 60_000) {
    this.interval = setInterval(() => void this.refresh(), intervalMs);
    this.interval.unref();
    void this.refresh();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    if (this.debounce) clearTimeout(this.debounce);
    for (const t of this.timers.values()) (this.d.clearTimer ?? clearTimeout)(t as NodeJS.Timeout);
    this.timers.clear();
  }

  /** Debounced refresh, used on live calendar changes. */
  poke(ms = 1500) {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), ms);
    this.debounce.unref?.();
  }

  /** Reload events and re-arm timers. Concurrent calls are coalesced. */
  refresh(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.doRefresh()
      .catch((err) => {
        this.lastError = (err as Error).message;
        this.d.log?.warn(`reminder refresh failed: ${this.lastError}`);
      })
      .finally(() => {
        this.running = null;
        if (this.rerun) {
          this.rerun = false;
          void this.refresh();
        }
      });
    return this.running;
  }

  private async doRefresh() {
    const { store } = this.d;
    const now = this.now();
    this.tz = await this.d.timeZone();
    const calendars = await this.d.listCalendars();
    this.names = new Map(calendars.map((c) => [c.entity_id, c.name]));
    const meta = store.ensureMeta(calendars.map((c) => c.entity_id));
    const startIso = new Date(now - GRACE_MS - 24 * 3600_000).toISOString();
    const endIso = new Date(now + HORIZON_MS + 24 * 3600_000).toISOString();
    const events: CadenceEvent[] = [];
    const results = await Promise.allSettled(calendars.map((c) => this.d.getEvents(c.entity_id, startIso, endIso)));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') events.push(...r.value);
      else this.d.log?.warn(`reminders: could not read ${calendars[i].entity_id}`);
    });
    for (const [id, m] of meta) if (m.display_name) this.names.set(id, m.display_name);
    store.pruneSent(14 * 24 * 3600_000, now);
    const settings = store.getSettings();
    const due = planReminders({
      events,
      eventRules: store.allEventReminders(),
      calendarRules: new Map([...meta].map(([id, m]) => [id, m.default_reminders])),
      calendarTargets: new Map([...meta].map(([id, m]) => [id, m.notify_targets])),
      defaultTargets: settings.notify_targets,
      now,
      horizonMs: HORIZON_MS,
      graceMs: GRACE_MS,
      sent: store.sentKeys(),
      timeZone: this.tz,
    });
    this.upcoming = due;
    this.lastError = null;
    this.arm(due);
  }

  private arm(due: DueReminder[]) {
    const setT = this.d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearT = this.d.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));
    const wanted = new Set(due.map((d) => d.key));
    for (const [key, t] of this.timers) {
      if (!wanted.has(key)) {
        clearT(t);
        this.timers.delete(key);
      }
    }
    for (const d of due) {
      if (this.timers.has(d.key)) {
        clearT(this.timers.get(d.key));
      }
      const delay = Math.min(Math.max(0, d.fireAt - this.now()), MAX_TIMER_MS);
      const t = setT(() => {
        this.timers.delete(d.key);
        void this.fire(d);
      }, delay);
      (t as NodeJS.Timeout)?.unref?.();
      this.timers.set(d.key, t);
    }
  }

  /** Send one reminder. Claims the key first so a crash or restart cannot double-send. */
  async fire(d: DueReminder): Promise<boolean> {
    const { store } = this.d;
    if (!store.claimSent(d.key, this.now())) return false;
    const { title, message } = formatReminder(d, this.tz, this.names.get(d.event.entity_id) ?? d.event.entity_id);
    const results = await Promise.allSettled(d.targets.map((t) => this.d.notify(t, title, message)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed === results.length) {
      // Nothing was delivered: release the key so the next refresh can retry within the grace window.
      store.releaseSent(d.key);
      this.d.log?.warn(`reminder for "${d.event.entity_id}" could not be sent to any target`);
      return false;
    }
    if (failed) this.d.log?.warn(`reminder sent, but ${failed} of ${results.length} targets failed`);
    this.upcoming = this.upcoming.filter((u) => u.key !== d.key);
    return true;
  }
}
