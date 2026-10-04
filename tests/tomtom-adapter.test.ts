import { it, expect, vi } from 'vitest';
import {
  TomTomTravelProvider,
  normalizeTomTomBatch,
  normalizeTomTomRoute,
  normalizeTomTomGeometry,
} from '../src/travel/tomtom';
import type { Location } from '../src/domain/types';
import type { RouteRequest } from '../src/travel/provider';
const context = { date: '2026-10-05', departureIso: '2026-10-05T08:45:00.000Z' };
const locations = (n: number): Location[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `fictitious-${i}`,
    address: `${i} Fixture Street`,
    lat: 40.4 + i / 10000,
    lng: -79.9,
  }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const batchResponse = (n: number) => ({
  batchItems: Array.from({ length: n }, (_, k) => ({
    statusCode: 200,
    response: {
      routes: [{ summary: { travelTimeInSeconds: k + 1, lengthInMeters: (k + 1) * 100 } }],
    },
  })),
});

it('decodes compact road geometry exactly and rejects malformed encoded paths', () => {
  const leg = { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@', encodedPolylinePrecision: 5 };
  expect(normalizeTomTomGeometry({ legs: [leg] })).toEqual([
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ]);
  for (const encodedPolyline of ['_', '???', '\u0000', '~~~~~~~'])
    expect(normalizeTomTomGeometry({ legs: [{ ...leg, encodedPolyline }] })).toBeUndefined();
  expect(
    normalizeTomTomGeometry({ legs: [{ ...leg, encodedPolylinePrecision: 6 }] }),
  ).toBeUndefined();
});

it('locates addresses concurrently with bounded pacing and deduplicates repeated pickups', async () => {
  vi.useFakeTimers();
  try {
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => {
      starts.push(Date.now());
      await new Promise((r) => setTimeout(r, 1000));
      return json({ results: [{ type: 'Point Address', position: { lat: 40.4, lon: -79.9 } }] });
    });
    const p = new TomTomTravelProvider('fixture', fetcher);
    const task = p.resolve(
      ['A', 'B', 'A', 'C', 'D'].map((address, i) => ({ key: String(i), address })),
    );
    await vi.runAllTimersAsync();
    expect((await task).map((l) => l.key)).toEqual(['0', '1', '2', '3', '4']);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(starts.every((v, i) => i === 0 || v - starts[i - 1] >= 250)).toBe(true);
    expect(starts.at(-1)! - starts[0]).toBeLessThan(2000);
  } finally {
    vi.useRealTimers();
  }
});

it('reuses directed edges across changed pickup sets but refreshes expired traffic', async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn<typeof fetch>(async (_, init) =>
      json(batchResponse(JSON.parse(String(init?.body)).batchItems.length)),
    );
    const p = new TomTomTravelProvider('fixture', fetcher);
    const first = p.matrix(locations(3), context);
    await vi.runAllTimersAsync();
    await first;
    await vi.advanceTimersByTimeAsync(540000);
    const changed = p.matrix([locations(3)[2], locations(3)[0]], context);
    await vi.runAllTimersAsync();
    expect((await changed).edges[0][1].seconds).toBe(5);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60001);
    const fresh = p.matrix([locations(3)[2], locations(3)[0]], context);
    await vi.runAllTimersAsync();
    await fresh;
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
function routeResponse(departure: string, pauses: number[], inclusivePause = false) {
  let time = Date.parse(departure);
  const legs = pauses.map((p) => {
    const departureTime = new Date(time).toISOString();
    time += 60000;
    const arrivalTime = new Date(time + (inclusivePause ? p * 1000 : 0)).toISOString();
    time += p * 1000;
    return {
      summary: {
        departureTime,
        arrivalTime,
        travelTimeInSeconds: 60 + (inclusivePause ? p : 0),
        lengthInMeters: 500,
        userDefinedPauseTimeInSeconds: p,
      },
    };
  });
  return {
    summary: {
      departureTime: departure,
      arrivalTime: new Date(time).toISOString(),
      lengthInMeters: legs.length * 500,
    },
    legs,
  };
}

