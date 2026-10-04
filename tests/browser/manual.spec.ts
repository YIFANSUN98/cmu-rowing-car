import { test, expect, TEAM_KEY, TEST_API, TEST_ORIGIN } from '../fixtures/access';
import { browserData, installTomTomFixture, uploadInputs } from '../fixtures/browser';
import fs from 'node:fs';
import * as XLSX from 'xlsx';

function crew() {
  const data = browserData();
  const ids = data.members.slice(0, 4).map((m) => m.member_id);
  data.members = data.members.filter((m) => ids.includes(m.member_id));
  data.members.forEach((m, i) => {
    m.pickup_address = `${10 + i} Fiction Lane`;
    m.pickup_lat = 40.43 + i * 0.001;
    m.pickup_lng = -79.94;
  });
  data.attendance = data.attendance
    .filter((a) => ids.includes(a.member_id))
    .map((a) => ({ ...a, attending: 'true', transport_mode: 'carpool' }));
  data.availability = data.availability
    .filter((a) => ids.includes(a.member_id))
    .map((a, i) => ({ ...a, available: i === 0 ? 'true' : 'false', total_seats: 5 }));
  return data;
}

test('admin edits driver, pickup order and departure; manual plan exports and publishes identically to the team', async ({
  page,
  browser,
}) => {
  await installTomTomFixture(page);
  await page.goto('./');
  const data = crew(),
    names = data.members.map((m) => m.display_name),
    ids = data.members.map((m) => m.member_id);
  await uploadInputs(page, data);
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit routes', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Edit routes', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Arrange your routes.' });
  await expect(editor).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^(Publish to team|Update published plan)$/ }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download Excel' })).toBeDisabled();
  await editor.getByLabel('Driver for car 1', { exact: true }).selectOption(ids[1]);
  await editor.getByLabel(`Travel for ${names[0]}`, { exact: true }).selectOption('absent');
  for (const name of [names[2], names[3]])
    await editor.getByLabel(`Travel for ${name}`, { exact: true }).selectOption('car:car-0');
  await editor
    .getByRole('button', { name: `Move ${names[3]} earlier in car 1`, exact: true })
    .click();
  await expect(editor.locator('.manual-passengers li > span')).toHaveText([names[3], names[2]]);
  await editor.getByLabel('Departure for car 1', { exact: true }).fill('04:50');
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `width ${width}`,
    ).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.screenshot({ path: 'docs/manual-editor-mobile.png' });
  await editor.getByRole('button', { name: 'Generate updated plan' }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Replan from files', exact: true })).toBeEnabled();
  const card = page.locator('#results .car-card').first();
  await expect(card).toContainText(names[1]);
  await expect(card).not.toContainText(names[0]);
  await card.getByRole('button', { name: /Show route/ }).click();
  await expect(card.locator('.timeline')).toContainText('04:50');
  const href = await card
    .getByRole('link', { name: /Open .* route in Google Maps/ })
    .getAttribute('href');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Excel' }).click();
  const book = XLSX.read(fs.readFileSync((await (await pending).path())!));
  const rows = XLSX.utils.sheet_to_json<string[]>(book.Sheets[book.SheetNames[0]], {
    header: 1,
    raw: false,
  });
  expect(rows[3][0]).toBe(`${names[1]} (driver)`);
  expect(rows[3][1]).toBe('04:50');
  expect(rows.slice(4, 6).map((r) => r[0])).toEqual([names[3], names[2]]);
  await page.getByRole('button', { name: /^(Publish to team|Update published plan)$/ }).click();
  await expect(
    page.getByText('Published. Drivers and rowers can now view this plan.', { exact: true }),
  ).toBeVisible();
  const context = await browser.newContext();
  try {
    await context.request.post(TEST_API + 'login', {
      headers: { Origin: TEST_ORIGIN },
      data: { key: TEAM_KEY },
    });
    const team = await context.newPage();
    await installTomTomFixture(team);
    await team.goto('./');
    await expect(
      team.getByRole('button', { name: /Edit routes|Arrange manually|Generate updated plan/ }),
    ).toHaveCount(0);
    await team
      .getByRole('button', { name: /Show route/ })
      .first()
      .click();
    await expect(team.getByRole('link', { name: /Open .* route in Google Maps/ })).toHaveAttribute(
      'href',
      href!,
    );
  } finally {
    await context.close();
  }
  await page.reload();
  await page.getByText('Private Excel files · admin only', { exact: true }).click();
  await page.getByRole('button', { name: 'Load saved files', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit published routes', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Edit published routes', exact: true }).click();
  await expect(editor.getByLabel('Driver for car 1')).toHaveValue(ids[1]);
  await expect(editor.locator('.manual-passengers li > span')).toHaveText([names[3], names[2]]);
  await expect(editor.getByLabel(`Travel for ${names[0]}`)).toHaveValue('absent');
  await editor.getByRole('button', { name: 'Generate updated plan' }).click();
  await expect(editor).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Update published plan', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Unpublish plan', exact: true }).click();
  await expect(page.getByText('Plan removed from the team view.', { exact: true })).toBeVisible();
});

