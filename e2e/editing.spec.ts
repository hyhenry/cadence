import { expect, test, type Page } from '@playwright/test';
import { haCommand, open, ownDay, setView, touchDrag, touchPath } from './helpers.ts';

const uniq = (base: string) => `${base} ${test.info().project.name} ${Date.now() % 100000}`;

async function createAt(page: Page, title: string, slotTime = '10:00:00') {
  const slot = page.locator(`td.fc-timegrid-slot-lane[data-time="${slotTime}"]`);
  await slot.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  // Let the scroll event pass first: a scroll during a touch cancels the press.
  await page.waitForTimeout(150);
  const box = (await slot.boundingBox())!;
  // Press in today's column (week views), so what follows doesn't depend on the weekday.
  const today = await page.locator('.fc-timegrid-col.fc-day-today').boundingBox();
  const at = { x: today ? today.x + today.width / 2 : box.x + box.width / 2, y: box.y + box.height / 2 };
  await touchDrag(page, at, at, { holdMs: 650, steps: 0 });
  const dialog = page.getByRole('dialog', { name: 'New event' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Title').fill(title);
  return dialog;
}

test('long-press an empty slot to create, then edit and delete', async ({ page }) => {
  await ownDay(page);
  await open(page);
  await setView(page, 'Day');
  await page.getByRole('button', { name: 'Next' }).or(page.locator('h1.title')).first().waitFor();
  const name = uniq('Vet');
  const dialog = await createAt(page, name, '10:00:00');
  await expect(dialog.getByLabel('Start time')).toHaveValue('10:00');
  await dialog.getByLabel('Location').fill('Animal clinic');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const ev = page.locator('.fc-event', { hasText: name });
  await expect(ev).toBeVisible();
  await expect(ev).not.toHaveClass(/ev-pending/);

  await ev.tap();
  const edit = page.getByRole('dialog', { name: 'Edit event' });
  await expect(edit.getByLabel('Location')).toHaveValue('Animal clinic');
  await edit.getByLabel('Title').fill(`${name} (moved)`);
  await edit.getByLabel('Start time').fill('11:30');
  await expect(edit.getByLabel('End time')).toHaveValue('12:30');
  await edit.getByRole('button', { name: 'Save' }).click();
  const moved = page.locator('.fc-event', { hasText: `${name} (moved)` });
  await expect(moved).toBeVisible();
  await expect(moved).toContainText('11:30');

  await moved.tap();
  await page.getByRole('dialog', { name: 'Edit event' }).getByRole('button', { name: 'Delete event' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.fc-event', { hasText: name })).toHaveCount(0);
});

test('all-day event from the editor', async ({ page }) => {
  await ownDay(page);
  await open(page);
  await setView(page, 'Day');
  const name = uniq('Holiday');
  const dialog = await createAt(page, name, '08:00:00');
  await dialog.getByLabel('All day').check();
  await expect(dialog.getByLabel('Start time')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.fc-daygrid-event', { hasText: name })).toBeVisible();
});

test('recurring event: delete one occurrence, then all', async ({ page }) => {
  await ownDay(page);
  await open(page);
  await setView(page, 'Week');
  const name = uniq('Practice');
  const dialog = await createAt(page, name, '06:00:00');
  await dialog.getByLabel('Repeat', { exact: true }).selectOption('daily');
  await dialog.getByLabel('Repeat ends').selectOption('count');
  await dialog.getByLabel('Number of times').fill('3');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const evs = page.locator('.fc-event', { hasText: name });
  await expect(evs.first()).toBeVisible();
  await setView(page, 'Agenda');
  const rows = page.locator('.fc-list-event', { hasText: name });
  await expect(rows).toHaveCount(3);
  await rows.first().tap();
  await page.getByRole('dialog', { name: 'Edit event' }).getByRole('button', { name: 'Delete event' }).click();
  await page.getByRole('dialog', { name: 'Delete recurring event' }).getByRole('button', { name: 'This event' }).click();
  await expect(rows).toHaveCount(2);
  await rows.first().tap();
  await page.getByRole('dialog', { name: 'Edit event' }).getByRole('button', { name: 'Delete event' }).click();
  await page.getByRole('dialog', { name: 'Delete recurring event' }).getByRole('button', { name: 'All events' }).click();
  await expect(rows).toHaveCount(0);
});

test('touch drag moves an event (long press, then drag)', async ({ page }) => {
  await ownDay(page);
  await open(page);
  await setView(page, 'Day');
  const name = uniq('Drag me');
  const dialog = await createAt(page, name, '13:00:00');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const ev = page.locator('.fc-timegrid-event', { hasText: name });
  await expect(ev).toBeVisible();
  await expect(ev).not.toHaveClass(/ev-pending/);
  const box = (await ev.boundingBox())!;
  const slotH = (await page.locator('td.fc-timegrid-slot-lane[data-time="13:00:00"]').boundingBox())!.height;
  // Two hours later = four 30-minute slots.
  await touchDrag(page, { x: box.x + box.width / 2, y: box.y + 8 }, { x: box.x + box.width / 2, y: box.y + 8 + slotH * 4 - 6 }, { holdMs: 650, steps: 16 });
  await expect(page.locator('.fc-timegrid-event:not(.fc-event-mirror)', { hasText: name })).toContainText('3pm', { timeout: 8000 });
  // Persisted in HA: reload and check again.
  await page.reload();
  await setView(page, 'Day');
  await expect(page.locator('.fc-timegrid-event', { hasText: name })).toContainText('3pm');
});

test('touch resize: long-press to select, then drag the handle', async ({ page }) => {
  await ownDay(page);
  await open(page);
  await setView(page, 'Day');
  const name = uniq('Resize me');
  const slotTime = '11:00:00';
  const dialog = await createAt(page, name, slotTime);
  await dialog.getByRole('button', { name: 'Save' }).click();
  const ev = page.locator('.fc-timegrid-event:not(.fc-event-mirror)', { hasText: name });
  await expect(ev).not.toHaveClass(/ev-pending/);
  const box = (await ev.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await touchDrag(page, centre, centre, { holdMs: 650, steps: 1 });
  await expect(ev).toHaveClass(/fc-event-selected/);
  const handle = ev.locator('.fc-event-resizer-end');
  const hb = (await handle.boundingBox())!;
  const slotH = (await page.locator(`td.fc-timegrid-slot-lane[data-time="${slotTime}"]`).boundingBox())!.height;
  await touchDrag(page, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 + slotH * 2 - 4 }, { steps: 10 });
  await expect(page.locator('.fc-timegrid-event:not(.fc-event-mirror)', { hasText: name })).toContainText(/11(am)? - 1pm/, { timeout: 8000 });
});

test('a tap on an empty slot does not create an event (touch)', async ({ page }) => {
  await ownDay(page);
  await open(page);
  await setView(page, 'Day');
  const slot = page.locator('td.fc-timegrid-slot-lane[data-time="10:00:00"]');
  await slot.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = (await slot.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('month view: touch and hold a day to create an all-day event', async ({ page }) => {
  await ownDay(page);
  await open(page);
  await setView(page, 'Month');
  // A day with nothing on it, so the hold lands on the day and not an event.
  const days = page.locator('td.fc-daygrid-day:not(.fc-day-other)');
  const n = await days.count();
  let target = null;
  for (let i = n - 1; i >= 0; i--) {
    if ((await days.nth(i).locator('.fc-event').count()) === 0) {
      target = days.nth(i);
      break;
    }
  }
  const box = (await target!.boundingBox())!;
  // Below the day number (a tap there opens the day).
  const at = { x: box.x + box.width / 2, y: box.y + box.height * 0.7 };
  await page.touchscreen.tap(at.x, at.y);
  await page.waitForTimeout(400);
  await expect(page.getByRole('dialog'), 'a tap does not create').toHaveCount(0);
  await touchDrag(page, at, at, { holdMs: 650, steps: 0 });
  const dialog = page.getByRole('dialog', { name: 'New event' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('All day')).toBeChecked();
});

test('moving first, then resting, does not pick up an event or open it', async ({ page }) => {
  await ownDay(page);
  await open(page);
  await setView(page, 'Day');
  const name = uniq('Stay put');
  const slotTime = '17:00:00';
  const dialog = await createAt(page, name, slotTime);
  await dialog.getByRole('button', { name: 'Save' }).click();
  const ev = page.locator('.fc-timegrid-event:not(.fc-event-mirror)', { hasText: name });
  await expect(ev).not.toHaveClass(/ev-pending/);
  const before = (await ev.textContent())!;
  const box = (await ev.boundingBox())!;
  const slotH = (await page.locator(`td.fc-timegrid-slot-lane[data-time="${slotTime}"]`).boundingBox())!.height;
  const x = box.x + box.width / 2;
  const y = box.y + 8;
  // A little sideways (a slow swipe that changes its mind), rest past the
  // long-press delay, then pull down two hours' worth. Before, the rest made
  // FullCalendar pick the event up and the pull moved it.
  await touchPath(page, [{ x, y }, { x: x - 6, y }, { x: x - 14, y: y + 1 }, { x: x - 16, y: y + 1, wait: 800 }, { x: x - 16, y: y + slotH * 2, wait: 30 }, { x: x - 16, y: y + slotH * 4, wait: 30 }]);
  await page.waitForTimeout(400);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.fc-timegrid-event:not(.fc-event-mirror)', { hasText: name })).toHaveText(before);
});

test('moving first, then resting, over empty slots does not create', async ({ page }) => {
  await ownDay(page);
  await open(page);
  await setView(page, 'Week');
  const slot = page.locator('td.fc-timegrid-slot-lane[data-time="09:00:00"]');
  await slot.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(150);
  const box = (await slot.boundingBox())!;
  const today = (await page.locator('.fc-timegrid-col.fc-day-today').boundingBox())!;
  const x = today.x + today.width * 0.75;
  const y = box.y + box.height / 2;
  await touchPath(page, [{ x, y }, { x: x - 8, y }, { x: x - 16, y: y + 1 }, { x: x - 18, y: y + 1, wait: 800 }, { x: x - 18, y: y + 80, wait: 30 }]);
  await page.waitForTimeout(400);
  await expect(page.locator('.fc-highlight')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a change Home Assistant rejects is rolled back with a message', async ({ page }) => {
  await ownDay(page);
  await open(page);
  await setView(page, 'Day');
  const name = uniq('Doomed');
  const dialog = await createAt(page, name, '19:00:00');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const ev = page.locator('.fc-timegrid-event', { hasText: name });
  await expect(ev).not.toHaveClass(/ev-pending/);
  // Someone deletes it in HA behind Cadence's back (no live update yet arrives before we act).
  const now = await page.evaluate(() => Date.now());
  const range = `start=${encodeURIComponent(new Date(now - 864e5 * 3).toISOString())}&end=${encodeURIComponent(new Date(now + 864e5 * 3).toISOString())}`;
  const states = await (await fetch(`http://127.0.0.1:8199/api/events?${range}`)).json();
  const target = states.events.find((e: any) => e.summary === name);
  await page.route('**/api/stream', (r) => r.abort());
  await haCommand({ type: 'calendar/event/delete', entity_id: target.entity_id, uid: target.uid });
  await ev.tap();
  const edit = page.getByRole('dialog', { name: 'Edit event' });
  await edit.getByLabel('Title').fill(`${name} renamed`);
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /No existing event/ })).toBeVisible();
  await expect(page.locator('.fc-timegrid-event', { hasText: `${name} renamed` })).toHaveCount(0);
});
