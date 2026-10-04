import * as XLSX from 'xlsx';
import { headers, requiredColumns } from '../domain/validation';
import type { FileKind } from '../domain/validation';
import { parseCsv, writeCsv } from './csv';
import { DEFAULT_DRIVER_SEATS, simpleFields, simpleHeaders } from './friendlySchema';
import { validDate } from '../domain/util';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10000;
const MAX_COLUMNS = 100;
export interface NormalizedUpload {
  text: string;
  sheetName?: string;
  // Converted CSV line -> original Excel row, including cells with embedded newlines.
  rowMap?: Record<number, number>;
  gridDateColumns?: Record<string, string>;
}
export interface InputSource {
  label: string;
  rowMap?: Record<number, number>;
  fieldLabels?: Record<string, string>;
  gridDateColumns?: Record<string, string>;
}
const tabName = (kind: FileKind) =>
  kind === 'availability' ? 'Drivers' : kind === 'members' ? 'Members' : 'Attendance';
const pad = (n: number) => String(n).padStart(2, '0');

export function workbookToCsv(book: XLSX.WorkBook, kind: FileKind): NormalizedUpload {
  const visible = book.SheetNames.filter(
    (name) =>
      !book.Workbook?.Sheets?.find((s) => s.name === name)?.Hidden && book.Sheets[name]?.['!ref'],
  );
  const matches = visible.filter(
    (name) =>
      name.trim().toLowerCase() === tabName(kind).toLowerCase() ||
      (kind === 'availability' && name.trim().toLowerCase() === 'driver_availability'),
  );
  const name =
    matches.length === 1
      ? matches[0]
      : matches.length === 0 && visible.length === 1
        ? visible[0]
        : undefined;
  if (!name)
    throw new Error(
      `Choose a workbook with one nonempty visible sheet, or name the input tab ${tabName(kind)}. Multiple possible tabs cannot be combined automatically.`,
    );
  const sheet = book.Sheets[name];
  const range = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref']!);
  if (range.e.r >= MAX_ROWS || range.e.c >= MAX_COLUMNS)
    throw new Error(
      'Keep the input sheet within 10,000 rows and 100 columns. Remove unused rows/columns and download it again.',
    );
  if (sheet['!merges']?.some((m) => m.s.r <= range.e.r && m.s.c <= range.e.c))
    throw new Error(
      'Use an unmerged input table with the template headers in row 1. Historical car-assignment layouts need review before upload.',
    );
  const date1904 = Boolean(book.Workbook?.WBProps?.date1904);
  const cellText = (row: number, col: number, field = '') => {
    field = simpleFields[kind][field] ?? field;
    const address = XLSX.utils.encode_cell({ r: row, c: col });
    const cell = sheet[address] as XLSX.CellObject | undefined;
    const fail = (message: string): never => {
      throw new Error(`${name}!${address}: ${message}`);
    };
    if (cell?.t === 'e') fail('Fix the spreadsheet error and download the file again.');
    if (cell?.f && (cell.v == null || cell.t === 'z'))
      fail(
        'This formula has no saved result. Recalculate and save the workbook, or paste its value before uploading.',
      );
    if (!cell || cell.v == null || cell.t === 'z') return '';
    if (cell.t === 'n' && typeof cell.v === 'number' && XLSX.SSF.is_date(cell.z ?? '')) {
      if (field === 'date') {
        if (!Number.isInteger(cell.v))
          fail('Use a calendar date without a time in the date column.');
        const d = XLSX.SSF.parse_date_code(cell.v, { date1904 });
        if (!d) fail('Use a valid Excel date or YYYY-MM-DD text.');
        return `${String(d.y).padStart(4, '0')}-${pad(d.m)}-${pad(d.d)}`;
      }
      if (field === 'ready_after' || field === 'earliest_departure') {
        const d = XLSX.SSF.parse_date_code(cell.v);
        if (cell.v < 0 || cell.v >= 1 || !d || d.S || d.u > 0.00001)
          fail('Use a time of day with whole minutes (HH:MM), without a date or seconds.');
        return `${pad(d.H)}:${pad(d.M)}`;
      }
    }
    let value = cell.t === 'b' ? (cell.v ? 'TRUE' : 'FALSE') : String(cell.v);
    if (field === 'member_id' && cell.t === 'n') value = cell.w ?? XLSX.utils.format_cell(cell);
    if (
      (kind === 'attendance' && field === 'attending') ||
      (kind === 'availability' && field === 'available')
    ) {
      if (/^(true|false)$/i.test(value.trim())) value = value.trim().toLowerCase();
    }
    return value;
  };
  const isGrid =
    kind !== 'members' &&
    cellText(0, 0).trim() === 'Name' &&
    !Array.from({ length: range.e.c + 1 }, (_, col) => cellText(0, col).trim()).includes('Date');
  const columns = Array.from({ length: range.e.c + 1 }, (_, col) =>
    cellText(0, col, isGrid && col > 0 ? 'date' : '').trim(),
  );
  while (columns.length && !columns.at(-1)) columns.pop();
  if (!columns.length || columns.some((h) => !h) || new Set(columns).size !== columns.length)
    throw new Error('Keep unique, nonempty template headers in row 1 of the input sheet.');
  if (isGrid) {
    const dates = columns.slice(1);
    if (!dates.length || dates.some((date) => !validDate(date)))
      throw new Error(
        `${name}: put Name in A1 and unique dates (YYYY-MM-DD or Excel dates) across row 1.`,
      );
    const rows: Record<string, string>[] = [],
      originalRows: number[] = [];
    const choice = kind === 'attendance' ? 'Attending?' : 'Can drive?';
    for (let row = 1; row <= range.e.r; row++) {
      const member = cellText(row, 0).trim();
      const values = Array.from({ length: range.e.c }, (_, col) =>
        cellText(row, col + 1, choice).trim(),
      );
      if (!member && !values.some(Boolean)) continue;
      if (!member) throw new Error(`${name}!A${row + 1}: enter the member name for this row.`);
      if (values.slice(dates.length).some(Boolean))
        throw new Error(`${name}, row ${row + 1}: data appears in a column without a date.`);
      dates.forEach((date, index) => {
        const value = (values[index] ?? '').toLowerCase();
        if (!['', 'yes', 'no', 'true', 'false'].includes(value))
          throw new Error(
            `${name}!${XLSX.utils.encode_cell({ r: row, c: index + 1 })}: choose Yes or No.`,
          );
        const answer = value === 'yes' || value === 'true' ? 'Yes' : 'No';
        rows.push({
          Date: date,
          Name: member,
          [choice]: answer,
          ...(kind === 'availability'
            ? { 'Seats (including driver)': answer === 'Yes' ? String(DEFAULT_DRIVER_SEATS) : '' }
            : {}),
        });
        originalRows.push(row + 1);
      });
    }
    const text = writeCsv(simpleHeaders[kind], rows);
    if (new TextEncoder().encode(text).length > MAX_UPLOAD_BYTES)
      throw new Error('The expanded input exceeds 5 MB. Use fewer members or dates.');
    const rowMap: Record<number, number> = { 1: 1 };
    parseCsv(text).rowNumbers.forEach((line, index) => {
      rowMap[line] = originalRows[index];
    });
    return {
      text,
      sheetName: name,
      rowMap,
      gridDateColumns: Object.fromEntries(
        dates.map((date, index) => [date, XLSX.utils.encode_col(index + 1)]),
      ),
    };
  }
  const expected =
    columns.includes('Name') && !columns.includes('member_id')
      ? simpleHeaders[kind]
      : headers[kind].slice(0, requiredColumns[kind]);
  const missing = expected.filter((h) => !columns.includes(h));
  if (missing.length)
    throw new Error(
      `The ${tabName(kind)} input is missing columns: ${missing.join(', ')}. Download the formatted example Sheet or use the input template.`,
    );
  const rows: Record<string, string>[] = [],
    originalRows: number[] = [];
  for (let row = 1; row <= range.e.r; row++) {
    const values = Array.from({ length: range.e.c + 1 }, (_, col) =>
      cellText(row, col, columns[col]),
    );
    if (!values.some((v) => v.trim())) continue;
    if (values.slice(columns.length).some((v) => v.trim()))
      throw new Error(`${name}, row ${row + 1}: data appears in a column without a header.`);
    rows.push(Object.fromEntries(columns.map((h, col) => [h, values[col] ?? ''])));
    originalRows.push(row + 1);
  }
  const text = writeCsv(columns, rows);
  if (new TextEncoder().encode(text).length > MAX_UPLOAD_BYTES)
    throw new Error('The expanded input exceeds 5 MB. Use a smaller week or fewer notes.');
  const rowMap: Record<number, number> = { 1: 1 };
  parseCsv(text).rowNumbers.forEach((line, i) => {
    rowMap[line] = originalRows[i];
  });
  return { text, sheetName: name, rowMap };
}

export async function readWorkbook(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>) {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('Please use an .xlsx file smaller than 5 MB.');
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  if (extension !== 'xlsx')
    throw new Error(
      'Only .xlsx files are supported. Download Microsoft Excel (.xlsx) from Google Sheets.',
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Do not let HTML error pages or renamed CSV files masquerade as Excel workbooks.
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!zip)
    throw new Error(
      'This is not a readable .xlsx workbook. Download it again as Microsoft Excel (.xlsx).',
    );
  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(bytes, {
      type: 'array',
      cellDates: false,
      cellNF: true,
      cellFormula: true,
      cellHTML: false,
      sheetRows: MAX_ROWS + 1,
    });
  } catch {
    throw new Error(
      'Could not read this Excel file. Download a fresh, unprotected .xlsx workbook and try again.',
    );
  }
  if (book.bookType !== 'xlsx')
    throw new Error(
      'Only .xlsx workbooks are supported. Save this file as Microsoft Excel (.xlsx).',
    );
  return book;
}

export async function normalizeUpload(
  file: Pick<File, 'name' | 'size' | 'arrayBuffer'>,
  kind: FileKind,
): Promise<NormalizedUpload> {
  return workbookToCsv(await readWorkbook(file), kind);
}
