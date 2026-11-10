import { DateTime } from 'luxon';
import { useEffect, useMemo, useState } from 'react';
import { api, type CadenceEvent, type Calendar, type EventInput, type ReminderRule } from '../api/client.ts';
import { Icon, Sheet } from '../components/Sheet.tsx';
import { dateOut, formatRange, inZone, isoOut } from '../util/time.ts';
import { ReminderPicker } from './ReminderPicker.tsx';
import { buildRrule, DAY_CODES, describeRepeat, isComplexRrule, matchPreset, parseRrule, presets, type DayCode, type Repeat } from './rrule.ts';

export interface EditorSeed {
  entity_id: string;
  start: string;
  end: string;
  allDay: boolean;
}

export interface EditorSave {
  entity_id: string;
  event: EventInput;
  /** undefined = unchanged, null = use calendar default, [] = none. */
  reminders: ReminderRule[] | null | undefined;
  /** True when the repeat rule was changed (then "this event only" is not offered). */
  ruleChanged: boolean;
}

interface Props {
  tz: string;
  calendars: Calendar[];
  /** Existing event, or null to create one from `seed`. */
  event: CadenceEvent | null;
  seed?: EditorSeed;
  onClose: () => void;
  onSave: (s: EditorSave) => void;
  onDelete: (e: CadenceEvent) => void;
}

const DAY_LETTERS: Record<DayCode, string> = { MO: 'M', TU: 'T', WE: 'W', TH: 'T', FR: 'F', SA: 'S', SU: 'S' };
const DAY_LABELS: Record<DayCode, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };

