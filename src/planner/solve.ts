import type {
  CarRoute,
  Dataset,
  DayPlan,
  DayProblem,
  Driver,
  DriverUsage,
  Plan,
  Settings,
  RideShareTrip,
} from '../domain/types';
import { rideShareCandidates, rideShareTrips } from './rideshare';
import { rng, shuffled } from '../domain/util';
import { checkDay, routeTotals } from './check';
import { optimizeCar, routeCost } from './route';
interface Alternative {
  rideShares?: RideShareTrip[];
  routes: CarRoute[];
  seconds: number;
  cost: number;
  driverKey: string;
}
class BudgetEnd extends Error {}
function driverSubsets(
  drivers: Driver[],
  demand: number,
  limit: number,
  random: () => number,
): { subsets: Driver[][]; truncated: boolean } {
  const order = [...drivers].sort((a, b) => a.id.localeCompare(b.id));
  const valid: Driver[][] = [];
  let truncated = false;
  // Enumerate small pools; use deterministic diverse sampling for larger pools.
  if (order.length <= 14) {
    for (let k = 1; k <= order.length; k++) {
      const visit = (start: number, selected: Driver[], seats: number) => {
        if (valid.length >= limit) {
          truncated = true;
          return;
        }
        if (selected.length === k) {
          if (seats >= demand) valid.push(selected);
          return;
        }
        for (let i = start; i <= order.length - (k - selected.length); i++)
          visit(i + 1, [...selected, order[i]], seats + order[i].seats);
      };
      visit(0, [], 0);
      if (truncated) break;
    }
  } else {
    truncated = true;
    const seen = new Set<string>();
    for (let i = 0; i < limit * 20 && valid.length < limit; i++) {
      const selected: Driver[] = [];
      let seats = 0;
      for (const d of shuffled(order, random)) {
        selected.push(d);
        seats += d.seats;
        if (seats >= demand) break;
      }
      if (seats < demand) continue;
      selected.sort((a, b) => a.id.localeCompare(b.id));
      const key = selected.map((d) => d.id).join('|');
      if (!seen.has(key)) {
        valid.push(selected);
        seen.add(key);
      }
    }
  }
  // Shuffle within car counts to remove persistent alphabetic preference under a capped budget.
  return { subsets: shuffled(valid, random).sort((a, b) => a.length - b.length), truncated };
}
function carAlternatives(
  p: DayProblem,
  s: Settings,
): { plan: DayPlan; alternatives: Alternative[]; evaluations: number } {
  const empty: DayPlan = {
    date: p.date,
    status: 'search-exhausted',
    routes: [],
    unassigned: p.riders.map((r) => r.id),
    independent: p.independent,
    external: p.external,
    unresolved: p.unresolved,
    messages: [],
    alternatives: 0,
    budgetExhausted: false,
  };
  if (p.unresolved.length)
    return {
      plan: {
        ...empty,
        status: 'input',
        messages: ['Review unresolved attendance and transport before planning.'],
      },
      alternatives: [],
      evaluations: 0,
    };
  if (!p.riders.length)
    return {
      plan: { ...empty, status: 'feasible', unassigned: [] },
      alternatives: [{ routes: [], seconds: 0, cost: 0, driverKey: '' }],
      evaluations: 0,
    };
  const seats = p.drivers.reduce((sum, d) => sum + d.seats, 0);
  if (seats < p.riders.length)
    return {
      plan: {
        ...empty,
        status: 'capacity',
        messages: [
          `Insufficient confirmed capacity under the current inputs: ${seats} seats for ${p.riders.length} people (${p.riders.length - seats} seat shortfall).${p.unknownAvailability.length ? ' Some availability is still unknown.' : ''}`,
        ],
      },
      alternatives: [],
      evaluations: 0,
    };
  const random = rng(s.seed + Number(p.date.replaceAll('-', '')));
  const selection = driverSubsets(p.drivers, p.riders.length, s.subsetLimit, random);
  empty.budgetExhausted = selection.truncated;
  let evaluations = 0;
  const alternatives: Alternative[] = [];
  const cache = new Map<string, CarRoute | null>();
  const route = (d: Driver, ids: string[]) => {
    const key = d.id + '|' + [...ids].sort().join('|');
    if (cache.has(key)) return cache.get(key)!;
    const r = optimizeCar(p, d, ids, () => {
      if (evaluations >= s.evaluationBudget) throw new BudgetEnd();
      evaluations++;
    });
    cache.set(key, r);
    return r;
  };
  const retain = (routes: CarRoute[]) => {
    if (checkDay(p, { routes }).length) throw new Error('Internal planner constraint violation.');
    const cost = routes.reduce((sum, r) => sum + routeCost(r), 0),
      driverKey = routes
        .map((r) => r.driverId)
        .sort()
        .join('|');
    const candidate = { routes, seconds: routeTotals(routes).seconds, cost, driverKey };
    const previous = alternatives.findIndex((a) => a.driverKey === driverKey);
    if (previous < 0) alternatives.push(candidate);
    else if (cost < alternatives[previous].cost) alternatives[previous] = candidate;
  };
  try {
    for (const selected of selection.subsets) {
      const passengers = p.riders
        .filter((r) => !selected.some((d) => d.id === r.id))
        .map((r) => r.id);
      if (p.riders.length <= 8) {
        const buckets = selected.map(() => [] as string[]);
        const exact = (i: number) => {
          if (i === passengers.length) {
            const routes = selected.map((d, j) => route(d, buckets[j]));
            if (routes.every((r): r is CarRoute => r !== null)) retain(routes);
            return;
          }
          for (let j = 0; j < selected.length; j++)
            if (buckets[j].length < selected[j].seats - 1) {
              buckets[j].push(passengers[i]);
              exact(i + 1);
              buckets[j].pop();
            }
        };
        exact(0);
        continue;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const routes = selected.map((d) => route(d, []));
        if (routes.some((r) => !r)) continue;
        let current = routes as CarRoute[];
        let failed = false;
        // Longest direct journeys first, then reproducible random orders to diversify insertion.
        const ordered =
          attempt === 0
            ? [...passengers].sort((a, b) => {
                const x = p.riders.find((r) => r.id === a)!,
                  y = p.riders.find((r) => r.id === b)!;
                return (
                  p.matrix.edges[y.location][p.destination].seconds -
                    p.matrix.edges[x.location][p.destination].seconds || a.localeCompare(b)
                );
              })
            : shuffled(passengers, random);
        for (const id of ordered) {
          let best: { index: number; r: CarRoute; delta: number } | undefined;
          for (let i = 0; i < selected.length; i++) {
            if (current[i].passengerIds.length + 1 >= selected[i].seats) continue;
            const r = route(selected[i], [...current[i].passengerIds, id]);
            if (!r) continue;
            const delta = routeCost(r) - routeCost(current[i]);
            if (!best || delta < best.delta) best = { index: i, r, delta };
          }
          if (!best) {
            failed = true;
            break;
          }
          current = current.map((r, i) => (i === best!.index ? best!.r : r));
        }
        if (failed) continue;
        retain(current);
        // Bounded relocations and swaps; driver substitutions are represented by other subsets.
        for (let step = 0; step < 48; step++) {
          const a = Math.floor(random() * current.length),
            b = Math.floor(random() * current.length);
          if (a === b || !current[a].passengerIds.length) continue;
          const id = current[a].passengerIds[Math.floor(random() * current[a].passengerIds.length)];
          const other =
            step % 2 && current[b].passengerIds.length
              ? current[b].passengerIds[Math.floor(random() * current[b].passengerIds.length)]
              : undefined;
          const aa = current[a].passengerIds.filter((x) => x !== id),
            bb = current[b].passengerIds.filter((x) => x !== other);
          if (other) aa.push(other);
          bb.push(id);
          if (bb.length + 1 > selected[b].seats) continue;
          const ra = route(selected[a], aa),
            rb = route(selected[b], bb);
          if (
            ra &&
            rb &&
            routeCost(ra) + routeCost(rb) < routeCost(current[a]) + routeCost(current[b])
          ) {
            current = current.map((r, i) => (i === a ? ra : i === b ? rb : r));
            retain(current);
          }
        }
      }
    }
  } catch (e) {
    if (!(e instanceof BudgetEnd)) throw e;
    empty.budgetExhausted = true;
  }
  alternatives.sort(
    (a, b) =>
      a.seconds - b.seconds ||
      a.routes.length - b.routes.length ||
      a.cost - b.cost ||
      a.driverKey.localeCompare(b.driverKey),
  );
  const best = alternatives[0];
  if (best)
    return {
      plan: {
        ...empty,
        status: 'feasible',
        routes: best.routes,
        unassigned: [],
        alternatives: alternatives.length,
        messages: empty.budgetExhausted
          ? ['Search budget reached; returning the best validated feasible alternatives found.']
          : [],
      },
      alternatives,
      evaluations,
    };
  const exact = p.riders.length <= 8 && !selection.truncated && !empty.budgetExhausted;
  return {
    plan: {
      ...empty,
      status: exact ? 'timing' : 'search-exhausted',
      messages: [
        exact
          ? 'Exhaustive search of this small case proves no assignment meets the current reachability/timing constraints.'
          : 'No feasible plan found within the bounded search. This is not proof of infeasibility.',
      ],
      budgetExhausted: empty.budgetExhausted || selection.truncated,
    },
    alternatives: [],
    evaluations,
  };
}
export function dailyAlternatives(p: DayProblem, s: Settings): ReturnType<typeof carAlternatives> {
  const requested = p.riders.some((r) => r.requiresUber);
  const shortfall = p.drivers.reduce((sum, d) => sum + d.seats, 0) < p.riders.length;
  if (p.unresolved.length || (!requested && (!s.uberFallback || !shortfall)))
    return carAlternatives(p, s);
  const candidates = rideShareCandidates(p, s);
  let evaluations = 0,
    best: ReturnType<typeof carAlternatives> | undefined;
  const options: Alternative[] = [];
  for (const [index, ids] of candidates.entries()) {
    if (evaluations >= s.evaluationBudget) break;
    const trips = rideShareTrips(p, ids);
    if (!trips) continue;
    const result = carAlternatives(
      { ...p, riders: p.riders.filter((r) => !ids.includes(r.id)) },
      {
        ...s,
        evaluationBudget: Math.max(
          1,
          Math.floor((s.evaluationBudget - evaluations) / (candidates.length - index)),
        ),
      },
    );
    evaluations += result.evaluations;
    if (result.plan.status !== 'feasible') continue;
    const seconds = trips.reduce((sum, trip) => sum + trip.drivingSeconds, 0);
    const alternatives = result.alternatives.map((a) => ({
      ...a,
      rideShares: trips,
      seconds: a.seconds + seconds,
      cost: a.cost + seconds,
    }));
    if (!best || trips.length < (best.plan.rideShares?.length ?? Infinity)) {
      best = { ...result, plan: { ...result.plan, rideShares: trips }, alternatives: [] };
      options.length = 0;
    }
    if (trips.length === best.plan.rideShares!.length) options.push(...alternatives);
  }
  if (!best || !options.length) {
    const result = carAlternatives(p, {
      ...s,
      evaluationBudget: Math.max(0, s.evaluationBudget - evaluations),
    });
    return {
      ...result,
      evaluations: evaluations + result.evaluations,
      plan: {
        ...result.plan,
        status: 'search-exhausted',
        messages: [
          ...result.plan.messages,
          'No checked carpool and Uber combination was found. Review available drivers, pickups and timing.',
        ],
      },
    };
  }
  options.sort(
    (a, b) => a.seconds - b.seconds || a.routes.length - b.routes.length || a.cost - b.cost,
  );
  const winner = options[0];
  const plan = {
    ...best.plan,
    routes: winner.routes,
    rideShares: winner.rideShares,
    alternatives: options.length,
    messages: [
      `${winner.rideShares!.reduce((sum, trip) => sum + trip.memberIds.length, 0)} members need ${winner.rideShares!.length} Uber ride${winner.rideShares!.length === 1 ? '' : 's'}. Booking is required; no rides have been ordered.`,
    ],
  };
  const errors = checkDay(p, plan);
  if (errors.length) throw new Error(errors.join(' '));
  return { plan, alternatives: options, evaluations };
}
export function usageFor(
  problems: DayProblem[],
  days: DayPlan[],
): { usage: DriverUsage[]; score: number } {
  const ids = [...new Set(problems.flatMap((p) => p.drivers.map((d) => d.id)))].sort();
  const eligible = Object.fromEntries(
    ids.map((id) => [id, problems.filter((p) => p.drivers.some((d) => d.id === id)).length]),
  );
  const totalEligible = Object.values(eligible).reduce((a, b) => a + b, 0);
  const K = days.flatMap((d) => d.routes).length;
  const usage = ids.map((id) => {
    const routes = days.flatMap((d) => d.routes).filter((r) => r.driverId === id);
    return {
      id,
      eligibleDays: eligible[id],
      daysDriven: routes.length,
      drivingSeconds: routes.reduce((sum, r) => sum + r.drivingSeconds, 0),
      targetDays: totalEligible ? (K * eligible[id]) / totalEligible : 0,
    };
  });
  return { usage, score: usage.reduce((sum, u) => sum + (u.daysDriven - u.targetDays) ** 2, 0) };
}
export function solveWeek(
  problems: DayProblem[],
  settings: Settings,
  data?: Pick<Dataset, 'scenario' | 'availability'>,
  progress?: import('../domain/progress').PlanningProgressCallback,
): Plan {
  const start = performance.now();
  let evaluations = 0;
  const results = problems.map((p, i) => {
    progress?.(
      `Assigning cars for ${p.date} · day ${i + 1} of ${problems.length}`,
      i / (problems.length + 1),
    );
    const result = dailyAlternatives(p, settings);
    evaluations += result.evaluations;
    return result;
  });
  const baseline = results.map((r) => r.plan);
  progress?.('Balancing driving across the week…', problems.length / (problems.length + 1));
  const baselineSeconds = baseline.reduce(
    (sum, d) =>
      sum +
      routeTotals(d.routes).seconds +
      (d.rideShares ?? []).reduce((n, trip) => n + trip.drivingSeconds, 0),
    0,
  );
  const maxSeconds = baselineSeconds * (1 + settings.fairnessAllowance);
  const carCounts = baseline.map((d) => d.routes.length);
  type Beam = { days: DayPlan[]; seconds: number };
  let beam: Beam[] = [{ days: [], seconds: 0 }];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const options = result.alternatives.filter((a) => a.routes.length <= carCounts[i]);
    if (!options.length) {
      beam = beam.map((b) => ({ ...b, days: [...b.days, result.plan] }));
      continue;
    }
    const remaining = results
      .slice(i + 1)
      .reduce((sum, r) => sum + (r.alternatives[0]?.seconds ?? 0), 0);
    const next: Beam[] = [];
    const unique = new Set<string>();
    for (const state of beam)
      for (const option of options) {
        const seconds = state.seconds + option.seconds;
        if (seconds + remaining > maxSeconds + 0.001) continue;
        const days = [
          ...state.days,
          { ...result.plan, routes: option.routes, rideShares: option.rideShares },
        ];
        const usage = usageFor(problems.slice(0, i + 1), days);
        const key = usage.usage.map((u) => u.daysDriven).join(',') + ':' + seconds;
        if (unique.has(key)) continue;
        unique.add(key);
        next.push({ days, seconds });
      }
    next.sort(
      (a, b) =>
        usageFor(problems.slice(0, i + 1), a.days).score -
          usageFor(problems.slice(0, i + 1), b.days).score || a.seconds - b.seconds,
    );
    beam = next.slice(0, settings.beamWidth);
  }
  const candidates = [
    { days: baseline, seconds: baselineSeconds },
    ...beam.filter((b) => b.days.length === problems.length),
  ];
  candidates.sort(
    (a, b) =>
      usageFor(problems, a.days).score - usageFor(problems, b.days).score || a.seconds - b.seconds,
  );
  const chosen = candidates[0],
    stats = usageFor(problems, chosen.days);
  for (let i = 0; i < chosen.days.length; i++)
    if (chosen.days[i].status === 'feasible') {
      const errors = checkDay(problems[i], chosen.days[i]);
      if (errors.length) throw new Error(errors.join(' '));
    }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    simulation:
      settings.mode === 'mock' ||
      Boolean(
        data?.availability.some((a) => settings.dates.includes(a.date) && a.source === 'simulated'),
      ),
    settings,
    scenario: data?.scenario,
    days: chosen.days,
    usage: stats.usage,
    fairnessScore: stats.score,
    baselineDrivingSeconds: baselineSeconds,
    drivingSeconds: chosen.seconds,
    search: {
      evaluations,
      elapsedMs: performance.now() - start,
      subsetLimit: settings.subsetLimit,
      evaluationBudget: settings.evaluationBudget,
      beamWidth: settings.beamWidth,
    },
    verified: chosen.days.every((d) => d.status === 'feasible'),
    liveRechecked: false,
  };
}