it('builds a directed dated matrix with the Routing allowance, without sending member metadata', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => json(batchResponse(2)));
  const provider = new TomTomTravelProvider('fictitious-key', fetcher);
  const matrix = await provider.matrix(locations(2), context);
  expect(matrix.provider).toBe('tomtom');
  expect(matrix.edges[0][0]).toEqual({ seconds: 0, meters: 0, reachable: true });
  expect(matrix.edges[0][1]).toEqual({ seconds: 1, meters: 100, reachable: true });
  expect(matrix.edges[1][0].seconds).toBe(2);
  const [url, init] = fetcher.mock.calls[0];
  expect(new URL(String(url)).pathname).toBe('/routing/1/batch/sync/json');
  expect(init?.credentials).toBe('omit');
  const body = JSON.parse(String(init?.body));
  expect(body.batchItems).toHaveLength(2);
  const query = new URL(body.batchItems[0].query, 'https://fixture.invalid');
  expect(query.pathname).toBe('/calculateRoute/40.4,-79.9:40.4001,-79.9/json');
  expect(query.searchParams.get('departAt')).toBe(context.departureIso);
  expect(query.searchParams.get('traffic')).toBe('true');
  expect(query.searchParams.get('maxAlternatives')).toBe('0');
  expect(String(init?.body)).not.toMatch(/Fixture|fictitious|key=/);
  matrix.edges[0][1].seconds = 999;
  expect((await provider.matrix(locations(2), context)).edges[0][1].seconds).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(provider.usage()).toMatchObject({
    matrixSubmissions: 0,
    matrixUnits: 0,
    routingRequests: 2,
    cacheHits: 1,
  });
  await provider.matrix(locations(2), { ...context, departureIso: '2026-10-05T08:46:00Z' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('splits batches at 100 items, preserves directed ordering, and skips coincident points', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_, init) =>
    json(batchResponse(JSON.parse(String(init?.body)).batchItems.length)),
  );
  const provider = new TomTomTravelProvider('fictitious-key', fetcher);
  const matrix = await provider.matrix(locations(11), context);
  expect(
    fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).batchItems.length),
  ).toEqual([100, 10]);
  expect(matrix.edges[9][10].seconds).toBe(100);
  expect(matrix.edges[10][0].seconds).toBe(1);
  expect(provider.usage()).toMatchObject({
    matrixSubmissions: 0,
    matrixUnits: 0,
    routingRequests: 110,
  });
  const coincident = await provider.matrix([locations(1)[0], locations(1)[0]], context);
  expect(
    coincident.edges.flat().every((e) => e.seconds === 0 && e.meters === 0 && e.reachable),
  ).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('reuses completed batches when a later batch is cancelled', async () => {
  const abort = new AbortController();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(batchResponse(100)))
    .mockImplementationOnce(async () => {
      abort.abort();
      throw new DOMException('cancelled', 'AbortError');
    })
    .mockResolvedValueOnce(json(batchResponse(10)));
  const provider = new TomTomTravelProvider('fictitious-key', fetcher);
  await expect(provider.matrix(locations(11), context, abort.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  const matrix = await provider.matrix(locations(11), context);
  expect(matrix.edges[0][1].seconds).toBe(1);
  expect(matrix.edges[10][9].seconds).toBe(10);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(provider.usage()).toMatchObject({ routingRequests: 120, cacheHits: 1, matrixUnits: 0 });
});

it('leaves a rate-limit window between a completed batch and the next route request', async () => {
  vi.useFakeTimers();
  try {
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      starts.push(Date.now());
      return String(url).includes('/batch/sync/')
        ? json(batchResponse(2))
        : json({ routes: [routeResponse(context.departureIso, [0])] });
    });
    const provider = new TomTomTravelProvider('fictitious-key', fetcher);
    const matrix = provider.matrix(locations(2), context);
    await vi.advanceTimersByTimeAsync(0);
    await matrix;
    const task = provider.leg(locations(2)[0], locations(2)[1], context);
    await vi.advanceTimersByTimeAsync(1249);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await task;
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1250);
  } finally {
    vi.useRealTimers();
  }
});

