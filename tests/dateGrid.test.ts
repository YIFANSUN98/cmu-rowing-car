import { expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { detectWorkbookInputs, normalizeSelectedUploads } from '../src/importers/uploadBatch';
import { workbookBytes } from './fixtures/workbooks';
import { parseUploads } from '../src/importers/friendly';
import { defaultSettings } from '../src/domain/types';
import { operationalIssues } from '../src/domain/validation';
import { locateOperationalIssues } from '../src/importers/issueLocations';

function grids() {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries({
    Members: [
      ['Name', 'Pickup address'],
      ['Avery Example', '10 Fiction Lane'],
      ['Blair Example', '20 Fiction Lane'],
    ],
    Attendance: [
      ['Name', '2026-10-06', '2026-10-07'],
      ['Avery Example', 'Yes', 'No'],
      [],
      ['Blair Example', '', true],
    ],
    Drivers: [
      ['Name', '2026-10-06', '2026-10-07'],
      ['Avery Example', 'Yes', 'No'],
      ['Blair Example', '', false],
    ],
  }))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return book;
}
function parse(book: XLSX.WorkBook) {
  const batch = detectWorkbookInputs(book);
  const texts = Object.fromEntries(
    Object.entries(batch).map(([kind, input]) => [kind, input!.text]),
  ) as Parameters<typeof parseUploads>[0];
  const sources = Object.fromEntries(
    Object.entries(batch).map(([kind, input]) => [
      kind,
      { ...input!, label: `week.xlsx · ${input!.sheetName}` },
    ]),
  );
  return parseUploads(texts, sources);
}

it('expands date grids with Yes/No attendance and defaults empty answers to No', () => {
  const parsed = parse(grids());
  expect(parsed.issues).toEqual([]);
  expect(parsed.data.attendance).toHaveLength(4);
  const driver = parsed.data.availability.find((row) => row.available === 'true')!;
  expect(driver).toMatchObject({ total_seats: 5, source: 'confirmed', date: '2026-10-06' });
  expect(parsed.data.availability.filter((row) => row.available === 'false')).toHaveLength(3);
  const issues = locateOperationalIssues(
    operationalIssues(parsed.data, { ...defaultSettings, dates: ['2026-10-06', '2026-10-07'] }),
    parsed.canonicalTexts,
    parsed.canonicalSources,
  );
  expect(issues).toEqual([]);
  expect(parsed.data.attendance.some((row) => row.attending === 'unknown')).toBe(false);
  const member = parsed.data.members.find((row) => row.display_name === 'Blair Example')!;
  expect(
    parsed.data.attendance.find(
      (row) => row.member_id === member.member_id && row.date === '2026-10-06',
    )?.attending,
  ).toBe('false');
});

it.each([false, true])('reads native Excel dates in grid headers with date1904=%s', (date1904) => {
  const book = grids();
  book.Workbook = { WBProps: { date1904 } };
  for (const name of ['Attendance', 'Drivers']) {
    for (const [col, day] of [
      ['B1', 6],
      ['C1', 7],
    ] as const) {
      book.Sheets[name][col] = {
        t: 'n',
        v:
          (Date.UTC(2026, 9, day) -
            Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30)) /
          86400000,
        z: 'm/d/yyyy',
      };
    }
  }
  const parsed = parse(XLSX.read(workbookBytes(book), { cellNF: true }));
  expect(parsed.issues).toEqual([]);
  expect([...new Set(parsed.data.attendance.map((row) => row.date))]).toEqual([
    '2026-10-06',
    '2026-10-07',
  ]);
});

it.each(['Not sure', 'Example only', 'Maybe'])(
  'rejects unsupported grid choice %s with its cell address',
  async (value) => {
    const book = grids();
    book.Sheets.Attendance.B4 = { t: 's', v: value };
    await expect(
      normalizeSelectedUploads([new File([workbookBytes(book)], 'download.xlsx')]),
    ).rejects.toThrow('Attendance!B4: choose Yes or No');
  },
);

it('rejects ambiguous tabs, duplicate dates, unnamed responses, and duplicate members', () => {
  const ambiguous = grids();
  ambiguous.Sheets.Signups = ambiguous.Sheets.Attendance;
  ambiguous.SheetNames[1] = 'Signups';
  expect(() => detectWorkbookInputs(ambiguous)).toThrow(
    'name this date-grid tab Attendance or Drivers',
  );
  const repeated = grids();
  repeated.Sheets.Attendance.C1 = repeated.Sheets.Attendance.B1;
  expect(() => detectWorkbookInputs(repeated)).toThrow('unique, nonempty');
  const missing = grids();
  delete missing.Sheets.Attendance.A4;
  expect(() => detectWorkbookInputs(missing)).toThrow('Attendance!A4');
  const duplicate = grids();
  duplicate.Sheets.Attendance.A4 = duplicate.Sheets.Attendance.A2;
  expect(
    parse(duplicate).issues.some((issue) => issue.message.includes('Duplicate person record')),
  ).toBe(true);
});
