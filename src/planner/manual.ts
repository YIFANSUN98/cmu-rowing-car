import type {
  Attendance,
  CarRoute,
  Dataset,
  DayPlan,
  DayProblem,
  Edge,
  Plan,
  Settings,
} from '../domain/types';
import type { Snapshot } from '../exports/plan';
import { seconds, validTime } from '../domain/util';
import { prepareProblems } from '../domain/prepare';
import { operationalIssues } from '../domain/validation';
import { withComparisonDates } from '../domain/comparison';
import type { RouteAlternative, RouteRequest, TravelProvider } from '../travel/provider';
import { checkAbort } from '../travel/provider';
import { recheckPlan } from '../travel/recheck';
import { checkDay } from './check';
import { usageFor } from './solve';

export interface ManualPerson {
  id: string;
  mode: Attendance['transport_mode'] | 'absent' | 'unconfirmed';
  pickup: string;
  readyAfter: string;
}
export interface ManualCar {
  id: string;
  driverId: string;
  passengerIds: string[];
  seats: number;
  leaveAt: string;
}
export interface ManualDay {
  date: string;
  people: ManualPerson[];
  cars: ManualCar[];
}
export interface ManualDraft {
  deadline: string;
  days: ManualDay[];
}

export function createManualDraft(
  data: Dataset,
  settings: Settings,
  snapshot?: Snapshot,
): ManualDraft {
  return {
    deadline: settings.deadline,
    days: [...settings.dates].sort().map((date) => {
      const planned = snapshot?.plan.days.find((day) => day.date === date);
      const problem = snapshot?.problems.find((day) => day.date === date);
      const cars =
        planned?.routes.map((r, index) => ({
          id: `car-${index}`,
          driverId: r.driverId,
          passengerIds: r.stops.flatMap((s) => s.memberIds),
          seats: r.seats,
          leaveAt: r.fixedDeparture
            ? `${String(Math.floor(r.departure / 3600)).padStart(2, '0')}:${String(Math.floor(r.departure / 60) % 60).padStart(2, '0')}`
            : '',
        })) ?? [];
      return {
        date,
        cars,
        people: data.members.map((m) => {
          const a = data.attendance.find((a) => a.date === date && a.member_id === m.member_id);
          const driver = planned?.routes.find((r) => r.driverId === m.member_id);
          const pickup =
            driver && problem
              ? problem.matrix.locations[driver.start].address
              : a?.pickup_override ||
                m.pickup_address ||
                (m.pickup_lat !== undefined && m.pickup_lng !== undefined
                  ? `${m.pickup_lat},${m.pickup_lng}`
                  : '');
          return {
            id: m.member_id,
            mode:
              !a || a.attending === 'false'
                ? 'absent'
                : a.attending === 'unknown'
                  ? 'unconfirmed'
                  : planned?.rideShares?.some((t) => t.memberIds.includes(m.member_id))
                    ? 'uber'
                    : a.transport_mode,
            pickup,
            readyAfter: a?.ready_after ?? '',
          };
        }),
      };
    }),
  };
}

// Every move removes the previous assignment first. Replacing a driver leaves the former
// driver unassigned so an emergency cancellation never silently removes an attendee.
export function moveManualPerson(day: ManualDay, id: string, target: string): ManualDay {
  const next = structuredClone(day),
    person = next.people.find((p) => p.id === id)!;
  if (target.startsWith('driver:')) return next;
  for (const car of next.cars) {
    if (car.driverId === id) car.driverId = '';
    car.passengerIds = car.passengerIds.filter((p) => p !== id);
  }
  const car = next.cars.find((c) => `car:${c.id}` === target);
  if (car) {
    car.passengerIds.push(id);
    person.mode = 'carpool';
  } else person.mode = target as ManualPerson['mode'];
  return next;
}
export function setManualDriver(day: ManualDay, carId: string, driverId: string): ManualDay {
  const next = driverId ? moveManualPerson(day, driverId, 'carpool') : structuredClone(day);
  next.cars.find((c) => c.id === carId)!.driverId = driverId;
  return next;
}

