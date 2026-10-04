import type { CarRoute, DayProblem, Edge, Plan, Stop } from '../domain/types';
import { permutations, zonedDate } from '../domain/util';
import { checkDay, routeTotals } from '../planner/check';
import { usageFor } from '../planner/solve';
import { routeCost } from '../planner/route';
import type { RouteAlternative, RouteRequest, TravelProvider } from './provider';
import { checkAbort } from './provider';
import type { PlanningProgressCallback } from '../domain/progress';

function replay(
  original: CarRoute,
  stops: Stop[],
  departure: number,
  edges: Edge[],
  boarding: number,
): CarRoute | undefined {
  if (
    edges.length !== stops.length + 1 ||
    edges.some(
      (e) =>
        !e.reachable ||
        !Number.isFinite(e.seconds) ||
        !Number.isFinite(e.meters) ||
        e.seconds < 0 ||
        e.meters < 0,
    )
  )
    return;
  let time = departure,
    occupancy = 1;
  const route = structuredClone(original);
  route.departure = departure;
  route.verifiedLegs = edges;
  route.stops = stops.map((stop, i) => {
    time += edges[i].seconds;
    const arrival = time;
    time += boarding;
    occupancy += stop.memberIds.length;
    return { ...stop, arrival, departure: time, occupancy };
  });
  route.arrival = time + edges.at(-1)!.seconds;
  route.drivingSeconds = edges.reduce((s, e) => s + e.seconds, 0);
  route.meters = edges.reduce((s, e) => s + e.meters, 0);
  route.durationSeconds = route.arrival - departure;
  return route;
}

