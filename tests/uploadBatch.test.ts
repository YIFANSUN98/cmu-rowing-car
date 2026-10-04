import { expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { detectWorkbookInputs, normalizeSelectedUploads } from '../src/importers/uploadBatch';
import { parseUploads } from '../src/importers/friendly';
import { simpleHeaders } from '../src/importers/friendlySchema';
import { inputWorkbook, workbookBytes } from './fixtures/workbooks';
import { makeDemo } from '../src/domain/scenarios';

const data = makeDemo({ people: 6, driverCount: 2 });
const file = (book: XLSX.WorkBook, name = 'download.xlsx') => new File([workbookBytes(book)], name);

it('detects arbitrary filenames by headers and preserves every input in one selection', async () => {
  const inputs = await normalizeSelectedUploads([
    file(inputWorkbook(data, 'availability'), 'members.xlsx'),
    file(inputWorkbook(data, 'members'), 'Copy (2).xlsx'),
    file(inputWorkbook(data, 'attendance'), 'September.xlsx'),
  ]);
  expect(inputs.members?.fileName).toBe('Copy (2).xlsx');
  expect(inputs.attendance?.fileName).toBe('September.xlsx');
  expect(inputs.availability?.fileName).toBe('members.xlsx');
  expect(
    parseUploads({
      members: inputs.members!.text,
      attendance: inputs.attendance!.text,
      availability: inputs.availability!.text,
    }).issues,
  ).toEqual([]);
});

it('detects three friendly tables in one workbook and ignores hidden archives and unrelated tabs', () => {
  const book = XLSX.utils.book_new();
  const memberSheet = XLSX.utils.aoa_to_sheet([
    simpleHeaders.members,
    ['Avery Example', '10 Fiction Lane\nGate A'],
  ]);
  XLSX.utils.book_append_sheet(book, memberSheet, 'Crew');
  XLSX.utils.book_append_sheet(book, memberSheet, '_Archive');
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      simpleHeaders.attendance,
      [],
      ['2026-10-06', 'Avery Example', 'Not sure'],
    ]),
    'Signups',
  );
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      simpleHeaders.availability,
      ['2026-10-06', 'Avery Example', 'No', ''],
    ]),
    'Cars',
  );
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Notes'], ['Read me']]), 'Notes');
  book.Workbook = {
    Sheets: book.SheetNames.map((name) => ({ name, Hidden: name === '_Archive' ? 1 : 0 })),
  };
  const inputs = detectWorkbookInputs(book);
  expect(Object.keys(inputs)).toHaveLength(3);
  expect(inputs.attendance?.sheetName).toBe('Signups');
  expect(inputs.attendance?.rowMap?.[2]).toBe(3);
  expect(inputs.members?.text).toContain('Gate A');
  expect(inputs.attendance?.text).toContain('Not sure');
});

it('rejects duplicate types across files or visible tabs, including legacy drivers tabs', async () => {
  await expect(
    normalizeSelectedUploads([
      file(inputWorkbook(data, 'members'), 'first.xlsx'),
      file(inputWorkbook(data, 'members'), 'second.xlsx'),
    ]),
  ).rejects.toThrow('Members was also found in first.xlsx');
  const book = inputWorkbook(data, 'availability');
  XLSX.utils.book_append_sheet(book, book.Sheets.driver_availability, 'Drivers');
  expect(() => detectWorkbookInputs(book)).toThrow('More than one Drivers table');
});

it('rejects unknown and malformed tables without assigning them by filename', async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([['Something else'], ['Example']]),
    'Sheet1',
  );
  await expect(normalizeSelectedUploads([file(book, 'members.xlsx')])).rejects.toThrow(
    'No Members, Attendance, or Drivers table',
  );
  book.SheetNames = ['Members'];
  book.Sheets.Members = book.Sheets.Sheet1;
  await expect(normalizeSelectedUploads([file(book)])).rejects.toThrow('missing columns');
  const mixed = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    mixed,
    XLSX.utils.aoa_to_sheet([
      [...simpleHeaders.attendance, 'Can drive?', 'Seats (including driver)'],
    ]),
    'Mixed',
  );
  expect(() => detectWorkbookInputs(mixed)).toThrow('matches more than one input type');
});

it('returns no partial result when a file is invalid and bounds each selection', async () => {
  await expect(
    normalizeSelectedUploads([
      file(inputWorkbook(data, 'members')),
      new File(['bad'], 'attendance.xlsx'),
    ]),
  ).rejects.toThrow('attendance.xlsx: This is not a readable .xlsx');
  await expect(normalizeSelectedUploads([])).rejects.toThrow('up to three');
  await expect(
    normalizeSelectedUploads(Array(4).fill(file(inputWorkbook(data, 'members')))),
  ).rejects.toThrow('up to three');
});

it('keeps Yes/No attendance with explicit Own travel and Uber grids and rejects conflicting exceptions', () => {
  const book = XLSX.utils.book_new();
  const add = (name: string, rows: string[][]) =>
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  add('Members', [
    ['Name', 'Pickup address'],
    ['Avery', '10 Example Lane'],
    ['Blair', '20 Example Lane'],
  ]);
  add('Attendance', [
    ['Name', '2026-10-05'],
    ['Avery', 'Yes'],
    ['Blair', 'Yes'],
  ]);
  add('Drivers', [
    ['Name', '2026-10-05'],
    ['Avery', 'No'],
    ['Blair', 'No'],
  ]);
  add('Own travel', [
    ['Name', '2026-10-05'],
    ['Avery', 'Yes'],
    ['Blair', 'No'],
  ]);
  add('Uber', [
    ['Name', '2026-10-05'],
    ['Avery', 'No'],
    ['Blair', 'Yes'],
  ]);
  const inputs = detectWorkbookInputs(book);
  const parsed = parseUploads({
    members: inputs.members!.text,
    attendance: inputs.attendance!.text,
    availability: inputs.availability!.text,
  });
  expect(parsed.issues).toEqual([]);
  expect(parsed.data.attendance.map((a) => a.transport_mode).sort()).toEqual(['self', 'uber']);
  book.Sheets.Uber.B2.v = 'Yes';
  expect(() => detectWorkbookInputs(book)).toThrow('not both');
  book.Sheets.Uber.B2.v = 'No';
  book.Sheets.Attendance.B2.v = 'No';
  expect(() => detectWorkbookInputs(book)).toThrow('also be marked Yes');
  book.Sheets.Attendance.B2.v = 'Yes';
  book.Sheets.Uber.B2.v = 'Maybe';
  expect(() => detectWorkbookInputs(book)).toThrow('Yes or No');
});
