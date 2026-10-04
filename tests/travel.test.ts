import { it, expect } from 'vitest';
import { tiny } from './helpers';
import { defaultSettings } from '../src/domain/types';
import { solveWeek } from '../src/planner/solve';
import { recheckPlan } from '../src/travel/recheck';
import { normalizeGoogleEdge } from '../src/travel/provider';
import type { TravelProvider } from '../src/travel/provider';
import { checkDay } from '../src/planner/check';
import { MockTravelProvider } from '../src/travel/mock';
import { makeDemo } from '../src/domain/scenarios';
import { prepareProblems } from '../src/domain/prepare';
it('normalizes Google milliseconds/meters and rejects missing or fallback estimates', () => {
  expect(
    normalizeGoogleEdge({
      durationMillis: 153001,
      distanceMeters: 4000,
      condition: 'ROUTE_EXISTS',
    }),
  ).toEqual({ seconds: 154, meters: 4000, reachable: true });
  for (const item of [
    { durationMillis: null, distanceMeters: 3 },
    { durationMillis: 2, distanceMeters: 3, error: {} },
    { durationMillis: 2, distanceMeters: 3, fallbackInfo: {} },
    { durationMillis: 2, distanceMeters: 3, condition: 'ROUTE_NOT_FOUND' },
  ])
    expect(normalizeGoogleEdge(item).reachable).toBe(false);
});
it('deduplicates shared pickup points but retains separate passenger demand', async () => {
  const data = makeDemo({ people: 10, driverCount: 3 }),
    s = { ...defaultSettings, dates: ['2026-10-05'] };
  const [p] = await prepareProblems(data, s, new MockTravelProvider());
  expect(p.riders).toHaveLength(10);
  expect(p.matrix.locations).toHaveLength(6);
  expect(p.matrix.departureIso).toBe('2026-10-05T08:00:00.000Z');
});
it('rechecks every chosen leg at its actual departure including service time, adjusting earlier', async () => {
  const p = tiny(3, 1, 3),
    plan = solveWeek([p], defaultSettings);
  const departures: string[] = [];
  const mock = new MockTravelProvider();
  const provider: TravelProvider = {
    mode: 'google',
    resolve: mock.resolve,
    matrix: mock.matrix,
    leg: async (a, b, c) => {
      departures.push(c.departureIso);
      const i = p.matrix.locations.findIndex((l) => l.key === a.key),
        j = p.matrix.locations.findIndex((l) => l.key === b.key);
      return { ...p.matrix.edges[i][j], seconds: p.matrix.edges[i][j].seconds + 30 };
    },
  };
  const result = await recheckPlan(plan, [p], provider);
  expect(result.verified).toBe(true);
  expect(result.liveRechecked).toBe(true);
  expect(result.days[0].routes[0].departure).toBeLessThan(plan.days[0].routes[0].departure);
  expect(departures.length).toBeGreaterThan(3);
  expect(checkDay(p, result.days[0], true)).toEqual([]);
});
it('does not display a feasible plan when updated live timing or reachability fails', async () => {
  const p = tiny(3, 1, 3),
    plan = solveWeek([p], defaultSettings);
  const mock = new MockTravelProvider();
  const provider: TravelProvider = {
    mode: 'google',
    resolve: mock.resolve,
    matrix: mock.matrix,
    leg: async () => ({ seconds: 5000, meters: 3000, reachable: true }),
  };
  const result = await recheckPlan(plan, [p], provider);
  expect(result.verified).toBe(false);
  expect(result.days[0].status).toBe('timing');
  expect(result.days[0].routes).toEqual([]);
  expect(result.days[0].unassigned).toHaveLength(3);
});
it('cancels mock preparation without requests', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(new MockTravelProvider().resolve([], abort.signal)).rejects.toThrow('cancelled');
});

it('compares complete pickup orders and shorter road alternatives, then independently verifies coverage and timing', async () => {
  const p = tiny(3, 1, 3),
    plan = solveWeek([p], defaultSettings);
  const preferredFirst = plan.days[0].routes[0].stops.at(-1)!.location;
  const mock = new MockTravelProvider();
  const orders: string[][] = [];
  const provider: TravelProvider = {
    mode: 'tomtom',
    resolve: mock.resolve,
    matrix: mock.matrix,
    leg: async () => {
      throw new Error('Complete-route checking must not use isolated legs.');
    },
    route: async (locations) => {
      orders.push(locations.map((l) => l.key));
      const preferred = locations[1].key === p.matrix.locations[preferredFirst].key;
      return [
        locations.slice(1).map(() => ({ seconds: 60, meters: 6000, reachable: true })),
        locations
          .slice(1)
          .map(() => ({ seconds: preferred ? 70 : 80, meters: 500, reachable: true })),
      ];
    },
  };
  const result = await recheckPlan(plan, [p], provider);
  const route = result.days[0].routes[0];
  expect(orders).toHaveLength(2);
  expect(route.stops[0].location).toBe(preferredFirst);
  expect(route.drivingSeconds).toBe(210);
  expect(route.meters).toBe(1500);
  expect(route.durationSeconds).toBe(330);
  expect(route.stops.at(-1)!.occupancy).toBe(3);
  expect(result.verified).toBe(true);
  expect(checkDay(p, result.days[0], true)).toEqual([]);
});

