import { test, expect } from '../fixtures/access';
import { browserData, installTomTomFixture, uploadInputs } from '../fixtures/browser';

test('shows one compact conditions panel with uniform corners and keeps the moon clear', async ({
  page,
}) => {
  await installTomTomFixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./');
  await expect(page.locator('.site-header h1')).toContainText('Less coordinating.');
  await expect(page.locator('.header-intro p')).toHaveText(
    'Plan the week, share the driving, and get your crew to the water on time.',
  );
  const logo = (await page.locator('.site-header .brand').boundingBox())!;
  const intro = (await page.locator('.header-intro').boundingBox())!;
  expect(intro.x).toBeGreaterThan(logo.x + logo.width);
  const destination = (await page.getByLabel('Boathouse destination').boundingBox())!;
  const figure = (await page.locator('.hero-art').boundingBox())!;
  expect(destination.x + destination.width).toBeLessThan(figure.x);
  await expect(page.getByLabel('Arrival buffer (min)')).toHaveCount(0);
  await page.getByLabel('Arrival deadline', { exact: true }).fill('13:30');
  await expect(page.locator('.hero-badge b')).toHaveText('08:00 AM ET');
  await expect(page.getByRole('timer')).toContainText('Mon, Sep 21, 2026');
  const conditions = page.getByRole('complementary', {
    name: 'Pittsburgh time and river conditions',
  });
  await expect(conditions).toContainText('63°F');
  await expect(conditions).toContainText('21,700 ft³/s');
  await expect(conditions).not.toContainText('Wind');
  await expect(conditions).not.toContainText('Observed');
  await expect(conditions.getByRole('link', { name: /^Temperature:/ })).toHaveAttribute(
    'title',
    /7:53 AM ET/,
  );
  await expect(conditions.getByRole('link', { name: /^Water flow/ })).toHaveAttribute(
    'title',
    /upstream of the boathouse/,
  );
  await page.locator('.site-header').screenshot({ path: 'docs/arrival-header-desktop.png' });
  await page.locator('.hero').screenshot({ path: 'docs/arrival-weather-desktop.png' });
  await uploadInputs(page, browserData());
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeEnabled();
  await expect(page.getByText('The arrival deadline cannot be later than 05:15.')).toHaveCount(0);
  await page.getByLabel('Arrival deadline', { exact: true }).fill('');
  await expect(page.locator('.planning-issues')).toContainText('Use valid HH:MM planning times.');
  await expect(page.getByRole('button', { name: 'Download review' })).toHaveCount(0);
  await page.getByLabel('Arrival deadline', { exact: true }).fill('06:30');
  for (const width of [1440, 1100, 1024, 900, 768, 640, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    const panel = (await conditions.boundingBox())!;
    const moon = (await page.locator('.sun').boundingBox())!;
    const art = (await page.locator('.hero-art').boundingBox())!;
    expect(
      panel.x + panel.width <= moon.x ||
        moon.x + moon.width <= panel.x ||
        panel.y + panel.height <= moon.y ||
        moon.y + moon.height <= panel.y,
    ).toBe(true);
    expect(panel.x).toBeGreaterThanOrEqual(art.x);
    expect(panel.x + panel.width).toBeLessThanOrEqual(art.x + art.width);
    expect(moon.x).toBeGreaterThanOrEqual(art.x);
    expect(moon.x + moon.width).toBeLessThanOrEqual(art.x + art.width);
    expect(
      await page.locator('.hero-art').evaluate((el) => {
        const s = getComputedStyle(el);
        return new Set([
          s.borderTopLeftRadius,
          s.borderTopRightRadius,
          s.borderBottomLeftRadius,
          s.borderBottomRightRadius,
        ]).size;
      }),
    ).toBe(1);
    expect(await conditions.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (width === 390)
      await page.locator('.hero').screenshot({ path: 'docs/arrival-weather-mobile.png' });
  }
});

test('current clock advances by the minute and changes date at Pittsburgh midnight', async ({
  page,
}) => {
  await page.route('https://api.weather.gov/**', (route) =>
    route.fulfill({ status: 503, body: '' }),
  );
  await page.clock.install({ time: new Date('2026-09-22T03:59:30Z') });
  await page.goto('./');
  await expect(page.locator('.hero-badge b')).toHaveText('11:59 PM ET');
  await expect(page.getByRole('timer')).toContainText('Mon, Sep 21, 2026');
  await page.clock.runFor(31000);
  await expect(page.locator('.hero-badge b')).toHaveText('12:00 AM ET');
  await expect(page.getByRole('timer')).toContainText('Tue, Sep 22, 2026');
  await page.clock.setSystemTime(new Date('2026-09-22T12:34:00Z'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.hero-badge b')).toHaveText('08:34 AM ET');
});

test('missing or stale observations stay empty without blocking planning', async ({ page }) => {
  await installTomTomFixture(page);
  await page.route('https://api.weather.gov/**', (route) =>
    route.fulfill({ status: 503, body: '' }),
  );
  await page.route('https://api.waterdata.usgs.gov/**', (route) =>
    route.fulfill({ status: 503, body: '' }),
  );
  await page.goto('./');
  const temperature = page.getByRole('link', { name: /^Temperature:/ });
  const flow = page.getByRole('link', { name: /^Water flow/ });
  await expect(temperature).toContainText('—');
  await expect(flow).toContainText('—');
  await uploadInputs(page, browserData());
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A seat for everyone.' })).toBeVisible();
  await page.route('https://api.weather.gov/**', (route) =>
    route.fulfill({
      json: {
        properties: {
          timestamp: '2026-09-20T12:00:00Z',
          textDescription: 'Clear',
          temperature: { value: 17, unitCode: 'wmoUnit:degC' },
          windSpeed: { value: null },
        },
      },
    }),
  );
  await page.reload();
  await expect(temperature).toHaveAttribute('title', /out of date/);
  await expect(temperature.locator('strong')).toHaveText('—');
});
