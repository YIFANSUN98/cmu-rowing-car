import { expect, test, type Page } from '@playwright/test';
import { adminKey, teamKey } from '../cloud/host.ts';
import { browserData, installTomTomFixture, uploadInputs } from '../fixtures/browser.ts';
const enter = async (page: Page, key: string) => {
  await page.getByLabel('Access key', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Enter planner' }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
};
test('cloud root URL supports mobile planning, publication, route maps, downloads, and team restrictions', async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installTomTomFixture(page);
  const inputRequests: string[] = [];
  let routingRequests = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/inputs') inputRequests.push(request.method());
    if (url.hostname === 'api.tomtom.com' && !url.pathname.includes('/map/')) routingRequests++;
  });
  await page.goto('/');
  await enter(page, adminKey);
  await expect(page.getByLabel('Upload Excel files')).toBeVisible();
  expect(inputRequests).toEqual([]);
  await uploadInputs(page, browserData());
  await page.getByRole('button', { name: 'Plan week', exact: false }).click();
  await expect(page.getByRole('button', { name: 'Publish to team', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  const firstRoutingRequests = routingRequests;
  await page.getByRole('button', { name: 'Replan week', exact: false }).click();
  await expect(page.getByRole('button', { name: 'Replan week', exact: false })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Publish to team', exact: true })).toBeEnabled();
  expect(inputRequests).toEqual(['PUT']);
  expect(routingRequests).toBe(firstRoutingRequests);
  await page.getByRole('button', { name: 'Publish to team', exact: true }).click();
  await expect(
    page.getByText('Published. Drivers and rowers can now view this plan.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Manage access' }).click();
  await expect(page.getByLabel('Upload Excel files')).toBeHidden();
  await page.route('**/api/plan?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });
  const refresh = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/plan' && response.request().method() === 'GET',
  );
  await page.getByRole('button', { name: 'View published plan' }).click();
  await expect(page.getByRole('button', { name: 'Show route', exact: false }).first()).toBeVisible({
    timeout: 500,
  });
  expect(await (await refresh).json()).toEqual({ unchanged: true });
  await expect(page.getByLabel('Current admin key', { exact: true })).toHaveCount(0);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const team = await context.newPage();
  const teamReads: string[] = [];
  team.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/'))
      teamReads.push(new URL(request.url()).pathname);
  });
  await installTomTomFixture(team);
  await team.goto('http://127.0.0.1:4176/');
  await enter(team, teamKey);
  await expect(team.getByLabel('Upload Excel files')).toHaveCount(0);
  await expect(team.locator('.published-meta')).toContainText('Published');
  expect(teamReads).not.toContain('/api/plan'); // Login includes the current plan in one round trip.
  await team.getByRole('button', { name: 'Show route', exact: false }).first().click();
  await expect(team.locator('.route-road').first()).toBeVisible({ timeout: 500 });
  await expect(team.getByRole('region', { name: /Route map/ }).first()).toBeVisible();
  const download = team.waitForEvent('download');
  await team.getByRole('button', { name: 'Download Excel' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
  expect((await context.request.get('http://127.0.0.1:4176/api/inputs')).status()).toBe(403);
  expect((await context.request.get('http://127.0.0.1:4176/api/inputs/0')).status()).toBe(403);
  for (const p of [page, team])
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await team.reload();
  await expect(team.locator('.published-meta')).toBeVisible();
  expect(teamReads).not.toContain('/api/plan'); // Session startup also includes it.
  await team.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(team.getByLabel('Access key', { exact: true })).toBeVisible();
  await context.close();
});
