import { expect, it } from 'vitest';
import { makeDemo } from '../src/domain/scenarios';
import { defaultSettings } from '../src/domain/types';
import { headers, operationalIssues } from '../src/domain/validation';
import { parseCsv, writeCsv } from '../src/importers/csv';
import { locateOperationalIssues } from '../src/importers/issueLocations';

it('locates operational checks by identity and date through reordered rows and multiline Excel cells', () => {
  const data = makeDemo();
  const member = data.members[0];
  const day = data.attendance.find((a) => a.member_id === member.member_id)!;
  member.pickup_address = '';
  member.pickup_lat = undefined;
  member.pickup_lng = undefined;
  const other = data.attendance.find(
    (a) => a.date === day.date && a.member_id !== member.member_id,
  )!;
  other.attending = 'unknown';
  const availability = data.availability.find(
    (v) => v.member_id === member.member_id && v.date === day.date,
  )!;
  availability.available = 'unknown';
  const members = [...data.members].reverse();
  members[0].pickup_notes = 'First line\nSecond line';
  const texts = {
    members: writeCsv(
      headers.members,
      members.map((m) => ({ ...m })),
    ),
    attendance: writeCsv(
      headers.attendance,
      [...data.attendance].reverse().map((a) => ({ ...a })),
    ),
    availability: writeCsv(
      headers.availability,
      data.availability.map((v) => ({ ...v })),
    ),
  };
  const table = parseCsv(texts.members);
  const rowMap = Object.fromEntries(table.rowNumbers.map((line, n) => [line, n + 5]));
  const issues = locateOperationalIssues(
    operationalIssues(data, { ...defaultSettings, dates: [day.date] }),
    texts,
    { members: { label: 'Roster.xlsx · members', rowMap } },
  );
  const pickup = issues.find((i) => i.field === 'pickup_address')!;
  expect(pickup).toMatchObject({
    file: 'Roster.xlsx · members',
    row: members.length + 4,
    memberId: member.member_id,
    severity: 'error',
  });
  expect(pickup.message).toContain(member.display_name);
  const attendance = issues.find((i) => i.field === 'attending')!;
  const attendanceTable = parseCsv(texts.attendance);
  expect(attendance.row).toBe(
    attendanceTable.rowNumbers[
      attendanceTable.rows.findIndex(
        (a) => a.member_id === other.member_id && a.date === other.date,
      )
    ],
  );
  expect(attendance.message).toContain(
    data.members.find((m) => m.member_id === other.member_id)!.display_name,
  );
  expect(issues.find((i) => i.field === 'available')).toMatchObject({
    severity: 'warning',
    inputKind: 'availability',
  });
  expect(issues.filter((i) => i.severity === 'error')).toHaveLength(2);
});

it('does not invent a row for missing availability or unreadable input', () => {
  const issues = locateOperationalIssues(
    [
      {
        file: 'driver_availability.csv',
        inputKind: 'availability',
        memberId: 'missing',
        date: '2026-10-05',
        message: 'Unknown availability',
        severity: 'warning',
      },
      {
        file: 'members.csv',
        inputKind: 'members',
        memberId: 'missing',
        message: 'Review pickup',
        severity: 'error',
      },
    ],
    {
      members: 'bad,"unclosed',
      attendance: '',
      availability: 'date,member_id\n2026-10-06,missing\n',
    },
    { availability: { label: 'Drivers.xls · driver_availability' } },
  );
  expect(issues.every((i) => i.row === undefined)).toBe(true);
  expect(issues[0].file).toBe('Drivers.xls · driver_availability');
});
