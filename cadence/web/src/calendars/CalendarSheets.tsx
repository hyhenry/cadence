import { useEffect, useState } from 'react';
import { api, ApiError, type Calendar } from '../api/client.ts';
import { Icon, Sheet } from '../components/Sheet.tsx';
import { useToast } from '../components/Toast.tsx';
import { ReminderPicker } from '../editor/ReminderPicker.tsx';

export const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#64748b', '#a16207'];

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Colour">
      {COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} className={`swatch ${value === c ? 'on' : ''}`} style={{ background: c }} onClick={() => onChange(c)}>
          {value === c && <Icon name="check" size={18} />}
        </button>
      ))}
    </div>
  );
}

export function CalendarSheet({ calendar, onClose, onChanged }: { calendar: Calendar; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(calendar.display_name ?? '');
  const [color, setColor] = useState(calendar.color);
  const [reminders, setReminders] = useState(calendar.default_reminders);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.updateCalendar(calendar.entity_id, { display_name: name.trim() || null, color, default_reminders: reminders });
      onChanged();
      onClose();
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteCalendar(calendar.entity_id);
      toast(`Removed ${calendar.name}`);
      onChanged();
      onClose();
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={calendar.name}
      onClose={onClose}
      action={
        <button type="button" className="btn primary" disabled={busy} onClick={save}>
          Save
        </button>
      }
    >
      <label className="field">
        <span>Display name</span>
        <input value={name} placeholder={calendar.ha_name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        <small className="muted">Only changes the name shown here. In Home Assistant it stays “{calendar.ha_name}”.</small>
      </label>
      <div className="field">
        <span>Colour</span>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      <div className="field">
        <span>Default reminders</span>
        <ReminderPicker value={reminders} onChange={setReminders} label="Default reminders" />
        <small className="muted">Used for every event in this calendar unless the event has its own reminders.</small>
      </div>
      <dl className="facts">
        <dt>Entity</dt>
        <dd>
          <code>{calendar.entity_id}</code>
        </dd>
        <dt>Type</dt>
        <dd>{calendar.kind === 'local' ? 'Local calendar' : calendar.kind === 'link' ? 'Subscribed by link (read-only)' : `From ${calendar.platform ?? 'another integration'}${calendar.can_create ? '' : ' (read-only)'}`}</dd>
      </dl>
      {calendar.kind === 'link' && (
        <button
          type="button"
          className="btn block"
          onClick={() =>
            api
              .refreshCalendar(calendar.entity_id)
              .then(() => toast('Refreshing…'))
              .catch((e) => toast(e.message, { kind: 'error' }))
          }
        >
          <Icon name="refresh" size={20} /> Refresh now
        </button>
      )}
      {calendar.removable &&
        (confirm ? (
          <div className="confirm-box" role="alert">
            <p>
              {calendar.kind === 'local' ? (
                <>
                  Delete <b>{calendar.name}</b> and all its events from Home Assistant? This cannot be undone.
                </>
              ) : (
                <>
                  Unsubscribe from <b>{calendar.name}</b>? It is removed from Home Assistant.
                </>
              )}
            </p>
            <div className="row">
              <button type="button" className="btn" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={remove}>
                {calendar.kind === 'local' ? 'Delete calendar' : 'Unsubscribe'}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn danger-outline block" onClick={() => setConfirm(true)}>
            <Icon name="trash" size={20} /> {calendar.kind === 'local' ? 'Delete calendar' : 'Unsubscribe'}
          </button>
        ))}
      {!calendar.removable && <p className="muted small">This calendar is managed by another integration. Remove it in Home Assistant → Settings → Devices &amp; services.</p>}
    </Sheet>
  );
}

export function AddCalendarSheet({ onClose, onAdded, remoteAvailable, usedColors }: { onClose: () => void; onAdded: (c?: Calendar) => void; remoteAvailable: boolean | null; usedColors: string[] }) {
  const toast = useToast();
  const [tab, setTab] = useState<'new' | 'link'>('new');
  const [name, setName] = useState('');
  const [color, setColor] = useState(() => COLORS.find((c) => !usedColors.includes(c)) ?? COLORS[0]);
  const [url, setUrl] = useState('');
  const [check, setCheck] = useState<Awaited<ReturnType<typeof api.checkLink>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCheck(null);
    setError(null);
  }, [url]);

  const showError = (e: unknown) => {
    setError(e instanceof ApiError ? e.message : 'Could not add the calendar.');
  };

  const createLocal = async () => {
    if (!name.trim()) return setError('Give the calendar a name.');
    setBusy(true);
    setError(null);
    try {
      const r = await api.createLocalCalendar(name.trim(), color);
      toast(r.pending ? 'Calendar created; it will appear in a moment.' : `Created ${name.trim()}`);
      onAdded(r.calendar);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runCheck = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.checkLink(url);
      setCheck(r);
      if (!name.trim() && r.suggestedName) setName(r.suggestedName);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const addLink = async () => {
    if (!name.trim()) return setError('Give the calendar a name.');
    setBusy(true);
    setError(null);
    try {
      const r = await api.addLink(url, name.trim(), color);
      toast(`Subscribed to ${name.trim()}`);
      onAdded(r.calendar);
      onClose();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const providerName = (p: string) => ({ google: 'Google Calendar', outlook: 'Outlook', icloud: 'iCloud', ical: 'iCalendar feed' })[p] ?? p;

  return (
    <Sheet title="Add calendar" onClose={onClose}>
      <div className="segmented" role="tablist" aria-label="Kind of calendar">
        <button type="button" role="tab" aria-selected={tab === 'new'} className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>
          New calendar
        </button>
        <button type="button" role="tab" aria-selected={tab === 'link'} className={tab === 'link' ? 'on' : ''} onClick={() => setTab('link')}>
          <Icon name="link" size={18} /> From a link
        </button>
      </div>
      {tab === 'new' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void createLocal();
          }}
        >
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kids" maxLength={100} data-autofocus />
          </label>
          <div className="field">
            <span>Colour</span>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          <p className="muted small">Creates a Local Calendar in Home Assistant, so you can use it in automations and dashboards too.</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn primary block" disabled={busy}>
            {busy ? 'Creating…' : 'Create calendar'}
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void (check ? addLink() : runCheck());
          }}
        >
          {remoteAvailable === false && (
            <p className="error" role="alert">
              Link calendars need Home Assistant 2025.4 or newer (the Remote Calendar integration).
            </p>
          )}
          <label className="field">
            <span>Calendar link</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a Google, Outlook or iCal link" inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} data-autofocus />
            <small className="muted">Paste an iCal link, e.g. Google's “Secret address in iCal format” (Settings → the calendar → Integrate calendar) or an Outlook ICS link.</small>
          </label>
          {check && (
            <div className="check-ok" role="status">
              <Icon name="check" size={18} /> {providerName(check.provider)} · {check.eventCount} event{check.eventCount === 1 ? '' : 's'} found
            </div>
          )}
          {check && (
            <>
              <label className="field">
                <span>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
              </label>
              <div className="field">
                <span>Colour</span>
                <ColorPicker value={color} onChange={setColor} />
              </div>
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn primary block" disabled={busy || !url.trim() || remoteAvailable === false}>
            {busy ? 'Checking…' : check ? 'Subscribe' : 'Check link'}
          </button>
        </form>
      )}
    </Sheet>
  );
}