test('manual generation works without an automatic plan; overcapacity and missing assignments remain editable', async ({
  page,
}) => {
  await installTomTomFixture(page);
  await page.goto('./');
  const data = crew(),
    names = data.members.map((m) => m.display_name),
    ids = data.members.map((m) => m.member_id);
  await uploadInputs(page, data);
  await page.getByRole('button', { name: 'Arrange manually', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Arrange your routes.' });
  await editor.getByRole('button', { name: 'Add car', exact: true }).click();
  await editor.getByLabel('Driver for car 1').selectOption(ids[0]);
  const option = await editor
    .getByLabel(`Travel for ${names[1]}`)
    .locator('option')
    .allTextContents();
  expect(option.join(' ')).toContain('Car 1');
  for (const name of names.slice(1)) {
    const value = await editor
      .getByLabel(`Travel for ${name}`)
      .locator('option')
      .filter({ hasText: 'Car 1' })
      .getAttribute('value');
    await editor.getByLabel(`Travel for ${name}`).selectOption(value!);
  }
  await editor.getByLabel('Seats for car 1').selectOption('3');
  await editor.getByRole('button', { name: 'Generate updated plan' }).click();
  await expect(editor.getByRole('alert')).toContainText('4 people for 3 seats');
  await editor.getByLabel(`Travel for ${names[3]}`).selectOption('uber');
  await editor.getByRole('button', { name: 'Generate updated plan' }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.uber-card')).toContainText(names[3]);
  await page.getByRole('button', { name: 'Edit routes', exact: true }).click();
  await expect(editor.getByLabel(`Travel for ${names[3]}`)).toHaveValue('uber');
  await editor.getByRole('button', { name: 'Remove car', exact: false }).click();
  await editor.getByRole('button', { name: 'Generate updated plan' }).click();
  await expect(editor.getByRole('alert')).toContainText('Assign');
  await editor.getByRole('button', { name: 'Cancel edits' }).click();
  await expect(page.getByRole('button', { name: 'Download Excel' })).toBeEnabled();
});

test('failed manual routing keeps the published plan and recoverable draft; cancellation restores the previous result', async ({
  page,
}) => {
  await installTomTomFixture(page);
  await page.goto('./');
  await uploadInputs(page, crew());
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A seat for everyone.' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit routes', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Arrange your routes.' });
  await editor.getByLabel('Departure for car 1').fill('04:45');
  await page.evaluate(() => {
    (window as any).__tomtomQuota = true;
  });
  await editor.getByRole('button', { name: 'Generate updated plan' }).click();
  await expect(page.getByRole('alert')).toContainText('allowance');
  await expect(editor.getByLabel('Departure for car 1')).toHaveValue('04:45');
  await expect(
    page.getByRole('button', { name: /^(Publish to team|Update published plan)$/ }),
  ).toBeDisabled();
  await editor.getByRole('button', { name: 'Cancel edits' }).click();
  await expect(page.getByRole('button', { name: 'Download Excel' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Replan week', exact: true })).toBeEnabled();
});
