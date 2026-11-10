import type { DatesSetArg } from '@fullcalendar/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribeLive, type CadenceEvent, type Calendar, type Info, type Settings } from './api/client.ts';
import { AddCalendarSheet, CalendarSheet } from './calendars/CalendarSheets.tsx';
import { Drawer } from './calendars/Drawer.tsx';
import { Icon } from './components/Sheet.tsx';
import { ToastProvider, useToast } from './components/Toast.tsx';
import { EventEditor, ScopeDialog, type EditorSave, type EditorSeed, type ScopeAction } from './editor/EventEditor.tsx';
import { SettingsSheet } from './settings/SettingsSheet.tsx';
import { dateOut, inZone, isoOut, nextRoundHour } from './util/time.ts';
import { useMedia } from './util/useMedia.ts';
import { CalendarView, eventKey, VIEW_LABELS, type CalendarHandle, type MoveInfo, type ViewName } from './views/CalendarView.tsx';
import { DateTime } from 'luxon';
import type { EventInput } from './api/client.ts';

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

type Overlay = { kind: 'calendar'; calendar: Calendar } | { kind: 'add' } | { kind: 'settings' } | { kind: 'editor'; event: CadenceEvent | null; seed?: EditorSeed } | null;

interface ScopeRequest {
  action: ScopeAction;
  allowThis: boolean;
  run: (scope: 'this' | 'future' | 'all') => void;
  cancel: () => void;
}

// The last view is remembered per device (a phone and a wall tablet usually
// want different views), in this browser's storage.
const VIEW_KEY = 'cadence.lastView';
function lastView(): ViewName | null {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v && v in VIEW_LABELS ? (v as ViewName) : null;
  } catch {
    return null;
  }
}
function rememberView(v: string) {
  try {
    if (v in VIEW_LABELS) localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* storage unavailable (private mode): just don't remember */
  }
}

const isRecurringInstance = (e: CadenceEvent) => !!e.rrule && !!e.recurrence_id;

