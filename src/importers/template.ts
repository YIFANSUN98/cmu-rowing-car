import type { FileKind } from '../domain/validation';
import { templateHeaders } from './friendlySchema';

export async function downloadTemplate(kind: FileKind, dates: string[] = []) {
  const XLSX = await import('xlsx');
  const book = XLSX.utils.book_new();
  const columns = templateHeaders(
    kind,
    dates.length
      ? dates
      : [
          new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/New_York',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(new Date()),
        ],
  );
  const sheet = XLSX.utils.aoa_to_sheet([columns]);
  sheet['!cols'] = columns.map((name, index) => ({
    wch: index === 0 ? 28 : kind === 'members' ? 55 : Math.max(name.length + 4, 16),
  }));
  const name = kind === 'availability' ? 'Drivers' : kind === 'members' ? 'Members' : 'Attendance';
  XLSX.utils.book_append_sheet(book, sheet, name);
  XLSX.writeFile(book, `${kind === 'availability' ? 'drivers' : kind}.xlsx`);
}
