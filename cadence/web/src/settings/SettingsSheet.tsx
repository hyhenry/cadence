import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import { api, type Calendar, type Info, type Settings } from '../api/client.ts';
import { Icon, Sheet } from '../components/Sheet.tsx';
import { useToast } from '../components/Toast.tsx';
import { offsetLabel } from '../editor/ReminderPicker.tsx';
import { VIEW_LABELS, type ViewName } from '../views/CalendarView.tsx';

interface Props {
  info: Info | null;
  settings: Settings;
  calendars: Calendar[];
  onClose: () => void;
  onSaved: (s: Settings) => void;
}

export function SettingsSheet({ info, settings, calendars, onClose, onSaved }: Props) {
  const toast = useToast();
  const [services, setServices] = useState<{ id: string; name: string }[] | null>(null);
  const [draft, setDraft] = useState<Settings>(settings);
  const [upcoming, setUpcoming] = useState<Awaited<ReturnType<typeof api.upcoming>> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .notifyServices()
      .then(setServices)
      .catch(() => setServices([]));
    api
      .upcoming()
      .then(setUpcoming)
      .catch(() => undefined);
  }, []);

  const toggleTarget = (id: string) => setDraft((d) => ({ ...d, notify_targets: d.notify_targets.includes(id) ? d.notify_targets.filter((t) => t !== id) : [...d.notify_targets, id] }));

  const save = async () => {
    setBusy(true);
    try {
      const s = await api.updateSettings(draft);
      onSaved(s);
      toast('Settings saved');
      onClose();
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    try {
      if (!draft.notify_targets.length) return toast('Choose at least one device first.', { kind: 'error' });
      const r = await api.testNotify(draft.notify_targets);
      if (r.failed.length) toast(`Could not send to ${r.failed.map((f) => f.target).join(', ')}`, { kind: 'error' });
      else toast(`Test sent to ${r.sent.length} device${r.sent.length === 1 ? '' : 's'}`);
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  };

  const tz = info?.time_zone ?? 'UTC';
  const calName = (id: string) => calendars.find((c) => c.entity_id === id)?.name ?? id;
  const writable = calendars.filter((c) => c.can_create);

  return (
    <Sheet
      title="Settings"
      onClose={onClose}
      action={
        <button type="button" className="btn primary" disabled={busy} onClick={save}>
          Save
        </button>
      }
    >
      <section className="settings-section">
        <h3>
          <Icon name="bell" size={20} /> Reminder notifications
        </h3>
        <p className="muted small">Reminders are sent through these Home Assistant notify services.</p>
        {services === null ? (
          <p className="muted">Loading…</p>
        ) : services.length === 0 ? (
          <p className="muted">No notify services found in Home Assistant. Install the Home Assistant Companion app on your phone to get one.</p>
        ) : (
          <ul className="check-list">
            {services.map((s) => (
              <li key={s.id}>
                <label>
                  <input type="checkbox" checked={draft.notify_targets.includes(s.id)} onChange={() => toggleTarget(s.id)} />
                  <span>
                    <code>{s.id}</code>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="btn" onClick={test}>
          Send test notification
        </button>
        {upcoming && (
          <details className="upcoming">
            <summary>Upcoming reminders ({upcoming.upcoming.length})</summary>
            {upcoming.last_error && <p className="error">{upcoming.last_error}</p>}
            {upcoming.upcoming.length === 0 ? (
              <p className="muted small">None in the next 48 hours.</p>
            ) : (
              <ul className="plain">
                {upcoming.upcoming.map((u) => (
                  <li key={`${u.entity_id}${u.start}${u.offset_minutes}${u.summary}`}>
                    <b>{DateTime.fromISO(u.fire_at).setZone(tz).toFormat('ccc HH:mm')}</b> {u.summary} <span className="muted">({offsetLabel(u.offset_minutes)}, {calName(u.entity_id)})</span>
                  </li>
                ))}
              </ul>
            )}
          </details>
        )}
      </section>

      <section className="settings-section">
        <h3>Calendar</h3>
        <label className="field">
          <span>Default view</span>
          <select value={draft.default_view} onChange={(e) => setDraft({ ...draft, default_view: e.target.value })}>
            {(Object.keys(VIEW_LABELS) as ViewName[]).map((v) => (
              <option key={v} value={v}>
                {VIEW_LABELS[v]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Week starts on</span>
          <select value={draft.week_start} onChange={(e) => setDraft({ ...draft, week_start: Number(e.target.value) })}>
            <option value={0}>Sunday</option>
            <option value={1}>Monday</option>
            <option value={6}>Saturday</option>
          </select>
        </label>
        <label className="field">
          <span>New events go to</span>
          <select value={draft.default_calendar ?? ''} onChange={(e) => setDraft({ ...draft, default_calendar: e.target.value || null })}>
            <option value="">First calendar</option>
            {writable.map((c) => (
              <option key={c.entity_id} value={c.entity_id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Default event length</span>
          <select value={draft.default_duration_minutes} onChange={(e) => setDraft({ ...draft, default_duration_minutes: Number(e.target.value) })}>
            {[15, 30, 45, 60, 90, 120].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Refresh link calendars every</span>
          <select value={draft.refresh_minutes} onChange={(e) => setDraft({ ...draft, refresh_minutes: Number(e.target.value) })}>
            {[5, 15, 30, 60, 180, 720].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="settings-section">
        <h3>About</h3>
        <dl className="facts">
          <dt>Version</dt>
          <dd>{info?.version}</dd>
          <dt>Home Assistant</dt>
          <dd>{info ? (info.mode === 'mock' ? 'Mock (development)' : info.ha_version) : '—'}</dd>
          <dt>Time zone</dt>
          <dd>{tz}</dd>
        </dl>
        <p className="muted small">
          Keyboard: <kbd>T</kbd> today, <kbd>←</kbd>/<kbd>→</kbd> previous/next, <kbd>M</kbd>/<kbd>W</kbd>/<kbd>D</kbd>/<kbd>A</kbd> views, <kbd>N</kbd> new event, <kbd>Esc</kbd> close.
        </p>
      </section>
    </Sheet>
  );
}
