import { test, expect, type Page } from '@playwright/test';
import { ADMIN_KEY, TEAM_KEY, TEST_API, TEST_ORIGIN } from '../fixtures/access';
import {
  browserData,
  installTomTomFixture,
  uploadInputs,
  uploadWorkbook,
} from '../fixtures/browser';
import { inputWorkbook } from '../fixtures/workbooks';

async function enter(page: Page, key: string) {
  await page.getByLabel('Access key', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Enter planner' }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}

test('admin publishes routes; team only sees those routes; both keys rotate online and revoke sessions', async ({
  page,
  browser,
}) => {
  const teamContext = await browser.newContext(),
    teamPage = await teamContext.newPage();
  let currentAdmin = ADMIN_KEY,
    currentTeam = TEAM_KEY;
  const nextAdmin = 'Ax7!m2Qp',
    nextTeam = 'Tx4!z6Wq';
  try {
    await installTomTomFixture(page);
    await page.goto('./');
    await expect(page.getByLabel('Upload Excel files')).toHaveCount(0);
    await expect(page.getByRole('contentinfo')).toContainText('Website owned by CMU Rowing');
    await expect(page.getByRole('contentinfo')).toContainText('Developed by Yifan Sun');
    await expect(
      page.getByRole('contentinfo').getByRole('link', { name: 'yifansu2@andrew.cmu.edu' }),
    ).toHaveAttribute('href', 'mailto:yifansu2@andrew.cmu.edu');
    await enter(page, ADMIN_KEY);
    await expect(
      page.getByRole('navigation', { name: 'Club access' }).getByRole('button'),
    ).toHaveText(['Plan the route', 'View published plan', 'Manage access', 'Sign out']);
    const data = browserData();
    data.members.push({
      member_id: 'unused-private-person',
      display_name: 'Unscheduled Private Person',
      pickup_address: '123 Private Address',
    });
    await uploadInputs(page, data);
    await expect(page.getByRole('button', { name: 'Publish to team', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Plan week', exact: false }).click();
    await expect(page.getByRole('button', { name: 'Publish to team', exact: true })).toBeEnabled({
      timeout: 30000,
    });
    await page.getByRole('button', { name: 'Publish to team', exact: true }).click();
    await expect(
      page.getByText('Published. Drivers and rowers can now view this plan.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Manage access' }).click();
    await expect(page.getByLabel('Upload Excel files')).toBeHidden();
    await page.getByLabel('Current admin key', { exact: true }).fill('unfinished-entry');
    await page.getByRole('button', { name: 'View published plan' }).click();
    await expect(page.getByLabel('Current admin key', { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Show route', exact: false }).first(),
    ).toBeVisible();
    await expect(page.locator('.published-meta')).toContainText(/Published .+ ET/);
    await expect(page.getByRole('button', { name: 'Refresh plan' })).toHaveCount(0);
    await expect(page.getByRole('contentinfo')).toHaveCount(1);
    const refreshed = page.waitForResponse(
      (response) =>
        response.url().split('?')[0] === TEST_API + 'plan' && response.request().method() === 'GET',
    );
    await page.getByRole('button', { name: 'View published plan' }).click();
    await refreshed;
    await page.getByRole('button', { name: 'Manage access' }).click();
    await expect(page.getByLabel('Current admin key', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Plan the route', exact: true }).click();
    await expect(page.getByLabel('Current admin key', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Upload Excel files')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replan week', exact: false })).toBeEnabled();

    await installTomTomFixture(teamPage);
    const requested: string[] = [];
    teamPage.on('request', (req) => requested.push(req.url()));
    await teamPage.goto(TEST_ORIGIN + '/cmu-rowing-car/');
    await enter(teamPage, TEAM_KEY);
    await expect(
      teamPage.getByRole('button', { name: 'Show route', exact: false }).first(),
    ).toBeVisible();
    await expect(teamPage.getByLabel('Upload Excel files')).toHaveCount(0);
    await expect(teamPage.getByRole('button', { name: 'Manage access' })).toHaveCount(0);
    await expect(teamPage.getByRole('button', { name: 'Refresh plan' })).toHaveCount(0);
    await expect(teamPage.locator('.published-meta')).toContainText(/Published .+ ET/);
    await expect(teamPage.getByRole('contentinfo')).toContainText('Developed by Yifan Sun');
    await expect(teamPage.getByText('Unscheduled Private Person')).toHaveCount(0);
    await teamPage.getByRole('button', { name: 'Show route', exact: false }).first().click();
    await expect(teamPage.getByRole('region', { name: /Route map/ })).toBeVisible();
    const download = teamPage.waitForEvent('download');
    await teamPage.getByRole('button', { name: 'Download Excel' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
    expect(requested.some((url) => url.includes('/api/inputs'))).toBe(false);
    const published = await teamContext.request.get(TEST_API + 'plan');
    expect(await published.text()).not.toMatch(/Unscheduled|member_id|availability|PRIVATE/);
    expect((await teamContext.request.get(TEST_API + 'inputs')).status()).toBe(403);

    await page.getByRole('button', { name: 'Manage access' }).click();
    await page.getByLabel('Current admin key', { exact: true }).fill(ADMIN_KEY);
    await page.getByLabel('New access key', { exact: true }).fill(nextTeam);
    await page.getByLabel('Confirm new access key', { exact: true }).fill(nextTeam);
    await page.getByRole('button', { name: 'Change access key', exact: true }).click();
    await expect(
      page.getByText('Team key changed. Previous team sessions are signed out.', { exact: true }),
    ).toBeVisible();
    currentTeam = nextTeam;
    await teamPage.reload();
    await expect(teamPage.getByLabel('Access key', { exact: true })).toBeVisible();
    expect(
      (
        await teamContext.request.post(TEST_API + 'login', {
          headers: { Origin: TEST_ORIGIN },
          data: { key: TEAM_KEY },
        })
      ).status(),
    ).toBe(401);
    await enter(teamPage, nextTeam);
    await expect(
      teamPage.getByRole('button', { name: 'Show route', exact: false }).first(),
    ).toBeVisible();

    await page.getByLabel('Key to change').selectOption('admin');
    await page.getByLabel('Current admin key', { exact: true }).fill(ADMIN_KEY);
    await page.getByLabel('New access key', { exact: true }).fill(nextAdmin);
    await page.getByLabel('Confirm new access key', { exact: true }).fill(nextAdmin);
    await page.getByRole('button', { name: 'Change access key', exact: true }).click();
    await expect(page.getByLabel('Access key', { exact: true })).toBeVisible();
    currentAdmin = nextAdmin;
    await enter(page, nextAdmin);
    await page.getByText('Private Excel files · admin only', { exact: true }).click();
    await page.getByRole('button', { name: 'Load saved files', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Plan week', exact: false })).toBeEnabled();
    await page.getByRole('button', { name: 'Unpublish plan' }).click();
    await teamPage.reload();
    await expect(teamPage.getByText('No plan published yet.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Access key', { exact: true })).toBeVisible();
    expect((await page.request.get(TEST_API + 'inputs')).status()).toBe(401);
  } finally {
    // Restore the isolated test server's known keys for the remaining browser tests.
    const response = await page.request.post(TEST_API + 'login', {
      headers: { Origin: TEST_ORIGIN },
      data: { key: currentAdmin },
    });
    const { csrf } = await response.json();
    const headers = { Origin: TEST_ORIGIN, 'X-CSRF-Token': csrf };
    if (currentTeam !== TEAM_KEY)
      await page.request.post(TEST_API + 'password', {
        headers,
        data: { role: 'team', currentKey: currentAdmin, newKey: TEAM_KEY },
      });
    if (currentAdmin !== ADMIN_KEY)
      await page.request.post(TEST_API + 'password', {
        headers,
        data: { role: 'admin', currentKey: currentAdmin, newKey: ADMIN_KEY },
      });
    await teamContext.close();
  }
});

test('saved files preserve partial replacements from a combined workbook', async ({ page }) => {
  await installTomTomFixture(page);
  await page.goto('./');
  await enter(page, ADMIN_KEY);
  const data = browserData();
  const combined = inputWorkbook(data, 'members');
  for (const kind of ['attendance', 'availability'] as const) {
    const book = inputWorkbook(data, kind);
    combined.SheetNames.push(...book.SheetNames);
    Object.assign(combined.Sheets, book.Sheets);
  }
  await uploadWorkbook(page, 'members', combined, 'combined.xlsx');
  const replacement = structuredClone(data);
  replacement.members[0].display_name = 'Replacement Name';
  await uploadWorkbook(page, 'members', inputWorkbook(replacement, 'members'), 'members.xlsx');
  await page.getByText('Private Excel files · admin only', { exact: true }).click();
  await page.getByRole('button', { name: 'Save Excel files', exact: true }).click();
  await expect(page.getByRole('link', { name: 'members.xlsx ↓', exact: true })).toBeVisible();
  await page.reload();
  await page.getByText('Private Excel files · admin only', { exact: true }).click();
  await page.getByRole('button', { name: 'Load saved files', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Plan week', exact: false })).toBeEnabled();
  await expect(page.getByText('Members was also found', { exact: false })).toHaveCount(0);
});

test('a slow Excel save overlaps route solving and verification', async ({ page }) => {
  await installTomTomFixture(page);
  await page.goto('./');
  await enter(page, ADMIN_KEY);
  await uploadInputs(page, browserData());
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/inputs', async (route) => {
    if (route.request().method() === 'PUT') await waiting;
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: 'Plan week', exact: false }).click();
    await expect(page.getByText('Route checks', { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('button', { name: 'Publish to team', exact: true })).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole('button', { name: 'Publish to team', exact: true })).toBeEnabled({
    timeout: 30000,
  });
});

test('a transient published-plan failure retries before the next polling interval', async ({
  page,
}) => {
  await page.goto('./');
  await enter(page, TEAM_KEY);
  let reads = 0;
  await page.route('**/api/plan*', async (route) => {
    reads++;
    if (reads === 1)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Temporary storage failure.' }),
      });
    else await route.continue();
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => reads, { timeout: 5000 }).toBe(2);
  await expect(page.getByText('Temporary storage failure.', { exact: true })).toHaveCount(0);
});
