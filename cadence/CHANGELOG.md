# Changelog

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
