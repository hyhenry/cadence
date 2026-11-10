import { expect, test } from '@playwright/test';
import { closeDrawer, haCommand, isPhone, open, openDrawer, setView, touchDrag } from './helpers.ts';

test('loads through the ingress prefix with relative paths', async ({ page }) => {
  const bad: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.port === '8224' && !u.pathname.startsWith('/api/hassio_ingress/e2e/')) bad.push(u.pathname);
  });
  await open(page);
  expect(bad).toEqual([]);
});

test('switches between month, week, 3-day, day and agenda views', async ({ page }) => {
  await open(page);
  await setView(page, 'Month');
  await expect(page.locator('.fc-dayGridMonth-view')).toBeVisible();
  await expect(page.locator('.fc-event', { hasText: 'Grandma visiting' }).first()).toBeVisible();
  await setView(page, 'Week');
  await expect(page.locator('.fc-timeGridWeek-view')).toBeVisible();
  await setView(page, '3 days');
  await expect(page.locator('.fc-timeGrid3Day-view')).toBeVisible();
  await setView(page, 'Day');
  await expect(page.locator('.fc-timeGridDay-view')).toBeVisible();
  await setView(page, 'Agenda');
  await expect(page.locator('.fc-list')).toBeVisible();
  await expect(page.locator('.fc-list-event', { hasText: 'Dentist' })).toBeVisible();
});

test('swipe changes the period and Today comes back', async ({ page }) => {
  await open(page);
  await setView(page, 'Day');
  await expect(page.locator('.fc-timeGridDay-view')).toBeVisible();
  const title = page.locator('h1.title');
  await expect(title).toHaveText(/\d{4}/);
  const before = (await title.textContent())!;
  const box = (await page.locator('.fc-view-harness').boundingBox())!;
  await touchDrag(page, { x: box.x + box.width * 0.85, y: box.y + 200 }, { x: box.x + box.width * 0.15, y: box.y + 210 }, { steps: 6 });
  await expect(title).not.toHaveText(before);
  await expect(page.getByRole('dialog'), 'a swipe is not a tap').toHaveCount(0);
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(title).toHaveText(before);
});

test('calendar toggles hide and show events', async ({ page }) => {
  await open(page);
  await setView(page, 'Agenda');
  await expect(page.locator('.fc-list-event', { hasText: 'Dentist' })).toBeVisible();
  await openDrawer(page);
  await page.getByRole('switch', { name: 'Show Family' }).click();
  await closeDrawer(page);
  await expect(page.locator('.fc-list-event', { hasText: 'Dentist' })).toHaveCount(0);
  await openDrawer(page);
  await page.getByRole('switch', { name: 'Show Family' }).click();
  await closeDrawer(page);
  await expect(page.locator('.fc-list-event', { hasText: 'Dentist' })).toBeVisible();
});

test('changes made in Home Assistant appear without reloading', async ({ page }) => {
  await open(page);
  await setView(page, 'Agenda');
  const name = `From HA ${test.info().project.name}`;
  const start = new Date(Date.now() + 2 * 3600e3);
  await haCommand({ type: 'calendar/event/create', entity_id: 'calendar.work', event: { summary: name, dtstart: start.toISOString(), dtend: new Date(start.getTime() + 3600e3).toISOString() } });
  await expect(page.locator('.fc-list-event', { hasText: name })).toBeVisible({ timeout: 10_000 });
  void isPhone;
});

test('the last used view is remembered on this device', async ({ page }) => {
  await open(page);
  await setView(page, '3 days');
  await expect(page.locator('.fc-timeGrid3Day-view')).toBeVisible();
  await page.reload();
  await expect(page.locator('.fc-timeGrid3Day-view')).toBeVisible();
  await setView(page, 'Month');
  await page.reload();
  await expect(page.locator('.fc-dayGridMonth-view')).toBeVisible();
});
