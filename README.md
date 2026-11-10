# Cadence

A touch-first calendar for Home Assistant, installed as a Home Assistant app. It shows
up in the sidebar as **Calendar**.

- Month, week, 3-day, day and agenda views with tap-to-create, drag, resize and swipe.
- Works with every `calendar.*` entity you already have; new calendars are ordinary
  Local Calendars, so automations and dashboards keep working.
- Subscribe to Google (secret iCal address), Outlook and other iCal calendars through
  Home Assistant's Remote Calendar integration.
- Reminders sent to your phone through Home Assistant notifications.
- Follows Home Assistant's theme, including dark mode.

## Installation

Requires Home Assistant OS or Supervised, version 2025.4 or newer.

1. In Home Assistant open **Settings → Apps → App store**, then **⋮ → Repositories**.
2. Add the URL of this repository.
3. Install **Calendar** (Cadence), start it, and turn on **Show in sidebar**.

See [cadence/DOCS.md](cadence/DOCS.md) for how to use it.

## Development

```bash
npm install
npm run dev        # mock Home Assistant, server and web app; open http://localhost:5173
npm test           # unit and integration tests
npm run test:e2e   # browser tests (run `npx playwright install chromium` once)
```

To develop against a real Home Assistant, copy `.env.example` to `.env` and set
`HA_URL` and a long-lived `HA_TOKEN`.