it('rechecks a complete route at an earlier departure and stops when readiness makes it impossible', async () => {
  const p = tiny(3, 1, 3),
    plan = solveWeek([p], defaultSettings);
  const mock = new MockTravelProvider(),
    departures: string[] = [];
  const provider: TravelProvider = {
    mode: 'tomtom',
    resolve: mock.resolve,
    matrix: mock.matrix,
    leg: mock.leg,
    route: async (locations, context) => {
      departures.push(context.departureIso);
      return [locations.slice(1).map(() => ({ seconds: 250, meters: 1000, reachable: true }))];
    },
  };
  const result = await recheckPlan(plan, [p], provider);
  expect(result.verified).toBe(true);
  expect(departures).toHaveLength(3);
  expect(Date.parse(departures[2])).toBeLessThan(Date.parse(departures[0]));
  expect(checkDay(p, result.days[0], true)).toEqual([]);
  p.drivers[0].earliest = plan.days[0].routes[0].departure;
  const failed = await recheckPlan(plan, [p], provider);
  expect(failed.verified).toBe(false);
  expect(failed.days[0].routes).toEqual([]);
  expect(failed.days[0].unassigned).toHaveLength(3);
});

it('merges equal geocoded locations without merging riders and skips APIs on empty days', async () => {
  const data = makeDemo({ people: 3, driverCount: 1 }),
    mock = new MockTravelProvider();
  const provider: TravelProvider = {
    ...mock,
    mode: 'tomtom',
    leg: mock.leg,
    matrix: mock.matrix,
    resolve: async (locations) => locations.map((l) => ({ ...l, lat: 40.4, lng: -79.9 })),
  };
  const settings = { ...defaultSettings, dates: ['2026-10-05'] };
  const [p] = await prepareProblems(data, settings, provider);
  expect(p.matrix.locations).toHaveLength(1);
  expect(p.riders).toHaveLength(3);
  expect(p.riders.every((r) => r.location === 0)).toBe(true);
  provider.resolve = async () => {
    throw new Error('No empty-day geocoding');
  };
  provider.matrix = async () => {
    throw new Error('No empty-day matrix');
  };
  data.attendance.forEach((a) => {
    a.attending = 'false';
  });
  expect((await prepareProblems(data, settings, provider))[0].riders).toEqual([]);
});

it('batches all days without changing the selected pickup orders, road alternatives or retiming', async () => {
  const first = tiny(4, 1, 4),
    second = tiny(4, 1, 4);
  second.date = second.matrix.date = '2026-10-06';
  const problems = [first, second];
  const plan = solveWeek(problems, defaultSettings);
  const mock = new MockTravelProvider();
  const alternatives = (locations: typeof first.matrix.locations) => {
    const preferred = locations[1].key === 'point-3';
    return [
      locations.slice(1).map(() => ({ seconds: 400, meters: 6000, reachable: true })),
      locations
        .slice(1)
        .map(() => ({ seconds: preferred ? 250 : 280, meters: 500, reachable: true })),
    ];
  };
  const provider: TravelProvider = {
    mode: 'tomtom',
    resolve: mock.resolve,
    matrix: mock.matrix,
    leg: mock.leg,
    route: async (locations) => alternatives(locations),
  };
  const sequential = await recheckPlan(plan, problems, provider);
  const batches: { dates: string[]; departures: string[] }[] = [];
  provider.routeBatch = async (requests) => {
    batches.push({
      dates: requests.map((r) => r.context.date),
      departures: requests.map((r) => r.context.departureIso),
    });
    return requests.map((r) =>
      alternatives(r.locations).map((edges, i) => ({
        edges,
        geometry: [
          { lat: 40.4 + i / 100, lng: -79.9 },
          { lat: 40.5 + i / 100, lng: -79.8 },
        ],
      })),
    );
  };
  const batched = await recheckPlan(plan, problems, provider);
  expect(batches).toHaveLength(2);
  expect(batches[0].dates).toHaveLength(12); // 3! pickup orders for each of two days.
  expect(batches[1].dates).toHaveLength(2); // Only the winning late route is retimed.
  expect(new Set(batches[0].dates).size).toBe(2);
  expect(Date.parse(batches[1].departures[0])).toBeLessThan(Date.parse(batches[0].departures[0]));
  for (const [i, day] of batched.days.entries()) {
    expect(checkDay(problems[i], day, true)).toEqual([]);
    expect(day.routes[0].geometry![0].lat).toBe(40.41);
    delete day.routes[0].geometry;
  }
  expect(batched).toEqual(sequential);
});

it('skips only impossible matrix pairs, preserving whole-week plans with mandatory and optional drivers', async () => {
  const { requiredTravelPairs } = await import('../src/domain/prepare');
  const cases = [tiny(8, 2, 4), tiny(7, 3, 4), tiny(7, 2, 4), tiny(7, 2, 4)];
  // One passenger shares a mandatory driver's home; another is at the destination.
  cases[2].riders[2].location = cases[2].drivers[0].start;
  cases[2].riders[3].location = cases[2].destination;
  // An alternate driver start must be included even when nobody boards there.
  cases[3].drivers[0].start = cases[3].destination;
  let saved = 0;
  for (const p of cases) {
    const full = solveWeek([p], defaultSettings);
    const scope = requiredTravelPairs(p);
    const sparse = structuredClone(p);
    sparse.matrix.edges.forEach((row, from) =>
      row.forEach((e, to) => {
        if (from !== to && (!scope.origins.includes(from) || !scope.destinations.includes(to))) {
          sparse.matrix.edges[from][to] = { seconds: Infinity, meters: Infinity, reachable: false };
          saved++;
        }
      }),
    );
    const result = solveWeek([sparse], defaultSettings);
    expect(result.verified).toBe(true);
    expect(result.days.map((d) => d.routes)).toEqual(full.days.map((d) => d.routes));
    expect(result.drivingSeconds).toBe(full.drivingSeconds);
    expect(checkDay(sparse, result.days[0])).toEqual([]);
  }
  expect(saved).toBeGreaterThan(0);
});