it('rejects missing or malformed batch results without converting service errors to unreachable roads', () => {
  expect(() => normalizeTomTomBatch({ batchItems: [] }, 2)).toThrow('incomplete');
  const invalid = batchResponse(1);
  invalid.batchItems[0].response.routes[0].summary.lengthInMeters = -1;
  expect(() => normalizeTomTomBatch(invalid, 1)).toThrow('invalid travel');
  expect(
    normalizeTomTomBatch(
      {
        batchItems: [{ statusCode: 400, response: { detailedError: { code: 'NO_ROUTE_FOUND' } } }],
      },
      1,
    )[0].reachable,
  ).toBe(false);
  expect(() => normalizeTomTomBatch({ batchItems: [{ statusCode: 500 }] }, 1)).toThrow('HTTP 500');
  expect(() =>
    normalizeTomTomBatch(
      {
        batchItems: [
          { statusCode: 403, response: { detailedError: { code: 'InsufficientFunds' } } },
        ],
      },
      1,
    ),
  ).toThrow('free allowance is exhausted');
});

it('reports exhausted credits accurately for HTTP 403 and never retries or echoes response data', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    json({ detailedError: { code: 'InsufficientFunds', message: 'DO-NOT-ECHO' } }, 403),
  );
  const provider = new TomTomTravelProvider('fictitious-key', fetcher);
  await expect(provider.matrix(locations(2), context)).rejects.toThrow(
    'free allowance is exhausted',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(provider.usage().matrixUnits).toBe(0);
});

it('stops on quota denial without retrying, and redacts key-bearing network failures', async () => {
  const quota = vi.fn<typeof fetch>(async () => json({}, 429));
  await expect(
    new TomTomTravelProvider('fictitious-key', quota).matrix(locations(2), context),
  ).rejects.toThrow('free allowance or rate limit');
  expect(quota).toHaveBeenCalledTimes(1);
  const network = vi.fn<typeof fetch>(async () => {
    throw new Error('https://api.tomtom.com?key=DO-NOT-ECHO');
  });
  await expect(
    new TomTomTravelProvider('DO-NOT-ECHO', network).matrix(locations(2), context),
  ).rejects.toThrow('Unable to connect to TomTom');
  expect(network).toHaveBeenCalledTimes(1);
});

it('geocodes only full address matches, caches coordinates without mixing identities, and rejects ambiguous results', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    json({ results: [{ type: 'Point Address', position: { lat: 40.4, lon: -79.9 } }] }),
  );
  const provider = new TomTomTravelProvider('fictitious-key', fetcher);
  const source = { key: 'private-internal-id', address: '1 Fixture Street' };
  await provider.resolve([source]);
  expect((await provider.resolve([{ ...source, key: 'second-private-id' }]))[0].key).toBe(
    'second-private-id',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0][0])).not.toContain('private-internal-id');
  for (const results of [
    [],
    [{ type: 'Street', position: { lat: 40.4, lon: -79.9 } }],
    [{ type: 'Point Address' }, { type: 'Point Address' }],
  ]) {
    const p = new TomTomTravelProvider('fictitious-key', async () => json({ results }));
    await expect(p.resolve([source])).rejects.toThrow('Ambiguous or unresolved');
  }
  const abort = new AbortController();
  abort.abort();
  await expect(provider.resolve([source], abort.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  await expect(provider.matrix(locations(2), context, abort.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
});

it('checks whole routes with fixed stop order, departure time, boarding and alternatives', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    json({ routes: [routeResponse(context.departureIso, [60, 0])] }),
  );
  const provider = new TomTomTravelProvider('fictitious-key', fetcher);
  const edges = await provider.route(locations(3), context, 60);
  expect(edges[0]).toEqual([
    { seconds: 60, meters: 500, reachable: true },
    { seconds: 60, meters: 500, reachable: true },
  ]);
  const [url, init] = fetcher.mock.calls[0];
  const params = new URL(String(url)).searchParams;
  expect(params.get('computeBestOrder')).toBe('false');
  expect(params.get('maxAlternatives')).toBe('2');
  expect(params.get('traffic')).toBe('true');
  expect(JSON.parse(String(init?.body)).legs).toEqual([
    { routeStop: { pauseTimeInSeconds: 60 } },
    { routeStop: { pauseTimeInSeconds: 0 } },
  ]);
  await provider.route(locations(3), context, 60);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(provider.usage()).toMatchObject({ routingRequests: 1, cacheHits: 1 });
});

