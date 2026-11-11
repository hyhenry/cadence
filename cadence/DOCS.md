# Cadence

Cadence is a touch-first calendar for Home Assistant. In the sidebar and in the app it is simply called **Calendar**. It shows every `calendar.*`
entity you already have in month, week, 3-day, day and agenda views, lets you add,
move and delete events with your finger, create new calendars, subscribe to Google
and Outlook calendars by link, and sends reminders to your phone through Home
Assistant notifications.

Home Assistant stays the source of truth. Calendars you create in Cadence are
ordinary Local Calendar entities, so automations, voice assistants and dashboards
keep working with them.

## Requirements

- Home Assistant OS or a Supervised installation (apps need the Supervisor).
- Home Assistant 2025.4 or newer (for the Remote Calendar integration used by link calendars).
- For reminders on a phone: the Home Assistant Companion app, which provides a `notify.mobile_app_…` service.

## Installation

1. In Home Assistant open **Settings → Apps** (called *Add-ons* on older versions) and
   select **App store** (*Add-on store*).
2. Open the **⋮** menu at the top right, choose **Repositories**, paste the URL of the
   Git repository that contains this app, and select **Add**. The repository must be
   reachable by Home Assistant (a public GitHub repository works).
3. Close the dialog and reload the store. The app appears as **Calendar**.
4. Open it and select **Install**. Home Assistant builds the app on your device, which
   can take a few minutes on a Raspberry Pi.
5. Select **Start**, turn on **Show in sidebar**, and open **Calendar** from the sidebar.

There is nothing to configure: the app talks to Home Assistant with the token the
Supervisor gives it.

### First steps

1. Open the menu (☰ on a phone; on a tablet the calendar list is always visible) and
   choose **Settings & reminders**.
2. Tick the devices that should receive reminders (for example
   `notify.mobile_app_your_phone`) and select **Send test notification**.
3. Select **Save**.

## Using Cadence

| To… | Do this |
|---|---|
| Create an event | Tap an empty time slot, or the **+** button. Long-press and drag across slots to pick a longer time. In month view, tap a day. |
| Edit or delete an event | Tap it. |
| Move an event | Long-press it, then drag. |
| Change how long it lasts | Long-press to select it, then drag the handle at its bottom edge. |
| Go to the next or previous period | Swipe left or right, or use the arrows on a larger screen. |
| Jump back | Tap **Today**. |
| Show or hide a calendar | Tap it in the calendar list. |

When you change or delete one occurrence of a repeating event, Cadence asks whether to
apply it to **this event**, **this and following events**, or **all events**.

On a keyboard: <kbd>T</kbd> today, <kbd>←</kbd>/<kbd>→</kbd> previous/next,
<kbd>M</kbd>/<kbd>W</kbd>/<kbd>D</kbd>/<kbd>A</kbd> month/week/day/agenda,
<kbd>N</kbd> new event, <kbd>Esc</kbd> close.

Cadence follows Home Assistant's theme: light or dark (including *Auto*) and the
theme's colours, switching as soon as you change it in your HA profile.

Times are shown in Home Assistant's time zone (**Settings → System → General**), not
the time zone of the device you are using.

## Calendars

- **All calendars appear automatically**, including ones set up outside Cadence (for
  example Google Calendar or CalDAV integrations). Calendars that Home Assistant
  cannot edit are marked with a lock.
- **Add calendar → New calendar** creates a Local Calendar in Home Assistant.
- **Add calendar → From a link** subscribes to a shared calendar using Home
  Assistant's Remote Calendar integration. The calendar is read-only.
  - *Google Calendar (stays private)*: you do not need to make the calendar public.
    In Google Calendar on a computer open **Settings**, choose the calendar under
    *Settings for my calendars*, then **Integrate calendar**, and copy the **Secret
    address in iCal format** (it ends in `/basic.ics`). Anyone with this address can
    read the calendar, so treat it like a password; you can reset it in Google.
    Google's *shareable link* (`…/calendar/u/0?cid=…`) and embed links of calendars that
    are not public only work for people signed in to Google, so Cadence explains how to
    get the secret address instead. Public calendars can also be added with their
    public iCal address, embed link or `webcal://` link.
  - *Outlook*: in Outlook on the web open **Settings → Calendar → Shared calendars →
    Publish a calendar**, publish it, and copy the **ICS** link. If you paste the HTML
    link, Cadence converts it.
  - Cadence checks the link before adding it and explains what is wrong if it is a web
    page or a sign-in page instead of a calendar.
  - Home Assistant only re-reads linked calendars once a day; Cadence asks it to refresh
    them every 15 minutes (change this in Settings).
- **Rename** (in a calendar's ⋯ menu) changes only the name shown in Cadence.
- **Delete** removes a Local Calendar, or unsubscribes from a link calendar, in Home
  Assistant. Calendars from other integrations are removed in **Settings → Devices &
  services** instead.

## Reminders

Home Assistant calendars have no reminders, so Cadence keeps them itself and sends
them with the `notify` services you choose.

- **Calendar defaults**: in a calendar's ⋯ menu, add reminders that apply to every
  event in that calendar.
- **Per event**: in the event editor, switch **Reminders** from *Calendar default* to
  *Custom*. This works on read-only calendars too.
- Reminders are checked every few minutes and whenever a calendar changes. A
  reminder that was due while Cadence was restarting is still sent if it is less than
  15 minutes late, and a reminder is never sent twice.
- **Settings → Upcoming reminders** lists what will be sent in the next 48 hours.

## Who can use it

Every Home Assistant user can add **Calendar** to their sidebar. The app acts with
its own Home Assistant access, so any user who can open it can add, change and delete
events and calendars, including removing a Local or Remote Calendar from Home
Assistant.

## Data and privacy

- Cadence stores its own settings (colours, hidden calendars, reminders) in
  `/data/cadence.db`, which is included in Home Assistant backups. Events stay in
  Home Assistant.
- Calendar links are stored by Home Assistant's Remote Calendar integration. Cadence
  does not log them.
- Cadence only accepts connections through Home Assistant's Ingress.

## Troubleshooting

- **"Home Assistant is not reachable"**: Home Assistant is restarting; Cadence
  reconnects by itself.
- **No notification services listed**: install the Companion app on your phone and log
  in, then reopen Settings.
- **A link calendar cannot be added**: open the link in a private browser window. If it
  asks you to sign in, the calendar is not shared publicly; use the secret iCal address.
- Logs are in **Settings → Apps → Cadence → Log**.

## Limitations

- No sign-in to Google or Microsoft accounts: link calendars are read-only.
- No invitations or attendees.
- Recurrence rules that Cadence cannot represent (made in another app) are kept as
  they are unless you choose a new repeat option.
