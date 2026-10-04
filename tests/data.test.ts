import { it, expect } from 'vitest';
import { parseCsv, writeCsv } from '../src/importers/csv';
import { parseDataset, operationalIssues, headers } from '../src/domain/validation';
import { defaultSettings } from '../src/domain/types';
import { makeDemo, simulateAvailability } from '../src/domain/scenarios';
import { stableId, validDate, zonedDate } from '../src/domain/util';
const texts = () => {
  const data = makeDemo();
  return {
    members: writeCsv(
      headers.members,
      data.members.map((r) => ({ ...r })),
    ),
    attendance: writeCsv(
      headers.attendance,
      data.attendance.map((r) => ({ ...r })),
    ),
    availability: writeCsv(
      headers.availability,
      data.availability.map((r) => ({ ...r })),
    ),
  };
};
it('handles BOM, quoted commas, escaped quotes, embedded newlines and CRLF', () => {
  const parsed = parseCsv('\uFEFFid,name\r\n1,"Avery, ""Example""\nCrew"\r\n2,Blair\r\n');
  expect(parsed.rows[0].name).toBe('Avery, "Example"\nCrew');
  expect(parsed.rowNumbers).toEqual([2, 4]);
  expect(() => parseCsv('a,b\n1,"oops')).toThrow('unclosed');
  expect(() => parseCsv('a,b\n1,2,3')).toThrow('columns');
});
it('validates canonical inputs and reports duplicate/cross-file rows', () => {
  const t = texts();
  expect(parseDataset(t).issues).toEqual([]);
  t.members += t.members.split('\r\n')[1] + '\r\n';
  expect(parseDataset(t).issues.some((i) => i.message.includes('Duplicate') && i.row)).toBe(true);
  t.attendance += '2026-10-05,unknown-id,true,carpool,,,\r\n';
  expect(parseDataset(t).issues.some((i) => i.message.includes('Unknown member_id'))).toBe(true);
});
it('preserves unknown versus false and rejects impossible capacities and invalid coordinates', () => {
  const t = texts();
  t.availability = t.availability.replace(',true,5,simulated', ',unknown,,confirmed');
  expect(parseDataset(t).data.availability[0].available).toBe('unknown');
  expect(parseDataset(t).data.availability[0].total_seats).toBeUndefined();
  t.availability = t.availability.replace(',true,5,simulated', ',true,6,confirmed');
  expect(parseDataset(t).issues.some((i) => i.field === 'total_seats')).toBe(true);
  const memberRows = parseCsv(t.members).rows;
  memberRows[0].pickup_lat = '91';
  t.members = writeCsv(headers.members, memberRows);
  expect(parseDataset(t).issues.some((i) => i.field === 'pickup_lat')).toBe(true);
});
it('does not block on incomplete nonparticipating pickups, accepts reviewed overrides, blocks unknown attendance', () => {
  const data = makeDemo();
  data.members[0].pickup_address = '';
  const s = { ...defaultSettings, dates: ['2026-10-05'] };
  data.attendance
    .filter((a) => a.member_id === data.members[0].member_id)
    .forEach((a) => (a.attending = 'false'));
  expect(operationalIssues(data, s).filter((i) => i.severity === 'error')).toEqual([]);
  data.attendance[0].attending = 'true';
  data.attendance[0].pickup_override = '12 Reviewed Fiction Lane';
  expect(operationalIssues(data, s).filter((i) => i.severity === 'error')).toEqual([]);
  data.attendance[1].attending = 'unknown';
  expect(operationalIssues(data, s).some((i) => i.field === 'attending')).toBe(true);
});
it('keeps stable IDs through harmless name cleanup and rejects impossible dates', () => {
  expect(stableId(' Avery   Example ')).toBe(stableId('avery example'));
  expect(validDate('2026-02-30')).toBe(false);
  expect(validDate('2028-02-29')).toBe(true);
});
it('uses New York date and DST rather than the machine timezone', () => {
  expect(zonedDate('2026-01-05', 4 * 3600).toISOString()).toBe('2026-01-05T09:00:00.000Z');
  expect(zonedDate('2026-07-06', 4 * 3600).toISOString()).toBe('2026-07-06T08:00:00.000Z');
  expect(() => zonedDate('2026-03-08', 2.5 * 3600)).toThrow('does not exist');
});
it('requires future Google dates and an actual confirmed destination', () => {
  const data = makeDemo();
  const issues = operationalIssues(data, {
    ...defaultSettings,
    mode: 'google',
    dates: ['2020-01-01'],
  });
  expect(issues.some((i) => i.message.includes('destination'))).toBe(true);
  expect(issues.some((i) => i.message.includes('future'))).toBe(true);
});
it('generates seeded scenarios with explicit candidates and real cancellation', () => {
  const a = makeDemo({ kind: 'mixed', seed: 5 }),
    b = makeDemo({ kind: 'mixed', seed: 5 });
  expect(a).toEqual(b);
  expect(new Set(a.availability.map((v) => v.total_seats))).toEqual(new Set([3, 4, 5]));
  const id = a.scenario!.candidateIds[0];
  const cancelled = simulateAvailability(a, {
    ...a.scenario!,
    kind: 'cancellation',
    cancelledDriver: id,
  });
  expect(
    cancelled.availability.filter((v) => v.member_id === id).every((v) => v.available === 'false'),
  ).toBe(true);
  expect(() => simulateAvailability(a, { kind: 'broad', seed: 1, candidateIds: [] })).toThrow(
    'explicit',
  );
  expect(() => simulateAvailability(a, { ...a.scenario!, kind: 'observed' })).toThrow('reviewed');
});
it('restricts observed simulation to the reviewed day and candidate pool', () => {
  const data = makeDemo();
  const id = data.scenario!.candidateIds[0];
  const result = simulateAvailability(
    data,
    { ...data.scenario!, kind: 'observed' },
    { '2026-10-05': [id, 'not-in-pool'] },
  );
  expect(result.availability.filter((a) => a.available === 'true')).toHaveLength(1);
  expect(result.availability.every((a) => a.source === 'simulated')).toBe(true);
});
it('rejects a planning horizon crossing a DST clock change instead of treating wall-clock hours as elapsed time', () => {
  const issues = operationalIssues(makeDemo(), {
    ...defaultSettings,
    dates: ['2026-03-08'],
    earliestDeparture: '01:30',
  });
  expect(issues.some((i) => i.message.includes('daylight-saving clock change'))).toBe(true);
});