it('uses the verified Yarrow Way building instead of the incorrect Gold Way geocode', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    json({
      results: [
        { type: 'Street', position: { lat: 40.4399376, lon: -79.9518372 } },
        {
          type: 'Address Range',
          address: { freeformAddress: '373 Gold Way, Pittsburgh, PA 15213' },
          position: { lat: 40.4540104, lon: -79.9525963 },
        },
      ],
    }),
  );
  const provider = new TomTomTravelProvider('fictitious-key', fetcher);
  const resolved = await provider.resolve([
    { key: 'first', address: '373 Yarrow Way, Pittsburgh, PA 15213' },
    { key: 'second', address: '373 Yarrow Wy, Pittsburgh, PA 15213' },
  ]);
  expect(resolved.map(({ key, lat, lng }) => ({ key, lat, lng }))).toEqual([
    { key: 'first', lat: 40.440168, lng: -79.951754 },
    { key: 'second', lat: 40.440168, lng: -79.951754 },
  ]);
  expect(fetcher).not.toHaveBeenCalled();
  await provider.resolve([{ key: 'different', address: '371 Yarrow Way, Pittsburgh, PA 15213' }]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('normalizes pause-inclusive and pause-exclusive summaries using their actual timeline and rejects inconsistent times', () => {
  for (const inclusive of [false, true]) {
    const route = routeResponse(context.departureIso, [60, 60, 0], inclusive);
    expect(
      normalizeTomTomRoute(route, context.departureIso, [60, 60, 0]).map((e) => e.seconds),
    ).toEqual([60, 60, 60]);
    route.legs[1].summary.departureTime = 'invalid';
    expect(() => normalizeTomTomRoute(route, context.departureIso, [60, 60, 0])).toThrow(
      'inconsistent',
    );
  }
});

it('handles boarding at the driver start and destination without duplicate API waypoints or double-counted pauses', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    json({ routes: [routeResponse(new URL(String(url)).searchParams.get('departAt')!, [0])] }),
  );
  const provider = new TomTomTravelProvider('fictitious-key', fetcher);
  const [a, b] = locations(2);
  expect((await provider.route([a, a, b, b], context, 60))[0].map((e) => e.seconds)).toEqual([
    0, 60, 0,
  ]);
  expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('departAt')).toBe(
    '2026-10-05T08:46:00.000Z',
  );
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).legs).toHaveLength(1);
});

it('aborts a stalled HTTP request after the deadline without retrying', async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn<typeof fetch>(
      (_, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('timed out', 'AbortError')),
            { once: true },
          );
        }),
    );
    const task = new TomTomTravelProvider('fictitious-key', fetcher).matrix(locations(2), context);
    const assertion = expect(task).rejects.toThrow('too long to respond');
    await vi.advanceTimersByTimeAsync(65001);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it.each(['Point Address', 'Address Range', 'Cross Street'])(
  'accepts TomTom’s documented %s type alongside a broad street suggestion',
  async (type) => {
    const provider = new TomTomTravelProvider('fictitious-key', async () =>
      json({
        results: [
          { type: 'Street', position: { lat: 40.5, lon: -80.0 } },
          { type, matchConfidence: { score: 0.907 }, position: { lat: 40.4, lon: -79.9 } },
        ],
      }),
    );
    expect(await provider.resolve([{ key: 'fixture', address: '1 Fixture Street' }])).toEqual([
      { key: 'fixture', address: '1 Fixture Street', lat: 40.4, lng: -79.9 },
    ]);
  },
);