export function manualDraftErrors(draft: ManualDraft, data: Dataset): string[] {
  const errors: string[] = [];
  const name = (id: string) =>
    data.members.find((m) => m.member_id === id)?.display_name ?? 'Unknown member';
  if (!validTime(draft.deadline)) errors.push('Enter a valid arrival time.');
  if (
    !draft.days.length ||
    draft.days.length > 7 ||
    new Set(draft.days.map((d) => d.date)).size !== draft.days.length
  )
    errors.push('Choose one to seven distinct practice dates.');
  for (const day of draft.days) {
    const prefix = `${day.date}: `,
      seen = new Set<string>();
    if (new Set(day.cars.map((c) => c.id)).size !== day.cars.length)
      errors.push(prefix + 'Each car needs a distinct entry.');
    if (
      day.people.length !== data.members.length ||
      new Set(day.people.map((p) => p.id)).size !== data.members.length ||
      day.people.some((p) => !data.members.some((m) => m.member_id === p.id))
    )
      errors.push(prefix + 'The member list changed. Reopen the editor.');
    const cover = (id: string) => {
      if (seen.has(id)) errors.push(prefix + `${name(id)} is assigned more than once.`);
      seen.add(id);
      if (!day.people.some((p) => p.id === id && p.mode === 'carpool'))
        errors.push(prefix + `${name(id)} must be attending by carpool to ride in a car.`);
    };
    for (const [i, car] of day.cars.entries()) {
      if (!car.driverId)
        errors.push(prefix + `Choose a driver for car ${i + 1}, or remove the car.`);
      else cover(car.driverId);
      car.passengerIds.forEach(cover);
      if (!Number.isInteger(car.seats) || car.seats < 1 || car.seats > 5)
        errors.push(prefix + `Car ${i + 1} needs 1–5 total seats.`);
      if (1 + car.passengerIds.length > car.seats)
        errors.push(
          prefix +
            `Car ${i + 1} has ${1 + car.passengerIds.length} people for ${car.seats} seats. Move a rider or change the car.`,
        );
      if (car.leaveAt && !validTime(car.leaveAt))
        errors.push(prefix + `Enter a valid departure time for car ${i + 1}.`);
    }
    for (const person of day.people) {
      if (['carpool', 'uber'].includes(person.mode) && !person.pickup.trim())
        errors.push(prefix + `Enter a pickup address for ${name(person.id)}.`);
      if (person.mode === 'carpool' && !seen.has(person.id))
        errors.push(prefix + `Assign ${name(person.id)} to a car, Uber, or independent travel.`);
      if (person.mode === 'unconfirmed' || person.mode === 'unknown')
        errors.push(prefix + `Choose attendance and travel for ${name(person.id)}.`);
      if (person.readyAfter && !validTime(person.readyAfter))
        errors.push(prefix + `Enter a valid ready time for ${name(person.id)}.`);
    }
  }
  return errors;
}

export function applyManualDraft(data: Dataset, draft: ManualDraft): Dataset {
  const errors = manualDraftErrors(draft, data);
  if (errors.length) throw new Error(errors.join('\n'));
  const result = structuredClone(data);
  for (const day of draft.days) {
    result.attendance = result.attendance.filter((a) => a.date !== day.date);
    result.availability = result.availability.filter((a) => a.date !== day.date);
    for (const p of day.people) {
      const old = data.attendance.find((a) => a.date === day.date && a.member_id === p.id);
      const member = data.members.find((m) => m.member_id === p.id)!;
      const driver = day.cars.find((c) => c.driverId === p.id);
      result.attendance.push({
        ...old,
        date: day.date,
        member_id: p.id,
        attending: p.mode === 'absent' ? 'false' : 'true',
        transport_mode: p.mode === 'absent' ? 'carpool' : (p.mode as Attendance['transport_mode']),
        pickup_override:
          p.pickup.trim() ===
          (member.pickup_address ||
            (member.pickup_lat !== undefined && member.pickup_lng !== undefined
              ? `${member.pickup_lat},${member.pickup_lng}`
              : ''))
            ? undefined
            : p.pickup.trim(),
        ready_after: p.readyAfter || undefined,
      });
      const availability = data.availability.find(
        (a) => a.date === day.date && a.member_id === p.id,
      );
      result.availability.push({
        ...availability,
        date: day.date,
        member_id: p.id,
        available: driver ? 'true' : 'false',
        total_seats: driver?.seats,
        source: 'confirmed',
        start_address: undefined,
        earliest_departure: p.readyAfter || availability?.earliest_departure,
      });
    }
  }
  return result;
}

