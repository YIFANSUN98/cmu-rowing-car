import { expect, test } from 'vitest';
import { tiny } from './helpers';
import { optimizeCar } from '../src/planner/route';
import { routeNavigation } from '../src/exports/navigation';
import { withComparisonDates } from '../src/domain/comparison';
import { defaultSettings } from '../src/domain/types';
test('full Google Maps links and mobile parts preserve every stop in order', () => {
  const p = tiny(5, 1, 5),
    route = optimizeCar(p, p.drivers[0], ['m1', 'm2', 'm3', 'm4'])!;
  const links = routeNavigation(route, p),
    full = new URL(links.url!);
  expect(full.searchParams.get('dir_action')).toBe('navigate');
  expect(full.searchParams.get('waypoints')!.split('|')).toEqual(
    route.stops.map((s) => p.matrix.locations[s.location].address),
  );
  expect(links.parts).toHaveLength(2);
  const parts = links.parts.map((l) => new URL(l.url));
  expect(parts[0].searchParams.get('destination')).toBe(parts[1].searchParams.get('origin'));
  const stitched = parts.flatMap((url, i) => [
    ...(i === 0 ? [url.searchParams.get('origin')] : []),
    ...(url.searchParams.get('waypoints')?.split('|') ?? []),
    url.searchParams.get('destination'),
  ]);
  expect(stitched).toEqual(
    [route.start, ...route.stops.map((s) => s.location), route.destination].map(
      (i) => p.matrix.locations[i].address,
    ),
  );
});
test('historical comparisons retain dates and shift all estimates by full weeks across DST', () => {
  const settings = {
    ...defaultSettings,
    mode: 'tomtom' as const,
    dates: ['2026-09-21', '2026-09-24'],
  };
  const result = withComparisonDates(settings, Date.parse('2026-09-24T20:00:00Z'));
  expect(result.dates).toEqual(settings.dates);
  expect(result.comparisonDates).toEqual({
    '2026-09-21': '2026-09-28',
    '2026-09-24': '2026-10-01',
  });
  expect(
    withComparisonDates(
      { ...settings, dates: ['2026-10-26', '2026-10-30'] },
      Date.parse('2026-10-30T20:00:00Z'),
    ).comparisonDates,
  ).toEqual({ '2026-10-26': '2026-11-02', '2026-10-30': '2026-11-06' });
  expect(
    withComparisonDates(settings, Date.parse('2026-09-20T20:00:00Z')).comparisonDates,
  ).toBeUndefined();
});
