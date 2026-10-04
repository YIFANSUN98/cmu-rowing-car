import * as XLSX from 'xlsx';
import { headers, requiredColumns } from '../domain/validation';
import type { FileKind } from '../domain/validation';
import { inputKinds, inputLabels, simpleHeaders } from './friendlySchema';
import { readWorkbook, workbookToCsv } from './spreadsheet';
import type { NormalizedUpload } from './spreadsheet';
import { parseCsv, writeCsv } from './csv';
import { normalize } from '../domain/util';

export interface DetectedUpload extends NormalizedUpload {
  fileName: string;
}
export type UploadBatch = Partial<Record<FileKind, DetectedUpload>>;

export function detectWorkbookInputs(
  book: XLSX.WorkBook,
): Partial<Record<FileKind, NormalizedUpload>> {
  const detected: Partial<Record<FileKind, NormalizedUpload>> = {};
  const exceptions: { tab: string; text: string; mode: 'self' | 'uber' }[] = [];
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    if (!sheet?.['!ref'] || book.Workbook?.Sheets?.find((tab) => tab.name === name)?.Hidden)
      continue;
    if (['own travel', 'uber'].includes(name.trim().toLowerCase())) {
      exceptions.push({
        tab: name,
        mode: name.trim().toLowerCase() === 'uber' ? 'uber' : 'self',
        text: workbookToCsv(
          { ...book, SheetNames: [name], Sheets: { [name]: sheet } },
          'attendance',
        ).text,
      });
      continue;
    }
    // Inspect only the header, within the same width limit as the normal importer.
    const lastColumn = Math.min(XLSX.utils.decode_range(sheet['!ref']).e.c, 99);
    const columns = Array.from({ length: lastColumn + 1 }, (_, col) =>
      String(sheet[XLSX.utils.encode_cell({ r: 0, c: col })]?.v ?? '').trim(),
    );
    const namedKind = inputKinds.find(
      (kind) =>
        name.trim().toLowerCase() === inputLabels[kind].toLowerCase() ||
        (kind === 'availability' && name.trim().toLowerCase() === 'driver_availability'),
    );
    const isGrid =
      columns[0] === 'Name' && !columns.includes('Pickup address') && !columns.includes('Date');
    if (isGrid && namedKind !== 'attendance' && namedKind !== 'availability')
      throw new Error(
        `${name}: name this date-grid tab Attendance or Drivers so the app can identify it.`,
      );
    const matches = inputKinds.filter((kind) => {
      const expected =
        columns.includes('Name') && !columns.includes('member_id')
          ? simpleHeaders[kind]
          : headers[kind].slice(0, requiredColumns[kind]);
      return expected.every((header) => columns.includes(header));
    });
    if (matches.length > 1)
      throw new Error(
        `${name} matches more than one input type. Keep each table on its own sheet.`,
      );
    // A known tab with damaged headers should report the missing columns, not be skipped.
    const kind = isGrid ? namedKind : (matches[0] ?? namedKind);
    if (!kind) continue;
    if (detected[kind])
      throw new Error(
        `More than one ${inputLabels[kind]} table was found. Keep one visible table for each input.`,
      );
    // Retain the original tab title, date system, cell metadata and Excel row numbers.
    detected[kind] = workbookToCsv(
      { ...book, SheetNames: [name], Sheets: { [name]: sheet } },
      kind,
    );
  }
  if (exceptions.length) {
    if (!detected.attendance)
      throw new Error('Keep Own travel and Uber tabs in the same workbook as Attendance.');
    const attendance = parseCsv(detected.attendance.text),
      overrides = new Map<string, string>();
    const simple = attendance.headers.includes('Name');
    if (!simple) throw new Error('Use name-based Attendance with Own travel or Uber tabs.');
    for (const exception of exceptions)
      for (const row of parseCsv(exception.text).rows) {
        const answer = normalize(row['Attending?'] ?? '');
        if (!['yes', 'no'].includes(answer))
          throw new Error(`${exception.tab}: use Yes or No for every attendance exception.`);
        if (answer !== 'yes') continue;
        const key = `${row.Date}:${normalize(row.Name)}`;
        if (overrides.has(key))
          throw new Error(`${row.Name} on ${row.Date}: choose Own travel or Uber, not both.`);
        const target = attendance.rows.find(
          (a) => a.Date === row.Date && normalize(a.Name) === normalize(row.Name),
        );
        if (!target || !['yes', 'true'].includes(normalize(target['Attending?'] ?? '')))
          throw new Error(
            `${exception.tab}: ${row.Name} must also be marked Yes in Attendance on ${row.Date}.`,
          );
        overrides.set(key, exception.mode);
      }
    detected.attendance.text = writeCsv(
      [...attendance.headers.filter((h) => h !== 'Transport exception'), 'Transport exception'],
      attendance.rows.map((row) => ({
        ...row,
        'Transport exception': overrides.get(`${row.Date}:${normalize(row.Name)}`) ?? 'carpool',
      })),
    );
  }
  if (!Object.keys(detected).length)
    throw new Error(
      'No Members, Attendance, or Drivers table was found. Keep the template headers in row 1.',
    );
  return detected;
}

export async function normalizeSelectedUploads(
  files: Pick<File, 'name' | 'size' | 'arrayBuffer'>[],
): Promise<UploadBatch> {
  if (!files.length || files.length > 3)
    throw new Error('Select up to three .xlsx files from the same week.');
  const batch: UploadBatch = {};
  for (const file of files) {
    try {
      const detected = detectWorkbookInputs(await readWorkbook(file));
      for (const kind of inputKinds) {
        const input = detected[kind];
        if (!input) continue;
        if (batch[kind])
          throw new Error(
            `${inputLabels[kind]} was also found in ${batch[kind]!.fileName}. Select only one file for each input.`,
          );
        batch[kind] = { ...input, fileName: file.name };
      }
    } catch (error) {
      throw new Error(`${file.name}: ${(error as Error).message}`);
    }
  }
  return batch;
}
