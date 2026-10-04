import * as XLSX from 'xlsx';
import { headers } from '../../src/domain/validation';
import type { FileKind } from '../../src/domain/validation';
import type { Dataset } from '../../src/domain/types';

export function inputWorkbook(data: Dataset, kind: FileKind, date1904 = false) {
  const book = XLSX.utils.book_new();
  book.Workbook = { WBProps: { date1904 } };
  const values = [
    headers[kind],
    ...data[kind].map((row) =>
      headers[kind].map((h) => (row as unknown as Record<string, unknown>)[h] ?? ''),
    ),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(values);
  for (let row = 1; row < values.length; row++) {
    headers[kind].forEach((field, col) => {
      const address = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = sheet[address];
      if (field === 'date') {
        const [y, m, d] = String(cell.v).split('-').map(Number);
        sheet[address] = {
          t: 'n',
          v:
            (Date.UTC(y, m - 1, d) -
              Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30)) /
            86400000,
          z: 'm/d/yy',
        };
      }
      if (
        (field === 'attending' || field === 'available') &&
        ['true', 'false'].includes(String(cell.v))
      )
        sheet[address] = { t: 'b', v: cell.v === 'true' };
      if ((field === 'ready_after' || field === 'earliest_departure') && cell.v) {
        const [h, m] = String(cell.v).split(':').map(Number);
        sheet[address] = { t: 'n', v: (h * 60 + m) / 1440, z: 'h:mm AM/PM' };
      }
    });
  }
  XLSX.utils.book_append_sheet(book, sheet, kind === 'availability' ? 'driver_availability' : kind);
  return book;
}
export function workbookBytes(book: XLSX.WorkBook, format: 'xlsx' | 'xls' = 'xlsx'): ArrayBuffer {
  return XLSX.write(book, { type: 'array', bookType: format });
}
