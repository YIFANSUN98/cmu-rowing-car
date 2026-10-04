import type { CarRoute, DayProblem, Driver, Edge, Stop } from '../domain/types';
import { permutations } from '../domain/util';
export function routeCost(r: CarRoute): number {
  return r.drivingSeconds + r.meters / 60 + r.durationSeconds * 0.08;
}
export function optimizeCar(
  problem: DayProblem,
  driver: Driver,
  passengerIds: string[],
  evaluate?: () => void,
): CarRoute | null {
  if (
    passengerIds.length + 1 > driver.seats ||
    driver.seats > 5 ||
    passengerIds.includes(driver.id) ||
    new Set(passengerIds).size !== passengerIds.length
  )
    return null;
  const groups = new Map<number, string[]>();
  for (const id of [...passengerIds].sort()) {
    const rider = problem.riders.find((r) => r.id === id);
    if (!rider) return null;
    groups.set(rider.location, [...(groups.get(rider.location) ?? []), id]);
  }
  let best: CarRoute | null = null;
  for (const order of permutations([...groups.keys()].sort((a, b) => a - b))) {
    evaluate?.();
    const legs: Edge[] = [];
    let previous = driver.start;
    for (const location of [...order, problem.destination]) {
      const edge = problem.matrix.edges[previous]?.[location];
      if (
        !edge?.reachable ||
        !Number.isFinite(edge.seconds) ||
        !Number.isFinite(edge.meters) ||
        edge.seconds < 0 ||
        edge.meters < 0
      )
        break;
      legs.push(edge);
      previous = location;
    }
    if (legs.length !== order.length + 1) continue;
    const drivingSeconds = legs.reduce((s, e) => s + e.seconds, 0),
      meters = legs.reduce((s, e) => s + e.meters, 0),
      durationSeconds = drivingSeconds + order.length * problem.boardingSeconds;
    const departure = problem.deadline - durationSeconds;
    if (departure < driver.earliest || durationSeconds > driver.maxSeconds) continue;
    let time = departure,
      occupancy = 1,
      feasible = true;
    const stops: Stop[] = [];
    order.forEach((location, i) => {
      time += legs[i].seconds;
      const memberIds = groups.get(location)!;
      if (memberIds.some((id) => problem.riders.find((r) => r.id === id)!.ready > time))
        feasible = false;
      const arrival = time;
      time += problem.boardingSeconds;
      occupancy += memberIds.length;
      stops.push({ location, memberIds, arrival, departure: time, occupancy });
    });
    if (!feasible) continue;
    const route: CarRoute = {
      driverId: driver.id,
      passengerIds: [...passengerIds].sort(),
      start: driver.start,
      destination: problem.destination,
      departure,
      arrival: time + legs.at(-1)!.seconds,
      stops,
      drivingSeconds,
      durationSeconds,
      meters,
      seats: driver.seats,
    };
    if (!best || routeCost(route) < routeCost(best)) best = route;
  }
  return best;
}
