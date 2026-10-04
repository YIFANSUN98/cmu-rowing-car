import { test, expect } from '../fixtures/access';
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { browserData, installTomTomFixture, uploadInputs } from '../fixtures/browser';

test('shows planning stages, downloads compact daily Excel without routing again, and prevents stale downloads', async ({
  page,
}) => {
  await installTomTomFixture(page);
  await page.goto('./');
  await page.evaluate(() => {
    const stages: string[] = [];
    const percentages: number[] = [];
    (window as any).__planningStages = stages;
    (window as any).__planningPercentages = percentages;
    new MutationObserver(() => {
      const value = document
        .querySelector('[aria-label="Planning progress"]')
        ?.getAttribute('aria-valuetext');
      if (value) stages.push(value);
      const percent = document
        .querySelector('[aria-label="Planning progress"]')
        ?.getAttribute('aria-valuenow');
      if (percent !== null && percent !== undefined) percentages.push(Number(percent));
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
    const fetch = window.fetch.bind(window);
    let paused = false;
    window.fetch = async (input, init) => {
      if (
        !paused &&
        String(input).includes('api.tomtom.com') &&
        typeof init?.body === 'string' &&
        JSON.parse(init.body).batchItems?.[0]?.post
      ) {
        paused = true;
        await new Promise<void>((resolve) => {
          (window as any).__releaseRouteChecks = resolve;
        });
      }
      return fetch(input, init);
    };
  });
  await expect(page.getByRole('button', { name: 'Download Excel' })).toHaveCount(0);
  const data = browserData();
  data.attendance.push(...data.attendance.map((a) => ({ ...a, date: '2026-10-06' })));
  data.availability.push(...data.availability.map((a) => ({ ...a, date: '2026-10-06' })));
  await uploadInputs(page, data);
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  const progress = page.getByRole('progressbar', { name: 'Planning progress' });
  await expect(progress).toHaveAttribute('aria-valuetext', /Step 3 of 3: Route checks/);
  await page.waitForFunction(() => typeof (window as any).__releaseRouteChecks === 'function');
  expect(Number(await progress.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(75);
  expect(Number(await progress.getAttribute('aria-valuenow'))).toBeLessThan(100);
  expect(await progress.locator('span').evaluate((el) => getComputedStyle(el).animationName)).toBe(
    'none',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.plan-bar').screenshot({ path: 'docs/planning-progress-mobile.png' });
  await page.evaluate(() => (window as any).__releaseRouteChecks());
  await expect(page.getByRole('heading', { name: 'A seat for everyone.' })).toBeVisible();
  await expect(progress).toHaveAttribute('aria-valuenow', '100');
  const stages = await page.evaluate(() => (window as any).__planningStages as string[]);
  for (const step of [1, 2, 3])
    expect(stages.some((s) => s.includes(`Step ${step} of 3`))).toBe(true);
  const percentages = await page.evaluate(() => (window as any).__planningPercentages as number[]);
  expect(percentages.length).toBeGreaterThan(3);
  expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
  await page.getByRole('tablist', { name: 'Practice days' }).getByRole('tab').last().click();
  const calls = await page.evaluate(() => (window as any).__tomtomCalls.length);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Excel' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('cmu-rowing-routes_2026-10-05_to_2026-10-06.xlsx');
  const book = XLSX.read(fs.readFileSync((await download.path())!), { cellNF: true });
  expect(book.SheetNames).toEqual(['2026-10-05', '2026-10-06']);
  for (const date of ['2026-10-05', '2026-10-06']) {
    const text = XLSX.utils.sheet_to_csv(book.Sheets[date]);
    expect(book.Sheets[date].A3.v).toBe('Car 1');
    expect(book.Sheets[date].B3.v).toBe('Time (ET)');
    expect(book.Sheets[date].C3.v).toBe('Street address');
    expect(book.Sheets[date].B4.z).toBe('hh:mm');
    const rows = XLSX.utils.sheet_to_json<string[]>(book.Sheets[date], { header: 1, raw: false });
    const car2 = rows.findIndex((row) => row[0] === 'Car 2');
    expect(car2).toBeGreaterThan(4);
    expect(rows[car2 - 1]).toEqual([]);
    expect(rows[car2 - 2][0]).toBe('Boathouse');
    expect(rows[car2][1]).toBe('Time (ET)');
    expect(rows[car2][2]).toBe('Street address');
    for (const row of rows.filter((row) => row[1] && row[1] !== 'Time (ET)')) {
      expect(row[1]).toMatch(/^\d{2}:\d{2}$/);
      expect(row[2]).toBeTruthy();
    }
    expect(text).toContain('300 Waterfront Dr');
    expect(text).not.toMatch(/Pittsburgh|\bPA\s+\d{5}/i);
    expect(rows.some((row) => /^\d+\. /.test(row[0] ?? ''))).toBe(false);
    expect(text).toContain('Boathouse');
    expect(text).toContain('America/New_York');
    for (const m of data.members) expect(text).toContain(m.display_name);
  }
  expect(await page.evaluate(() => (window as any).__tomtomCalls.length)).toBe(calls);
  await page
    .getByRole('button', { name: /Show route for/ })
    .first()
    .click();
  for (const time of await page.locator('.timeline time').allTextContents())
    expect(time).toMatch(/^\d{2}:\d{2}$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Download Excel' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page
    .locator('#results > .section-heading')
    .screenshot({ path: 'docs/excel-download-mobile.png' });
  await page.getByLabel('Arrival deadline', { exact: true }).fill('06:00');
  await expect(page.getByRole('button', { name: 'Download Excel' })).toBeDisabled();
});
