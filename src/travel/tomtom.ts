import type { Edge, Location, Matrix, TravelUsage } from '../domain/types';
import type {
  MatrixScope,
  RouteAlternative,
  RouteRequest,
  TravelContext,
  TravelProvider,
} from './provider';
import { checkAbort } from './provider';

const unavailable = (): Edge => ({ seconds: Infinity, meters: Infinity, reachable: false });
const zero = (): Edge => ({ seconds: 0, meters: 0, reachable: true });
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const point = (l: Location) => {
  if (
    !Number.isFinite(l.lat) ||
    !Number.isFinite(l.lng) ||
    Math.abs(l.lat!) > 90 ||
    Math.abs(l.lng!) > 180
  )
    throw new Error('A pickup or destination has invalid coordinates.');
  return { latitude: l.lat!, longitude: l.lng! };
};
const same = (a: Pick<Location, 'lat' | 'lng'>, b: Pick<Location, 'lat' | 'lng'>) =>
  a.lat === b.lat && a.lng === b.lng;
// This public apartment building is missing from TomTom's address-level results:
// it returns a Yarrow Way street centroid and an unrelated address on Gold Way.
// Address: https://3riversliving.com/property/park-house-flats/
// Building pin verified in Google Maps on 2026-09-23:
// https://www.google.com/maps/place/373+Yarrow+Wy,+Pittsburgh,+PA+15213/@40.440168,-79.951754,17z/data=!4m6!3m5!1s0x8834f227f5e6041f:0x4f316313f1732f11!8m2!3d40.440168!4d-79.951754!16s%2Fg%2F11splsfvwr
const verifiedPublicPickups = new Map<string, Pick<Location, 'lat' | 'lng'>>([
  ['373 yarrow way, pittsburgh, pa 15213', { lat: 40.440168, lng: -79.951754 }],
  ['373 yarrow wy, pittsburgh, pa 15213', { lat: 40.440168, lng: -79.951754 }],
]);
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    checkAbort(signal);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Calculation cancelled.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });

// Each item uses the Routing allowance; batching does not make the items free.
// https://docs.tomtom.com/routing-api/documentation/tomtom-maps/v1/batch-routing/synchronous-batch
export const ROUTING_BATCH_SIZE = 100;
const errorCode = (value: any): string =>
  String(value?.detailedError?.code ?? value?.error?.code ?? '').toUpperCase();
function requestError(status: number, value?: unknown): Error {
  const code = errorCode(value);
  if (['INSUFFICIENTFUNDS', 'OVER_TRANSACTION_LIMIT'].includes(code))
    return new Error(
      'TomTom’s free allowance is exhausted. Planning stopped. Check your TomTom usage dashboard and wait for the allowance to renew.',
    );
  if (status === 429)
    return new Error(
      'TomTom’s free allowance or rate limit has been reached. Planning stopped. Check the TomTom usage dashboard before trying again.',
    );
  if (status === 401 || status === 403)
    return new Error(
      'TomTom rejected this request. Check the key’s allowed website and enabled Routing/Geocoding products.',
    );
  return new Error(
    `TomTom could not complete the request (HTTP ${status}). Planning stopped; try again later.`,
  );
}

export function normalizeTomTomBatch(value: any, expected: number): Edge[] {
  if (!Array.isArray(value?.batchItems) || value.batchItems.length !== expected)
    throw new Error('TomTom returned an incomplete route batch.');
  return value.batchItems.map((item: any): Edge => {
    if (item?.statusCode !== 200) {
      if (
        item?.statusCode === 400 &&
        ['NO_ROUTE_FOUND', 'MAP_MATCHING_FAILURE'].includes(errorCode(item.response))
      )
        return unavailable();
      throw requestError(item?.statusCode, item?.response);
    }
    const s = item.response?.routes?.[0]?.summary;
    if (!finite(s?.travelTimeInSeconds) || !finite(s?.lengthInMeters))
      throw new Error('TomTom returned an invalid travel estimate.');
    return {
      seconds: Math.ceil(s.travelTimeInSeconds),
      meters: s.lengthInMeters,
      reachable: true,
    };
  });
}

