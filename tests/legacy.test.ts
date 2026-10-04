import { it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { importLegacy, weekday } from '../src/importers/legacy';
import { stableId } from '../src/domain/util';
function fixture() {
  const roster = XLSX.utils.book_new();
  const info = XLSX.utils.aoa_to_sheet([
    ['Name', 'Address', 'General Location', 'Date of Birth', 'Car ownership', 'Phone', 'Andrew ID'],
    [
      'Avery Example',
      '12 Fiction St',
      '',
      'PRIVATE_BIRTHDAY',
      'no',
      'PRIVATE_PHONE',
      'PRIVATE_ANDREW',
    ],
    ['NOVICE'],
    ['Avery Sample', '30 Fiction Rd', '', 'PRIVATE_BIRTHDAY', 'yes'],
    ['Blair Demo', 'study abroad (fall)'],
  ]);
  info['!ref'] = 'A1:G904';
  XLSX.utils.book_append_sheet(roster, info, 'INFO');
  XLSX.utils.book_append_sheet(roster, {}, 'Sheet5');
  const cars = XLSX.utils.book_new();
  const day = XLSX.utils.aoa_to_sheet([
    ['Drivers', 'Rowers'],
    ['Blair', 'Avery E', '', 'Car #1', '', 'Car #1', '', '', ''],
    ['', 'Blair', '', 'Blair', '', 'Uber #1', '', '', 'On their own'],
    ['', '', '', 'Avery E', '15 Different Fiction St', 'Casey', '99 Sample Rd', '', 'Avery S'],
  ]);
  day['!merges'] = [XLSX.utils.decode_range('D2:E2'), XLSX.utils.decode_range('D3:E3')];
  XLSX.utils.book_append_sheet(cars, day, 'Thrudasy');
  const saturday = XLSX.utils.aoa_to_sheet([
    ['Drivers', 'Rowers'],
    ['', 'Blair'],
  ]);
  saturday.D9 = { t: 's', v: 'Blair' };
  saturday.E9 = { t: 's', v: 'Avery E' };
  saturday['!ref'] = 'A1:F13';
  XLSX.utils.book_append_sheet(cars, saturday, 'Saturday');
  return [
    { name: 'Fiction roster.xlsx', workbook: roster },
    { name: 'Fiction week.xlsx', workbook: cars },
  ];
}
it('reads meaningful rows and shifted/merged/repeated car headings, excludes sensitive fields', () => {
  const r = importLegacy(fixture());
  expect(r.members.filter((m) => m.member_id.startsWith('m-'))).toHaveLength(3);
  expect(r.sheets[0].rowerCount).toBe(2);
  expect(r.evidence.some((e) => e.role === 'external' && e.label === 'Casey')).toBe(true);
  expect(r.evidence.some((e) => e.role === 'self' && e.label === 'Avery S')).toBe(true);
  expect(r.evidence.some((e) => e.role === 'driver' && e.label === 'Blair')).toBe(true);
  expect(JSON.stringify(r)).not.toContain('PRIVATE_BIRTHDAY');
  expect(JSON.stringify(r)).not.toContain('PRIVATE_PHONE');
  expect(JSON.stringify(r)).not.toContain('PRIVATE_ANDREW');
  expect(r.members.some((m) => m.display_name === 'NOVICE')).toBe(false);
  expect(r.issues.some((i) => i.code === 'non-location')).toBe(true);
});
it('keeps provisional identities and ambiguity until aliases are explicitly approved', () => {
  const r = importLegacy(fixture());
  expect(r.identityReview.find((i) => i.label === 'Avery E')!.suggestions).toEqual([
    stableId('Avery Example'),
  ]);
  expect(r.members.find((m) => m.display_name === 'Avery E')!.member_id).toMatch(/^p-/);
  const books = fixture();
  books[1].workbook.Sheets.Thrudasy.B2 = { t: 's', v: 'Avery' };
  const ambiguous = importLegacy(books);
  expect(ambiguous.identityReview.find((i) => i.label === 'Avery')!.suggestions).toHaveLength(2);
  const approved = importLegacy(fixture(), { aliases: { 'Avery E': stableId('Avery Example') } });
  expect(approved.members.find((m) => m.display_name === 'Avery Example')!.pickup_status).toBe(
    'conflict',
  );
  expect(approved.pickups[stableId('Avery Example')]).toHaveLength(2);
});
it('preserves assignment-only people, unresolved dates and Saturday structure', () => {
  const r = importLegacy(fixture());
  expect(r.attendance.some((a) => a.assignmentOnly)).toBe(true);
  expect(r.attendance.every((a) => a.date === '' && a.attending === 'unknown')).toBe(true);
  expect(r.issues.some((i) => i.code === 'unresolved-layout' && i.source?.cell === 'D9')).toBe(
    true,
  );
  expect(r.issues.some((i) => i.code === 'unparsed-group-cell' && i.source?.cell === 'E9')).toBe(
    true,
  );
  expect(r).not.toHaveProperty('availability');
});
it('normalizes weekdays, accepts explicit dates and validates their weekday', () => {
  expect(weekday(' Thrus ')).toBe('Thursday');
  expect(weekday('tuesday')).toBe('Tuesday');
  const r = importLegacy(fixture(), { dates: { 'Fiction week.xlsx::Thrudasy': '2026-10-08' } });
  expect(r.attendance.some((a) => a.date === '2026-10-08')).toBe(true);
  expect(() =>
    importLegacy(fixture(), { dates: { 'Fiction week.xlsx::Thrudasy': '2026-10-05' } }),
  ).toThrow('weekday');
});
it('roundtrips a real XLSX container and retains merged headings', () => {
  const books = fixture().map((b) => ({
    name: b.name,
    workbook: XLSX.read(XLSX.write(b.workbook, { type: 'buffer', bookType: 'xlsx' }), {
      type: 'buffer',
    }),
  }));
  const r = importLegacy(books);
  expect(r.sheets[0].merges).toContain('D2:E2');
  expect(r.sheets[0].rowerCount).toBe(2);
});
it('recognizes the misspelled driver heading and independent travel heading as non-people', () => {
  const books = fixture();
  const day = books[1].workbook.Sheets.Thrudasy;
  day.A1 = { t: 's', v: 'Divers' };
  day.I3 = { t: 's', v: 'Drive themselves' };
  const report = importLegacy(books);
  expect(report.members.some((m) => /^(Divers|Drive themselves)$/.test(m.display_name))).toBe(
    false,
  );
  expect(report.evidence.some((e) => e.label === 'Avery S' && e.role === 'self')).toBe(true);
  expect(report.evidence.some((e) => e.label === 'Avery S' && e.role === 'passenger')).toBe(false);
});
