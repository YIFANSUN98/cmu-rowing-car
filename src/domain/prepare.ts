import type { Dataset, DayProblem, Location, Settings } from './types';
import { normalize, seconds, zonedDate } from './util';
import type { MatrixScope, TravelProvider } from '../travel/provider';
import { DEMO_DESTINATION } from './scenarios';
import type { PlanningProgressCallback } from './progress';

export function requiredTravelPairs({
  riders,
  drivers,
  destination,
}: Pick<DayProblem, 'riders' | 'drivers' | 'destination'>): MatrixScope {
  const seats = drivers.reduce((sum, driver) => sum + driver.seats, 0);
  // If removing a driver leaves too few seats, every feasible plan must use that
  // driver. Their home needs no incoming pickup leg unless another rider uses it.
  const mandatory = new Set(
    drivers.filter((d) => seats - d.seats < riders.length).map((d) => d.id),
  );
  const pickups = riders.filter((r) => !mandatory.has(r.id)).map((r) => r.location);
  return {
    origins: [...new Set([...drivers.map((d) => d.start), ...pickups])].sort((a, b) => a - b),
    destinations: [...new Set([...pickups, destination])].sort((a, b) => a - b),
  };
}
export async function prepareProblems(
  data: Dataset,
  settings: Settings,
  provider: TravelProvider,
  signal?: AbortSignal,
  progress?: PlanningProgressCallback,
  estimateTravel = true,
): Promise<DayProblem[]> {
  if (data.scenario?.uploadedTest && (settings.mode !== 'mock' || provider.mode !== 'mock'))
    throw new Error(
      'Uploaded-data tests can only use Mock routing. Reupload reviewed input files for online routing.',
    );
  const problems: DayProblem[] = [];
  for (const date of [...settings.dates].sort()) {
    const index = problems.length;
    const report = (message: string, fraction: number) =>
      progress?.(message, (index + fraction) / settings.dates.length);
    report(`Estimating travel for ${date} · day ${index + 1} of ${settings.dates.length}`, 0);
    const all = data.attendance.filter((a) => a.date === date);
    const active = all
      .filter(
        (a) =>
          a.attending === 'true' && (a.transport_mode === 'carpool' || a.transport_mode === 'uber'),
      )
      .sort((a, b) => a.member_id.localeCompare(b.member_id));
    const locations: Location[] = [];
    const add = (address: string, lat?: number, lng?: number) => {
      const key = lat !== undefined && lng !== undefined ? `geo:${lat},${lng}` : normalize(address);
      if (!key) throw new Error('A required location is missing.');
      let i = locations.findIndex((l) => l.key === key);
      if (i < 0) {
        i = locations.length;
        locations.push({ key, address: address || `${lat},${lng}`, lat, lng });
      }
      return i;
    };
    const destination = add(
      settings.destination.trim() || (settings.mode === 'mock' ? DEMO_DESTINATION : ''),
    );
    const riders = active.map((a) => {
      const m = data.members.find((m) => m.member_id === a.member_id)!;
      return {
        id: a.member_id,
        requiresUber: a.transport_mode === 'uber',
        location: a.pickup_override
          ? add(a.pickup_override)
          : add(m.pickup_address, m.pickup_lat, m.pickup_lng),
        ready: seconds(a.ready_after || settings.earliestDeparture),
      };
    });
    const drivers = data.availability
      .filter(
        (v) =>
          v.date === date &&
          v.available === 'true' &&
          riders.some((r) => r.id === v.member_id && !r.requiresUber),
      )
      .sort((a, b) => a.member_id.localeCompare(b.member_id))
      .map((v) => {
        const rider = riders.find((r) => r.id === v.member_id)!;
        return {
          id: v.member_id,
          start: v.start_address ? add(v.start_address) : rider.location,
          seats: v.total_seats!,
          earliest: Math.max(
            seconds(settings.earliestDeparture),
            seconds(v.earliest_departure || settings.earliestDeparture),
            rider.ready,
          ),
          maxSeconds:
            Math.min(settings.maxRouteMinutes, v.max_route_minutes ?? settings.maxRouteMinutes) *
            60,
        };
      });
    const resolved = active.length
      ? await provider.resolve(locations, signal, (done, total) =>
          report(
            `Locating pickups for ${date} · ${done}/${total}`,
            total ? (0.2 * done) / total : 0.2,
          ),
        )
      : locations;
    // Different address spellings may resolve to the same pickup. Keep people separate.
    const unique: Location[] = [];
    const indices = resolved.map((l) => {
      let index = unique.findIndex((u) =>
        l.lat !== undefined && l.lng !== undefined
          ? u.lat === l.lat && u.lng === l.lng
          : u.key === l.key,
      );
      if (index < 0) {
        index = unique.length;
        unique.push(l);
      }
      return index;
    });
    riders.forEach((r) => {
      r.location = indices[r.location];
    });
    drivers.forEach((d) => {
      d.start = indices[d.start];
    });
    const context = {
      date: settings.comparisonDates?.[date] ?? date,
      departureIso: zonedDate(
        settings.comparisonDates?.[date] ?? date,
        seconds(settings.earliestDeparture),
      ).toISOString(),
    };
    const matrix =
      active.length && estimateTravel
        ? await provider.matrix(
            unique,
            context,
            signal,
            requiredTravelPairs({ riders, drivers, destination: indices[destination] }),
            (done, total) =>
              report(
                `Estimating travel for ${date} · ${done}/${total}`,
                0.2 + 0.8 * (total ? done / total : 1),
              ),
          )
        : {
            locations: unique,
            edges: unique.map((_, i) =>
              unique.map((_, j) => ({
                seconds: i === j ? 0 : Infinity,
                meters: i === j ? 0 : Infinity,
                reachable: i === j,
              })),
            ),
            ...context,
            provider: provider.mode,
          };
    report(`Travel estimates ready for ${date}`, 1);
    problems.push({
      date,
      riders,
      drivers,
      destination: indices[destination],
      matrix,
      deadline: seconds(settings.deadline) - settings.bufferMinutes * 60,
      boardingSeconds: settings.boardingSeconds,
      independent: all
        .filter((a) => a.attending === 'true' && a.transport_mode === 'self')
        .map((a) => a.member_id),
      external: all
        .filter((a) => a.attending === 'true' && a.transport_mode === 'external')
        .map((a) => a.member_id),
      unresolved: all
        .filter(
          (a) =>
            a.attending === 'unknown' || (a.attending === 'true' && a.transport_mode === 'unknown'),
        )
        .map((a) => a.member_id),
      unknownAvailability: riders
        .filter(
          (r) =>
            !data.availability.some(
              (v) => v.date === date && v.member_id === r.id && v.available !== 'unknown',
            ),
        )
        .map((r) => r.id),
    });
  }
  return problems;
}
