import { it, expect, vi, beforeEach, afterEach } from 'vitest';
const sdk = vi.hoisted(() => ({
  matrix: vi.fn(),
  route: vi.fn(),
  geocode: vi.fn(),
  load: vi.fn(),
  options: vi.fn(),
}));
vi.mock('@googlemaps/js-api-loader', () => ({
  setOptions: sdk.options,
  importLibrary: async (name: string) => {
    sdk.load(name);
    if (name === 'routes')
      return {
        RouteMatrix: { computeRouteMatrix: sdk.matrix },
        Route: { computeRoutes: sdk.route },
      };
    return {
      Geocoder: class {
        geocode = sdk.geocode;
      },
    };
  },
}));
import { GoogleMapsTravelProvider } from '../src/travel/google';
beforeEach(() => {
  vi.useFakeTimers();
  sdk.matrix.mockReset();
  sdk.route.mockReset();
  sdk.geocode.mockReset();
  sdk.load.mockClear();
});
afterEach(() => vi.useRealTimers());
it('does not load Google in the constructor and requires a key', () => {
  expect(() => new GoogleMapsTravelProvider('')).toThrow('restricted');
  new GoogleMapsTravelProvider('fictitious-test-key');
  expect(sdk.load).not.toHaveBeenCalled();
});
it('batches <=100 elements, uses date-specific departures, normalizes units and memoizes in-session', async () => {
  sdk.matrix.mockImplementation(async (req: { origins: unknown[]; destinations: unknown[] }) => ({
    matrix: {
      rows: req.origins.map((_, i) => ({
        items: req.destinations.map((_, j) => ({
          durationMillis: 10000 + i * 1000 + j * 2000,
          distanceMeters: 600 + i * 100 + j * 200,
          condition: 'ROUTE_EXISTS',
        })),
      })),
    },
  }));
  const p = new GoogleMapsTravelProvider('fictitious-test-key');
  const locations = Array.from({ length: 11 }, (_, i) => ({
      key: `point${i}`,
      address: `${i} Fiction Lane`,
      lat: 40 + i * 0.001,
      lng: -79,
    })),
    context = { date: '2026-10-05', departureIso: '2026-10-05T08:00:00.000Z' };
  const pending = p.matrix(locations, context);
  await vi.runAllTimersAsync();
  const matrix = await pending;
  expect(sdk.matrix).toHaveBeenCalledTimes(4);
  expect(matrix.edges[0][1].seconds).toBe(12);
  expect(matrix.edges[1][0].seconds).toBe(11);
  for (const [r] of sdk.matrix.mock.calls) {
    expect(r.origins.length * r.destinations.length).toBeLessThanOrEqual(100);
    expect(r.departureTime.toISOString()).toBe(context.departureIso);
    expect(Object.keys(r).sort()).toEqual(
      [
        'origins',
        'destinations',
        'travelMode',
        'routingPreference',
        'departureTime',
        'fields',
      ].sort(),
    );
    expect(JSON.stringify(r)).not.toContain('Fiction Lane');
  }
  expect(await p.matrix(locations, context)).toBe(matrix);
  expect(sdk.matrix).toHaveBeenCalledTimes(4);
});
it('refuses ambiguous geocodes and failed route responses rather than fabricating estimates', async () => {
  const p = new GoogleMapsTravelProvider('fictitious-test-key');
  sdk.geocode.mockResolvedValue({ results: [{ partial_match: true }] });
  await expect(p.resolve([{ key: 'a', address: 'Fiction Lane' }])).rejects.toThrow('Ambiguous');
  sdk.route.mockResolvedValue({ routes: [] });
  expect(
    (
      await p.leg(
        { key: 'a', address: 'Fiction A' },
        { key: 'b', address: 'Fiction B' },
        { date: '2026-10-05', departureIso: '2026-10-05T08:00:00Z' },
      )
    ).reachable,
  ).toBe(false);
});
it('bounds retryable network failures to three attempts and does not retry auth failures', async () => {
  const p = new GoogleMapsTravelProvider('fictitious-test-key');
  sdk.route.mockRejectedValue(new Error('NETWORK'));
  const ctx = { date: '2026-10-05', departureIso: '2026-10-05T08:00:00Z' },
    a = { key: 'a', address: 'A' },
    b = { key: 'b', address: 'B' };
  const pending = expect(p.leg(a, b, ctx)).rejects.toThrow('NETWORK');
  await vi.runAllTimersAsync();
  await pending;
  expect(sdk.route).toHaveBeenCalledTimes(3);
  sdk.route.mockClear();
  sdk.route.mockRejectedValue(new Error('REQUEST_DENIED'));
  await expect(p.leg(a, b, ctx)).rejects.toThrow('REQUEST_DENIED');
  expect(sdk.route).toHaveBeenCalledTimes(1);
});
