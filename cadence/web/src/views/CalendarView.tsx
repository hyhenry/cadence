// FullCalendar (MIT plugins) as the grid engine, restyled, with swipe
// navigation and live refetching on top. Times are shown in the HA time zone.
import type { DateSelectArg, EventClickArg, EventDropArg, EventInput, DatesSetArg } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin, { type DateClickArg, type EventResizeDoneArg } from '@fullcalendar/interaction';
import listPlugin from '@fullcalendar/list';
import luxonPlugin from '@fullcalendar/luxon3';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { api, type CadenceEvent, type Calendar } from '../api/client.ts';
import { textOn } from '../util/color.ts';

export type ViewName = 'dayGridMonth' | 'timeGridWeek' | 'timeGrid3Day' | 'timeGridDay' | 'listAgenda';

export const VIEW_LABELS: Record<ViewName, string> = {
  dayGridMonth: 'Month',
  timeGridWeek: 'Week',
  timeGrid3Day: '3 days',
  timeGridDay: 'Day',
  listAgenda: 'Agenda',
};

export interface CalendarHandle {
  api(): import('@fullcalendar/core').CalendarApi | undefined;
  /** Refetch events; resolves when FullCalendar has finished loading them. */
  refetch(): Promise<void>;
  /** Replace one event in place (optimistic update). Returns a function that undoes it. */
  patchEvent(id: string, change: Partial<CadenceEvent>): () => void;
  addTemp(e: CadenceEvent): () => void;
  removeEvent(id: string): () => void;
}

export interface MoveInfo {
  event: CadenceEvent;
  start: string;
  end: string;
  allDay: boolean;
  revert: () => void;
}

interface Props {
  timeZone: string;
  calendars: Calendar[];
  view: ViewName;
  firstDay: number;
  onDatesSet: (arg: DatesSetArg) => void;
  onEventTap: (e: CadenceEvent) => void;
  onCreate: (start: string, end: string, allDay: boolean) => void;
  onMove: (m: MoveInfo) => void;
  onLoadError: (message: string) => void;
}

/** How long a finger must rest before a touch creates or picks up an event. */
const HOLD_MS = 500;
/** How far a finger may wander before the touch counts as a swipe or scroll. */
const SLOP = 10;
const CACHE_MS = 5 * 60_000;

interface Gesture {
  x0: number;
  y0: number;
  lastX: number;
  lastT: number;
  /** Horizontal offset the view is dragged by (swipe only). */
  dx: number;
  /** Horizontal finger speed in px/ms. */
  vx: number;
  mode: 'pending' | 'press' | 'swipe' | 'scroll';
  timer: number;
  raf: number;
  harness?: HTMLElement;
  width: number;
  /** Distance that moves the view by one increment. */
  step: number;
  maxSteps: number;
  fade: boolean;
  /** Navigate by days (3-day view) rather than with next()/prev(). */
  byDays: boolean;
}

const isTouch = (e: Event | undefined | null) => !!e && e.type.startsWith('touch');

export function eventKey(e: Pick<CadenceEvent, 'entity_id' | 'uid' | 'recurrence_id' | 'start' | 'summary'>): string {
  return `${e.entity_id}|${e.uid ?? e.summary}|${e.recurrence_id ?? ''}|${e.start}`;
}

/** Add one day to an all-day end that FullCalendar would otherwise treat as exclusive already. */
function toFc(e: CadenceEvent, cal: Calendar | undefined): EventInput {
  const editable = !!cal?.can_update && !!e.uid;
  return {
    id: eventKey(e),
    title: e.summary || '(no title)',
    start: e.start,
    end: e.end,
    allDay: e.all_day,
    backgroundColor: cal?.color,
    borderColor: cal?.color,
    textColor: cal ? textOn(cal.color) : undefined,
    editable,
    startEditable: editable,
    durationEditable: editable,
    classNames: [editable ? 'ev-editable' : 'ev-readonly', e.rrule ? 'ev-recurring' : ''],
    extendedProps: { cadence: e },
  };
}