export function EventEditor({ tz, calendars, event, seed, onClose, onSave, onDelete }: Props) {
  const cal = calendars.find((c) => c.entity_id === (event?.entity_id ?? seed?.entity_id));
  const readOnly = !!event && (!cal?.can_update || !event.uid);
  const canDelete = !!event && !!cal?.can_delete_events && !!event.uid;
  const writable = calendars.filter((c) => c.can_create);

  const init = useMemo(() => {
    const allDay = event ? event.all_day : !!seed?.allDay;
    const s = inZone(event?.start ?? seed!.start, tz);
    let e = inZone(event?.end ?? seed!.end, tz);
    if (allDay) e = e.minus({ days: 1 }); // HA end dates are exclusive; show the last day
    return { allDay, s, e };
  }, [event, seed, tz]);

  const [summary, setSummary] = useState(event?.summary ?? '');
  const [entityId, setEntityId] = useState(event?.entity_id ?? seed?.entity_id ?? writable[0]?.entity_id ?? '');
  const [allDay, setAllDay] = useState(init.allDay);
  const [startDate, setStartDate] = useState(init.s.toISODate()!);
  const [startTime, setStartTime] = useState(init.allDay ? '09:00' : init.s.toFormat('HH:mm'));
  const [endDate, setEndDate] = useState(init.e.toISODate()!);
  const [endTime, setEndTime] = useState(init.allDay ? '10:00' : init.e.toFormat('HH:mm'));
  const [location, setLocation] = useState(event?.location ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const startDt = useMemo(() => DateTime.fromISO(`${startDate}T${allDay ? '00:00' : startTime}`, { zone: tz }), [startDate, startTime, allDay, tz]);
  const [repeat, setRepeat] = useState<Repeat>(() => parseRrule(event?.rrule, init.s));
  const originalRule = event?.rrule ?? undefined;
  const complexRule = isComplexRrule(originalRule);
  const [repeatTouched, setRepeatTouched] = useState(false);
  const [reminderMode, setReminderMode] = useState<'default' | 'custom'>('default');
  const [reminders, setReminders] = useState<ReminderRule[]>([]);
  const [remindersTouched, setRemindersTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const targetCal = calendars.find((c) => c.entity_id === entityId);
  const calendarDefault = targetCal?.default_reminders ?? [];

  // Load this event's reminders (stored in Cadence, not HA).
  useEffect(() => {
    if (!event?.uid) return;
    let alive = true;
    api
      .eventReminders(event.entity_id, event.uid, event.recurrence_id)
      .then((r) => {
        if (!alive) return;
        const own = r.instance ?? r.series;
        if (own) {
          setReminderMode('custom');
          setReminders(own);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [event]);

  // Keep end after start when the start moves (preserve duration).
  const shiftStart = (date: string, time: string) => {
    const oldS = DateTime.fromISO(`${startDate}T${startTime}`, { zone: tz });
    const oldE = DateTime.fromISO(`${endDate}T${endTime}`, { zone: tz });
    const newS = DateTime.fromISO(`${date}T${time}`, { zone: tz });
    if (oldS.isValid && oldE.isValid && newS.isValid) {
      const ne = newS.plus(oldE.diff(oldS));
      setEndDate(ne.toISODate()!);
      setEndTime(ne.toFormat('HH:mm'));
    }
    setStartDate(date);
    setStartTime(time);
  };

  const buildEvent = (): EventInput | string => {
    if (!summary.trim()) return 'Add a title.';
    let dtstart: string, dtend: string;
    if (allDay) {
      if (endDate < startDate) return 'The end date is before the start date.';
      dtstart = startDate;
      dtend = dateOut(DateTime.fromISO(endDate, { zone: tz }).plus({ days: 1 }));
    } else {
      const s = DateTime.fromISO(`${startDate}T${startTime}`, { zone: tz });
      const e = DateTime.fromISO(`${endDate}T${endTime}`, { zone: tz });
      if (!s.isValid || !e.isValid) return 'Check the start and end.';
      if (e <= s) return 'The event must end after it starts.';
      dtstart = isoOut(s);
      dtend = isoOut(e);
    }
    const ev: EventInput = { summary: summary.trim(), dtstart, dtend };
    if (location.trim()) ev.location = location.trim();
    if (description.trim()) ev.description = description.trim();
    const rule = repeatTouched || !complexRule ? buildRrule(repeat, startDt, allDay) : originalRule;
    if (rule) ev.rrule = rule;
    return ev;
  };

  const save = () => {
    const ev = buildEvent();
    if (typeof ev === 'string') return setError(ev);
    const newRule = ev.rrule ?? undefined;
    onSave({
      entity_id: entityId,
      event: ev,
      reminders: !remindersTouched ? undefined : reminderMode === 'default' ? null : reminders,
      ruleChanged: (newRule ?? '') !== (originalRule ?? ''),
    });
  };

  const saveRemindersOnly = async () => {
    if (!event?.uid) return onClose();
    try {
      await api.setEventReminders(event.entity_id, event.uid, null, reminderMode === 'default' ? null : reminders);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const presetList = presets(startDt.isValid ? startDt : init.s);
  const presetId = repeat.freq ? matchPreset(repeat, startDt) : 'none';

  const reminderBlock = (
    <div className="field">
      <span>Reminders</span>
      <div className="segmented" role="radiogroup" aria-label="Reminder source">
        <button type="button" role="radio" aria-checked={reminderMode === 'default'} className={reminderMode === 'default' ? 'on' : ''} onClick={() => (setReminderMode('default'), setRemindersTouched(true))}>
          Calendar default
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={reminderMode === 'custom'}
          className={reminderMode === 'custom' ? 'on' : ''}
          onClick={() => {
            if (reminderMode !== 'custom' && !reminders.length) setReminders(calendarDefault);
            setReminderMode('custom');
            setRemindersTouched(true);
          }}
        >
          Custom
        </button>
      </div>
      {reminderMode === 'default' ? (
        <small className="muted">{calendarDefault.length ? `Uses ${targetCal?.name}'s default reminders (${calendarDefault.length}).` : `${targetCal?.name ?? 'This calendar'} has no default reminders.`}</small>
      ) : (
        <ReminderPicker
          value={reminders}
          allDay={allDay}
          onChange={(v) => {
            setReminders(v);
            setRemindersTouched(true);
          }}
        />
      )}
    </div>
  );

  if (readOnly && event) {
    const s = inZone(event.start, tz);
    const e = inZone(event.end, tz);
    return (
      <Sheet
        title="Event"
        onClose={onClose}
        action={
          event.uid ? (
            <button type="button" className="btn primary" onClick={saveRemindersOnly}>
              Save
            </button>
          ) : undefined
        }
      >
        <div className="event-summary">
          <span className="dot" style={{ background: cal?.color }} />
          <div>
            <h3>{event.summary || '(no title)'}</h3>
            <div>{formatRange(s, e, event.all_day)}</div>
            {event.rrule && <div className="muted small">{describeRepeat(parseRrule(event.rrule, s), s)}</div>}
            <div className="muted small">{cal?.name}</div>
          </div>
        </div>
        {event.location && <p>{event.location}</p>}
        {event.description && <p className="pre">{event.description}</p>}
        <p className="readonly-note">
          <Icon name="lock" size={16} /> This calendar is read-only. You can still set reminders.
        </p>
        {event.uid && reminderBlock}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </Sheet>
    );
  }

  return (
    <Sheet
      title={event ? 'Edit event' : 'New event'}
      onClose={onClose}
      action={
        <button type="button" className="btn primary" onClick={save}>
          Save
        </button>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input className="title-input" aria-label="Title" placeholder="Add title" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={255} data-autofocus enterKeyHint="done" />

        <label className="field">
          <span>Calendar</span>
          <span className="cal-pick">
            <span className="dot" style={{ background: targetCal?.color }} />
            <select value={entityId} onChange={(e) => setEntityId(e.target.value)} disabled={!!event?.recurrence_id && !!event.rrule} aria-label="Calendar">
              {writable.map((c) => (
                <option key={c.entity_id} value={c.entity_id}>
                  {c.name}
                </option>
              ))}
            </select>
          </span>
        </label>

        <div className="switch-row">
          <label htmlFor="allday">All day</label>
          <input id="allday" className="switch" type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        </div>

        <div className="datetime-row">
          <span className="muted small">Starts</span>
          <input type="date" aria-label="Start date" value={startDate} onChange={(e) => e.target.value && shiftStart(e.target.value, startTime)} required />
          {!allDay && <input type="time" aria-label="Start time" value={startTime} step={300} onChange={(e) => e.target.value && shiftStart(startDate, e.target.value)} required />}
        </div>
        <div className="datetime-row">
          <span className="muted small">Ends</span>
          <input type="date" aria-label="End date" value={endDate} min={startDate} onChange={(e) => e.target.value && setEndDate(e.target.value)} required />
          {!allDay && <input type="time" aria-label="End time" value={endTime} step={300} onChange={(e) => e.target.value && setEndTime(e.target.value)} required />}
        </div>

        <label className="field">
          <span>Repeat</span>
          <select
            aria-label="Repeat"
            value={complexRule && !repeatTouched ? 'complex' : presetId}
            onChange={(e) => {
              setRepeatTouched(true);
              const p = presetList.find((x) => x.id === e.target.value);
              if (p) setRepeat({ ...p.repeat, end: repeat.end });
              else if (e.target.value === 'custom') setRepeat({ ...repeat, freq: repeat.freq ?? 'WEEKLY', byDay: repeat.byDay.length ? repeat.byDay : [] });
            }}
          >
            {complexRule && !repeatTouched && <option value="complex">{describeRepeat(repeat, startDt)} (set elsewhere)</option>}
            {presetList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </label>

        {repeat.freq && (presetId === 'custom' || repeatTouched) && (
          <div className="repeat-detail">
            {presetId === 'custom' && (
              <div className="row-inline">
                <span>Every</span>
                <input type="number" min={1} max={99} aria-label="Repeat interval" value={repeat.interval} onChange={(e) => (setRepeatTouched(true), setRepeat({ ...repeat, interval: Math.max(1, Number(e.target.value) || 1) }))} />
                <select aria-label="Repeat unit" value={repeat.freq} onChange={(e) => (setRepeatTouched(true), setRepeat({ ...repeat, freq: e.target.value as Repeat['freq'] }))}>
                  <option value="DAILY">day{repeat.interval > 1 ? 's' : ''}</option>
                  <option value="WEEKLY">week{repeat.interval > 1 ? 's' : ''}</option>
                  <option value="MONTHLY">month{repeat.interval > 1 ? 's' : ''}</option>
                  <option value="YEARLY">year{repeat.interval > 1 ? 's' : ''}</option>
                </select>
              </div>
            )}
            {presetId === 'custom' && repeat.freq === 'WEEKLY' && (
              <div className="chips weekday-chips" role="group" aria-label="Days of the week">
                {DAY_CODES.map((d) => {
                  const on = repeat.byDay.includes(d) || startDt.weekday - 1 === DAY_CODES.indexOf(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      className={`chip ${on ? 'on' : ''}`}
                      aria-pressed={on}
                      aria-label={DAY_LABELS[d]}
                      onClick={() => {
                        setRepeatTouched(true);
                        setRepeat({ ...repeat, byDay: repeat.byDay.includes(d) ? repeat.byDay.filter((x) => x !== d) : [...repeat.byDay, d] });
                      }}
                    >
                      {DAY_LETTERS[d]}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="row-inline">
              <span>Ends</span>
              <select
                aria-label="Repeat ends"
                value={repeat.end.kind}
                onChange={(e) => {
                  setRepeatTouched(true);
                  const k = e.target.value;
                  setRepeat({ ...repeat, end: k === 'until' ? { kind: 'until', date: startDt.plus({ months: 3 }).toISODate()! } : k === 'count' ? { kind: 'count', count: 10 } : { kind: 'never' } });
                }}
              >
                <option value="never">Never</option>
                <option value="until">On date</option>
                <option value="count">After</option>
              </select>
              {repeat.end.kind === 'until' && <input type="date" aria-label="Repeat until" value={repeat.end.date} min={startDate} onChange={(e) => e.target.value && setRepeat({ ...repeat, end: { kind: 'until', date: e.target.value } })} />}
              {repeat.end.kind === 'count' && (
                <>
                  <input type="number" min={1} max={999} aria-label="Number of times" value={repeat.end.count} onChange={(e) => setRepeat({ ...repeat, end: { kind: 'count', count: Math.max(1, Number(e.target.value) || 1) } })} />
                  <span>times</span>
                </>
              )}
            </div>
            <p className="muted small">{describeRepeat(repeat, startDt)}</p>
          </div>
        )}

        <label className="field">
          <span>Location</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Add location" maxLength={500} />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Add notes" maxLength={5000} />
        </label>

        {reminderBlock}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>

      {canDelete &&
        (confirmDelete && !event!.rrule ? (
          <div className="confirm-box" role="alert">
            <p>Delete this event?</p>
            <div className="row">
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button type="button" className="btn danger" onClick={() => onDelete(event!)}>
                Delete
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn danger-outline block" onClick={() => (event!.rrule ? onDelete(event!) : setConfirmDelete(true))}>
            <Icon name="trash" size={20} /> Delete event
          </button>
        ))}
    </Sheet>
  );
}

export type ScopeAction = 'save' | 'delete' | 'move';

export function ScopeDialog({ action, allowThis, onPick, onCancel }: { action: ScopeAction; allowThis: boolean; onPick: (s: 'this' | 'future' | 'all') => void; onCancel: () => void }) {
  const verb = action === 'delete' ? 'Delete' : action === 'move' ? 'Move' : 'Change';
  return (
    <Sheet title={`${verb} recurring event`} onClose={onCancel} size="small">
      <div className="scope-list" role="group" aria-label="Which events">
        {allowThis && (
          <button type="button" className="btn" onClick={() => onPick('this')} data-autofocus>
            This event
          </button>
        )}
        <button type="button" className="btn" onClick={() => onPick('future')}>
          This and following events
        </button>
        <button type="button" className={`btn ${action === 'delete' ? 'danger-outline' : ''}`} onClick={() => onPick('all')}>
          All events
        </button>
        <button type="button" className="text-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
