import type { Snapshot } from '../exports/plan';
import {
  defaultSettings,
  type CarRoute,
  type DayProblem,
  type Member,
  type RideShareTrip,
} from '../domain/types';
import { cleanPlan, type Publication, type SharedPlan } from './schema';

export function publishable(snapshot: Snapshot, stale: boolean): boolean {
  return (
    !stale &&
    snapshot.plan.verified &&
    snapshot.plan.liveRechecked &&
    !snapshot.plan.simulation &&
    !snapshot.data.scenario &&
    !snapshot.plan.settings.comparisonDates &&
    snapshot.plan.settings.mode === 'tomtom' &&
    snapshot.plan.days.length > 0 &&
    snapshot.plan.days.every(
      (d) => d.status === 'feasible' && !d.unassigned.length && !d.unresolved.length,
    )
  );
}
export function sharePlan(snapshot: Snapshot): SharedPlan {
  if (!publishable(snapshot, false))
    throw new Error('Finish planning and resolve all issues before publishing.');
  const name = (id: string) => {
    const member = snapshot.data.members.find((m) => m.member_id === id);
    if (!member) throw new Error('A route member is missing. Replan before publishing.');
    return member.display_name;
  };
  return cleanPlan({
    schemaVersion: 1,
    deadline: snapshot.plan.settings.deadline,
    days: snapshot.plan.days.map((day) => {
      const problem = snapshot.problems.find((p) => p.date === day.date)!;
      const place = (index: number) => problem.matrix.locations[index];
      return {
        date: day.date,
        independent: day.independent.map(name),
        external: day.external.map(name),
        rideShares: (day.rideShares ?? []).map((trip) => ({
          names: trip.memberIds.map(name),
          pickup: place(trip.location),
          destination: place(trip.destination),
          pickupTime: trip.pickupTime,
          departure: trip.departure,
          arrival: trip.arrival,
          drivingSeconds: trip.drivingSeconds,
          meters: trip.meters,
        })),
        routes: day.routes.map((r) => ({
          driver: name(r.driverId),
          start: place(r.start),
          destination: place(r.destination),
          departure: r.departure,
          arrival: r.arrival,
          drivingSeconds: r.drivingSeconds,
          meters: r.meters,
          seats: r.seats,
          geometry: r.geometry,
          stops: r.stops.map((s) => ({
            names: s.memberIds.map(name),
            place: place(s.location),
            arrival: s.arrival,
            departure: s.departure,
          })),
        })),
      };
    }),
  });
}

// Reuse the map, route cards and daily Excel exporter with ONLY the published stops.
export function viewSnapshot(publication: Publication): Snapshot {
  const members: Member[] = [],
    problems: DayProblem[] = [];
  const plan = publication.plan;
  const settings = {
    ...defaultSettings,
    dates: plan.days.map((d) => d.date),
    deadline: plan.deadline,
    mode: 'tomtom' as const,
    destinationConfirmed: true,
  };
  const [hours, minutes] = plan.deadline.split(':').map(Number),
    deadline = hours * 3600 + minutes * 60;
  const days = plan.days.map((day, di) => {
    const locations: DayProblem['matrix']['locations'] = [];
    const location = (p: { address: string; lat?: number; lng?: number }) => {
      locations.push({ ...p, key: `stop-${locations.length}` });
      return locations.length - 1;
    };
    const member = (name: string, address: string) => {
      const id = `person-${members.length}`;
      members.push({ member_id: id, display_name: name, pickup_address: address });
      return id;
    };
    const routes: CarRoute[] = day.routes.map((r) => {
      const driverId = member(r.driver, r.start.address);
      let occupancy = 1;
      const stops = r.stops.map((s) => {
        occupancy += s.names.length;
        return {
          location: location(s.place),
          memberIds: s.names.map((n) => member(n, s.place.address)),
          arrival: s.arrival,
          departure: s.departure,
          occupancy,
        };
      });
      return {
        driverId,
        passengerIds: stops.flatMap((s) => s.memberIds),
        stops,
        start: location(r.start),
        destination: location(r.destination),
        departure: r.departure,
        arrival: r.arrival,
        durationSeconds: r.arrival - r.departure,
        drivingSeconds: r.drivingSeconds,
        seats: r.seats,
        meters: r.meters,
        geometry: r.geometry,
      };
    });
    const rideShares: RideShareTrip[] = (day.rideShares ?? []).map((r) => ({
      memberIds: r.names.map((n) => member(n, r.pickup.address)),
      location: location(r.pickup),
      destination: location(r.destination),
      pickupTime: r.pickupTime,
      departure: r.departure,
      arrival: r.arrival,
      drivingSeconds: r.drivingSeconds,
      meters: r.meters,
      reason: 'capacity',
    }));
    const independent = (day.independent ?? []).map((n) => member(n, ''));
    const external = (day.external ?? []).map((n) => member(n, ''));
    problems[di] = {
      date: day.date,
      riders: [],
      drivers: [],
      destination: routes[0]?.destination ?? 0,
      matrix: { locations, edges: [], date: day.date, departureIso: '', provider: 'tomtom' },
      deadline,
      boardingSeconds: 0,
      independent: [],
      external: [],
      unresolved: [],
      unknownAvailability: [],
    };
    return {
      date: day.date,
      status: 'feasible' as const,
      routes,
      rideShares,
      unassigned: [],
      independent,
      external,
      unresolved: [],
      messages: [],
      alternatives: 0,
      budgetExhausted: false,
    };
  });
  return {
    revision: 0,
    problems,
    data: { schemaVersion: 1, members, attendance: [], availability: [] },
    plan: {
      schemaVersion: 1,
      generatedAt: publication.publishedAt,
      simulation: false,
      settings,
      days,
      usage: [],
      fairnessScore: 0,
      baselineDrivingSeconds: 0,
      drivingSeconds: days.reduce(
        (n, d) => n + [...d.routes, ...d.rideShares].reduce((s, r) => s + r.drivingSeconds, 0),
        0,
      ),
      search: { evaluations: 0, elapsedMs: 0, subsetLimit: 0, evaluationBudget: 0, beamWidth: 0 },
      verified: true,
      liveRechecked: true,
    },
  };
}
