import { travelLabel } from '../domain/types';
import type { CarRoute, Dataset, DayProblem, Plan } from '../domain/types';
import { clockMinutes } from '../domain/util';
import { writeCsv } from '../importers/csv';
export interface Snapshot {
  plan: Plan;
  problems: DayProblem[];
  data: Dataset;
  revision: number;
}
export const navLink = (from: string, to: string) =>
  `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=driving`;
export function instructions(
  route: CarRoute,
  problem: DayProblem,
  data: Dataset,
  simulation: boolean,
): string {
  const name = (id: string) => data.members.find((m) => m.member_id === id)?.display_name ?? id;
  let previous = problem.matrix.locations[route.start].address;
  const lines = [
    `${simulation ? 'SIMULATION · ' : ''}${problem.date} · ${name(route.driverId)}`,
    ...(data.scenario?.uploadedTest
      ? [
          'UPLOADED-DATA TEST: assumed attendance/transport, fictitious pickups, and hypothetical drivers. Do not use as real driving instructions.',
        ]
      : []),
    `All times America/New_York. Arrival is an estimate.`,
    `Depart ${clockMinutes(route.departure)} from ${previous}. ${route.passengerIds.length + 1}/${route.seats} seats used.`,
  ];
  for (const stop of route.stops) {
    const address = problem.matrix.locations[stop.location].address;
    lines.push(
      `${clockMinutes(stop.arrival)} pick up ${stop.memberIds.map(name).join(', ')} at ${address}. Leave ${clockMinutes(stop.departure)}.`,
      ...(data.scenario?.uploadedTest ? [] : [navLink(previous, address)]),
    );
    previous = address;
  }
  const destination = problem.matrix.locations[route.destination].address;
  lines.push(
    `${clockMinutes(route.arrival)} estimated arrival at ${destination}.`,
    ...(data.scenario?.uploadedTest ? [] : [navLink(previous, destination)]),
  );
  if (problem.matrix.provider !== 'mock')
    lines.push(`Travel estimates: ${travelLabel(problem.matrix.provider)}.`);
  return lines.join('\n');
}
export function planJson(s: Snapshot): string {
  const names = Object.fromEntries(
    s.data.members
      .filter((m) =>
        s.plan.days.some((d) =>
          [
            ...d.routes.flatMap((r) => [r.driverId, ...r.passengerIds]),
            ...d.independent,
            ...d.external,
            ...d.unassigned,
            ...d.unresolved,
          ].includes(m.member_id),
        ),
      )
      .map((m) => [m.member_id, m.display_name]),
  );
  return JSON.stringify(
    {
      ...s.plan,
      memberNames: names,
      locationsByDate: Object.fromEntries(s.problems.map((p) => [p.date, p.matrix.locations])),
      driverInstructions: s.plan.days.flatMap((d, i) =>
        d.routes.map((r) => instructions(r, s.problems[i], s.data, s.plan.simulation)),
      ),
    },
    null,
    2,
  );
}
export function planCsv(s: Snapshot): string {
  const rows: Record<string, unknown>[] = [];
  const name = (id: string) => s.data.members.find((m) => m.member_id === id)?.display_name ?? id;
  const metadata = {
    schema_version: 1,
    travel_provider: travelLabel(s.plan.settings.mode),
    generated_at: s.plan.generatedAt,
    mode: s.plan.simulation ? 'Simulation' : `${travelLabel(s.plan.settings.mode)} estimates`,
    timezone: s.plan.settings.timezone,
    verified: s.plan.verified,
    settings: JSON.stringify(s.plan.settings),
    scenario: JSON.stringify(s.plan.scenario ?? { seed: s.plan.settings.seed }),
    fairness_score: s.plan.fairnessScore,
  };
  for (const [i, day] of s.plan.days.entries()) {
    const p = s.problems[i];
    for (const r of day.routes) {
      let previous = p.matrix.locations[r.start].address;
      rows.push({
        ...metadata,
        date: day.date,
        status: day.status,
        driver: name(r.driverId),
        member_id: r.driverId,
        role: 'driver',
        time: clockMinutes(r.departure),
        address: previous,
        occupancy: 1,
        total_seats: r.seats,
        route_minutes: r.durationSeconds / 60,
        distance_meters: r.meters,
      });
      for (const stop of r.stops) {
        const address = p.matrix.locations[stop.location].address;
        for (const id of stop.memberIds)
          rows.push({
            ...metadata,
            date: day.date,
            status: day.status,
            driver: name(r.driverId),
            member_id: id,
            role: 'passenger',
            time: clockMinutes(stop.arrival),
            address,
            occupancy: stop.occupancy,
            total_seats: r.seats,
            navigation: s.plan.scenario?.uploadedTest ? '' : navLink(previous, address),
          });
        previous = address;
      }
      rows.push({
        ...metadata,
        date: day.date,
        status: day.status,
        driver: name(r.driverId),
        role: 'arrival',
        time: clockMinutes(r.arrival),
        address: p.matrix.locations[r.destination].address,
        navigation: s.plan.scenario?.uploadedTest
          ? ''
          : navLink(previous, p.matrix.locations[r.destination].address),
      });
    }
    for (const [role, ids] of [
      ['self', day.independent],
      ['external', day.external],
      ['unassigned', day.unassigned],
      ['unresolved', day.unresolved],
    ] as const)
      for (const id of ids)
        rows.push({
          ...metadata,
          date: day.date,
          status: day.status,
          member_id: id,
          role,
          notes: day.messages.join(' '),
        });
    if (!day.routes.length && !day.unassigned.length)
      rows.push({
        ...metadata,
        date: day.date,
        status: day.status,
        role: 'day-summary',
        notes: day.messages.join(' '),
      });
  }
  return writeCsv(
    [
      'schema_version',
      'travel_provider',
      'generated_at',
      'mode',
      'timezone',
      'verified',
      'date',
      'status',
      'driver',
      'member_id',
      'role',
      'time',
      'address',
      'occupancy',
      'total_seats',
      'route_minutes',
      'distance_meters',
      'navigation',
      'notes',
      'settings',
      'scenario',
      'fairness_score',
    ],
    rows,
    true,
  );
}
export function download(filename: string, content: string, type = 'text/plain') {
  const a = document.createElement('a'),
    url = URL.createObjectURL(new Blob([content], { type }));
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
