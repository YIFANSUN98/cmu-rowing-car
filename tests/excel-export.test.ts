import { expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { createPlanWorkbook, planExcelFilename } from '../src/exports/excel';
import { navLink, type Snapshot } from '../src/exports/plan';
import { tiny } from './helpers';
import { solveWeek } from '../src/planner/solve';
import { defaultSettings } from '../src/domain/types';
import { clockMinutes } from '../src/domain/util';

function snapshot(shortfall = false): Snapshot {
  const first = tiny(5, 2, 3),
    second = tiny(shortfall ? 8 : 6, 2, 3);
  second.date = second.matrix.date = '2026-10-06';
  first.riders[4].location = first.riders[3].location;
  const problems = [first, second];
  const plan = solveWeek(problems, {
    ...defaultSettings,
    mode: 'tomtom',
    dates: problems.map((p) => p.date),
  });
  plan.simulation = false;
  return {
    plan,
    problems,
    revision: 0,
    data: {
      schemaVersion: 1,
      attendance: [],
      availability: [],
      members: second.riders.map((r, i) => ({
        member_id: r.id,
        display_name: i === 0 ? '=1+1' : `Example Rower ${i}`,
        pickup_address: 'Example address',
      })),
    },
  };
}
function roundTrip(s: Snapshot) {
  return XLSX.read(XLSX.write(createPlanWorkbook(s), { type: 'buffer', bookType: 'xlsx' }), {
    cellNF: true,
  });
}
const cell = (sheet: XLSX.WorkSheet, r: number, c: number): XLSX.CellObject | undefined =>
  sheet[XLSX.utils.encode_cell({ r, c })];

it('stacks cars with blank rows and preserves every rider, street address and minute time on each date tab', () => {
  const s = snapshot(),
    book = roundTrip(s);
  expect(book.SheetNames).toEqual(['2026-10-05', '2026-10-06']);
  expect(planExcelFilename(s)).toBe('cmu-rowing-routes_2026-10-05_to_2026-10-06.xlsx');
  const name = (id: string) => s.data.members.find((m) => m.member_id === id)!.display_name;
  expect(s.plan.days[0].routes.some((r) => r.stops.some((stop) => stop.memberIds.length > 1))).toBe(
    true,
  );
  for (const [di, day] of s.plan.days.entries()) {
    const p = s.problems[di],
      sheet = book.Sheets[day.date];
    expect(day.routes).toHaveLength(2);
    expect(sheet.A1.v).toContain('America/New_York');
    expect(sheet.A2.v).toBe('Driver: depart. Pickups / boathouse: arrive.');
    let row = 2;
    for (const [index, route] of day.routes.entries()) {
      expect(cell(sheet, row, 0)?.v).toBe(`Car ${index + 1}`);
      expect(cell(sheet, row, 1)?.v).toBe('Time (ET)');
      expect(cell(sheet, row, 2)?.v).toBe('Street address');
      row++;
      expect(cell(sheet, row, 0)?.v).toBe(`${name(route.driverId)} (driver)`);
      expect(cell(sheet, row, 2)?.v).toBe(p.matrix.locations[route.start].address);
      const checkTime = (r: number, seconds: number) => {
        const value = cell(sheet, r, 1)!;
        expect(value.t).toBe('n');
        expect(value.z).toBe('hh:mm');
        expect(value.v).toBeCloseTo(Math.floor(seconds / 60) / 1440, 12);
        expect(XLSX.utils.format_cell(value)).toBe(clockMinutes(seconds));
      };
      checkTime(row++, route.departure);
      let previous = p.matrix.locations[route.start].address;
      for (const stop of route.stops) {
        const address = p.matrix.locations[stop.location].address;
        for (const id of stop.memberIds) {
          expect(cell(sheet, row, 0)?.v).toBe(name(id));
          expect(cell(sheet, row, 0)?.l?.Target).toBe(navLink(previous, address));
          expect(cell(sheet, row, 2)?.v).toBe(address);
          checkTime(row++, stop.arrival);
        }
        previous = address;
      }
      const destination = p.matrix.locations[route.destination].address;
      expect(cell(sheet, row, 0)?.v).toBe('Boathouse');
      expect(cell(sheet, row, 0)?.l?.Target).toBe(navLink(previous, destination));
      expect(cell(sheet, row, 2)?.v).toBe(destination);
      checkTime(row++, route.arrival);
      for (const column of [0, 1, 2]) expect(cell(sheet, row, column)).toBeUndefined();
      row++;
    }
    expect(XLSX.utils.decode_range(sheet['!ref']!).e.c).toBe(2);
    const formulaLike = Object.values(sheet).filter((c) => c?.v === '=1+1 (driver)');
    expect(formulaLike.length).toBeGreaterThan(0);
    expect(formulaLike.every((c) => c.t === 's' && !c.f)).toBe(true);
    expect(XLSX.utils.sheet_to_csv(sheet)).not.toContain('m0');
  }
});

it('omits the shared city/state/ZIP in Excel while preserving street details and complete navigation links', () => {
  const s = snapshot();
  const variants = [
    '5136 Margaret Morrison St, Apt 4, Pittsburgh, PA 15217',
    '300 Waterfront Dr, Pittsburgh, PA 15222',
    '12 Example Ave, pittsburgh, pa 15213-1234, USA',
    '18 Example St Pittsburgh Pennsylvania 15213',
    '20 Pittsburgh St, Suite 3, Pittsburgh, PA, 15213, United States',
    '25 Other Ave, Cleveland, OH 44114',
  ];
  const displayed = [
    '5136 Margaret Morrison St, Apt 4',
    '300 Waterfront Dr',
    '12 Example Ave',
    '18 Example St',
    '20 Pittsburgh St, Suite 3',
    '25 Other Ave, Cleveland, OH 44114',
  ];
  s.problems.forEach((p) =>
    p.matrix.locations.forEach((place, i) => {
      place.address = variants[i % variants.length];
    }),
  );
  const original = structuredClone(s),
    book = roundTrip(s);
  for (const sheet of Object.values(book.Sheets)) {
    for (const row of XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false })) {
      if (row[1] && row[1] !== 'Time (ET)') expect(displayed).toContain(row[2]);
    }
    for (const value of Object.values(sheet)) {
      if (!value?.l?.Target) continue;
      const url = new URL(value.l.Target);
      expect(variants).toContain(url.searchParams.get('origin'));
      expect(variants).toContain(url.searchParams.get('destination'));
    }
  }
  expect(s).toEqual(original);
});

it('keeps incomplete dates and their unassigned people on the relevant date tab', () => {
  const s = snapshot(true),
    book = roundTrip(s);
  expect(s.plan.verified).toBe(false);
  expect(book.SheetNames).toEqual(['2026-10-05', '2026-10-06']);
  const text = XLSX.utils.sheet_to_csv(book.Sheets['2026-10-06']);
  expect(text).toContain('Incomplete day');
  expect(text).toContain('No verified routes');
  expect(text).toContain('capacity');
  expect(text).not.toContain('Car 1');
  for (const m of s.data.members) expect(text).toContain(`Unassigned: ${m.display_name}`);
  expect(XLSX.utils.sheet_to_csv(book.Sheets['2026-10-05'])).not.toContain('Incomplete');
});