// Leg timestamps disambiguate whether the API summary includes a stop's pause.
// Verify the complete timeline, strip boarding, and let the independent checker add it once.
export function normalizeTomTomRoute(route: any, departureIso: string, pauses: number[]): Edge[] {
  const fail = () => {
    throw new Error('TomTom returned an incomplete or inconsistent multi-stop route.');
  };
  if (!Array.isArray(route?.legs) || route.legs.length !== pauses.length) return fail();
  const summaries = route.legs.map((l: any) => l?.summary);
  const start = Date.parse(departureIso) / 1000;
  const end = Date.parse(route.summary?.arrivalTime) / 1000;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isFinite(Date.parse(route.summary?.departureTime)) ||
    Math.abs(Date.parse(route.summary?.departureTime) / 1000 - start) > 1
  )
    return fail();
  const edges = summaries.map((s: any, i: number): Edge => {
    const departure = Date.parse(s?.departureTime) / 1000;
    const arrival = Date.parse(s?.arrivalTime) / 1000;
    const next =
      i + 1 < summaries.length ? Date.parse(summaries[i + 1]?.departureTime) / 1000 : end;
    const drive = next - departure - pauses[i];
    if (
      ![departure, arrival, next, drive].every(Number.isFinite) ||
      drive < 0 ||
      !finite(s?.lengthInMeters) ||
      !finite(s?.travelTimeInSeconds) ||
      (i === 0 && Math.abs(departure - start) > 1) ||
      (s.userDefinedPauseTimeInSeconds !== undefined &&
        s.userDefinedPauseTimeInSeconds !== pauses[i]) ||
      (Math.abs(s.travelTimeInSeconds - drive) > 1 &&
        Math.abs(s.travelTimeInSeconds - drive - pauses[i]) > 1) ||
      (Math.abs(arrival - departure - drive) > 1 && Math.abs(arrival - next) > 1)
    )
      return fail();
    return { seconds: drive, meters: s.lengthInMeters, reachable: true };
  });
  const elapsed =
    edges.reduce((sum: number, e: Edge) => sum + e.seconds, 0) + pauses.reduce((a, b) => a + b, 0);
  const meters = edges.reduce((sum: number, e: Edge) => sum + e.meters, 0);
  if (
    Math.abs(start + elapsed - end) > 1 ||
    !finite(route.summary?.lengthInMeters) ||
    Math.abs(meters - route.summary.lengthInMeters) > summaries.length
  )
    return fail();
  return edges;
}

// Never substitute straight waypoint connectors for a missing road shape.
function decodePolyline(
  encoded: string,
  precision: number,
): { latitude: number; longitude: number }[] | undefined {
  if (![5, 7].includes(precision) || encoded.length > 2000000) return;
  let offset = 0,
    latitude = 0,
    longitude = 0;
  const read = () => {
    let value = 0,
      shift = 0,
      byte: number;
    do {
      if (offset >= encoded.length || shift > 45) throw new Error('Invalid polyline');
      byte = encoded.charCodeAt(offset++) - 63;
      if (byte < 0 || byte > 63) throw new Error('Invalid polyline');
      value += (byte % 32) * 2 ** shift;
      shift += 5;
    } while (byte >= 32);
    return value % 2 ? -(value + 1) / 2 : value / 2;
  };
  const points = [];
  try {
    while (offset < encoded.length) {
      latitude += read();
      longitude += read();
      points.push({ latitude: latitude / 10 ** precision, longitude: longitude / 10 ** precision });
    }
    return points;
  } catch {
    return;
  }
}
export function normalizeTomTomGeometry(route: any): RouteAlternative['geometry'] {
  if (!Array.isArray(route?.legs) || !route.legs.length) return;
  const points: { lat: number; lng: number }[] = [];
  for (const leg of route.legs) {
    const legPoints =
      typeof leg?.encodedPolyline === 'string'
        ? decodePolyline(leg.encodedPolyline, leg.encodedPolylinePrecision)
        : leg?.points;
    if (!Array.isArray(legPoints) || legPoints.length < 2) return;
    for (const p of legPoints) {
      if (
        !Number.isFinite(p?.latitude) ||
        !Number.isFinite(p?.longitude) ||
        Math.abs(p.latitude) > 90 ||
        Math.abs(p.longitude) > 180
      )
        return;
      const next = { lat: p.latitude, lng: p.longitude };
      if (!points.length || !same(points.at(-1)!, next)) points.push(next);
    }
  }
  return points.length > 1 ? points : undefined;
}

