// FullCalendar (MIT plugins) as the grid engine, restyled, with swipe
// navigation and live refetching on top. Times are shown in the HA time zone.
import type { DateSelectArg, EventClickArg, EventDropArg, EventInput, DatesSetArg } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin, { type DateClickArg, type EventResizeDoneArg } from '@fullcalendar/interaction';
import listPlugin from '@fullcalendar/list';
import luxonPlugin from '@fullcalendar/luxon3';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
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
    if (dragging.current || pressing.current) deferred.current = true;
    else capi.refetchEvents();
  };
  const flushDeferred = () => {
    if (dragging.current || pressing.current || !deferred.current) return;
    deferred.current = false;
    fc.current?.getApi().refetchEvents();
  };
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
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  /** The current touch has moved (a swipe or scroll), so it is not a tap. */
  const moved = useRef(false);

  const visibleIds = useMemo(() => props.calendars.filter((c) => c.visible).map((c) => c.entity_id), [props.calendars]);
  const visibleRef = useRef(visibleIds);
  visibleRef.current = visibleIds;

  const fetchEvents = useCallback((info: { startStr: string; endStr: string }, success: (e: EventInput[]) => void, failure: (e: Error) => void) => {
    const ids = visibleRef.current;
    if (!ids.length) return success([]);
    api
      .events(info.startStr, info.endStr, ids)
      .then((r) => {
        const byId = new Map(propsRef.current.calendars.map((c) => [c.entity_id, c]));
        if (r.errors.length) {
          const names = r.errors.map((e) => byId.get(e.entity_id)?.name ?? e.entity_id).join(', ');
          propsRef.current.onLoadError(`Could not load ${names}.`);
        }
        success(r.events.map((e) => toFc(e, byId.get(e.entity_id))));
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
    propsRef.current.onMove({ event: e, start: arg.event.startStr, end: arg.event.endStr || arg.event.startStr, allDay: arg.event.allDay, revert: arg.revert });
  };

  const onTouchStart = (ev: React.TouchEvent) => {
    pressStart(ev.target);
    moved.current = false;
    if (ev.touches.length !== 1) return (touch.current = null);
    touch.current = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, t: Date.now() };
  };
  const onTouchMove = (ev: React.TouchEvent) => {
    const s = touch.current;
    if (s && (Math.abs(ev.touches[0].clientX - s.x) > 10 || Math.abs(ev.touches[0].clientY - s.y) > 10)) moved.current = true;
  };
  const onTouchEnd = (ev: React.TouchEvent) => {
    pressEnd();
    const s = touch.current;
    touch.current = null;
    if (!s || dragging.current) return;
    const dx = ev.changedTouches[0].clientX - s.x;
    const dy = ev.changedTouches[0].clientY - s.y;
    if (Date.now() - s.t > 700 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
    const capi = fc.current?.getApi();
    if (!capi) return;
    const el = (ev.currentTarget as HTMLElement).querySelector('.fc-view-harness');
    el?.classList.remove('swipe-left', 'swipe-right');
    void (el as HTMLElement | null)?.offsetWidth;
    el?.classList.add(dx < 0 ? 'swipe-left' : 'swipe-right');
    if (dx < 0) capi.next();
    else capi.prev();
  };

  return (
    <div
      className="calendar-wrap"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={pressEnd}
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
        eventLongPressDelay={300}
        selectLongPressDelay={300}
        longPressDelay={300}
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
          if (moved.current) return; // end of a swipe, not a tap
          // Tapping an empty slot creates an event there (month view: on that day).
          if (arg.view.type === 'dayGridMonth') {
            propsRef.current.onCreate(arg.dateStr, arg.dateStr, true);
            return;
          }
          propsRef.current.onCreate(arg.dateStr, '', arg.allDay);
        }}
        select={(arg: DateSelectArg) => {
          // A plain tap also fires `select` for one slot; let dateClick handle that.
          const ms = arg.end.getTime() - arg.start.getTime();
          if (!arg.allDay && ms <= 30 * 60_000) return;
          if (arg.allDay && ms <= 86_400_000 && arg.view.type === 'dayGridMonth') return;
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
