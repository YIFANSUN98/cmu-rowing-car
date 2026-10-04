import type { Dataset, Availability, ScenarioConfig } from './types';
import { rng, shuffled } from './util';
export const DEMO_DATES = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
export const DEMO_DESTINATION = 'Fictitious Launch Point, Demo Harbor';
export const scenarioKinds = [
  'broad',
  'rotating',
  'insufficient',
  'zero',
  'mixed',
  'cancellation',
] as const;
export function simulateAvailability(
  data: Dataset,
  config: ScenarioConfig,
  reviewedObserved?: Record<string, string[]>,
): Dataset {
  if (data.scenario?.uploadedTest)
    throw new Error('Reupload reviewed input files before changing the availability scenario.');
  if (![...scenarioKinds, 'observed'].includes(config.kind as (typeof scenarioKinds)[number]))
    throw new Error('Unknown simulation scenario.');
  if (!Number.isInteger(config.seed)) throw new Error('Scenario seed must be an integer.');
  const random = rng(config.seed);
  const candidates = new Set(config.candidateIds);
  if (!candidates.size) throw new Error('Choose an explicit candidate driver pool.');
  if (config.candidateIds.some((id) => !data.members.some((m) => m.member_id === id)))
    throw new Error('Candidate driver ID is not in members.');
  if (config.kind === 'observed' && !reviewedObserved)
    throw new Error(
      'Observed-driver simulation requires identity/date-reviewed driver IDs by date.',
    );
  if (config.kind === 'cancellation') {
    if (!config.cancelledDriver || !candidates.has(config.cancelledDriver))
      throw new Error('Choose a candidate driver to cancel.');
    return {
      ...data,
      availability: data.availability.map((a) => ({
        ...a,
        available: a.member_id === config.cancelledDriver ? ('false' as const) : a.available,
        source: 'simulated' as const,
      })),
      scenario: { ...config, candidateIds: [...config.candidateIds].sort() },
    };
  }
  const dates = [...new Set(data.attendance.map((a) => a.date))].sort();
  const availability: Availability[] = [];
  for (const [di, date] of dates.entries()) {
    const attendees = data.attendance
      .filter((a) => a.date === date && a.attending === 'true' && a.transport_mode === 'carpool')
      .map((a) => a.member_id)
      .sort();
    const pool = attendees.filter((id) => candidates.has(id));
    const shuffledPool = shuffled(pool, random);
    const allowed = new Set(
      config.kind === 'rotating'
        ? shuffledPool.slice(0, Math.max(1, Math.ceil(pool.length * 0.75)))
        : config.kind === 'insufficient'
          ? shuffledPool.slice(0, 1)
          : config.kind === 'zero' && di === 0
            ? []
            : config.kind === 'observed'
              ? (reviewedObserved![date] ?? []).filter((id) => pool.includes(id))
              : pool,
    );
    for (const [i, id] of pool.entries())
      availability.push({
        date,
        member_id: id,
        available: allowed.has(id) ? 'true' : 'false',
        total_seats: config.kind === 'mixed' ? 3 + ((i + di) % 3) : 5,
        source: 'simulated',
      });
  }
  return {
    ...data,
    availability,
    scenario: { ...config, candidateIds: [...config.candidateIds].sort() },
  };
}
export function makeDemo(config: Partial<ScenarioConfig> = {}): Dataset {
  const count = config.people ?? 18,
    driverCount = config.driverCount ?? 6;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 200 ||
    !Number.isInteger(driverCount) ||
    driverCount < 1 ||
    driverCount > count
  )
    throw new Error(
      'Use 1–200 fictitious people and a driver count between 1 and the people count.',
    );
  const first = [
    'Avery',
    'Blair',
    'Casey',
    'Devon',
    'Ellis',
    'Finley',
    'Gray',
    'Harper',
    'Indigo',
    'Jules',
    'Kai',
    'Lane',
    'Morgan',
    'Noel',
    'Oakley',
    'Parker',
    'Quinn',
    'Reese',
    'Sage',
    'Taylor',
  ];
  const last = ['Demo', 'Example', 'Sample', 'Fiction'];
  const members = Array.from({ length: count }, (_, i) => ({
    member_id: `demo-${String(i + 1).padStart(3, '0')}`,
    display_name: `${first[i % first.length]} ${last[Math.floor(i / first.length) % last.length]}${i >= 80 ? ' ' + i : ''}`,
    pickup_address: `${10 + Math.floor(i / 2) * 10} Lantern Walk, Demo Harbor`,
    pickup_notes: 'Fictitious location for simulation only.',
  }));
  const attendance = DEMO_DATES.flatMap((date) =>
    members.map((m, i) => ({
      date,
      member_id: m.member_id,
      attending: 'true' as const,
      transport_mode:
        count === 18 && i === 17
          ? ('self' as const)
          : count === 18 && i === 16
            ? ('external' as const)
            : ('carpool' as const),
      ready_after: '04:00',
    })),
  );
  const candidateIds = config.candidateIds ?? members.slice(0, driverCount).map((m) => m.member_id);
  const base: Dataset = { schemaVersion: 1, members, attendance, availability: [] };
  const settings = {
    kind: config.kind ?? 'broad',
    seed: config.seed ?? 42,
    people: count,
    driverCount,
    candidateIds,
    cancelledDriver: config.cancelledDriver,
  };
  if (settings.kind === 'cancellation') {
    const broad = simulateAvailability(base, { ...settings, kind: 'broad' });
    return simulateAvailability(broad, {
      ...settings,
      cancelledDriver: settings.cancelledDriver ?? candidateIds[0],
    });
  }
  return simulateAvailability(base, settings);
}
