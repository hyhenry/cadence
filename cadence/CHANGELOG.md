# Changelog

## 0.1.4

- Swiping between days and weeks follows your finger and is smoother. The next and previous periods are loaded ahead, so their events are there when you arrive. In the 3-day view a swipe moves by as many days as you drag.
- Creating an event on a touch screen now takes a touch and hold on an empty slot, so a tap while scrolling or swiping no longer opens a new event. A mouse click still creates one.
- Events are harder to move by accident: the hold is a little longer, and a touch that starts moving (a swipe or scroll) can no longer pick up an event if the finger then rests. Tapping an event still opens it.
## 0.1.3

- Fixed the "Lost connection to the calendar. Retrying…" banner staying up for good after the app was left open, for example across a Home Assistant restart or a tablet waking from sleep. Cadence now reconnects on its own and clears the banner once it is back.

## 0.1.2

- Available in the sidebar for all users, not only administrators.
- No longer marked experimental.

## 0.1.1

- Called "Calendar" everywhere in Home Assistant, including the header on phones.
- Fixed the top bar overlapping the calendar inside the Home Assistant app on iPhone.
- Remembers the view you last used (month, week, 3 days, day or agenda) on each device.

## 0.1.0

- First release: month, week, 3-day, day and agenda views with touch drag, resize and swipe.
- Create, edit and delete events (including recurring events, with "this / following / all").
- Create and delete Local Calendars; subscribe to Google, Outlook and other iCal links (Remote Calendar).
- Reminders sent through Home Assistant notify services, per event or per calendar.
