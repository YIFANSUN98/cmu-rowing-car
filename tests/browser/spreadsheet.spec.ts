import { test, expect } from '../fixtures/access';
import * as XLSX from 'xlsx';
import fs from 'node:fs';
import {
  browserData,
  installTomTomFixture,
  uploadInputs,
  uploadWorkbook,
} from '../fixtures/browser';
import { inputWorkbook, workbookBytes } from '../fixtures/workbooks';
import { headers } from '../../src/domain/validation';
import { inputLabels, simpleHeaders } from '../../src/importers/friendlySchema';

test('date grids default empty attendance to No and replan when it becomes Yes', async ({
  page,
}) => {
  await installTomTomFixture(page);
  await page.goto('./');
  const names = [
    'Avery Example',
    'Blair Example',
    'Casey Example',
    'Devon Example',
    'Ellis Example',
  ];
  const makeBook = (kind: 'members' | 'attendance' | 'availability', unanswered = false) => {
    const rows =
      kind === 'members'
        ? [
            ['Name', 'Pickup address'],
            ...names.map((name, index) => [name, `${10 + index * 10} Fiction Lane`]),
          ]
        : [
            ['Name', '2026-10-06'],
            ...names.map((name, index) => [
              name,
              kind === 'attendance'
                ? unanswered && index === 1
                  ? ''
                  : 'Yes'
                : index === 0
                  ? 'Yes'
                  : 'No',
            ]),
          ];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), inputLabels[kind]);
    return book;
  };
  await page.getByLabel('Upload Excel files').setInputFiles(
    (['availability', 'attendance', 'members'] as const).map((kind, index) => ({
      name: `download-${index}.xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(workbookBytes(makeBook(kind, true))),
    })),
  );
  await expect(page.locator('.upload-status .loaded')).toHaveCount(3);
  await expect(page.locator('.issues')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A seat for everyone.' })).toBeVisible();
  await expect(page.locator('.car-card')).not.toContainText('Blair Example');
  await uploadWorkbook(page, 'attendance', makeBook('attendance'));
  await expect(page.locator('.issues')).toHaveCount(0);
  await page.getByRole('button', { name: 'Replan week', exact: true }).click();
  await expect(page.getByText('Stale · comparison only')).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByRole('heading', { name: 'A seat for everyone.' })).toBeVisible();
  await expect(page.locator('.car-card')).toHaveCount(1);
  for (const name of names) await expect(page.locator('.car-card')).toContainText(name);
});

test('one selection detects all three renamed files in any order', async ({ page }) => {
  await installTomTomFixture(page);
  await page.goto('./');
  const data = browserData();
  await page.getByLabel('Upload Excel files').setInputFiles(
    (['availability', 'attendance', 'members'] as const).map((kind, i) => ({
      name: `download (${i + 1}).xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(workbookBytes(inputWorkbook(data, kind))),
    })),
  );
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeEnabled();
  const status = page.getByRole('list', { name: 'Detected files' });
  await expect(status.getByRole('listitem').filter({ hasText: 'Members' })).toContainText(
    'download (3).xlsx',
  );
  await expect(status.getByRole('listitem').filter({ hasText: 'Attendance' })).toContainText(
    'download (2).xlsx',
  );
  await expect(status.getByRole('listitem').filter({ hasText: 'Drivers' })).toContainText(
    'download (1).xlsx',
  );
  expect(await page.evaluate(() => (window as any).__tomtomCalls)).toEqual([]);
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A seat for everyone.' })).toBeVisible();
});

test('a combined workbook can be dropped into the same upload area', async ({ page }) => {
  await installTomTomFixture(page);
  await page.goto('./');
  const data = browserData();
  const book = XLSX.utils.book_new();
  for (const kind of ['members', 'attendance', 'availability'] as const) {
    const input = inputWorkbook(data, kind);
    XLSX.utils.book_append_sheet(book, input.Sheets[input.SheetNames[0]], inputLabels[kind]);
  }
  const transfer = await page.evaluateHandle(
    (bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], 'week.xlsx', {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      );
      return transfer;
    },
    Array.from(new Uint8Array(workbookBytes(book))),
  );
  await page.locator('.upload-panel').dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeEnabled();
  await expect(page.getByRole('listitem').filter({ hasText: 'week.xlsx' })).toHaveCount(3);
});

