import { headers, parseDataset } from '../domain/validation';
import type { FileKind } from '../domain/validation';
import type { Issue } from '../domain/types';
import { normalize, stableId } from '../domain/util';
import { parseCsv, writeCsv } from './csv';
import type { CsvTable } from './csv';
import type { InputSource } from './spreadsheet';
import { simpleFields, simpleHeaders } from './friendlySchema';

export function parseUploads(
  texts: Record<FileKind, string>,
  sources: Partial<Record<FileKind, InputSource>> = {},
) {
  const kinds = ['members', 'attendance', 'availability'] as const;
  const tables: Partial<Record<FileKind, CsvTable>> = {};
  for (const kind of kinds) {
    try {
      tables[kind] = parseCsv(texts[kind]);
    } catch {
      /* Reported by canonical parser below. */
    }
  }
  const simple = (kind: FileKind) =>
    Boolean(tables[kind]?.headers.includes('Name') && !tables[kind]?.headers.includes('member_id'));
  const canonicalTexts = { ...texts };
  const canonicalSources: Partial<Record<FileKind, InputSource>> = { ...sources };
  const extraIssues: Issue[] = [];
  const file = (kind: FileKind) =>
    sources[kind]?.label ?? (kind === 'availability' ? 'driver_availability.csv' : `${kind}.csv`);
  const complain = (kind: FileKind, row: number, field: string, message: string) =>
    extraIssues.push({
      file: file(kind),
      row: sources[kind]?.rowMap?.[row] ?? row,
      field,
      message,
      severity: 'error',
    });
  const names = new Map<string, string[]>();
  for (const row of tables.members?.rows ?? []) {
    const name = simple('members') ? row.Name : row.display_name;
    const key = normalize(name ?? '');
    const id = simple('members') ? stableId(`input-name:${key}`, 'person') : row.member_id;
    names.set(key, [...(names.get(key) ?? []), id]);
  }
  for (const kind of kinds) {
    const table = tables[kind];
    if (!table || !simple(kind)) continue;
    for (const h of simpleHeaders[kind])
      if (!table.headers.includes(h))
        complain(
          kind,
          1,
          h,
          `Missing column “${h}”. Download the ${kind === 'availability' ? 'drivers' : kind} template.`,
        );
    const rows = table.rows.map((row, index) => {
      const line = table.rowNumbers[index];
      const name = row.Name?.trim() ?? '';
      const matches = names.get(normalize(name)) ?? [];
      if (!name) complain(kind, line, 'Name', 'Enter a name matching the Members sheet.');
      else if (matches.length > 1)
        complain(
          kind,
          line,
          'Name',
          `“${name}” matches multiple member rows. Use a distinct name for each person in all three sheets.`,
        );
      else if (!matches.length && kind !== 'members')
        complain(
          kind,
          line,
          'Name',
          `“${name}” is not in Members. Use the same name in all three sheets; nicknames are not merged automatically.`,
        );
      const id =
        matches.length === 1 ? matches[0] : stableId(`input-name:${normalize(name)}`, 'person');
      const choose = (column: string, choices: Record<string, string>, fallback: string) => {
        const value = normalize(row[column] ?? '');
        if (!value) return fallback;
        if (Object.hasOwn(choices, value)) return choices[value];
        complain(
          kind,
          line,
          column,
          `“${row[column]}” is not a supported choice in ${column}. Use the sheet's dropdown options.`,
        );
        return fallback;
      };
      const truth = (column: string) =>
        choose(
          column,
          {
            yes: 'true',
            true: 'true',
            no: 'false',
            false: 'false',
            'not sure': 'unknown',
            unknown: 'unknown',
          },
          'unknown',
        );
      if (kind === 'members')
        return {
          member_id: id,
          display_name: name,
          pickup_address: row['Pickup address'] ?? '',
        };
      if (kind === 'attendance')
        return {
          date: row.Date ?? '',
          member_id: id,
          attending: truth('Attending?'),
          transport_mode: choose(
            'Transport exception',
            { carpool: 'carpool', self: 'self', uber: 'uber' },
            'carpool',
          ),
        };
      if (!row['Can drive?']?.trim())
        complain(kind, line, 'Can drive?', 'Choose Yes or No in Can drive?.');
      return {
        date: row.Date ?? '',
        member_id: id,
        available: choose(
          'Can drive?',
          { yes: 'true', true: 'true', no: 'false', false: 'false' },
          'false',
        ),
        total_seats: row['Seats (including driver)'] ?? '',
        source: 'confirmed',
      };
    });
    canonicalTexts[kind] = writeCsv(headers[kind], rows);
    const rowMap: Record<number, number> = { 1: 1 };
    parseCsv(canonicalTexts[kind]).rowNumbers.forEach((line, i) => {
      rowMap[line] = sources[kind]?.rowMap?.[table.rowNumbers[i]] ?? table.rowNumbers[i];
    });
    canonicalSources[kind] = {
      ...sources[kind],
      label: file(kind),
      rowMap,
      fieldLabels: Object.fromEntries(
        Object.entries(simpleFields[kind]).map(([label, field]) => [field, label]),
      ),
    };
  }
  const result = parseDataset(canonicalTexts);
  for (const issue of result.issues) {
    const kind: FileKind =
      issue.file === 'driver_availability.csv'
        ? 'availability'
        : issue.file === 'attendance.csv'
          ? 'attendance'
          : 'members';
    const source = canonicalSources[kind];
    if (source) {
      issue.file = source.label;
      if (issue.row) issue.row = source.rowMap?.[issue.row] ?? issue.row;
      if (issue.field) issue.field = source.fieldLabels?.[issue.field] ?? issue.field;
    }
  }
  return {
    ...result,
    issues: [...extraIssues, ...result.issues],
    canonicalTexts,
    canonicalSources,
  };
}
