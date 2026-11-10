import { expect, test, type Page } from '@playwright/test';
import { closeDrawer, open, openDrawer } from './helpers.ts';

const P = () => test.info().project.name;

async function addSheet(page: Page) {
  await openDrawer(page);
  await page.getByRole('button', { name: 'Add calendar' }).click();
  return page.getByRole('dialog', { name: 'Add calendar' });
}

test('create and delete a local calendar', async ({ page }) => {
  await open(page);
  const name = `Chores ${P()}`;
  const sheet = await addSheet(page);
  await sheet.getByLabel('Name').fill(name);
  await sheet.getByRole('button', { name: 'Create calendar' }).click();
  await expect(sheet).toHaveCount(0);
  await openDrawer(page);
  await expect(page.getByRole('switch', { name: `Show ${name}` })).toBeVisible();
  // The new calendar is writable: it is offered in the event editor.
  await closeDrawer(page);
  await page.getByRole('button', { name: 'New event' }).click();
  const editor = page.getByRole('dialog', { name: 'New event' });
  await expect(editor.getByRole('combobox', { name: 'Calendar' }).locator('option', { hasText: name })).toHaveCount(1);
  await editor.getByRole('button', { name: 'Close' }).click();

  await openDrawer(page);
  await page.getByRole('button', { name: `${name} settings` }).click();
  const settings = page.getByRole('dialog', { name });
  await settings.getByRole('button', { name: 'Delete calendar' }).click();
  await settings.getByRole('button', { name: 'Delete calendar' }).last().click();
  await expect(page.getByRole('switch', { name: `Show ${name}` })).toHaveCount(0);
});

test('subscribe to a Google calendar from its embed link', async ({ page }) => {
  await open(page);
  const sheet = await addSheet(page);
  await sheet.getByRole('tab', { name: 'From a link' }).click();
  await sheet.getByLabel('Calendar link').fill(`https://calendar.google.com/calendar/embed?src=school-${P()}%40group.calendar.google.com&ctz=America%2FToronto`);
  await sheet.getByRole('button', { name: 'Check link' }).click();
  await expect(sheet.getByRole('status')).toContainText('Google Calendar · 3 events found');
  await expect(sheet.getByLabel('Name')).toHaveValue('School events');
  await sheet.getByLabel('Name').fill(`School ${P()}`);
  await sheet.getByRole('button', { name: 'Subscribe' }).click();
  await expect(sheet).toHaveCount(0);
  await openDrawer(page);
  await expect(page.getByRole('switch', { name: `Show School ${P()}` })).toBeVisible();
  await closeDrawer(page);
  await expect(page.locator('.fc-event', { hasText: 'Robotics club' }).first()).toBeVisible();
});

test('subscribe to an Outlook calendar from its HTML link', async ({ page }) => {
  await open(page);
  const sheet = await addSheet(page);
  await sheet.getByRole('tab', { name: 'From a link' }).click();
  await sheet.getByLabel('Calendar link').fill(`https://outlook.office365.com/owa/calendar/${P()}@contoso.com/abc123/calendar.html`);
  await sheet.getByRole('button', { name: 'Check link' }).click();
  await expect(sheet.getByRole('status')).toContainText('Outlook · 2 events found');
  await sheet.getByLabel('Name').fill(`Team ${P()}`);
  await sheet.getByRole('button', { name: 'Subscribe' }).click();
  await expect(sheet).toHaveCount(0);
  await openDrawer(page);
  await expect(page.getByRole('switch', { name: `Show Team ${P()}` })).toBeVisible();
});

test('a sign-in page link gets a specific explanation', async ({ page }) => {
  await open(page);
  const sheet = await addSheet(page);
  await sheet.getByRole('tab', { name: 'From a link' }).click();
  await sheet.getByLabel('Calendar link').fill('https://feeds.mock.test/login');
  await sheet.getByRole('button', { name: 'Check link' }).click();
  await expect(sheet.getByRole('alert')).toContainText('sign-in page');
});

test('private Google calendar: a shareable (cid) link shows the steps, the secret address works', async ({ page }) => {
  await open(page);
  const sheet = await addSheet(page);
  await sheet.getByRole('tab', { name: 'From a link' }).click();
  await sheet.getByLabel('Calendar link').fill('https://calendar.google.com/calendar/u/0?cid=ZmFtaWx5QGdyb3VwLmNhbGVuZGFyLmdvb2dsZS5jb20');
  await sheet.getByRole('button', { name: 'Check link' }).click();
  await expect(sheet.getByRole('alert')).toContainText('only works for people signed in to Google');

  await sheet.getByLabel('Calendar link').fill(`https://calendar.google.com/calendar/ical/family-${P()}%40group.calendar.google.com/private-a1b2c3d4e5f6/basic.ics`);
  await sheet.getByRole('button', { name: 'Check link' }).click();
  await expect(sheet.getByRole('status')).toContainText('Google Calendar · 3 events found');
  await sheet.getByLabel('Name').fill(`Private ${P()}`);
  await sheet.getByRole('button', { name: 'Subscribe' }).click();
  await expect(sheet).toHaveCount(0);
  await openDrawer(page);
  await expect(page.getByRole('switch', { name: `Show Private ${P()}` })).toBeVisible();
});
