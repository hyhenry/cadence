import { expect, test } from '@playwright/test';
import { notifications, open, openDrawer, setView } from './helpers.ts';

const HA_TZ = 'America/Toronto';
const hhmm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: HA_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: HA_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

test('choose a device, send a test, and receive an event reminder', async ({ page }) => {
  const P = test.info().project.name;
  await open(page);
  await openDrawer(page);
  await page.getByRole('button', { name: 'Settings & reminders' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('checkbox', { name: 'notify.mobile_app_pixel_9' }).check();
  const before = (await notifications()).length;
  await settings.getByRole('button', { name: 'Send test notification' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Test sent to 1 device' })).toBeVisible();
  await expect.poll(async () => (await notifications()).length).toBe(before + 1);
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings).toHaveCount(0);

  // An event 4 minutes from now with a "5 min before" reminder is due straight away.
  const start = new Date(Date.now() + 4 * 60e3);
  const end = new Date(start.getTime() + 30 * 60e3);
  await setView(page, 'Day');
  await page.getByRole('button', { name: 'New event' }).click();
  const editor = page.getByRole('dialog', { name: 'New event' });
  const title = `Take medicine ${P}`;
  await editor.getByLabel('Title').fill(title);
  await editor.getByLabel('Start date').fill(ymd(start));
  await editor.getByLabel('Start time').fill(hhmm(start));
  await editor.getByLabel('End date').fill(ymd(end));
  await editor.getByLabel('End time').fill(hhmm(end));
  await editor.getByRole('radio', { name: 'Custom' }).click();
  await editor.getByRole('button', { name: 'Add reminder' }).click();
  await editor.getByRole('option', { name: '5 min before', exact: true }).click();
  await expect(editor.getByText('5 min before', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Save' }).click();

  await expect
    .poll(async () => (await notifications()).filter((n) => n.data.title === title).map((n) => n.service), { timeout: 15_000 })
    .toEqual(['notify.mobile_app_pixel_9']);

  // Reopening the event shows its own reminder.
  await page.locator('.fc-event', { hasText: title }).first().click();
  await expect(page.getByRole('dialog', { name: 'Edit event' }).getByText('5 min before', { exact: true })).toBeVisible();
});
