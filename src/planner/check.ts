import type { CarRoute, DayPlan, DayProblem } from '../domain/types';
// Deliberately independent of optimizeCar: replay every leg and check membership/time/capacity.
export function checkDay(
  problem: DayProblem,
  plan: Pick<DayPlan, 'routes' | 'rideShares'>,
  useVerifiedLegs = false,
): string[] {
  const errors: string[] = [];
  const seen = new Map<string, number>();
  const active = new Set(problem.riders.map((r) => r.id));
  const cover = (id: string) => {
    seen.set(id, (seen.get(id) ?? 0) + 1);
    if (!active.has(id)) errors.push(`Unexpected member ${id}.`);
  };
  for (const route of plan.routes) {
    if (
      [
        route.departure,
        route.arrival,
        route.durationSeconds,
        route.drivingSeconds,
        route.meters,
      ].some((n) => !Number.isFinite(n) || n < 0)
    )
      errors.push('Non-finite or negative route values.');
    if (
      route.stops.some((stop) => !Number.isFinite(stop.arrival) || !Number.isFinite(stop.departure))
    )
      errors.push('Non-finite pickup times.');
    const driver = problem.drivers.find((d) => d.id === route.driverId);
    if (
      [route.driverId, ...route.passengerIds].some(
        (id) => problem.riders.find((r) => r.id === id)?.requiresUber,
      )
    )
      errors.push('A requested Uber rider was placed in a club car.');
    cover(route.driverId);
    if (!driver) {
      errors.push(`Driver ${route.driverId} is not explicitly eligible.`);
      continue;
    }
    if (
      route.seats !== driver.seats ||
      route.seats < 1 ||
      route.seats > 5 ||
      !Number.isInteger(route.seats)
    )
      errors.push('Invalid vehicle capacity.');
    if (route.start !== driver.start || route.destination !== problem.destination)
      errors.push('Incorrect route endpoints.');
    if (!Number.isFinite(route.departure) || route.departure < driver.earliest)
      errors.push('Departure precedes driver readiness/earliest departure.');
    let time = route.departure,
      previous = driver.start,
      occupancy = 1,
      drive = 0,
      meters = 0;
    const passengers: string[] = [];
    const replay = (destination: number, index: number) => {
      const edge = useVerifiedLegs
        ? route.verifiedLegs?.[index]
        : problem.matrix.edges[previous]?.[destination];
      if (
        !edge?.reachable ||
        !Number.isFinite(edge.seconds) ||
        !Number.isFinite(edge.meters) ||
        edge.seconds < 0 ||
        edge.meters < 0
      ) {
        errors.push('Unreachable or missing leg.');
        time = Infinity;
        return;
      }
      time += edge.seconds;
      drive += edge.seconds;
      meters += edge.meters;
      previous = destination;
    };
    route.stops.forEach((stop, i) => {
      replay(stop.location, i);
      if (!stop.memberIds.length) errors.push('Empty pickup stop.');
      if (Math.abs(time - stop.arrival) > 0.01) errors.push('Incorrect pickup arrival estimate.');
      for (const id of stop.memberIds) {
        cover(id);
        passengers.push(id);
        const rider = problem.riders.find((r) => r.id === id);
        if (!rider || rider.location !== stop.location)
          errors.push(`Incorrect pickup location for ${id}.`);
        if (rider && time < rider.ready) errors.push(`Pickup precedes readiness for ${id}.`);
      }
      time += problem.boardingSeconds;
      occupancy += stop.memberIds.length;
      if (Math.abs(time - stop.departure) > 0.01) errors.push('Pickup service time is missing.');
      if (occupancy !== stop.occupancy || occupancy > driver.seats)
        errors.push('Seat occupancy exceeded or misreported.');
    });
    replay(problem.destination, route.stops.length);
    if (passengers.sort().join('|') !== [...route.passengerIds].sort().join('|'))
      errors.push('Passenger manifest differs from pickup stops.');
    if (!Number.isFinite(time) || Math.abs(time - route.arrival) > 0.01 || time > problem.deadline)
      errors.push('Arrival misses buffered deadline or is inconsistent.');
    if (
      time - route.departure > driver.maxSeconds ||
      Math.abs(time - route.departure - route.durationSeconds) > 0.01
    )
      errors.push('Route-duration limit exceeded or misreported.');
    if (Math.abs(drive - route.drivingSeconds) > 0.01 || Math.abs(meters - route.meters) > 0.01)
      errors.push('Route totals do not match legs.');
  }
  for (const trip of plan.rideShares ?? []) {
    if (
      !trip.memberIds.length ||
      trip.memberIds.length > 4 ||
      new Set(trip.memberIds).size !== trip.memberIds.length
    )
      errors.push('Uber groups require one to four distinct passengers.');
    const edge = useVerifiedLegs
      ? trip.verifiedLeg
      : problem.matrix.edges[trip.location]?.[problem.destination];
    if (
      trip.destination !== problem.destination ||
      !edge?.reachable ||
      !Number.isFinite(edge.seconds) ||
      !Number.isFinite(edge.meters)
    )
      errors.push('Missing or incorrect Uber route.');
    else if (
      [trip.pickupTime, trip.departure, trip.arrival, trip.drivingSeconds, trip.meters].some(
        (n) => !Number.isFinite(n) || n < 0,
      ) ||
      Math.abs(trip.departure - trip.pickupTime - problem.boardingSeconds) > 0.01 ||
      Math.abs(trip.arrival - trip.departure - edge.seconds) > 0.01 ||
      trip.arrival > problem.deadline ||
      Math.abs(trip.drivingSeconds - edge.seconds) > 0.01 ||
      Math.abs(trip.meters - edge.meters) > 0.01
    )
      errors.push('Incorrect Uber pickup or arrival estimate.');
    for (const id of trip.memberIds) {
      cover(id);
      const rider = problem.riders.find((r) => r.id === id);
      if (!rider || rider.location !== trip.location || rider.ready > trip.pickupTime)
        errors.push('Uber pickup does not match the rider location or readiness.');
      if (problem.drivers.some((d) => d.id === id))
        errors.push('An available club driver was assigned to Uber overflow.');
    }
  }
  for (const id of active)
    if (seen.get(id) !== 1)
      errors.push(`${id} must be covered exactly once (found ${seen.get(id) ?? 0}).`);
  return errors;
}
export function routeTotals(routes: CarRoute[]) {
  return {
    seconds: routes.reduce((s, r) => s + r.drivingSeconds, 0),
    meters: routes.reduce((s, r) => s + r.meters, 0),
  };
}
