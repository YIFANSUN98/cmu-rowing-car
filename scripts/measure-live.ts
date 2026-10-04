import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Read-only production checks; report timings/statuses, never keys or plan contents.
const config = JSON.parse(await readFile('data/private/cloud/deployment.json', 'utf8'));
const rows = (await readFile('data/private/server/access-keys.txt', 'utf8')).split(/\r?\n/);
const key = rows.map((line) => /^Team:\s*(.*)$/i.exec(line.trim())?.[1]).find(Boolean);
if (!key) throw new Error('The local team key is required for authenticated speed checks.');
const origin = config.origin;
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? '/usr/bin/google-chrome',
  headless: true,
});
const report: {
  origin: string;
  measuredAt: string;
  runs: Record<string, unknown>[];
} = { origin, measuredAt: new Date().toISOString(), runs: [] };
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const requests: { path: string; status?: number; ms: number }[] = [];
    page.on('requestfinished', async (request) => {
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname.startsWith('/api/')) {
        requests.push({
          path: url.pathname,
          status: (await request.response())?.status(),
          ms: Math.round(request.timing().responseEnd),
        });
      }
    });
    const run: Record<string, unknown> = { viewport, requests, reloadMs: [] };
    try {
      let start = performance.now();
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Access key', { exact: true }).waitFor({ timeout: 45000 });
      run.loginFormMs = Math.round(performance.now() - start);
      await page.getByLabel('Access key', { exact: true }).fill(key);
      const loginResponse = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/login',
      );
      start = performance.now();
      await page.getByRole('button', { name: 'Enter planner' }).click();
      await page.locator('#results').waitFor({ timeout: 45000 });
      run.signInToRoutesMs = Math.round(performance.now() - start);
      const login = await (await loginResponse).json();
      run.combinedStartup = 'publication' in login;
      for (let repeat = 0; repeat < 3; repeat++) {
        start = performance.now();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('#results').waitFor({ timeout: 45000 });
        (run.reloadMs as number[]).push(Math.round(performance.now() - start));
      }
      await page
        .locator('#results button[aria-expanded]')
        .first()
        .evaluate((button) => {
          button.addEventListener(
            'click',
            () => {
              const timings = window as Window & { routeOpenedAt?: number };
              timings.routeOpenedAt = performance.now();
            },
            { once: true },
          );
        });
      start = performance.now();
      await page.locator('#results button[aria-expanded]').first().click();
      await page.locator('.route-road').first().waitFor({ timeout: 15000 });
      run.routeLineMs = Math.round(performance.now() - start);
      run.mapRenderAfterClickMs = await page.evaluate(() => {
        const timings = window as Window & { routeOpenedAt?: number };
        return Math.round(performance.now() - timings.routeOpenedAt!);
      });
      run.inputsDenied = (await context.request.get(origin + '/api/inputs')).status() === 403;
      run.passed = true;
    } catch (error) {
      run.passed = false;
      run.errorType = (error as Error).name;
      process.exitCode = 1;
    } finally {
      try {
        await page.getByRole('button', { name: 'Sign out', exact: true }).click({ timeout: 2000 });
        await page.getByLabel('Access key', { exact: true }).waitFor({ timeout: 45000 });
      } catch {
        /* The isolated context is closed even if the logout bridge is unavailable. */
      }
      await context.close();
    }
    report.runs.push(run);
    console.log(JSON.stringify(run));
  }
} finally {
  await browser.close();
  await mkdir('data/private/cloud', { recursive: true, mode: 0o700 });
  await writeFile(
    resolve('data/private/cloud/loading-speed.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
}
