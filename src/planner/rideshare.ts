import type { DayProblem, RideShareTrip, Settings } from '../domain/types';
import { rng, shuffled } from '../domain/util';

// One pickup per Uber, up to four passengers. No invented club drivers or seats.
export function rideShareTrips(p: DayProblem, ids: string[]): RideShareTrip[] | undefined {
  const locations = new Map<number, string[]>();
  for (const id of ids) {
    const rider = p.riders.find((r) => r.id === id)!;
    locations.set(rider.location, [...(locations.get(rider.location) ?? []), id]);
  }
  const trips: RideShareTrip[] = [];
  for (const [location, members] of locations) {
    const edge = p.matrix.edges[location]?.[p.destination];
    if (!edge?.reachable || !Number.isFinite(edge.seconds)) return;
    for (let i = 0; i < members.length; i += 4) {
      const memberIds = members.slice(i, i + 4),
        departure = p.deadline - edge.seconds;
      const pickupTime = departure - p.boardingSeconds;
      if (memberIds.some((id) => p.riders.find((r) => r.id === id)!.ready > pickupTime)) return;
      trips.push({
        memberIds,
        location,
        destination: p.destination,
        pickupTime,
        departure,
        arrival: p.deadline,
        drivingSeconds: edge.seconds,
        meters: edge.meters,
        reason: memberIds.some((id) => p.riders.find((r) => r.id === id)!.requiresUber)
          ? 'requested'
          : 'capacity',
      });
    }
  }
  return trips;
}

export function rideShareCandidates(p: DayProblem, s: Settings): string[][] {
  const requested = p.riders.filter((r) => r.requiresUber).map((r) => r.id);
  const eligible = p.riders.filter((r) => !r.requiresUber && !p.drivers.some((d) => d.id === r.id));
  const shortfall = Math.max(
    0,
    p.riders.length - requested.length - p.drivers.reduce((sum, d) => sum + d.seats, 0),
  );
  if (!shortfall) return [requested];
  if (!s.uberFallback) return [];
  const limit = Math.max(1, Math.min(32, s.subsetLimit)),
    candidates: string[][] = [],
    seen = new Set<string>();
  const retain = (ids: string[]) => {
    const key = [...ids].sort().join('|');
    if (!seen.has(key) && candidates.length < limit) {
      seen.add(key);
      candidates.push([...requested, ...ids]);
    }
  };
  const random = rng(s.seed + Number(p.date.replaceAll('-', '')));
  // Prefer co-located overflow groups to reduce the number of separately booked rides.
  const grouped = [...new Set(eligible.map((r) => r.location))]
    .map((location) => ({
      location,
      ids: eligible.filter((r) => r.location === location).map((r) => r.id),
      seconds: p.matrix.edges[location]?.[p.destination]?.seconds ?? Infinity,
    }))
    .sort((a, b) => b.ids.length - a.ids.length || a.seconds - b.seconds);
  retain(grouped.flatMap((g) => g.ids).slice(0, shortfall));
  // Small candidate spaces are fully enumerated; larger ones use deterministic diversity.
  let combinations = 1;
  for (let i = 1; i <= shortfall; i++) combinations *= (eligible.length - i + 1) / i;
  if (combinations <= limit) {
    const visit = (start: number, ids: string[]) => {
      if (ids.length === shortfall) {
        retain(ids);
        return;
      }
      for (let i = start; i <= eligible.length - (shortfall - ids.length); i++)
        visit(i + 1, [...ids, eligible[i].id]);
    };
    visit(0, []);
  } else
    for (let i = 0; i < limit * 6 && candidates.length < limit; i++)
      retain(
        (i % 2
          ? shuffled(eligible, random).map((r) => r.id)
          : shuffled(grouped, random).flatMap((g) => g.ids)
        ).slice(0, shortfall),
      );
  return candidates;
}
