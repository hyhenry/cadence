// Cadence-only state in SQLite (node:sqlite): calendar metadata, settings,
// reminder rules and sent-reminder keys. HA stays the source of truth for
// calendars and events.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface ReminderRule {
  offset_minutes: number;
  /** notify.* services; null/empty means "use the default targets from settings". */
  targets?: string[] | null;
}

export interface CalendarMeta {
  entity_id: string;
  color: string | null;
  visible: boolean;
  sort: number | null;
  display_name: string | null;
  default_reminders: ReminderRule[];
  notify_targets: string[] | null;
}

export interface Settings {
  notify_targets: string[];
  refresh_minutes: number;
  default_calendar: string | null;
  week_start: number;
  default_view: string;
  default_duration_minutes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  notify_targets: [],
  refresh_minutes: 15,
  default_calendar: null,
  week_start: 0,
  default_view: 'timeGridWeek',
  default_duration_minutes: 60,
};

export const PALETTE = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16'];

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_meta (
        entity_id TEXT PRIMARY KEY,
        color TEXT,
        visible INTEGER NOT NULL DEFAULT 1,
        sort INTEGER,
        display_name TEXT,
        default_reminders TEXT NOT NULL DEFAULT '[]',
        notify_targets TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_reminders (
        entity_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        recurrence_id TEXT NOT NULL DEFAULT '',
        rules TEXT NOT NULL,
        PRIMARY KEY (entity_id, uid, recurrence_id)
      );
      CREATE TABLE IF NOT EXISTS sent_reminders (key TEXT PRIMARY KEY, sent_at INTEGER NOT NULL);
    `);
  }

  close() {
    this.db.close();
  }

  // ---- settings ----
  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) {
      if (r.key in DEFAULT_SETTINGS) out[r.key] = JSON.parse(r.value);
    }
    return out as unknown as Settings;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const stmt = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(patch)) {
      if (k in DEFAULT_SETTINGS && v !== undefined) stmt.run(k, JSON.stringify(v));
    }
    return this.getSettings();
  }

  // ---- calendar metadata ----
  private rowToMeta(r: any): CalendarMeta {
    return {
      entity_id: r.entity_id,
      color: r.color,
      visible: !!r.visible,
      sort: r.sort,
      display_name: r.display_name,
      default_reminders: JSON.parse(r.default_reminders || '[]'),
      notify_targets: r.notify_targets ? JSON.parse(r.notify_targets) : null,
    };
  }

  allMeta(): Map<string, CalendarMeta> {
    const rows = this.db.prepare('SELECT * FROM calendar_meta').all();
    return new Map(rows.map((r: any) => [r.entity_id, this.rowToMeta(r)]));
  }

  getMeta(entity_id: string): CalendarMeta | null {
    const r = this.db.prepare('SELECT * FROM calendar_meta WHERE entity_id = ?').get(entity_id);
    return r ? this.rowToMeta(r) : null;
  }

  /** Make sure every calendar has metadata (assigning a distinct colour). */
  ensureMeta(entity_ids: string[]): Map<string, CalendarMeta> {
    const all = this.allMeta();
    const used = new Set([...all.values()].map((m) => m.color));
    const insert = this.db.prepare('INSERT OR IGNORE INTO calendar_meta (entity_id, color, visible, sort) VALUES (?, ?, 1, ?)');
    let i = all.size;
    for (const id of entity_ids) {
      if (all.has(id)) continue;
      const color = PALETTE.find((c) => !used.has(c)) ?? PALETTE[i % PALETTE.length];
      used.add(color);
      insert.run(id, color, i++);
    }
    return this.allMeta();
  }

  updateMeta(entity_id: string, patch: Partial<Omit<CalendarMeta, 'entity_id'>>): CalendarMeta {
    this.ensureMeta([entity_id]);
    const cur = this.getMeta(entity_id)!;
    const next = { ...cur, ...patch };
    this.db
      .prepare('UPDATE calendar_meta SET color = ?, visible = ?, sort = ?, display_name = ?, default_reminders = ?, notify_targets = ? WHERE entity_id = ?')
      .run(next.color, next.visible ? 1 : 0, next.sort, next.display_name || null, JSON.stringify(next.default_reminders ?? []), next.notify_targets?.length ? JSON.stringify(next.notify_targets) : null, entity_id);
    return this.getMeta(entity_id)!;
  }

  deleteCalendarData(entity_id: string) {
    this.db.prepare('DELETE FROM calendar_meta WHERE entity_id = ?').run(entity_id);
    this.db.prepare('DELETE FROM event_reminders WHERE entity_id = ?').run(entity_id);
  }

  // ---- per-event reminder rules ----
  /** recurrence_id '' means the whole series (or a non-recurring event). rules=null clears the override. */
  setEventReminders(entity_id: string, uid: string, recurrence_id: string | null, rules: ReminderRule[] | null) {
    const rid = recurrence_id ?? '';
    if (rules === null) {
      this.db.prepare('DELETE FROM event_reminders WHERE entity_id = ? AND uid = ? AND recurrence_id = ?').run(entity_id, uid, rid);
      return;
    }
    this.db
      .prepare('INSERT INTO event_reminders (entity_id, uid, recurrence_id, rules) VALUES (?, ?, ?, ?) ON CONFLICT(entity_id, uid, recurrence_id) DO UPDATE SET rules = excluded.rules')
      .run(entity_id, uid, rid, JSON.stringify(rules));
  }

  /** When an event series is replaced (all instances edited), instance-level overrides no longer apply. */
  clearInstanceReminders(entity_id: string, uid: string) {
    this.db.prepare("DELETE FROM event_reminders WHERE entity_id = ? AND uid = ? AND recurrence_id != ''").run(entity_id, uid);
  }

  deleteEventReminders(entity_id: string, uid: string) {
    this.db.prepare('DELETE FROM event_reminders WHERE entity_id = ? AND uid = ?').run(entity_id, uid);
  }

  moveEventReminders(from: { entity_id: string; uid: string }, to: { entity_id: string; uid: string }) {
    this.db.prepare('UPDATE OR REPLACE event_reminders SET entity_id = ?, uid = ? WHERE entity_id = ? AND uid = ?').run(to.entity_id, to.uid, from.entity_id, from.uid);
  }

  /** Map key `${entity_id}|${uid}|${recurrence_id}` -> rules. */
  allEventReminders(): Map<string, ReminderRule[]> {
    const rows = this.db.prepare('SELECT * FROM event_reminders').all() as any[];
    return new Map(rows.map((r) => [`${r.entity_id}|${r.uid}|${r.recurrence_id}`, JSON.parse(r.rules)]));
  }

  // ---- sent keys (dedupe) ----
  /** Atomically claim a reminder key. Returns false if it was already sent. */
  claimSent(key: string, now = Date.now()): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO sent_reminders (key, sent_at) VALUES (?, ?)').run(key, now);
    return Number(r.changes) > 0;
  }
  releaseSent(key: string) {
    this.db.prepare('DELETE FROM sent_reminders WHERE key = ?').run(key);
  }
  sentKeys(): Set<string> {
    return new Set((this.db.prepare('SELECT key FROM sent_reminders').all() as any[]).map((r) => r.key));
  }
  pruneSent(olderThanMs: number, now = Date.now()) {
    this.db.prepare('DELETE FROM sent_reminders WHERE sent_at < ?').run(now - olderThanMs);
  }
}