function Shell() {
  const toast = useToast();
  const [info, setInfo] = useState<Info | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [calendars, setCalendars] = useState<Calendar[] | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [haConnected, setHaConnected] = useState(true);
  const [serverReachable, setServerReachable] = useState(true);
  const [title, setTitle] = useState('');
  const [view, setView] = useState<ViewName | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [scope, setScope] = useState<ScopeRequest | null>(null);
  const cal = useRef<CalendarHandle>(null);
  const wide = useMedia('(min-width: 900px)');
  const phone = useMedia('(max-width: 599px)');

  const loadCalendars = useCallback(async () => {
    try {
      setCalendars(await api.calendars());
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  }, [toast]);

  const boot = useCallback(async () => {
    try {
      const [i, s, c] = await Promise.all([api.info(), api.settings(), api.calendars()]);
      setInfo(i);
      setSettings(s);
      setCalendars(c);
      setHaConnected(i.connected);
      setFatal(null);
      setView((v) => v ?? lastView() ?? (phone && s.default_view === 'timeGridWeek' ? 'timeGrid3Day' : (s.default_view as ViewName)));
    } catch (e) {
      setFatal((e as Error).message);
    }
  }, [phone]);

  useEffect(() => {
    void boot();
  }, [boot]);

  // While Cadence (or HA behind it) is still starting, keep retrying quietly.
  useEffect(() => {
    if (!fatal) return;
    const t = setTimeout(() => void boot(), 3000);
    return () => clearTimeout(t);
  }, [fatal, boot]);

  // Live updates from HA (through the server), plus refetch when the app regains focus.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refetch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void cal.current?.refetch(), 250);
    };
    let lostTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = subscribeLive(
      (e) => {
        if (e.type === 'events') refetch();
        else if (e.type === 'calendars') void loadCalendars();
        else if (e.type === 'connection') {
          setHaConnected(e.connected);
          if (e.connected) refetch();
        }
      },
      (ok) => {
        if (ok) {
          clearTimeout(lostTimer);
          lostTimer = undefined;
          setServerReachable((was) => {
            if (!was) {
              refetch();
              void loadCalendars();
            }
            return true;
          });
        } else {
          // EventSource retries by itself (every ~3 s); only warn if it stays down.
          lostTimer ??= setTimeout(() => setServerReachable(false), 4000);
        }
      },
    );
    const onVis = () => document.visibilityState === 'visible' && (refetch(), void loadCalendars());
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      stop();
      clearTimeout(timer);
      clearTimeout(lostTimer);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [loadCalendars]);

  // Refetch when the set of visible calendars or their colours change.
  const calKey = useMemo(() => (calendars ?? []).map((c) => `${c.entity_id}:${c.visible}:${c.color}`).join(','), [calendars]);
  useEffect(() => {
    cal.current?.refetch();
  }, [calKey]);

  const changeView = (v: ViewName) => {
    setView(v);
    cal.current?.api()?.changeView(v);
  };

  const toggle = async (c: Calendar) => {
    setCalendars((cs) => cs!.map((x) => (x.entity_id === c.entity_id ? { ...x, visible: !x.visible } : x)));
    try {
      await api.updateCalendar(c.entity_id, { visible: !c.visible });
    } catch (e) {
      setCalendars((cs) => cs!.map((x) => (x.entity_id === c.entity_id ? { ...x, visible: c.visible } : x)));
      toast((e as Error).message, { kind: 'error' });
    }
  };

  const onDatesSet = useCallback((arg: DatesSetArg) => {
    setTitle(arg.view.title);
    setView(arg.view.type as ViewName);
    rememberView(arg.view.type);
  }, []);

  const tz = info?.time_zone ?? 'UTC';
  const calsRef = useRef(calendars);
  calsRef.current = calendars;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const defaultCalendar = useCallback((): string | null => {
    const cs = (calsRef.current ?? []).filter((c) => c.can_create);
    const pref = settingsRef.current?.default_calendar;
    return cs.find((c) => c.entity_id === pref)?.entity_id ?? cs.find((c) => c.visible)?.entity_id ?? cs[0]?.entity_id ?? null;
  }, []);

  const refetchSoon = () => setTimeout(() => void cal.current?.refetch(), 50);

  const onEventTap = useCallback((e: CadenceEvent) => setOverlay({ kind: 'editor', event: e }), []);

  const startCreate = useCallback(
    (start: string, end: string, allDay: boolean) => {
      const entity_id = defaultCalendar();
      if (!entity_id) {
        toast('Create a calendar first.', { kind: 'error', action: { label: 'Add calendar', run: () => setOverlay({ kind: 'add' }) } });
        return;
      }
      const minutes = settingsRef.current?.default_duration_minutes ?? 60;
      let s = start;
      let e = end;
      if (allDay) {
        if (!e || e <= s) e = dateOut(DateTime.fromISO(s.slice(0, 10)).plus({ days: 1 }));
        s = s.slice(0, 10);
        e = e.slice(0, 10);
      } else if (!e) {
        const t = inZone(s, tz);
        const slot = t.set({ minute: t.minute < 30 ? 0 : 30, second: 0 });
        s = isoOut(slot);
        e = isoOut(slot.plus({ minutes }));
      }
      setOverlay({ kind: 'editor', event: null, seed: { entity_id, start: s, end: e, allDay } });
    },
    [defaultCalendar, toast, tz],
  );

  const newEventNow = () => {
    const viewDate = cal.current?.api()?.getDate();
    let s = nextRoundHour(tz);
    if (viewDate) {
      const d = DateTime.fromJSDate(viewDate, { zone: 'utc' });
      const day = DateTime.fromObject({ year: d.year, month: d.month, day: d.day }, { zone: tz });
      if (!day.hasSame(s, 'day')) s = day.set({ hour: 9 });
    }
    startCreate(isoOut(s), '', false);
  };

  const fail = (err: unknown, undo?: () => void) => {
    undo?.();
    toast((err as Error).message || 'Home Assistant rejected the change.', { kind: 'error' });
  };

  const askScope = (action: ScopeAction, allowThis: boolean, run: (s: 'this' | 'future' | 'all') => void, cancel: () => void = () => undefined) =>
    setScope({ action, allowThis, run: (s) => (setScope(null), run(s)), cancel: () => (setScope(null), cancel()) });

  const onSave = (original: CadenceEvent | null, save: EditorSave) => {
    setOverlay(null);
    if (!original) {
      const temp: CadenceEvent = { entity_id: save.entity_id, uid: null, recurrence_id: null, rrule: save.event.rrule ?? null, summary: save.event.summary, description: null, location: null, start: save.event.dtstart, end: save.event.dtend, all_day: save.event.dtstart.length === 10 };
      const undo = cal.current?.addTemp(temp);
      api
        .createEvent(save.entity_id, save.event, save.reminders ?? null)
        .then(() => cal.current?.refetch())
        .then(() => undo?.())
        .catch((err) => fail(err, undo));
      return;
    }
    const run = (scopeChoice: 'this' | 'future' | 'all') => {
      const moving = save.entity_id !== original.entity_id;
      const undo = scopeChoice === 'this' || !original.rrule ? cal.current?.patchEvent(eventKey(original), { start: save.event.dtstart, end: save.event.dtend, all_day: save.event.dtstart.length === 10, summary: save.event.summary }) : undefined;
      const event: EventInput = scopeChoice === 'this' ? { ...save.event, rrule: undefined } : save.event;
      api
        .updateEvent({
          entity_id: original.entity_id,
          uid: original.uid!,
          recurrence_id: original.recurrence_id,
          scope: scopeChoice,
          event,
          original_start: original.start,
          target_entity_id: moving ? save.entity_id : undefined,
          reminders: save.reminders,
        })
        .then(() => refetchSoon())
        .catch((err) => fail(err, undo));
    };
    if (isRecurringInstance(original)) askScope('save', !save.ruleChanged && save.entity_id === original.entity_id, run);
    else run('all');
  };

  const onDelete = (e: CadenceEvent) => {
    setOverlay(null);
    const run = (scopeChoice: 'this' | 'future' | 'all') => {
      const undo = scopeChoice === 'this' || !e.rrule ? cal.current?.removeEvent(eventKey(e)) : undefined;
      api
        .deleteEvent({ entity_id: e.entity_id, uid: e.uid!, recurrence_id: e.recurrence_id, scope: scopeChoice })
        .then(() => {
          toast(`Deleted "${e.summary}"`);
          refetchSoon();
        })
        .catch((err) => fail(err, undo));
    };
    if (isRecurringInstance(e)) askScope('delete', true, run);
    else run('all');
  };

  const onMove = useCallback(
    (m: MoveInfo) => {
      const e = m.event;
      const c = calsRef.current?.find((x) => x.entity_id === e.entity_id);
      if (!c?.can_update || !e.uid) return m.revert();
      let dtstart: string, dtend: string;
      if (m.allDay) {
        dtstart = m.start.slice(0, 10);
        dtend = m.end && m.end.slice(0, 10) > dtstart ? m.end.slice(0, 10) : dateOut(DateTime.fromISO(dtstart).plus({ days: 1 }));
      } else {
        dtstart = isoOut(inZone(m.start, tz));
        dtend = m.end && m.end !== m.start ? isoOut(inZone(m.end, tz)) : isoOut(inZone(m.start, tz).plus({ hours: 1 }));
      }
      const base: EventInput = { summary: e.summary, dtstart, dtend };
      if (e.description) base.description = e.description;
      if (e.location) base.location = e.location;
      const run = (scopeChoice: 'this' | 'future' | 'all') => {
        const event = scopeChoice !== 'this' && e.rrule ? { ...base, rrule: e.rrule } : base;
        api
          .updateEvent({ entity_id: e.entity_id, uid: e.uid!, recurrence_id: e.recurrence_id, scope: scopeChoice, event, original_start: e.start })
          .then(() => refetchSoon())
          .catch((err) => fail(err, m.revert));
      };
      if (isRecurringInstance(e)) askScope('move', true, run, m.revert);
      else run('all');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tz],
  );

  const onLoadError = useCallback((m: string) => toast(m, { kind: 'error' }), [toast]);

  // Keyboard shortcuts (ignored while typing or when a sheet is open).
  const overlayOpen = !!overlay || !!scope;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlayOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      const capi = cal.current?.api();
      if (!capi) return;
      const views: Record<string, ViewName> = { m: 'dayGridMonth', w: 'timeGridWeek', '3': 'timeGrid3Day', d: 'timeGridDay', a: 'listAgenda' };
      const k = e.key.toLowerCase();
      if (k === 't') capi.today();
      else if (e.key === 'ArrowLeft' || k === 'k' || k === 'p') capi.prev();
      else if (e.key === 'ArrowRight' || k === 'j') capi.next();
      else if (views[k]) changeView(views[k]);
      else if (k === 'n' || k === 'c') newEventNow();
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (fatal) {
    return (
      <div className="fatal" role="alert">
        <h1>Calendar can't start</h1>
        <p>{fatal}</p>
        <button type="button" className="btn primary" onClick={() => void boot()}>
          Try again
        </button>
      </div>
    );
  }
  if (!info || !settings || !calendars || !view) {
    return (
      <div className="loading" aria-busy="true">
        <Icon name="calendar" size={40} />
        <p>Loading calendars…</p>
      </div>
    );
  }

  return (
    <div className={`app ${wide ? 'wide' : ''}`}>
      <Drawer
        open={drawerOpen || wide}
        docked={wide}
        calendars={calendars}
        info={info}
        onClose={() => setDrawerOpen(false)}
        onToggle={toggle}
        onEdit={(c) => (setDrawerOpen(false), setOverlay({ kind: 'calendar', calendar: c }))}
        onAdd={() => (setDrawerOpen(false), setOverlay({ kind: 'add' }))}
        onSettings={() => (setDrawerOpen(false), setOverlay({ kind: 'settings' }))}
      />
      <div className="main">
        <header className="topbar">
          {!wide && (
            <button type="button" className="icon-btn" aria-label="Calendars and settings" onClick={() => setDrawerOpen(true)}>
              <Icon name="menu" />
            </button>
          )}
          <h1 className="title" aria-live="polite">
            {title}
          </h1>
          <div className="nav">
            <button type="button" className="btn today" onClick={() => cal.current?.api()?.today()}>
              Today
            </button>
            {!phone && (
              <>
                <button type="button" className="icon-btn" aria-label="Previous" onClick={() => cal.current?.api()?.prev()}>
                  <Icon name="left" />
                </button>
                <button type="button" className="icon-btn" aria-label="Next" onClick={() => cal.current?.api()?.next()}>
                  <Icon name="right" />
                </button>
              </>
            )}
            {!wide ? (
              <select className="view-select" aria-label="View" value={view} onChange={(e) => changeView(e.target.value as ViewName)}>
                {(Object.keys(VIEW_LABELS) as ViewName[]).map((v) => (
                  <option key={v} value={v}>
                    {VIEW_LABELS[v]}
                  </option>
                ))}
              </select>
            ) : (
              <div className="segmented views" role="tablist" aria-label="View">
                {(Object.keys(VIEW_LABELS) as ViewName[]).map((v) => (
                  <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => changeView(v)}>
                    {VIEW_LABELS[v]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>
        {!serverReachable && (
          <div className="banner" role="alert">
            Lost connection to the calendar. Retrying…
          </div>
        )}
        {serverReachable && !haConnected && (
          <div className="banner" role="alert">
            Home Assistant is not reachable. Showing the last loaded events; changes will work again once it reconnects.
          </div>
        )}
        {calendars.length > 0 && calendars.every((c) => !c.visible) && (
          <div className="empty-state compact">
            <p>All calendars are hidden.{wide ? ' Tick one in the list to show it.' : ''}</p>
            {!wide && (
              <button type="button" className="btn" onClick={() => setDrawerOpen(true)}>
                Choose calendars
              </button>
            )}
          </div>
        )}
        {calendars.length === 0 && (
          <div className="empty-state">
            <p>You don't have any calendars yet.</p>
            <button type="button" className="btn primary" onClick={() => setOverlay({ kind: 'add' })}>
              <Icon name="plus" size={20} /> Add a calendar
            </button>
          </div>
        )}
        <CalendarView
          ref={cal}
          timeZone={info.time_zone}
          calendars={calendars}
          view={view}
          firstDay={settings.week_start}
          onDatesSet={onDatesSet}
          onEventTap={onEventTap}
          onCreate={startCreate}
          onMove={onMove}
          onLoadError={onLoadError}
        />
      </div>

      {calendars.some((c) => c.can_create) && (
        <button type="button" className="fab" aria-label="New event" onClick={newEventNow}>
          <Icon name="plus" size={30} />
        </button>
      )}
      {overlay?.kind === 'editor' && (
        <EventEditor
          tz={info.time_zone}
          calendars={calendars}
          event={overlay.event}
          seed={overlay.seed}
          onClose={() => {
            setOverlay(null);
            cal.current?.api()?.unselect();
          }}
          onSave={(s) => onSave(overlay.event, s)}
          onDelete={onDelete}
        />
      )}
      {scope && <ScopeDialog action={scope.action} allowThis={scope.allowThis} onPick={scope.run} onCancel={scope.cancel} />}
      {overlay?.kind === 'calendar' && <CalendarSheet calendar={overlay.calendar} onClose={() => setOverlay(null)} onChanged={() => void loadCalendars()} />}
      {overlay?.kind === 'add' && <AddCalendarSheet onClose={() => setOverlay(null)} onAdded={() => void loadCalendars()} remoteAvailable={info.remote_calendar} usedColors={calendars.map((c) => c.color)} />}
      {overlay?.kind === 'settings' && <SettingsSheet info={info} settings={settings} calendars={calendars} onClose={() => setOverlay(null)} onSaved={(s) => {
            if (s.default_view !== settings.default_view && s.default_view in VIEW_LABELS) changeView(s.default_view as ViewName);
            setSettings(s);
          }} />}
    </div>
  );
}