function stopsFor(car: ManualCar, problem: DayProblem) {
  const stops: { location: number; memberIds: string[] }[] = [];
  for (const id of car.passengerIds) {
    const rider = problem.riders.find((r) => r.id === id)!;
    const previous = stops.at(-1);
    if (previous?.location === rider.location) previous.memberIds.push(id);
    else stops.push({ location: rider.location, memberIds: [id] });
  }
  return stops;
}
const validEdges = (edges: Edge[], length: number) =>
  edges.length === length &&
  edges.every(
    (e) =>
      e.reachable &&
      Number.isFinite(e.seconds) &&
      e.seconds >= 0 &&
      Number.isFinite(e.meters) &&
      e.meters >= 0,
  );

export async function generateManualPlan(
  data: Dataset,
  draft: ManualDraft,
  settings: Settings,
  provider: TravelProvider,
  signal?: AbortSignal,
  progress?: (message: string, fraction: number) => void,
): Promise<Omit<Snapshot, 'revision'>> {
  checkAbort(signal);
  const input = applyManualDraft(data, draft);
  const readable = (message: string) =>
    [...input.members]
      .sort((a, b) => b.member_id.length - a.member_id.length)
      .reduce((text, member) => text.split(member.member_id).join(member.display_name), message);
  const earliestDeparture = [
    settings.earliestDeparture,
    ...draft.days.flatMap((day) => [
      ...day.cars.map((car) => car.leaveAt),
      ...day.people.filter((p) => p.mode !== 'absent').map((p) => p.readyAfter),
    ]),
  ]
    .filter(Boolean)
    .sort()[0];
  const config = withComparisonDates({
    ...settings,
    earliestDeparture,
    deadline: draft.deadline,
    dates: draft.days.map((d) => d.date),
  });
  const errors = operationalIssues(input, config).filter((i) => i.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.message).join('\n'));
  // Manual assignments need only their chosen routes, not an all-pairs search matrix.
  const problems = await prepareProblems(
    input,
    config,
    provider,
    signal,
    (message, fraction) => progress?.(message, fraction * 0.35),
    false,
  );
  const { zonedDate } = await import('../domain/util');
  const cases = problems.flatMap((p, di) => {
    const date = config.comparisonDates?.[p.date] ?? p.date;
    const cars = draft.days
      .find((d) => d.date === p.date)!
      .cars.map((car) => {
        const driver = p.drivers.find((d) => d.id === car.driverId)!;
        return {
          di,
          car,
          memberIds: [] as string[],
          locations: [driver.start, ...stopsFor(car, p).map((s) => s.location), p.destination],
          departure: car.leaveAt ? seconds(car.leaveAt) : driver.earliest,
        };
      });
    const groups = new Map<number, string[]>();
    p.riders
      .filter((r) => r.requiresUber)
      .forEach((r) => groups.set(r.location, [...(groups.get(r.location) ?? []), r.id]));
    const ubers = [...groups].flatMap(([location, ids]) =>
      Array.from({ length: Math.ceil(ids.length / 4) }, (_, i) => ({
        di,
        car: undefined as ManualCar | undefined,
        memberIds: ids.slice(i * 4, i * 4 + 4),
        locations: [location, p.destination],
        departure: seconds(config.earliestDeparture),
      })),
    );
    return [...cars, ...ubers].map((c) => ({
      ...c,
      request: {
        locations: c.locations.map((i) => p.matrix.locations[i]),
        context: { date, departureIso: zonedDate(date, c.departure).toISOString() },
        boardingSeconds: c.car ? p.boardingSeconds : 0,
      } satisfies RouteRequest,
    }));
  });
  progress?.('Calculating your chosen routes…', 0.4);
  let estimates: RouteAlternative[][] = [];
  if (cases.length && provider.routeBatch)
    estimates = await provider.routeBatch(
      cases.map((c) => c.request),
      signal,
      (n, total) => progress?.('Calculating your chosen routes…', 0.4 + (0.2 * n) / total),
    );
  else
    for (const { request } of cases) {
      checkAbort(signal);
      if (provider.route)
        estimates.push(
          (
            await provider.route(
              request.locations,
              request.context,
              request.boardingSeconds,
              signal,
            )
          ).map((edges) => ({ edges })),
        );
      else {
        const edges: Edge[] = [];
        for (let i = 1; i < request.locations.length; i++)
          edges.push(
            await provider.leg(
              request.locations[i - 1],
              request.locations[i],
              request.context,
              signal,
            ),
          );
        estimates.push([{ edges }]);
      }
    }
  if (estimates.length !== cases.length)
    throw new Error('Incomplete routing response. Try generating again.');
  const days: DayPlan[] = problems.map((p) => ({
    date: p.date,
    status: 'feasible',
    routes: [],
    rideShares: [],
    unassigned: [],
    independent: p.independent,
    external: p.external,
    unresolved: [],
    messages: [],
    alternatives: 1,
    budgetExhausted: false,
  }));
  for (const [i, c] of cases.entries()) {
    const p = problems[c.di],
      day = days[c.di];
    const alternative = estimates[i]
      .filter((a) => validEdges(a.edges, c.locations.length - 1))
      .sort(
        (a, b) =>
          a.edges.reduce((n, e) => n + e.seconds, 0) - b.edges.reduce((n, e) => n + e.seconds, 0),
      )[0];
    if (!alternative)
      throw new Error(`${p.date}: a selected route cannot be reached. Review its pickups.`);
    const { edges } = alternative,
      drivingSeconds = edges.reduce((n, e) => n + e.seconds, 0),
      meters = edges.reduce((n, e) => n + e.meters, 0);
    if (c.car) {
      const driver = p.drivers.find((d) => d.id === c.car!.driverId)!,
        stops = stopsFor(c.car, p);
      const departure = c.car.leaveAt
        ? seconds(c.car.leaveAt)
        : p.deadline - drivingSeconds - stops.length * p.boardingSeconds;
      let time = departure,
        occupancy = 1;
      const route: CarRoute = {
        driverId: driver.id,
        passengerIds: [...c.car.passengerIds],
        start: driver.start,
        destination: p.destination,
        seats: driver.seats,
        departure,
        arrival: 0,
        drivingSeconds,
        meters,
        durationSeconds: drivingSeconds + stops.length * p.boardingSeconds,
        fixedDeparture: Boolean(c.car.leaveAt),
        verifiedLegs: edges,
        geometry: alternative.geometry,
        stops: stops.map((s, j) => {
          time += edges[j].seconds;
          const arrival = time;
          time += p.boardingSeconds;
          occupancy += s.memberIds.length;
          return { ...s, arrival, departure: time, occupancy };
        }),
      };
      route.arrival = time + edges.at(-1)!.seconds;
      day.routes.push(route);
    } else {
      const departure = p.deadline - drivingSeconds;
      day.rideShares!.push({
        memberIds: c.memberIds,
        location: c.locations[0],
        destination: p.destination,
        pickupTime: departure - p.boardingSeconds,
        departure,
        arrival: p.deadline,
        drivingSeconds,
        meters,
        reason: 'requested',
        verifiedLeg: edges[0],
      });
    }
  }
  for (const [i, day] of days.entries()) {
    const errors = checkDay(problems[i], day, true);
    if (errors.length)
      throw new Error(
        `${day.date}: ${readable(errors.join(' '))} Change the departure, ready times, pickups, or arrival deadline.`,
      );
    if (day.rideShares?.length)
      day.messages.push('Uber booking is required; no rides have been ordered.');
  }
  const usage = usageFor(problems, days),
    drivingSeconds = days.reduce(
      (n, d) => n + [...d.routes, ...d.rideShares!].reduce((sum, r) => sum + r.drivingSeconds, 0),
      0,
    );
  const plan: Plan = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    simulation: config.mode === 'mock' || Boolean(input.scenario),
    settings: config,
    scenario: input.scenario,
    days,
    usage: usage.usage,
    fairnessScore: usage.score,
    baselineDrivingSeconds: drivingSeconds,
    drivingSeconds,
    manuallyEdited: true,
    search: { evaluations: 0, elapsedMs: 0, subsetLimit: 0, evaluationBudget: 0, beamWidth: 0 },
    verified: true,
    liveRechecked: false,
  };
  const checked = await recheckPlan(
    plan,
    problems,
    provider,
    signal,
    (message, fraction) => progress?.(message, 0.65 + 0.34 * fraction),
    { preserveOrder: true },
  );
  checkAbort(signal);
  if (!checked.verified)
    throw new Error(
      checked.days
        .filter((d) => d.status !== 'feasible')
        .flatMap((d) => d.messages.map((m) => `${d.date}: ${readable(m)}`))
        .join('\n'),
    );
  progress?.('Manual plan ready to review.', 1);
  return { data: input, problems, plan: checked };
}