function prepareRouteRequest({ locations, context, boardingSeconds }: RouteRequest) {
  locations.forEach(point);
  if (locations.length < 2 || !finite(boardingSeconds))
    throw new Error('Invalid route stops or boarding time.');
  const moving = locations.slice(1).flatMap((l, i) => (same(locations[i], l) ? [] : [i]));
  const departureIso = new Date(
    Date.parse(context.departureIso) + (moving[0] ?? 0) * boardingSeconds * 1000,
  ).toISOString();
  const pauses = moving.map((i, index) =>
    index + 1 < moving.length ? (moving[index + 1] - i) * boardingSeconds : 0,
  );
  const pathPoints = moving.length
    ? [locations[moving[0]], ...moving.map((i) => locations[i + 1])]
    : [];
  const params = new URLSearchParams({
    departAt: departureIso,
    traffic: 'true',
    travelMode: 'car',
    routeType: 'fastest',
    computeBestOrder: 'false',
    maxAlternatives: '2',
    routeRepresentation: 'encodedPolyline',
  });
  const item = {
    query: `/calculateRoute/${pathPoints.map((l) => `${l.lat},${l.lng}`).join(':')}/json?${params}`,
    post: { legs: pauses.map((pauseTimeInSeconds) => ({ routeStop: { pauseTimeInSeconds } })) },
  };
  return {
    key: JSON.stringify([locations.map(point), context, boardingSeconds]),
    item,
    moving,
    departureIso,
    pauses,
    locations,
  };
}

