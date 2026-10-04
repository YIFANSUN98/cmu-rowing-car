import type { DayProblem } from '../src/domain/types';
export function tiny(count = 4, driverCount = 2, seats = 3): DayProblem {
  const locations = Array.from({ length: count + 1 }, (_, i) => ({
    key: `point-${i}`,
    address: `${i} Fiction Lane`,
  }));
  return {
    date: '2026-10-05',
    riders: Array.from({ length: count }, (_, i) => ({ id: `m${i}`, location: i, ready: 14400 })),
    drivers: Array.from({ length: driverCount }, (_, i) => ({
      id: `m${i}`,
      start: i,
      seats,
      earliest: 14400,
      maxSeconds: 3600,
    })),
    destination: count,
    matrix: {
      locations,
      edges: locations.map((_, i) =>
        locations.map((_, j) => ({
          seconds: i === j ? 0 : 120 + Math.abs(i - j) * 20,
          meters: i === j ? 0 : 900 + Math.abs(i - j) * 50,
          reachable: true,
        })),
      ),
      date: '2026-10-05',
      departureIso: '2026-10-05T08:00:00Z',
      provider: 'mock',
    },
    deadline: 18600,
    boardingSeconds: 60,
    independent: [],
    external: [],
    unresolved: [],
    unknownAvailability: [],
  };
}