// Reload a published arrangement against the admin's roster, without inventing identities.
export function draftFromPublication(
  data: Dataset,
  settings: Settings,
  publication: import('../sharing/schema').Publication,
): ManualDraft {
  const draft = createManualDraft(data, {
    ...settings,
    dates: publication.plan.days.map((d) => d.date),
    deadline: publication.plan.deadline,
  });
  const match = (name: string) => {
    const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
    const members = data.members.filter(
      (m) => m.display_name.trim().toLowerCase().replace(/\s+/g, ' ') === key,
    );
    if (members.length !== 1)
      throw new Error(
        `“${name}” does not match one member in the loaded roster. Load the matching saved Excel files first.`,
      );
    return members[0].member_id;
  };
  for (const published of publication.plan.days) {
    const day = draft.days.find((d) => d.date === published.date)!;
    day.people.forEach((p) => {
      p.mode = 'absent';
    });
    const place = (name: string, mode: ManualPerson['mode'], pickup?: string) => {
      const id = match(name),
        person = day.people.find((p) => p.id === id)!;
      if (person.mode !== 'absent')
        throw new Error(`${published.date}: ${name} occurs more than once in the published plan.`);
      person.mode = mode;
      if (pickup !== undefined) person.pickup = pickup;
      return id;
    };
    day.cars = published.routes.map((route, index) => ({
      id: `car-${index}`,
      driverId: place(route.driver, 'carpool', route.start.address),
      passengerIds: route.stops.flatMap((s) =>
        s.names.map((name) => place(name, 'carpool', s.place.address)),
      ),
      seats: route.seats,
      leaveAt: `${String(Math.floor(route.departure / 3600)).padStart(2, '0')}:${String(Math.floor(route.departure / 60) % 60).padStart(2, '0')}`,
    }));
    for (const trip of published.rideShares ?? [])
      trip.names.forEach((name) => place(name, 'uber', trip.pickup.address));
    for (const name of published.independent ?? []) place(name, 'self');
    for (const name of published.external ?? []) place(name, 'external');
  }
  return draft;
}