export class TomTomTravelProvider implements TravelProvider {
  readonly mode = 'tomtom' as const;
  private resolved = new Map<string, Pick<Location, 'lat' | 'lng'>>();
  private matrices = new Map<string, { at: number; edges: Edge[][] }>();
  private routes = new Map<string, { at: number; edges: Edge[][] }>();
  private completeRoutes = new Map<string, { at: number; alternatives: RouteAlternative[] }>();
  private batches = new Map<string, { at: number; edges: Edge[] }>();
  private pairs = new Map<string, { at: number; edge: Edge }>();
  private nextRequestAt = 0;
  private counts: TravelUsage = {
    geocodingRequests: 0,
    matrixSubmissions: 0,
    matrixUnits: 0,
    routingRequests: 0,
    cacheHits: 0,
  };
  constructor(
    private key: string,
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    if (!key.trim())
      throw new Error(
        'TomTom routing is not configured yet. The site owner needs to add the free TomTom key and restart the website.',
      );
  }
  usage(): TravelUsage {
    return { ...this.counts };
  }
  usageSince(before: TravelUsage): TravelUsage {
    return Object.fromEntries(
      Object.entries(this.counts).map(([key, count]) => [
        key,
        count - before[key as keyof TravelUsage],
      ]),
    ) as unknown as TravelUsage;
  }
  private async request(
    path: string,
    params: Record<string, string>,
    body: unknown,
    signal?: AbortSignal,
    timeoutMs = 20000,
  ): Promise<any> {
    checkAbort(signal);
    // Stay below the lowest standard 5-QPS limit, including status/download calls.
    const startAt = Math.max(Date.now(), this.nextRequestAt);
    this.nextRequestAt = startAt + 250;
    await pause(Math.max(0, startAt - Date.now()), signal);
    checkAbort(signal);
    const url = new URL(path, 'https://api.tomtom.com');
    url.search = new URLSearchParams({ ...params, key: this.key }).toString();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    try {
      const response = await this.fetcher(url.toString(), {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
      checkAbort(signal);
      // No automatic retries, paid-provider fallback, or raw response/URL in errors.
      if (!response.ok)
        throw requestError(response.status, await response.json().catch(() => undefined));
      try {
        return await response.json();
      } catch {
        throw new Error('TomTom returned an unreadable response.');
      }
    } catch (error) {
      checkAbort(signal);
      if (timeout.signal.aborted)
        throw new Error('TomTom took too long to respond. Planning stopped; try again later.');
      if (error instanceof Error && error.message.startsWith('TomTom')) throw error;
      throw new Error(
        'Unable to connect to TomTom. Check your connection and the key’s website restrictions.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
  async resolve(
    locations: Location[],
    signal?: AbortSignal,
    progress?: (completed: number, total: number) => void,
  ): Promise<Location[]> {
    const result: Location[] = new Array(locations.length);
    const pending = new Map<string, Promise<Pick<Location, 'lat' | 'lng'>>>();
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    let next = 0,
      completed = 0;
    progress?.(0, locations.length);
    const locate = async (location: Location): Promise<Location> => {
      checkAbort(combined);
      if (location.lat !== undefined || location.lng !== undefined) {
        point(location);
        return { ...location };
      }
      const address = /^maggie\s*mo$/i.test(location.address.trim())
        ? '5136 Margaret Morrison St, Pittsburgh, PA 15217'
        : location.address.trim();
      const cacheKey = address.toLowerCase().replace(/\s+/g, ' ');
      let position = this.resolved.get(cacheKey) ?? verifiedPublicPickups.get(cacheKey);
      if (position) this.counts.cacheHits++;
      else {
        if (!pending.has(cacheKey))
          pending.set(
            cacheKey,
            (async () => {
              this.counts.geocodingRequests++;
              const value = await this.request(
                `/search/2/geocode/${encodeURIComponent(address)}.json`,
                { countrySet: 'US', limit: '2' },
                undefined,
                combined,
              );
              // TomTom can return a precise address alongside a broad street suggestion.
              // Only pickup-level results compete; never use a city/street centroid.
              const candidates = Array.isArray(value?.results)
                ? value.results.filter((result: { type?: string }) =>
                    ['Point Address', 'Address Range', 'Cross Street'].includes(result?.type ?? ''),
                  )
                : [];
              if (candidates.length !== 1)
                throw new Error(
                  `Ambiguous or unresolved address: ${location.address}. Enter a full street address including Pittsburgh, PA and ZIP code in the sheet.`,
                );
              const resolved = {
                lat: candidates[0].position?.lat,
                lng: candidates[0].position?.lon,
              };
              point({ ...location, ...resolved });
              this.resolved.set(cacheKey, resolved);
              return resolved;
            })(),
          );
        position = await pending.get(cacheKey)!;
      }
      return { ...location, ...position };
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(3, locations.length) }, async () => {
          while (next < locations.length) {
            checkAbort(combined);
            const index = next++;
            result[index] = await locate(locations[index]);
            progress?.(++completed, locations.length);
          }
        }),
      );
    } catch (error) {
      abort.abort();
      throw error;
    }
    return result;
  }
  async matrix(
    locations: Location[],
    context: TravelContext,
    signal?: AbortSignal,
    scope?: MatrixScope,
    progress?: (completed: number, total: number) => void,
  ): Promise<Matrix> {
    checkAbort(signal);
    const points = locations.map(point);
    const key = JSON.stringify([points, context, scope]);
    const cached = this.matrices.get(key);
    if (cached && Date.now() - cached.at < 600000) {
      this.counts.cacheHits++;
      progress?.(1, 1);
      return { locations, edges: structuredClone(cached.edges), ...context, provider: this.mode };
    }
    const edges: Edge[][] = locations.map((a) =>
      locations.map((b) => (same(a, b) ? zero() : unavailable())),
    );
    const pairs: { from: number; to: number; query: string }[] = [];
    // Reuse individual directed legs after an attendance/driver edit changes the matrix.
    // Departure timestamps stay in each key, and traffic expires after ten minutes.
    const now = Date.now();
    for (const [key, value] of this.pairs) if (now - value.at >= 600000) this.pairs.delete(key);
    let reused = 0;
    let oldestEstimate = now;
    const params = new URLSearchParams({
      departAt: context.departureIso,
      traffic: 'true',
      routeType: 'fastest',
      travelMode: 'car',
      maxAlternatives: '0',
      routeRepresentation: 'summaryOnly',
    });
    for (let from = 0; from < locations.length; from++)
      for (let to = 0; to < locations.length; to++) {
        if (same(locations[from], locations[to])) continue;
        if (scope && (!scope.origins.includes(from) || !scope.destinations.includes(to))) continue;
        const path = [locations[from], locations[to]].map((l) => `${l.lat},${l.lng}`).join(':');
        const query = `/calculateRoute/${path}/json?${params}`;
        const cachedPair = this.pairs.get(query);
        if (cachedPair) {
          edges[from][to] = { ...cachedPair.edge };
          oldestEstimate = Math.min(oldestEstimate, cachedPair.at);
          reused++;
        } else pairs.push({ from, to, query });
      }
    if (reused) this.counts.cacheHits++;
    progress?.(0, pairs.length);
    for (let start = 0; start < pairs.length; start += ROUTING_BATCH_SIZE) {
      checkAbort(signal);
      const batch = pairs.slice(start, start + ROUTING_BATCH_SIZE);
      const body = { batchItems: batch.map(({ query }) => ({ query })) };
      const batchKey = JSON.stringify(body);
      const cachedBatch = this.batches.get(batchKey);
      let values: Edge[];
      if (cachedBatch && Date.now() - cachedBatch.at < 600000) {
        this.counts.cacheHits++;
        oldestEstimate = Math.min(oldestEstimate, cachedBatch.at);
        values = cachedBatch.edges;
      } else {
        this.counts.routingRequests += batch.length;
        const value = await this.request('/routing/1/batch/sync/json', {}, body, signal, 65000);
        // A batch can finish many Routing items together. Allow the shared Routing
        // rate window to clear before the next batch or complete-route request.
        this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + 1250);
        values = normalizeTomTomBatch(value, batch.length);
        // Completed batches survive cancellation of a later batch within this tab.
        this.batches.set(batchKey, { at: Date.now(), edges: structuredClone(values) });
      }
      batch.forEach(({ from, to, query }, i) => {
        edges[from][to] = { ...values[i] };
        this.pairs.set(query, {
          at: cachedBatch && Date.now() - cachedBatch.at < 600000 ? cachedBatch.at : Date.now(),
          edge: { ...values[i] },
        });
      });
      progress?.(start + batch.length, pairs.length);
    }
    this.matrices.set(key, { at: oldestEstimate, edges: structuredClone(edges) });
    return { locations, edges, ...context, provider: this.mode };
  }
  async routeBatch(
    requests: RouteRequest[],
    signal?: AbortSignal,
    progress?: (completed: number, total: number) => void,
  ): Promise<RouteAlternative[][]> {
    checkAbort(signal);
    const prepared = requests.map(prepareRouteRequest);
    const values = new Map<string, RouteAlternative[]>();
    const pending = new Map<string, ReturnType<typeof prepareRouteRequest>>();
    for (const request of prepared) {
      const cached = this.completeRoutes.get(request.key);
      if (!request.moving.length) {
        values.set(request.key, [{ edges: request.locations.slice(1).map(zero) }]);
      } else if (cached && Date.now() - cached.at < 600000) {
        this.counts.cacheHits++;
        values.set(request.key, cached.alternatives);
      } else pending.set(request.key, request);
    }
    const missing = [...pending.values()];
    const report = () =>
      progress?.(prepared.filter((r) => values.has(r.key)).length, requests.length);
    report();
    for (let start = 0; start < missing.length; start += ROUTING_BATCH_SIZE) {
      checkAbort(signal);
      const batch = missing.slice(start, start + ROUTING_BATCH_SIZE);
      this.counts.routingRequests += batch.length;
      const value = await this.request(
        '/routing/1/batch/sync/json',
        {},
        { batchItems: batch.map((r) => r.item) },
        signal,
        65000,
      );
      this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + 1250);
      if (!Array.isArray(value?.batchItems) || value.batchItems.length !== batch.length)
        throw new Error('TomTom returned an incomplete route batch.');
      for (const [i, request] of batch.entries()) {
        const item = value.batchItems[i];
        if (item?.statusCode !== 200) {
          if (
            item?.statusCode === 400 &&
            ['NO_ROUTE_FOUND', 'MAP_MATCHING_FAILURE'].includes(errorCode(item.response))
          ) {
            values.set(request.key, []);
            continue;
          }
          throw requestError(item?.statusCode, item?.response);
        }
        if (!Array.isArray(item.response?.routes) || !item.response.routes.length)
          throw new Error('TomTom could not find a complete route for these pickups.');
        const alternatives: RouteAlternative[] = item.response.routes.map((route: unknown) => {
          const movingEdges = normalizeTomTomRoute(route, request.departureIso, request.pauses);
          const edges = request.locations.slice(1).map(zero);
          request.moving.forEach((index, j) => {
            edges[index] = movingEdges[j];
          });
          return { edges, geometry: normalizeTomTomGeometry(route) };
        });
        this.completeRoutes.set(request.key, { at: Date.now(), alternatives });
        values.set(request.key, alternatives);
      }
      report();
    }
    checkAbort(signal);
    return prepared.map((r) => structuredClone(values.get(r.key)!));
  }
  async route(
    locations: Location[],
    context: TravelContext,
    boardingSeconds: number,
    signal?: AbortSignal,
  ): Promise<Edge[][]> {
    checkAbort(signal);
    locations.forEach(point);
    if (locations.length < 2 || !finite(boardingSeconds))
      throw new Error('Invalid route stops or boarding time.');
    const key = JSON.stringify([locations.map(point), context, boardingSeconds]);
    const cached = this.routes.get(key);
    if (cached && Date.now() - cached.at < 600000) {
      this.counts.cacheHits++;
      return structuredClone(cached.edges);
    }
    // A passenger at the driver's start still boards, but needs no duplicate API waypoint.
    const moving = locations.slice(1).flatMap((l, i) => (same(locations[i], l) ? [] : [i]));
    if (!moving.length) return [locations.slice(1).map(zero)];
    const departureIso = new Date(
      Date.parse(context.departureIso) + moving[0] * boardingSeconds * 1000,
    ).toISOString();
    const pauses = moving.map((i, index) =>
      index + 1 < moving.length ? (moving[index + 1] - i) * boardingSeconds : 0,
    );
    const pathPoints = [locations[moving[0]], ...moving.map((i) => locations[i + 1])];
    this.counts.routingRequests++;
    const value = await this.request(
      `/routing/1/calculateRoute/${pathPoints.map((l) => `${l.lat},${l.lng}`).join(':')}/json`,
      {
        departAt: departureIso,
        traffic: 'true',
        travelMode: 'car',
        routeType: 'fastest',
        computeBestOrder: 'false',
        maxAlternatives: '2',
        routeRepresentation: 'summaryOnly',
      },
      { legs: pauses.map((pauseTimeInSeconds) => ({ routeStop: { pauseTimeInSeconds } })) },
      signal,
    );
    if (!Array.isArray(value?.routes) || !value.routes.length)
      throw new Error('TomTom could not find a complete route for these pickups.');
    const alternatives = value.routes.map((route: unknown) => {
      const movingEdges = normalizeTomTomRoute(route, departureIso, pauses);
      const edges = locations.slice(1).map(zero);
      moving.forEach((originalIndex, i) => {
        edges[originalIndex] = movingEdges[i];
      });
      return edges;
    });
    this.routes.set(key, { at: Date.now(), edges: structuredClone(alternatives) });
    return alternatives;
  }
  async leg(
    origin: Location,
    destination: Location,
    context: TravelContext,
    signal?: AbortSignal,
  ): Promise<Edge> {
    const routes = await this.route([origin, destination], context, 0, signal);
    return routes[0][0];
  }
}
