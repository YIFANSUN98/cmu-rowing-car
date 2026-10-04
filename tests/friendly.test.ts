import { expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseUploads } from '../src/importers/friendly';
import { writeCsv } from '../src/importers/csv';
import { simpleHeaders } from '../src/importers/friendlySchema';
import { workbookToCsv } from '../src/importers/spreadsheet';
import { operationalIssues } from '../src/domain/validation';
import { defaultSettings } from '../src/domain/types';
import { locateOperationalIssues } from '../src/importers/issueLocations';

const input = () => ({
  members: 'Name,Pickup address\nAvery Example,10 Fiction Lane\nBlair Sample,20 Fiction Lane\n',
  attendance:
    'Date,Name,Attending?\n2026-10-06, avery   EXAMPLE ,Yes\n2026-10-06,Blair Sample,Not sure\n',
  availability:
    'Date,Name,Can drive?,Seats (including driver)\n2026-10-06,Avery Example,Yes,5\n2026-10-06,Blair Sample,No,\n',
});
it('accepts minimal sheets, uses supplied pickups directly, and puts attendees in carpool', () => {
  const parsed = parseUploads(input());
  expect(parsed.issues).toEqual([]);
  const a = parsed.data.members.find((m) => m.display_name === 'Avery Example')!;
  expect(a).not.toHaveProperty('pickup_status');
  expect(parsed.data.attendance.find((r) => r.member_id === a.member_id)).toMatchObject({
    attending: 'true',
    transport_mode: 'carpool',
  });
  expect(parsed.data.availability.find((r) => r.member_id === a.member_id)).toMatchObject({
    available: 'true',
    total_seats: 5,
    source: 'confirmed',
  });
  expect(
    operationalIssues(parsed.data, { ...defaultSettings, dates: ['2026-10-06'] })
      .filter((i) => i.severity === 'error')
      .map((i) => i.field),
  ).toEqual(['attending']);
  const reordered = input();
  reordered.members =
    'Name,Pickup address\nBlair Sample,20 Fiction Lane\nAvery Example,10 Fiction Lane\n';
  expect(parseUploads(reordered).data).toEqual(parsed.data);
});
it.each(['Example only', 'Not sure', 'unknown', ''])(
  'rejects %s as a driver choice instead of inventing availability',
  (value) => {
    const texts = input();
    texts.availability = texts.availability.replace(
      'Avery Example,Yes,5',
      `Avery Example,${value},5`,
    );
    const parsed = parseUploads(texts);
    expect(parsed.issues.some((i) => i.field === 'Can drive?' && i.severity === 'error')).toBe(
      true,
    );
    expect(parsed.data.availability.some((v) => v.available === 'true')).toBe(false);
  },
);
it('ignores removed columns in older downloads', () => {
  const texts = input();
  texts.members =
    'Name,Pickup address,Pickup confirmed?\nAvery Example,10 Fiction Lane,Conflicting\nBlair Sample,20 Fiction Lane,Not yet\n';
  texts.attendance =
    'Date,Name,Attending?,Travel\n2026-10-06,Avery Example,Yes,Not sure\n2026-10-06,Blair Sample,No,Uber / other\n';
  const parsed = parseUploads(texts);
  expect(parsed.issues).toEqual([]);
  expect(operationalIssues(parsed.data, { ...defaultSettings, dates: ['2026-10-06'] })).toEqual([]);
  expect(parsed.data.attendance.every((a) => a.transport_mode === 'carpool')).toBe(true);
});
it('rejects duplicate names, unmatched aliases, and unsupported choices instead of guessing identities', () => {
  const duplicate = input();
  duplicate.members += 'avery example,Other point\n';
  expect(
    parseUploads(duplicate).issues.some((i) => i.message.includes('multiple member rows')),
  ).toBe(true);
  const alias = input();
  alias.attendance = alias.attendance.replace(' avery   EXAMPLE ', 'Avery');
  expect(
    parseUploads(alias).issues.some((i) => i.message.includes('“Avery” is not in Members')),
  ).toBe(true);
  const invalid = input();
  invalid.attendance = invalid.attendance.replace(',Yes', ',Maybe');
  expect(
    parseUploads(invalid).issues.filter((i) => i.message.includes('supported choice')),
  ).toHaveLength(1);
});
it.each(['xlsx', 'xls'] as const)(
  'reads %s friendly date/boolean cells and maps issues to actual rows through blank/multiline cells',
  (format) => {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      simpleHeaders.attendance,
      [],
      [0, 'Avery Example', true],
      ['2026-10-06', 'Blair Sample', 'Not sure'],
    ]);
    const serial = (Date.UTC(2026, 9, 6) - Date.UTC(1899, 11, 30)) / 86400000;
    sheet.A3 = { t: 'n', v: serial, z: 'yyyy-mm-dd' };
    XLSX.utils.book_append_sheet(book, sheet, 'Attendance');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['archived']]), '_Archive');
    book.Workbook = {
      Sheets: [
        { name: 'Attendance', Hidden: 0 },
        { name: '_Archive', Hidden: 1 },
      ],
    };
    const converted = workbookToCsv(
      XLSX.read(XLSX.write(book, { type: 'array', bookType: format }), {
        type: 'array',
        cellNF: true,
      }),
      'attendance',
    );
    const texts = { ...input(), attendance: converted.text };
    const parsed = parseUploads(texts, {
      attendance: { label: 'attendance.xlsx · Attendance', rowMap: converted.rowMap },
    });
    expect(parsed.issues).toEqual([]);
    const issues = locateOperationalIssues(
      operationalIssues(parsed.data, { ...defaultSettings, dates: ['2026-10-06'] }),
      parsed.canonicalTexts,
      parsed.canonicalSources,
    );
    expect(issues.find((i) => i.field === 'Attending?')).toMatchObject({
      row: 4,
      file: 'attendance.xlsx · Attendance',
    });
    const native = parsed.data.attendance.find((a) => a.attending === 'true')!;
    expect(native.date).toBe('2026-10-06');
  },
);
it('keeps CSV line numbers correct when name-based conversion removes a multiline unused column', () => {
  const texts = input();
  texts.attendance = writeCsv(
    [...simpleHeaders.attendance, 'Notes'],
    [
      {
        Date: '2026-10-06',
        Name: 'Avery Example',
        'Attending?': 'Yes',
        Travel: 'Carpool',
        Notes: 'first\nsecond',
      },
      { Date: '2026-10-06', Name: 'Blair Sample', 'Attending?': 'Not sure', Travel: 'Not sure' },
    ],
  );
  const parsed = parseUploads(texts);
  const issues = locateOperationalIssues(
    operationalIssues(parsed.data, { ...defaultSettings, dates: ['2026-10-06'] }),
    parsed.canonicalTexts,
    parsed.canonicalSources,
  );
  expect(issues.find((i) => i.field === 'Attending?')?.row).toBe(4);
});
