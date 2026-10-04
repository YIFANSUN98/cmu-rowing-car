import { test, expect } from '../fixtures/access';
import {
  browserData,
  installTomTomFixture,
  uploadInputs,
  uploadWorkbook,
} from '../fixtures/browser';
import { inputWorkbook } from '../fixtures/workbooks';

test('TomTom planning → expand → edit → stale → replan with no removed controls', async ({
  page,
}) => {
  const external: string[] = [],
    errors: string[] = [];
  page.on('request', (r) => {
    if (!['localhost', '127.0.0.1'].includes(new URL(r.url()).hostname)) external.push(r.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await installTomTomFixture(page);
  await page.goto('./');
  await expect(page.getByLabel('Boathouse destination')).toHaveValue(
    '300 Waterfront Dr, Pittsburgh, PA 15222',
  );
  await expect(page.getByText('TomTom · traffic-aware travel estimates')).toHaveCount(0);
  await expect(page.locator('.preview, .scenario-panel, .header-right, .upload-help')).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Try the fictitious demo' })).toHaveCount(0);
  for (const name of [
    'Earliest departure',
    'Maximum route (min)',
    'Boarding per stop (sec)',
    'Reproducible seed',
    'Extra driving allowed for fairness',
  ])
    await expect(page.getByLabel(name, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__tomtomCalls)).toEqual([]);
  const data = browserData();
  await uploadInputs(page, data);
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A seat for everyone.' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__tomtomCalls)).toEqual(
    expect.arrayContaining(['geocode', 'matrix', 'route']),
  );
  await expect(
    page.locator('.travel-groups, .export-bar, .search-details, .result-meta'),
  ).toHaveCount(0);
  const card = page.locator('.car-card').first();
  await expect(card.locator('.timeline')).toHaveCount(0);
  await expect(page.locator('.route-map')).toHaveCount(0);
  expect(
    external.every(
      (url) =>
        url.startsWith('https://api.weather.gov/') ||
        url.startsWith('https://api.waterdata.usgs.gov/'),
    ),
  ).toBe(true);
  const routingBeforeMap = await page.evaluate(() => (window as any).__tomtomCalls.length);
  await card.getByRole('button', { name: /Show route for/ }).click();
  await expect(card.locator('.timeline')).toBeVisible();
  await expect(card.getByRole('region', { name: /Route map for/ })).toBeVisible();
  await expect(card.locator('.route-road')).toHaveCount(1);
  await expect(card.locator('.leaflet-tile-loaded').first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).__tomtomCalls.length)).toBe(routingBeforeMap);
  await card.getByRole('button', { name: 'Show pickup 1 on map' }).click();
  await expect(card.locator('.leaflet-popup')).toContainText('Pickup 1:');
  await card.getByRole('button', { name: 'Fit route' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await card.locator('.route-map-wrap').screenshot({ path: 'docs/route-map-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await card.locator('.route-map-wrap').screenshot({ path: 'docs/route-map-desktop.png' });
  await expect(card.locator('.destination')).toContainText(
    '300 Waterfront Dr, Pittsburgh, PA 15222',
  );
  await expect(card.locator('.travel-attribution')).toHaveText('TomTom');
  const callsBeforeRepeat = await page.evaluate(() => (window as any).__tomtomCalls.length);
  await page.getByRole('button', { name: 'Replan week', exact: true }).click();
  await expect(page.getByText('Stale · comparison only')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Replan week', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__tomtomCalls.length)).toBe(callsBeforeRepeat);
  await page
    .locator('.car-card')
    .first()
    .getByRole('button', { name: /Show route for/ })
    .click();
  await page.getByLabel('Arrival deadline', { exact: true }).fill('06:00');
  await expect(page.getByText('Stale · comparison only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy instructions' })).toBeDisabled();
  await page.getByRole('button', { name: 'Replan week', exact: true }).click();
  await expect(page.getByText('Stale · comparison only')).toHaveCount(0);
  await expect(page.locator('.daily-title')).toContainText('Arrive by 06:00 ET');
  const removedName = data.members.find(
    (m) => m.member_id === data.attendance[0].member_id,
  )!.display_name;
  data.attendance[0].attending = 'false';
  await uploadWorkbook(page, 'attendance', inputWorkbook(data, 'attendance'));
  await expect(page.getByText('Stale · comparison only')).toBeVisible();
  await page.getByRole('button', { name: 'Replan week', exact: true }).click();
  await expect(page.getByText('Stale · comparison only')).toHaveCount(0);
  await expect(page.locator('.car-summary').getByText(removedName, { exact: true })).toHaveCount(0);
  expect(external.length).toBeGreaterThan(0);
  expect(
    external.every(
      (url) =>
        url.startsWith('https://api.tomtom.com/map/') ||
        url.startsWith('https://api.weather.gov/') ||
        url.startsWith('https://api.waterdata.usgs.gov/'),
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'docs/planner-desktop.png', fullPage: true });
});

test('one upload area fits desktop and mobile viewports', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto('./');
  await expect(page.locator('.file-select')).toHaveCount(1);
  await expect(page.getByLabel('Upload Excel files')).toHaveAttribute('multiple');
  await expect(
    page.getByRole('list', { name: 'Detected files' }).getByRole('listitem'),
  ).toHaveCount(3);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'docs/planner-mobile.png', fullPage: true });
});

test('map tile failure preserves the verified road and readable route details', async ({
  page,
}) => {
  await installTomTomFixture(page);
  await page.route('https://api.tomtom.com/map/**', (route) =>
    route.fulfill({ status: 403, body: '' }),
  );
  await page.goto('./');
  await uploadInputs(page, browserData());
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A seat for everyone.' })).toBeVisible();
  const card = page.locator('.car-card').first();
  await card.getByRole('button', { name: /Show route for/ }).click();
  await expect(
    card.getByText('Map background unavailable. Your route details are below.'),
  ).toBeVisible();
  await expect(card.locator('.route-road')).toHaveCount(1);
  await expect(card.locator('.timeline')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Copy instructions' })).toBeEnabled();
});

test('TomTom requests can be cancelled', async ({ page }) => {
  await installTomTomFixture(page, 'pending');
  await page.goto('./');
  await uploadInputs(page, browserData());
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  const progress = page.getByRole('progressbar', { name: 'Planning progress' });
  await expect(progress).toHaveAttribute('aria-valuetext', /Step 1 of 3/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(progress).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeEnabled();
  await expect(page.locator('.car-card')).toHaveCount(0);
});

test('TomTom failure is shown without falling back to mock routes', async ({ page }) => {
  await installTomTomFixture(page, 'error');
  await page.goto('./');
  await uploadInputs(page, browserData());
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('TomTom rejected');
  await expect(page.getByRole('progressbar', { name: 'Planning progress' })).toHaveCount(0);
  await expect(page.locator('.car-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeEnabled();
});

test('free allowance exhaustion stops planning without retries or mock results', async ({
  page,
}) => {
  await installTomTomFixture(page, 'quota');
  await page.goto('./');
  await uploadInputs(page, browserData());
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('free allowance or rate limit');
  await expect(page.locator('.car-card')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__tomtomCalls)).toEqual(['geocode']);
});

test('quota exhaustion during the final route check never publishes the worker draft', async ({
  page,
}) => {
  await installTomTomFixture(page, 'route-quota');
  await page.goto('./');
  await uploadInputs(page, browserData());
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('free allowance or rate limit');
  await expect(page.locator('.car-card')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as any).__tomtomCalls.filter((c: string) => c === 'route').length,
    ),
  ).toBe(1);
});

test('a failed refresh marks the preceding plan stale even when inputs did not change', async ({
  page,
}) => {
  await installTomTomFixture(page);
  await page.goto('./');
  await uploadInputs(page, browserData());
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A seat for everyone.' })).toBeVisible();
  await page
    .locator('.car-card')
    .first()
    .getByRole('button', { name: /Show route/ })
    .click();
  await page.evaluate(() => {
    (window as any).__tomtomQuota = true;
  });
  await page.clock.setFixedTime(new Date('2026-09-21T12:20:00Z'));
  await page.getByRole('button', { name: 'Replan week', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('free allowance or rate limit');
  await expect(page.getByText('Stale · comparison only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy instructions' })).toBeDisabled();
});
