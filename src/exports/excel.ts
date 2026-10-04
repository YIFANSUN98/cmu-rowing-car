import * as XLSX from 'xlsx';
import type { Snapshot } from './plan';
import { navLink } from './plan';

type Value = string | number | XLSX.CellObject;
const excelTime = (seconds: number): XLSX.CellObject => ({
  t: 'n',
  v: Math.floor(seconds / 60) / 1440,
  z: 'hh:mm',
});
// Shorten only the shared city/state suffix, preserving street numbers and apartment details.
// Routing and navigation continue to use the original complete address.
const streetAddress = (address: string) =>
  address
    .replace(
      /(?:,\s*|\s+)Pittsburgh\s*,?\s*(?:PA|Pennsylvania)\s*,?\s*(?:\d{5}(?:-\d{4})?)?(?:\s*,?\s*(?:USA|US|United States(?: of America)?))?\s*$/i,
      '',
    )
    .trim() || address;

// Loaded only on download. Each date stacks cars in name/time/address columns.
// Uploaded text remains string cells and is never interpreted as a formula.
export function createPlanWorkbook({ plan, problems, data }: Snapshot): XLSX.WorkBook {
  const book = XLSX.utils.book_new();
  const names = new Map(data.members.map((m) => [m.member_id, m.display_name]));
  const name = (id: string) => {
    const value = names.get(id);
    if (!value)
      throw new Error('A planned member is missing from the roster. Replan before downloading.');
    return value;
  };
  if (!plan.days.length) throw new Error('Plan your practice dates before downloading.');
  for (const day of plan.days) {
    const problem = problems.find((p) => p.date === day.date);
    if (!problem)
      throw new Error('Route details are missing for a practice date. Replan before downloading.');
    const rows: Value[][] = [
      [`${day.date} · America/New_York`],
      ['Driver: depart. Pickups / boathouse: arrive.'],
    ];
    const columns: XLSX.ColInfo[] = [{ wch: 30 }, { wch: 10 }, { wch: 36 }];
    for (const [index, route] of day.routes.entries()) {
      let previous = problem.matrix.locations[route.start].address;
      const car: [Value, Value, Value][] = [
        [`Car ${index + 1}`, 'Time (ET)', 'Street address'],
        [`${name(route.driverId)} (driver)`, excelTime(route.departure), streetAddress(previous)],
      ];
      const stopName = (label: string, address: string): XLSX.CellObject => ({
        t: 's',
        v: label,
        ...(!plan.scenario?.uploadedTest && {
          l: { Target: navLink(previous, address), Tooltip: streetAddress(address) },
        }),
      });
      for (const stop of route.stops) {
        const address = problem.matrix.locations[stop.location].address;
        // Row order is pickup order; shared pickups retain the same time and address.
        for (const id of stop.memberIds)
          car.push([stopName(name(id), address), excelTime(stop.arrival), streetAddress(address)]);
        previous = address;
      }
      car.push([
        stopName('Boathouse', problem.matrix.locations[route.destination].address),
        excelTime(route.arrival),
        streetAddress(problem.matrix.locations[route.destination].address),
      ]);
      if (index > 0) rows.push([]);
      rows.push(...car);
      const longestName = Math.max(
        ...car.map(([value]) => String(typeof value === 'object' ? value.v : value).length),
      );
      columns[0].wch = Math.max(columns[0].wch!, longestName + 2);
      columns[2].wch = Math.max(columns[2].wch!, ...car.map((row) => String(row[2]).length + 2));
    }
    const lastColumn = columns.length - 1;
    for (const [index, trip] of (day.rideShares ?? []).entries()) {
      const pickup = problem.matrix.locations[trip.location].address;
      rows.push([], [`Uber ${index + 1} · booking required`, 'Time (ET)', 'Street address']);
      for (const id of trip.memberIds)
        rows.push([name(id), excelTime(trip.pickupTime), streetAddress(pickup)]);
      rows.push(
        ['Leave pickup by', excelTime(trip.departure), streetAddress(pickup)],
        [
          'Boathouse',
          excelTime(trip.arrival),
          streetAddress(problem.matrix.locations[trip.destination].address),
        ],
      );
    }
    const merges: XLSX.Range[] = [0, 1].map((r) => ({
      s: { r, c: 0 },
      e: { r, c: lastColumn },
    }));
    const notes: string[] = [];
    if (plan.settings.comparisonDates?.[day.date])
      notes.push(
        `Historical comparison: estimates use ${plan.settings.comparisonDates[day.date]}, not observed traffic on ${day.date}.`,
      );
    if (day.rideShares?.length)
      notes.push(
        'Uber rides must be booked separately. Pickup waiting time, availability and fares are not included.',
      );
    if (plan.simulation) notes.push('Simulation — not an operational schedule.');
    if (plan.scenario?.uploadedTest)
      notes.push('Assumed attendance, fictitious pickups and hypothetical drivers.');
    if (day.status !== 'feasible') notes.push('Incomplete day — needs review.');
    if (!day.routes.length)
      notes.push(
        day.status === 'feasible' ? 'No carpool routes for this date.' : 'No verified routes.',
      );
    notes.push(...day.messages);
    for (const [label, ids] of [
      ['Unassigned', day.unassigned],
      ['Needs review', day.unresolved],
      ['Independent travel', day.independent],
      ['External transport', day.external],
    ] as const)
      for (const id of ids) notes.push(`${label}: ${name(id)}`);
    if (notes.length) {
      rows.push([]);
      // Keep notes on their date tab, without widening the car columns.
      const noteWidth = Math.floor(columns.reduce((sum, c) => sum + (c.wch ?? 0), 0)) - 4;
      for (const note of notes) {
        let line = '';
        const appendLine = () => {
          const r = rows.length;
          rows.push([line]);
          merges.push({ s: { r, c: 0 }, e: { r, c: lastColumn } });
        };
        for (const word of note.split(/\s+/)) {
          if (line && line.length + word.length + 1 > noteWidth) {
            appendLine();
            line = '';
          }
          line += (line ? ' ' : '') + word;
        }
        if (line) appendLine();
      }
    }
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = columns;
    sheet['!merges'] = merges;
    sheet['!rows'] = rows.map((row, r) => ({ hpt: r === 0 ? 26 : row.length ? 22 : 12 }));
    XLSX.utils.book_append_sheet(book, sheet, day.date);
  }
  book.Props = { Title: 'CMU Rowing — Daily car plans' };
  return book;
}

export function planExcelFilename(snapshot: Snapshot): string {
  const dates = snapshot.plan.days.map((d) => d.date).sort();
  const range = dates.length > 1 ? `${dates[0]}_to_${dates.at(-1)}` : (dates[0] ?? 'week');
  return `cmu-rowing-routes_${range}.xlsx`;
}

export function downloadPlanExcel(snapshot: Snapshot) {
  XLSX.writeFile(createPlanWorkbook(snapshot), planExcelFilename(snapshot), {
    bookType: 'xlsx',
    compression: true,
  });
}
