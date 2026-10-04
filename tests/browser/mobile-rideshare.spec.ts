import { test, expect, TEAM_KEY, TEST_API, TEST_ORIGIN } from '../fixtures/access';
import { browserData, installTomTomFixture, uploadInputs } from '../fixtures/browser';

test('mobile admin and team can view car routes, open ordered Google Maps links, and see required Uber', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await installTomTomFixture(page);
  await page.goto('./');
  const data = browserData();
  data.attendance.forEach((a) => {
    a.attending = 'true';
    a.transport_mode = 'carpool';
  });
  data.members.forEach((m, i) => {
    m.pickup_address = `${10 + i} Fiction Lane`;
    m.pickup_lat = 40.43 + i * 0.001;
    m.pickup_lng = -79.94;
  });
  data.availability.forEach((a, i) => {
    a.available = i === 0 ? 'true' : 'false';
    a.total_seats = 5;
  });
  await uploadInputs(page, data);
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your rides, planned.' })).toBeVisible();
  await expect(page.locator('.uber-card')).toHaveCount(1);
  await expect(page.locator('.uber-card')).toContainText('BOOKING REQUIRED');
  const card = page.locator('.car-card:not(.uber-card)').first();
  await card.getByRole('button', { name: /Show route/ }).click();
  const link = card.getByRole('link', { name: /Open .* route in Google Maps/ });
  await expect(link).toBeVisible();
  const url = new URL((await link.getAttribute('href'))!);
  expect(url.origin).toBe('https://www.google.com');
  expect(url.searchParams.get('waypoints')!.split('|')).toHaveLength(4);
  await expect(card.getByText('Mobile browser: open in 2 parts', { exact: true })).toBeVisible();
  for (const width of [320, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `admin width ${width}`,
    ).toBe(true);
    const box = await link.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await card.screenshot({ path: 'docs/mobile-route-navigation.png' });
  await page.locator('.uber-card').screenshot({ path: 'docs/mobile-uber.png' });
  await page.getByRole('button', { name: 'Publish to team', exact: true }).click();
  await expect(
    page.getByText('Published. Drivers and rowers can now view this plan.', { exact: true }),
  ).toBeVisible();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  try {
    const response = await context.request.post(TEST_API + 'login', {
      headers: { Origin: TEST_ORIGIN },
      data: { key: TEAM_KEY },
    });
    expect(response.ok()).toBe(true);
    const team = await context.newPage();
    await installTomTomFixture(team);
    await team.goto('./');
    await expect(team.locator('.uber-card')).toBeVisible();
    await expect(team.getByLabel('Upload Excel files')).toHaveCount(0);
    await expect(team.getByRole('button', { name: 'Manage access' })).toHaveCount(0);
    await team
      .getByRole('button', { name: /Show route/ })
      .first()
      .tap();
    await expect(team.getByRole('link', { name: /Open .* route in Google Maps/ })).toHaveAttribute(
      'href',
      url.toString(),
    );
    expect(await team.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await team.screenshot({ path: 'docs/mobile-team-plan.png', fullPage: true });
  } finally {
    await context.close();
  }
  expect(errors).toEqual([]);
});

test('past-week comparison keeps uploaded dates, clearly labels future traffic estimates and cannot publish', async ({
  page,
}) => {
  await installTomTomFixture(page);
  await page.clock.setFixedTime(new Date('2026-09-24T20:00:00Z'));
  await page.goto('./');
  const data = browserData();
  data.attendance.forEach((a) => (a.date = '2026-09-21'));
  data.availability.forEach((a) => (a.date = '2026-09-21'));
  await uploadInputs(page, data);
  await page.getByRole('button', { name: 'Compare past week', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A seat for everyone.' })).toBeVisible();
  await expect(page.locator('#results')).toContainText('2026-09-28');
  await expect(
    page.getByRole('button', { name: /^(Publish to team|Update published plan)$/ }),
  ).toBeDisabled();
  await expect(
    page.getByText('Historical comparisons cannot be published as a live schedule.'),
  ).toBeVisible();
});