// Check the same permutations and road alternatives as the sequential path, but
// send independent checks together. Only late routes need another timed pass.
async function recheckCompleteRoutes(
  plan: Plan,
  problems: DayProblem[],
  provider: TravelProvider,
  signal?: AbortSignal,
  progress?: PlanningProgressCallback,
  preserveOrder = false,
): Promise<Map<CarRoute, CarRoute | undefined>> {
  const results = new Map<CarRoute, CarRoute | undefined>();
  let states = plan.days.flatMap((day, di) =>
    day.status !== 'feasible'
      ? []
      : day.routes.map((original) => ({
          original,
          problem: problems[di],
          departure: original.departure,
          orders: preserveOrder ? [original.stops] : [...permutations(original.stops)],
        })),
  );
  for (let attempt = 0; attempt < 3 && states.length; attempt++) {
    checkAbort(signal);
    const candidates = states.flatMap((state) => state.orders.map((order) => ({ state, order })));
    const requests: RouteRequest[] = candidates.map(({ state, order }) => ({
      locations: [
        state.original.start,
        ...order.map((s) => s.location),
        state.original.destination,
      ].map((i) => state.problem.matrix.locations[i]),
      context: {
        date: plan.settings.comparisonDates?.[state.problem.date] ?? state.problem.date,
        departureIso: zonedDate(
          plan.settings.comparisonDates?.[state.problem.date] ?? state.problem.date,
          state.departure,
        ).toISOString(),
      },
      boardingSeconds: state.problem.boardingSeconds,
    }));
    const report = (completed: number, total: number) =>
      progress?.(
        `Checking pickup routes: ${completed}/${total}, pass ${attempt + 1}`,
        total ? completed / total : 1,
      );
    let alternatives: RouteAlternative[][];
    if (provider.routeBatch) alternatives = await provider.routeBatch(requests, signal, report);
    else {
      alternatives = [];
      for (const [i, request] of requests.entries()) {
        checkAbort(signal);
        report(i, requests.length);
        alternatives.push(
          (
            await provider.route!(
              request.locations,
              request.context,
              request.boardingSeconds,
              signal,
            )
          ).map((edges) => ({ edges })),
        );
      }
    }
    checkAbort(signal);
    if (alternatives.length !== candidates.length)
      throw new Error('Travel provider returned an incomplete route batch.');
    const best = new Map<(typeof states)[number], CarRoute>();
    for (const [i, { state, order }] of candidates.entries()) {
      const { original, problem, departure } = state;
      const driver = problem.drivers.find((d) => d.id === original.driverId)!;
      for (const alternative of alternatives[i]) {
        const route = replay(
          original,
          order,
          departure,
          alternative.edges,
          problem.boardingSeconds,
        );
        if (!route) continue;
        route.geometry = alternative.geometry;
        const shift = route.arrival > problem.deadline ? route.arrival - problem.deadline + 15 : 0;
        if (
          (original.fixedDeparture && shift > 0) ||
          route.departure - shift < driver.earliest ||
          route.durationSeconds > driver.maxSeconds ||
          route.stops.some((s) =>
            s.memberIds.some(
              (id) => problem.riders.find((r) => r.id === id)!.ready > s.arrival - shift,
            ),
          )
        )
          continue;
        if (!best.has(state) || routeCost(route) < routeCost(best.get(state)!))
          best.set(state, route);
      }
    }
    states = states.filter((state) => {
      const route = best.get(state);
      if (!route || route.arrival <= state.problem.deadline) {
        results.set(state.original, route);
        return false;
      }
      state.departure -= route.arrival - state.problem.deadline + 15;
      state.orders = [route.stops];
      return true;
    });
  }
  return results;
}
async function recheckUberTrips(
  result: Plan,
  problems: DayProblem[],
  provider: TravelProvider,
  signal?: AbortSignal,
) {
  for (const [di, day] of result.days.entries()) {
    if (day.status !== 'feasible') continue;
    const p = problems[di];
    for (const trip of day.rideShares ?? []) {
      for (let attempt = 0; attempt < 3; attempt++) {
        checkAbort(signal);
        const edge = await provider.leg(
          p.matrix.locations[trip.location],
          p.matrix.locations[p.destination],
          {
            date: result.settings.comparisonDates?.[day.date] ?? day.date,
            departureIso: zonedDate(
              result.settings.comparisonDates?.[day.date] ?? day.date,
              trip.departure,
            ).toISOString(),
          },
          signal,
        );
        if (!edge.reachable) {
          delete trip.verifiedLeg;
          break;
        }
        trip.verifiedLeg = edge;
        trip.drivingSeconds = edge.seconds;
        trip.meters = edge.meters;
        trip.arrival = trip.departure + edge.seconds;
        if (trip.arrival <= p.deadline || attempt === 2) break;
        trip.departure -= trip.arrival - p.deadline + 15;
        trip.pickupTime = trip.departure - p.boardingSeconds;
      }
    }
  }
}
export async function recheckPlan(
  plan: Plan,
  problems: DayProblem[],
  provider: TravelProvider,
  signal?: AbortSignal,
  progress?: PlanningProgressCallback,
  options: { preserveOrder?: boolean } = {},
): Promise<Plan> {
  const result = structuredClone(plan);
  const completeRoutes =
    provider.routeBatch || provider.route
      ? await recheckCompleteRoutes(
          result,
          problems,
          provider,
          signal,
          progress,
          options.preserveOrder,
        )
      : undefined;
  await recheckUberTrips(result, problems, provider, signal);
  for (const [di, day] of result.days.entries()) {
    if (day.status !== 'feasible') continue;
    const problem = problems[di];
    const revised: CarRoute[] = [];
    let failure = '';
    for (const original of day.routes) {
      if (completeRoutes) {
        const route = completeRoutes.get(original);
        if (!route) {
          failure =
            'Complete-route estimates do not meet pickup readiness, departure, route-duration, or arrival limits.';
          break;
        }
        revised.push(route);
        continue;
      }
      let departure = original.departure,
        verified: CarRoute | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        checkAbort(signal);
        progress?.(
          `Checking ${day.date}: chosen route ${revised.length + 1}/${day.routes.length}, pass ${attempt + 1}`,
          (di + revised.length / day.routes.length) / result.days.length,
        );
        const driver = problem.drivers.find((d) => d.id === original.driverId)!;
        if (departure < driver.earliest) {
          failure = 'Updated traffic would require departure before the allowed time.';
          break;
        }
        const route = structuredClone(original);
        route.departure = departure;
        route.verifiedLegs = [];
        let time = departure,
          previous = route.start;
        for (let i = 0; i <= route.stops.length; i++) {
          const destination = i < route.stops.length ? route.stops[i].location : route.destination;
          const edge = await provider.leg(
            problem.matrix.locations[previous],
            problem.matrix.locations[destination],
            {
              date: result.settings.comparisonDates?.[day.date] ?? day.date,
              departureIso: zonedDate(
                result.settings.comparisonDates?.[day.date] ?? day.date,
                time,
              ).toISOString(),
            },
            signal,
          );
          route.verifiedLegs.push(edge);
          if (!edge.reachable) {
            failure = 'A selected routing leg is unreachable or its estimate failed.';
            break;
          }
          time += edge.seconds;
          if (i < route.stops.length) {
            const stop = route.stops[i];
            stop.arrival = time;
            time += problem.boardingSeconds;
            stop.departure = time;
          }
          previous = destination;
        }
        if (failure) break;
        route.arrival = time;
        route.drivingSeconds = route.verifiedLegs.reduce((s, e) => s + e.seconds, 0);
        route.meters = route.verifiedLegs.reduce((s, e) => s + e.meters, 0);
        route.durationSeconds = time - departure;
        if (time > problem.deadline) {
          if (original.fixedDeparture) {
            failure =
              'The chosen departure misses the arrival deadline. Choose an earlier departure or change the route.';
            break;
          }
          departure -= time - problem.deadline + 15;
          continue;
        }
        verified = route;
        break;
      }
      if (!verified) {
        failure ||= 'Updated estimates still miss the buffered deadline after three checks.';
        break;
      }
      revised.push(verified);
    }
    const errors = failure
      ? [failure]
      : checkDay(problem, { routes: revised, rideShares: day.rideShares }, true);
    if (errors.length) {
      day.status = 'timing';
      day.routes = [];
      day.rideShares = [];
      day.unassigned = problem.riders.map((r) => r.id);
      day.messages.push('Live timing verification failed: ' + errors.join(' '));
    } else day.routes = revised;
  }
  const usage = usageFor(problems, result.days);
  result.usage = usage.usage;
  result.fairnessScore = usage.score;
  result.drivingSeconds = result.days.reduce(
    (sum, d) =>
      sum +
      routeTotals(d.routes).seconds +
      (d.rideShares ?? []).reduce((n, trip) => n + trip.drivingSeconds, 0),
    0,
  );
  result.liveRechecked = true;
  result.verified = result.days.every((d) => d.status === 'feasible');
  return result;
}