export const CalendarView = forwardRef<CalendarHandle, Props>(function CalendarView(props, ref) {
  const fc = useRef<FullCalendar>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const dragging = useRef(false);
  const waiters = useRef<(() => void)[]>([]);
  const deferred = useRef(false);
  /** A finger (or mouse button) is down on an event: it may be about to become a drag. */
  const pressing = useRef(false);
  // A refetch re-renders events; doing that under a finger (during the long-press
  // or mid-drag) leaves FullCalendar dragging a stale element. Defer it.
  const doRefetch = () => {
    const capi = fc.current?.getApi();
    if (!capi) return;
    dropCache();
    if (dragging.current || pressing.current) deferred.current = true;
    else capi.refetchEvents();
  };
  const flushDeferred = () => {
    if (dragging.current || pressing.current || !deferred.current) return;
    deferred.current = false;
    dropCache();
    fc.current?.getApi().refetchEvents();
  };
  /** Drop FullCalendar's touch "selected event" (armed to drag without a long press). */
  const unselectEvent = () => (fc.current?.getApi() as unknown as { dispatch?: (a: { type: string }) => void } | undefined)?.dispatch?.({ type: 'UNSELECT_EVENT' });
  const dragEnded = () =>
    setTimeout(() => {
      dragging.current = false;
      flushDeferred();
    }, 50);
  const pressStart = (target: EventTarget | null) => {
    if ((target as Element | null)?.closest?.('.fc-event')) pressing.current = true;
  };
  const pressEnd = () => {
    if (!pressing.current) return;
    pressing.current = false;
    setTimeout(flushDeferred, 400);
  };
  const wrapRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  /** Swallow the click a browser may send at the end of a swipe. */
  const suppressClickUntil = useRef(0);

  const visibleIds = useMemo(() => props.calendars.filter((c) => c.visible).map((c) => c.entity_id), [props.calendars]);
  const visibleRef = useRef(visibleIds);
  visibleRef.current = visibleIds;

  // Events for a window around what is on screen, so swiping to the next or
  // previous period shows its events straight away. Dropped on every refetch.
  const cache = useRef<{ key: string; start: number; end: number; at: number; events: CadenceEvent[] } | null>(null);
  const cacheGen = useRef(0);
  const dropCache = () => {
    cacheGen.current++;
    cache.current = null;
  };

  const fetchEvents = useCallback((info: { startStr: string; endStr: string }, success: (e: EventInput[]) => void, failure: (e: Error) => void) => {
    const ids = visibleRef.current;
    if (!ids.length) return success([]);
    const toInputs = (evs: CadenceEvent[]) => {
      const byId = new Map(propsRef.current.calendars.map((c) => [c.entity_id, c]));
      return evs.map((e) => toFc(e, byId.get(e.entity_id)));
    };
    const key = ids.join(',');
    const s = Date.parse(info.startStr);
    const e = Date.parse(info.endStr);
    const c = cache.current;
    if (c && c.key === key && s >= c.start && e <= c.end && Date.now() - c.at < CACHE_MS) return success(toInputs(c.events));
    // Fetch one extra period on each side.
    const span = e - s;
    const from = s - span;
    const to = e + span;
    const gen = cacheGen.current;
    api
      .events(new Date(from).toISOString(), new Date(to).toISOString(), ids)
      .then((r) => {
        if (r.errors.length) {
          const byId = new Map(propsRef.current.calendars.map((c) => [c.entity_id, c]));
          const names = r.errors.map((e) => byId.get(e.entity_id)?.name ?? e.entity_id).join(', ');
          propsRef.current.onLoadError(`Could not load ${names}.`);
        } else if (gen === cacheGen.current) {
          cache.current = { key, start: from, end: to, at: Date.now(), events: r.events };
        }
        success(toInputs(r.events));
      })
      .catch((err: Error) => {
        propsRef.current.onLoadError(err.message);
        failure(err);
      });
  }, []);

  useImperativeHandle(ref, () => ({
    api: () => fc.current?.getApi(),
    refetch: () =>
      new Promise<void>((resolve) => {
        const capi = fc.current?.getApi();
        if (!capi) return resolve();
        waiters.current.push(resolve);
        doRefetch();
        setTimeout(resolve, 5000); // never hang
      }),
    patchEvent(id, change) {
      const ev = fc.current?.getApi().getEventById(id);
      if (!ev) return () => undefined;
      const before = { start: ev.startStr, end: ev.endStr, allDay: ev.allDay, title: ev.title };
      if (change.start || change.end) ev.setDates(change.start ?? ev.startStr, change.end ?? ev.endStr, { allDay: change.all_day ?? ev.allDay });
      if (change.summary !== undefined) ev.setProp('title', change.summary);
      return () => {
        ev.setDates(before.start, before.end || null, { allDay: before.allDay });
        ev.setProp('title', before.title);
      };
    },
    addTemp(e) {
      const cal = propsRef.current.calendars.find((c) => c.entity_id === e.entity_id);
      const added = fc.current?.getApi().addEvent({ ...toFc(e, cal), editable: false, classNames: ['ev-pending'] });
      return () => added?.remove();
    },
    removeEvent(id) {
      const ev = fc.current?.getApi().getEventById(id);
      if (!ev) return () => undefined;
      const data = { ...ev.toPlainObject({ collapseExtendedProps: false }), backgroundColor: ev.backgroundColor, borderColor: ev.borderColor };
      ev.remove();
      return () => {
        fc.current?.getApi().addEvent(data as EventInput);
      };
    },
  }));

  const onMove = (arg: EventDropArg | EventResizeDoneArg) => {
    const e = arg.event.extendedProps.cadence as CadenceEvent;
    // Once moved, the event should need a fresh long press before it moves again.
    setTimeout(unselectEvent, 0);
    propsRef.current.onMove({ event: e, start: arg.event.startStr, end: arg.event.endStr || arg.event.startStr, allDay: arg.event.allDay, revert: arg.revert });
  };

  // Touch gestures. Every touch starts "pending". Holding still for HOLD_MS makes
  // it a press, which FullCalendar turns into a selection (create) or an event
  // drag. Moving first makes it a swipe (horizontal, follows the finger and
  // changes the period) or a scroll, and FullCalendar's pending press is
  // cancelled. FullCalendar only cancels it on a real scroll, so a slow
  // sideways swipe used to pick up events and open the editor.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    // FullCalendar drops a pending long press, and won't fire dateClick, when
    // it sees a scroll event during the touch. Tell it the touch is not a press.
    const cancelFcPress = () => window.dispatchEvent(new Event('scroll'));

    const frame = (g: Gesture) => {
      g.raf = 0;
      if (!g.harness) return;
      const fade = g.fade ? 1 - Math.min(0.5, (Math.abs(g.dx) / g.width) * 0.6) : 1;
      g.harness.style.transform = `translate3d(${g.dx}px,0,0)`;
      g.harness.style.opacity = String(fade);
    };

    const beginSwipe = (g: Gesture) => {
      const capi = fc.current?.getApi();
      const harness = wrap.querySelector<HTMLElement>('.fc-view-harness');
      if (!capi || !harness) return;
      capi.unselect();
      const width = harness.clientWidth || 1;
      const type = capi.view.type;
      g.harness = harness;
      g.width = width;
      g.step = width;
      g.maxSteps = 1;
      g.fade = true;
      g.byDays = false;
      if (type === 'timeGrid3Day') {
        // Moves a day at a time: slide by one day column, and keep it seamless.
        const col = harness.querySelector<HTMLElement>('.fc-timegrid-col.fc-day');
        g.step = col?.offsetWidth || width / 3;
        g.maxSteps = 3;
        g.fade = false;
        g.byDays = true;
      }
      harness.style.transition = 'none';
      harness.style.willChange = 'transform, opacity';
    };

    const clearHarness = (h: HTMLElement) => {
      h.style.transition = '';
      h.style.transform = '';
      h.style.opacity = '';
      h.style.willChange = '';
    };

    const animate = (h: HTMLElement, transform: string, opacity: string, ms: number, then: () => void) => {
      h.style.transition = `transform ${ms}ms cubic-bezier(0.2, 0.7, 0.3, 1), opacity ${ms}ms ease-out`;
      h.style.transform = transform;
      h.style.opacity = opacity;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        h.removeEventListener('transitionend', finish);
        then();
      };
      h.addEventListener('transitionend', finish);
      setTimeout(finish, ms + 60);
    };

    const endSwipe = (g: Gesture) => {
      if (g.raf) cancelAnimationFrame(g.raf);
      const h = g.harness;
      const capi = fc.current?.getApi();
      if (!h || !capi) return;
      const dist = Math.abs(g.dx);
      const flung = Math.abs(g.vx) > 0.35 && Math.sign(g.vx) === Math.sign(g.dx) && dist > 24;
      const steps = Math.min(g.maxSteps, Math.max(flung ? 1 : 0, Math.round(dist / g.step + (g.byDays ? 0 : 0.15))));
      if (!steps) {
        animate(h, 'translate3d(0,0,0)', '1', 180, () => clearHarness(h));
        return;
      }
      const dir = g.dx < 0 ? 1 : -1; // 1 = forward in time
      const go = () => {
        if (g.byDays) capi.incrementDate({ days: dir * steps });
        else if (dir > 0) capi.next();
        else capi.prev();
        unselectEvent();
      };
      if (reduceMotion?.matches) {
        go();
        clearHarness(h);
        return;
      }
      const target = -dir * steps * g.step;
      // Finish at least as fast as the finger was moving.
      const speed = Math.max(Math.abs(g.vx), 1.2);
      const ms = Math.round(Math.min(220, Math.max(90, Math.abs(target - g.dx) / speed)));
      animate(h, `translate3d(${target}px,0,0)`, g.fade ? '0.4' : '1', ms, () => {
        h.style.transition = 'none';
        go();
        if (g.byDays) {
          // The new range lines up exactly with where the old one stopped.
          clearHarness(h);
          return;
        }
        h.style.transform = `translate3d(${dir * g.width * 0.3}px,0,0)`;
        h.style.opacity = '0.4';
        requestAnimationFrame(() => animate(h, 'translate3d(0,0,0)', '1', 200, () => clearHarness(h)));
      });
    };

    const onStart = (ev: TouchEvent) => {
      pressStart(ev.target);
      const prev = gesture.current;
      if (prev) {
        clearTimeout(prev.timer);
        if (prev.mode === 'swipe') endSwipe({ ...prev, dx: 0, vx: 0 });
      }
      if (ev.touches.length !== 1) {
        // A second finger: not a press, not a swipe.
        if (prev?.mode === 'pending') cancelFcPress();
        gesture.current = null;
        return;
      }
      const t = ev.touches[0];
      const now = performance.now();
      const g: Gesture = {
        x0: t.clientX,
        y0: t.clientY,
        lastX: t.clientX,
        lastT: now,
        dx: 0,
        vx: 0,
        mode: 'pending',
        timer: 0,
        raf: 0,
        width: 1,
        step: 1,
        maxSteps: 1,
        fade: true,
        byDays: false,
      };
      // A little before FullCalendar's own timer, so a move in between is never
      // taken as a swipe while FullCalendar has started a drag.
      g.timer = window.setTimeout(() => {
        if (gesture.current === g && g.mode === 'pending') {
          g.mode = 'press';
          const el = ev.target as Element | null;
          if (!el?.closest?.('.fc-list, .ev-readonly, .fc-col-header, .fc-timegrid-axis')) navigator.vibrate?.(8);
        }
      }, HOLD_MS - 40);
      gesture.current = g;
    };

    const onTouchMove = (ev: TouchEvent) => {
      const g = gesture.current;
      if (!g || ev.touches.length !== 1) return;
      const t = ev.touches[0];
      const dx = t.clientX - g.x0;
      const dy = t.clientY - g.y0;
      const now = performance.now();
      const dt = now - g.lastT;
      if (dt > 0) g.vx = 0.7 * ((t.clientX - g.lastX) / dt) + 0.3 * g.vx;
      g.lastX = t.clientX;
      g.lastT = now;
      if (g.mode === 'pending') {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        clearTimeout(g.timer);
        if (dragging.current) {
          // FullCalendar is already dragging (an event that was selected).
          g.mode = 'press';
          return;
        }
        cancelFcPress();
        unselectEvent();
        g.mode = Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'scroll';
        if (g.mode === 'swipe') {
          beginSwipe(g);
          // Start tracking from here so the content doesn't jump by the slop.
          g.x0 = t.clientX - Math.sign(dx) * SLOP;
        }
      }
      if (g.mode === 'swipe') {
        if (ev.cancelable) ev.preventDefault();
        g.dx = t.clientX - g.x0;
        if (!g.raf) g.raf = requestAnimationFrame(() => frame(g));
      }
    };

    const onEnd = (ev: TouchEvent) => {
      pressEnd();
      const g = gesture.current;
      if (!g || ev.touches.length) return;
      clearTimeout(g.timer);
      gesture.current = null;
      if (g.mode === 'swipe') {
        // Velocity is stale if the finger paused before lifting.
        if (performance.now() - g.lastT > 80) g.vx = 0;
        suppressClickUntil.current = performance.now() + 400;
        endSwipe(g);
      } else if (g.mode === 'press' && !(ev.target as Element | null)?.closest?.('.fc-list')) {
        // A hold is never also a tap: some browsers send a click when the finger
        // lifts, which would open the editor over the resize handles.
        suppressClickUntil.current = performance.now() + 400;
      }
    };

    const onClick = (ev: MouseEvent) => {
      if (performance.now() < suppressClickUntil.current) {
        ev.stopPropagation();
        ev.preventDefault();
      }
    };

    // Capture phase: we see each touch before FullCalendar's own handlers.
    wrap.addEventListener('touchstart', onStart, { capture: true, passive: true });
    wrap.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    wrap.addEventListener('touchend', onEnd, { capture: true, passive: true });
    wrap.addEventListener('touchcancel', onEnd, { capture: true, passive: true });
    wrap.addEventListener('click', onClick, true);
    return () => {
      wrap.removeEventListener('touchstart', onStart, true);
      wrap.removeEventListener('touchmove', onTouchMove, true);
      wrap.removeEventListener('touchend', onEnd, true);
      wrap.removeEventListener('touchcancel', onEnd, true);
      wrap.removeEventListener('click', onClick, true);
    };
    // Everything it reads is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={wrapRef}
      className="calendar-wrap"
      onMouseDown={(e) => pressStart(e.target)}
      onMouseUp={pressEnd}
      data-testid="calendar"
    >
      <FullCalendar
        ref={fc}
        plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, luxonPlugin]}
        timeZone={props.timeZone}
        initialView={props.view}
        headerToolbar={false}
        height="100%"
        firstDay={props.firstDay}
        nowIndicator
        navLinks
        navLinkDayClick={(date) => {
          const capi = fc.current?.getApi();
          capi?.changeView('timeGridDay', date);
        }}
        views={{
          timeGridWeek: { titleFormat: { year: 'numeric', month: 'long' }, dayHeaderFormat: { weekday: 'short', day: 'numeric' } },
          timeGrid3Day: { type: 'timeGrid', duration: { days: 3 }, dateIncrement: { days: 1 }, titleFormat: { year: 'numeric', month: 'long' }, dayHeaderFormat: { weekday: 'short', day: 'numeric' } },
          timeGridDay: { titleFormat: { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }, dayHeaderFormat: { weekday: 'long', day: 'numeric' } },
          listAgenda: { type: 'list', duration: { days: 30 }, dateIncrement: { days: 7 }, titleFormat: { year: 'numeric', month: 'long' }, noEventsContent: 'Nothing scheduled in the next 30 days' },
          dayGridMonth: { dayMaxEvents: true, displayEventTime: false, eventDisplay: 'block', titleFormat: { year: 'numeric', month: 'long' } },
        }}
        eventContent={(arg) => {
          if (arg.view.type.startsWith('timeGrid') && !arg.event.allDay) {
            return (
              <div className="ev-body">
                <div className="ev-title">{arg.event.title}</div>
                <div className="ev-time">{arg.timeText}</div>
              </div>
            );
          }
          return true; // FullCalendar's default rendering
        }}
        events={fetchEvents}
        loading={(isLoading) => {
          // Set directly, not through state: a re-render here would re-render
          // FullCalendar on every fetch. (Tests also wait on it.)
          wrapRef.current?.setAttribute('aria-busy', String(isLoading));
          if (isLoading) return;
          const w = waiters.current;
          waiters.current = [];
          w.forEach((r) => r());
        }}
        lazyFetching
        editable
        selectable
        selectMirror
        unselectAuto
        eventLongPressDelay={HOLD_MS}
        selectLongPressDelay={HOLD_MS}
        longPressDelay={HOLD_MS}
        dragScroll
        slotDuration="00:30:00"
        snapDuration="00:15:00"
        scrollTime="07:00:00"
        scrollTimeReset={false}
        allDayText="All day"
        slotEventOverlap={false}
        eventTimeFormat={{ hour: 'numeric', minute: '2-digit', omitZeroMinute: true, meridiem: 'short' }}
        datesSet={(arg) => propsRef.current.onDatesSet(arg)}
        eventClick={(arg: EventClickArg) => {
          arg.jsEvent.preventDefault();
          propsRef.current.onEventTap(arg.event.extendedProps.cadence as CadenceEvent);
        }}
        dateClick={(arg: DateClickArg) => {
          // On touch, creating takes a long press (see `select`): a tap is too easy
          // to land by accident while scrolling or swiping.
          if (isTouch(arg.jsEvent)) return;
          // Clicking an empty slot creates an event there (month view: on that day).
          if (arg.view.type === 'dayGridMonth') {
            propsRef.current.onCreate(arg.dateStr, arg.dateStr, true);
            return;
          }
          propsRef.current.onCreate(arg.dateStr, '', arg.allDay);
        }}
        select={(arg: DateSelectArg) => {
          const ms = arg.end.getTime() - arg.start.getTime();
          const single = arg.allDay ? ms <= 86_400_000 : ms <= 30 * 60_000;
          if (isTouch(arg.jsEvent) && single) {
            // Long press and let go: a new event of the default length there.
            propsRef.current.onCreate(arg.startStr, arg.allDay ? arg.startStr : '', arg.allDay);
            fc.current?.getApi().unselect();
            return;
          }
          // A plain click also fires `select` for one slot; let dateClick handle that.
          if (!arg.allDay && single) return;
          if (arg.allDay && single && arg.view.type === 'dayGridMonth') return;
          propsRef.current.onCreate(arg.startStr, arg.endStr, arg.allDay);
          fc.current?.getApi().unselect();
        }}
        eventDragStart={() => (dragging.current = true)}
        eventDragStop={dragEnded}
        eventResizeStart={() => (dragging.current = true)}
        eventResizeStop={dragEnded}
        eventDrop={onMove}
        eventResize={onMove}
        eventDidMount={(arg) => {
          const e = arg.event.extendedProps.cadence as CadenceEvent | undefined;
          const cal = propsRef.current.calendars.find((c) => c.entity_id === e?.entity_id);
          arg.el.setAttribute('aria-label', `${arg.event.title}${cal ? `, ${cal.name}` : ''}`);
          if (arg.view.type.startsWith('list') && cal) {
            const dot = arg.el.querySelector<HTMLElement>('.fc-list-event-dot');
            if (dot) dot.style.borderColor = cal.color;
          }
        }}
      />
    </div>
  );
});