test('duplicate selections are rejected together and missing files can be added', async ({
  page,
}) => {
  await installTomTomFixture(page);
  await page.goto('./');
  const data = browserData();
  const input = page.getByLabel('Upload Excel files');
  await input.setInputFiles(
    ['first.xlsx', 'second.xlsx'].map((name) => ({
      name,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(workbookBytes(inputWorkbook(data, 'members'))),
    })),
  );
  await expect(page.getByRole('alert')).toContainText('Members was also found');
  await expect(page.locator('.upload-status .loaded')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeDisabled();
  await uploadWorkbook(page, 'members', inputWorkbook(data, 'members'));
  await expect(page.getByText('Still needed: Attendance, Drivers.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeDisabled();
  await input.setInputFiles(
    (['availability', 'attendance'] as const).map((kind) => ({
      name: `${kind}.xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(workbookBytes(inputWorkbook(data, kind))),
    })),
  );
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('XLSX templates match every upload and only XLSX is accepted', async ({ page }) => {
  await page.goto('./');
  const kinds = ['members', 'attendance', 'availability'] as const;
  await expect(page.locator('input[type=file]')).toHaveCount(1);
  await expect(page.getByLabel('Upload Excel files')).toHaveAttribute('multiple');
  await page.getByText('Excel templates', { exact: true }).click();
  for (let i = 0; i < kinds.length; i++) {
    await expect(page.getByLabel('Upload Excel files')).toHaveAttribute(
      'accept',
      '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: `${inputLabels[kinds[i]]} template` }).click();
    const downloaded = await pending;
    expect(downloaded.suggestedFilename()).toBe(
      `${kinds[i] === 'availability' ? 'drivers' : kinds[i]}.xlsx`,
    );
    const book = XLSX.read(fs.readFileSync((await downloaded.path())!));
    const columns = XLSX.utils.sheet_to_json<string[]>(book.Sheets[book.SheetNames[0]], {
      header: 1,
    })[0];
    if (kinds[i] === 'members') expect(columns).toEqual(simpleHeaders.members);
    else {
      expect(columns[0]).toBe('Name');
      expect(columns.length).toBeGreaterThan(1);
      expect(columns.slice(1).every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))).toBe(true);
      expect(columns).not.toContain('Seats (including driver)');
    }
  }
});

test('CSV and XLS uploads are rejected; a valid XLSX replacement recovers', async ({ page }) => {
  await installTomTomFixture(page);
  await page.goto('./');
  const data = browserData();
  await uploadInputs(page, data);
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeEnabled();
  for (const ext of ['csv', 'xls']) {
    await page.getByLabel('Upload Excel files', { exact: true }).setInputFiles({
      name: `members.${ext}`,
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('not an xlsx'),
    });
    await expect(page.getByRole('alert')).toContainText('Choose .xlsx files');
    await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeDisabled();
    await uploadWorkbook(page, 'members', inputWorkbook(data, 'members'));
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeEnabled();
  }
});

test('XLSX validation keeps original Excel row numbers after blank and multiline cells', async ({
  page,
}) => {
  await installTomTomFixture(page);
  await page.goto('./');
  const data = browserData();
  await uploadInputs(page, data);
  const row = headers.attendance.map(
    (h) => (data.attendance[0] as unknown as Record<string, string>)[h] ?? '',
  );
  row[6] = 'Note,\nwith another line';
  const invalid = [...row];
  invalid[0] = '2026-10-06';
  invalid[2] = 'maybe';
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([headers.attendance, row, [], invalid]),
    'Attendance',
  );
  await uploadWorkbook(page, 'attendance', book);
  await expect(page.getByText(/attendance.xlsx · Attendance · row 4/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeDisabled();
  await uploadWorkbook(page, 'attendance', inputWorkbook(data, 'attendance'));
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeEnabled();
});

test('unreadable XLSX blocks planning and recovers after a valid replacement', async ({ page }) => {
  await installTomTomFixture(page);
  await page.goto('./');
  const data = browserData();
  await uploadInputs(page, data);
  await page.getByLabel('Upload Excel files', { exact: true }).setInputFiles({
    name: 'bad.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('<html>Download failed</html>'),
  });
  await expect(page.getByRole('alert')).toContainText('not a readable .xlsx workbook');
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeDisabled();
  await uploadWorkbook(page, 'members', inputWorkbook(data, 'members'));
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeEnabled();
});

test('unreviewed uploads cannot be silently converted into hypothetical online inputs', async ({
  page,
}) => {
  await installTomTomFixture(page);
  await page.goto('./');
  const data = browserData();
  const pickup = data.members[0].pickup_address;
  data.members[0].pickup_address = '';
  data.members[0].pickup_lat = undefined;
  data.members[0].pickup_lng = undefined;
  data.attendance[1].attending = 'unknown';
  await uploadInputs(page, data);
  await expect(page.locator('.issues')).toContainText('Attendance remains unknown');
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeDisabled();
  await expect(page.locator('.preview, .upload-test, .scenario-panel')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__tomtomCalls)).toEqual([]);
  data.members[0].pickup_address = pickup;
  data.attendance[1].attending = 'true';
  await uploadWorkbook(page, 'members', inputWorkbook(data, 'members'));
  await uploadWorkbook(page, 'attendance', inputWorkbook(data, 'attendance'));
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeEnabled();
});

test('simple sheets use pickup addresses directly and put all attendees in the carpool', async ({
  page,
}) => {
  await installTomTomFixture(page);
  await page.goto('./');
  const rows = {
    members: [
      ['Avery Example', '10 Fiction Lane'],
      ['Blair Example', ''],
      ['Casey Example', '30 Fiction Lane'],
      ['Devon Example', '40 Fiction Lane'],
    ],
    attendance: [
      ['2026-10-06', 'Avery Example', 'Yes'],
      ['2026-10-07', 'Avery Example', 'Yes'],
      ['2026-10-06', 'Blair Example', 'Yes'],
      ['2026-10-07', 'Blair Example', 'Yes'],
      ['2026-10-06', 'Casey Example', 'Not sure'],
      ['2026-10-06', 'Devon Example', 'Yes'],
    ],
    availability: [
      ['2026-10-06', 'Avery Example', 'Yes', '4'],
      ['2026-10-07', 'Avery Example', 'Yes', '4'],
      ['2026-10-06', 'Blair Example', 'No', ''],
      ['2026-10-07', 'Blair Example', 'No', ''],
      ['2026-10-06', 'Devon Example', 'No', ''],
    ],
  };
  async function upload(kind: keyof typeof rows) {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([simpleHeaders[kind], ...rows[kind]]),
      kind === 'availability' ? 'Drivers' : kind === 'members' ? 'Members' : 'Attendance',
    );
    await uploadWorkbook(page, kind, book);
  }
  for (const kind of ['members', 'attendance', 'availability'] as const) await upload(kind);
  const panel = page.locator('.issues');
  await expect(panel.locator(':scope > summary')).toHaveText('2 items need review');
  await expect(panel.locator('li.error')).toHaveCount(2);
  await expect(panel).toContainText('Enter a pickup address');
  await expect(panel).toContainText('“Yes” or “No” under “Attending?”');
  await expect(panel).not.toContainText('Pickup confirmed?');
  await expect(panel).not.toContainText('Travel');
  await expect(panel).not.toContainText('pickup_status');
  await expect(panel).not.toContainText('pickup_override');
  await expect(panel).not.toContainText('member_id');
  await expect(panel.locator('.review-notices')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeDisabled();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download review (.xlsx)' }).click();
  const downloaded = await pending;
  expect(downloaded.suggestedFilename()).toBe('input-review.xlsx');
  const book = XLSX.read(fs.readFileSync((await downloaded.path())!));
  const required = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    book.Sheets['Required changes'],
  );
  expect(required).toHaveLength(2);
  expect(required.find((row) => row.Name === 'Blair Example')).toMatchObject({
    File: 'members.xlsx · Members',
    Row: 3,
    Dates: '2026-10-06, 2026-10-07',
    Column: 'Pickup address',
  });
  expect(book.SheetNames).not.toContain('Notices');
  rows.members[1][1] = '20 Fiction Lane';
  rows.attendance[4][2] = 'No';
  await upload('members');
  await upload('attendance');
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Plan week', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Plan week', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('.car-card')).toHaveCount(1);
  await expect(page.locator('.car-card')).toContainText('Blair Example');
  await expect(page.locator('.car-card')).toContainText('Devon Example');
  await page.getByRole('tab').nth(1).click();
  await expect(page.locator('.car-card')).toHaveCount(1);
  await expect(page.locator('.car-card')).toContainText('Blair Example');
  expect(await page.evaluate(() => (window as any).__tomtomCalls)).toContain('matrix');
});
