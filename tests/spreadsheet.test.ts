import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { normalizeUpload, workbookToCsv } from '../src/importers/spreadsheet';
import { makeDemo } from '../src/domain/scenarios';
import { headers, parseDataset } from '../src/domain/validation';
import { parseCsv } from '../src/importers/csv';
import { inputWorkbook, workbookBytes } from './fixtures/workbooks';

const demo = makeDemo({ people: 6, driverCount: 2 });
const file = (book: XLSX.WorkBook, ext: 'xlsx' | 'xls' = 'xlsx') =>
  new File([workbookBytes(book, ext)], `input.${ext}`);
describe.each(['xlsx'] as const)('%s upload', (ext) => {
  it.each([false, true])(
    'reads all three inputs, native booleans, and dates with date1904=%s',
    async (date1904) => {
      const texts = { members: '', attendance: '', availability: '' };
      for (const kind of ['members', 'attendance', 'availability'] as const) {
        const result = await normalizeUpload(file(inputWorkbook(demo, kind, date1904), ext), kind);
        texts[kind] = result.text;
      }
      const parsed = parseDataset(texts);
      expect(parsed.issues).toEqual([]);
      expect(parsed.data.members.map((m) => m.member_id)).toEqual(
        demo.members.map((m) => m.member_id).sort(),
      );
      expect(parsed.data.attendance[0].date).toBe('2026-10-05');
      expect(parsed.data.attendance[0].attending).toBe('true');
      expect(
        parsed.data.availability.find((v) => v.available === 'true')?.total_seats,
      ).toBeGreaterThan(0);
    },
  );
});
it('normalizes Excel times without depending on the browser timezone', async () => {
  const next = structuredClone(demo);
  next.attendance[0].ready_after = '04:07';
  next.availability[0].earliest_departure = '04:12';
  for (const [kind, field, expected] of [
    ['attendance', 'ready_after', '04:07'],
    ['availability', 'earliest_departure', '04:12'],
  ] as const) {
    const result = await normalizeUpload(file(inputWorkbook(next, kind)), kind);
    expect(parseCsv(result.text).rows[0][field]).toBe(expected);
  }
});
it('retains unknowns, formatted IDs, commas/newlines, empty cells and original row numbers', async () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    headers.attendance,
    ['2026-10-05', '001', 'unknown', 'unknown', '', '', 'A note,\nwith another line'],
    [],
    ['2026-10-06', '001', true, 'carpool'],
  ]);
  sheet.B2 = { t: 'n', v: 1, z: '000' };
  XLSX.utils.book_append_sheet(book, sheet, 'attendance');
  const result = await normalizeUpload(file(book), 'attendance');
  const parsed = parseCsv(result.text);
  expect(parsed.rows[0]).toMatchObject({
    member_id: '001',
    attending: 'unknown',
    notes: 'A note,\nwith another line',
    ready_after: '',
  });
  expect(parsed.rows[1].attending).toBe('true');
  expect(parsed.rowNumbers.map((line) => result.rowMap![line])).toEqual([2, 4]);
});
it('selects the matching named tab in a multi-tab workbook without combining inputs', () => {
  const book = inputWorkbook(demo, 'members');
  const other = inputWorkbook(demo, 'attendance');
  XLSX.utils.book_append_sheet(book, other.Sheets.attendance, 'attendance');
  expect(workbookToCsv(book, 'members').sheetName).toBe('members');
  expect(workbookToCsv(book, 'attendance').sheetName).toBe('attendance');
  expect(() => workbookToCsv(book, 'availability')).toThrow('Multiple possible tabs');
});
it('ignores hidden tabs but includes hidden rows in the selected table', () => {
  const book = inputWorkbook(demo, 'members');
  const sheet = book.Sheets.members;
  sheet['!rows'] = [undefined, { hidden: true }] as XLSX.RowInfo[];
  XLSX.utils.book_append_sheet(book, sheet, 'Notes');
  book.Workbook!.Sheets = [
    { name: 'members', Hidden: 0 },
    { name: 'Notes', Hidden: 1 },
  ];
  expect(parseCsv(workbookToCsv(book, 'members').text).rows).toHaveLength(6);
});
it('rejects missing headers, merges, ambiguous workbooks, and truncated ranges', () => {
  const wrong = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wrong,
    XLSX.utils.aoa_to_sheet([
      ['Rowers', 'Drivers'],
      ['Demo One', 'Demo Two'],
    ]),
    'Monday',
  );
  expect(() => workbookToCsv(wrong, 'members')).toThrow('missing columns');
  const book = inputWorkbook(demo, 'members');
  book.Sheets.members['!merges'] = [XLSX.utils.decode_range('A1:B1')];
  expect(() => workbookToCsv(book, 'members')).toThrow('unmerged');
  delete book.Sheets.members['!merges'];
  book.Sheets.members['!fullref'] = 'A1:G10001';
  expect(() => workbookToCsv(book, 'members')).toThrow('10,000');
});
it('rejects Excel errors and formulas without cached results, and accepts saved results', () => {
  const book = inputWorkbook(demo, 'attendance');
  book.Sheets.attendance.C2 = { t: 'b', f: '1=1', v: true };
  expect(parseCsv(workbookToCsv(book, 'attendance').text).rows[0].attending).toBe('true');
  delete book.Sheets.attendance.C2.v;
  expect(() => workbookToCsv(book, 'attendance')).toThrow('no saved result');
  book.Sheets.attendance.C2 = { t: 'e', v: 7 };
  expect(() => workbookToCsv(book, 'attendance')).toThrow('spreadsheet error');
});
it('does not silently drop a date time-component or time seconds', () => {
  const book = inputWorkbook(demo, 'attendance');
  book.Sheets.attendance.A2.v = Number(book.Sheets.attendance.A2.v) + 0.5;
  expect(() => workbookToCsv(book, 'attendance')).toThrow('without a time');
  const times = inputWorkbook(demo, 'attendance');
  times.Sheets.attendance.F2 = { t: 'n', v: (4 * 3600 + 1) / 86400, z: 'hh:mm:ss' };
  expect(() => workbookToCsv(times, 'attendance')).toThrow('whole minutes');
});
it('accepts uppercase .xlsx and rejects CSV, XLS, renamed workbooks, and oversized files', async () => {
  const bytes = workbookBytes(inputWorkbook(demo, 'members'));
  expect((await normalizeUpload(new File([bytes], 'members.XLSX'), 'members')).sheetName).toBe(
    'members',
  );
  for (const name of ['members.csv', 'members.CSV', 'members.xls', 'members.pdf'])
    await expect(normalizeUpload(new File([bytes], name), 'members')).rejects.toThrow('Only .xlsx');
  await expect(
    normalizeUpload(new File(['<html>Not a workbook</html>'], 'members.xlsx'), 'members'),
  ).rejects.toThrow('not a readable .xlsx');
  const renamed = XLSX.write(inputWorkbook(demo, 'members'), { type: 'array', bookType: 'xlsb' });
  await expect(normalizeUpload(new File([renamed], 'members.xlsx'), 'members')).rejects.toThrow(
    'Only .xlsx',
  );
  await expect(
    normalizeUpload(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'members.xlsx'), 'members'),
  ).rejects.toThrow('5 MB');
});