it('batches complete routes with independent times, geometry and boarding, deduplicating requests and cloning cached results', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_, init) => {
    const { batchItems } = JSON.parse(String(init?.body));
    return json({
      batchItems: batchItems.map((item: any) => {
        const params = new URL(item.query, 'https://fixture.invalid').searchParams;
        expect(params.get('routeRepresentation')).toBe('encodedPolyline');
        expect(params.get('computeBestOrder')).toBe('false');
        expect(params.get('maxAlternatives')).toBe('2');
        const route = routeResponse(
          params.get('departAt')!,
          item.post.legs.map((l: any) => l.routeStop.pauseTimeInSeconds),
        );
        const shaped = {
          ...route,
          legs: route.legs.map((leg, i) => ({
            ...leg,
            points: [
              { latitude: 40.4 + i / 100, longitude: -79.9 },
              { latitude: 40.41 + i / 100, longitude: -79.9 },
            ],
          })),
        };
        return { statusCode: 200, response: { routes: [shaped] } };
      }),
    });
  });
  const provider = new TomTomTravelProvider('fictitious-key', fetcher);
  const requests: RouteRequest[] = Array.from({ length: 101 }, (_, i) => ({
    locations: locations(3),
    context: {
      ...context,
      departureIso: new Date(Date.parse(context.departureIso) + i * 1000).toISOString(),
    },
    boardingSeconds: 60,
  }));
  requests.push(requests[0]);
  const [a, b] = locations(2);
  requests.push({ locations: [a, a, b, b], context, boardingSeconds: 60 });
  const result = await provider.routeBatch(requests);
  expect(result).toHaveLength(103);
  expect(
    fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).batchItems.length),
  ).toEqual([100, 2]);
  expect(result[0][0].geometry).toHaveLength(3);
  expect(result[102][0].edges.map((e) => e.seconds)).toEqual([0, 60, 0]);
  result[0][0].geometry![0].lat = 0;
  expect(result[101][0].geometry![0].lat).toBe(40.4);
  expect((await provider.routeBatch([requests[0]]))[0][0].geometry![0].lat).toBe(40.4);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(provider.usage().routingRequests).toBe(102);
  expect(String(fetcher.mock.calls[0][1]?.body)).not.toMatch(/Fixture|fictitious|key=/);
});

it('rejects incomplete and denied complete-route batches and honours cancellation without retries', async () => {
  for (const response of [
    { batchItems: [] },
    {
      batchItems: [{ statusCode: 403, response: { detailedError: { code: 'InsufficientFunds' } } }],
    },
  ]) {
    const fetcher = vi.fn<typeof fetch>(async () => json(response));
    const provider = new TomTomTravelProvider('fictitious-key', fetcher);
    await expect(
      provider.routeBatch([{ locations: locations(2), context, boardingSeconds: 60 }]),
    ).rejects.toThrow(/incomplete|free allowance/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const abort = new AbortController();
    abort.abort();
    await expect(provider.routeBatch([], abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

it('omits missing or invalid road shapes instead of drawing straight stop connectors', () => {
  expect(normalizeTomTomGeometry({ legs: [{ summary: {} }] })).toBeUndefined();
  expect(
    normalizeTomTomGeometry({
      legs: [
        {
          points: [
            { latitude: 40, longitude: -80 },
            { latitude: 999, longitude: -80 },
          ],
        },
      ],
    }),
  ).toBeUndefined();
});

it('requests only scoped pairs and never reuses an incomplete matrix as a complete one', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_, init) =>
    json(batchResponse(JSON.parse(String(init?.body)).batchItems.length)),
  );
  const provider = new TomTomTravelProvider('fictitious-key', fetcher);
  const scoped = await provider.matrix(locations(3), context, undefined, {
    origins: [0, 1],
    destinations: [1, 2],
  });
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).batchItems).toHaveLength(3);
  expect(scoped.edges[2][0].reachable).toBe(false);
  expect(scoped.edges[2][2]).toEqual({ seconds: 0, meters: 0, reachable: true });
  const full = await provider.matrix(locations(3), context);
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).batchItems).toHaveLength(3);
  expect(full.edges[2][0].reachable).toBe(true);
});
