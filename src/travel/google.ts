import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import type { Edge, Location, Matrix } from '../domain/types';
import type { TravelContext, TravelProvider } from './provider';
import { checkAbort, normalizeGoogleEdge } from './provider';
// No module-level SDK loading. This adapter is imported only by the explicit Google action.
let configured = false;
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    checkAbort(signal);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
async function bounded<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    checkAbort(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    try {
      const result = await Promise.race([
        request(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Google request timed out.')), 20000);
          onAbort = () => reject(new DOMException('Cancelled', 'AbortError'));
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      checkAbort(signal);
      return result;
    } catch (error) {
      const message = String(error);
      if (
        attempt >= 2 ||
        !/UNKNOWN_ERROR|NETWORK|fetch|OVER_QUERY_LIMIT|RESOURCE_EXHAUSTED/i.test(message) ||
        signal?.aborted
      )
        throw error;
      await wait(800 * 2 ** attempt, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
const point = (l: Location) =>
  l.lat !== undefined && l.lng !== undefined ? { lat: l.lat, lng: l.lng } : l.address;
export class GoogleMapsTravelProvider implements TravelProvider {
  readonly mode = 'google' as const;
  private cache = new Map<string, { at: number; value: Matrix }>();
  private resolved = new Map<string, Location>();
  private nextMatrixAt = 0;
  constructor(key: string) {
    if (!key)
      throw new Error('Configure a restricted VITE_GOOGLE_MAPS_API_KEY to use Google routing.');
    if (!configured) {
      setOptions({ key, v: 'weekly', language: 'en', region: 'US' });
      configured = true;
    }
  }
  async resolve(locations: Location[], signal?: AbortSignal): Promise<Location[]> {
    const { Geocoder } = await bounded(() => importLibrary('geocoding'), signal);
    const geocoder = new Geocoder();
    const result: Location[] = [];
    for (const location of locations) {
      checkAbort(signal);
      if (location.lat !== undefined) {
        result.push(location);
        continue;
      }
      const previous = this.resolved.get(location.key);
      if (previous) {
        result.push(previous);
        continue;
      }
      const response = await bounded(
        () => geocoder.geocode({ address: location.address, region: 'US' }),
        signal,
      );
      if (response.results.length !== 1 || response.results[0].partial_match)
        throw new Error(
          `Ambiguous/unresolved pickup or destination: ${location.address}. Review the address or provide confirmed coordinates.`,
        );
      const coordinates = response.results[0].geometry.location.toJSON();
      const value = { ...location, ...coordinates };
      this.resolved.set(location.key, value);
      result.push(value);
    }
    return result;
  }
  async matrix(
    locations: Location[],
    context: TravelContext,
    signal?: AbortSignal,
  ): Promise<Matrix> {
    const key = JSON.stringify([locations.map(point), context]);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.value;
    const { RouteMatrix } = await bounded(() => importLibrary('routes'), signal);
    const size = locations.length;
    const edges: Edge[][] = Array.from({ length: size }, () =>
      Array.from({ length: size }, () => ({
        seconds: Infinity,
        meters: Infinity,
        reachable: false,
      })),
    );
    // 10x10 stays within the strictest driving matrix limit (100 elements).
    for (let o = 0; o < size; o += 10)
      for (let d = 0; d < size; d += 10) {
        checkAbort(signal);
        const origins = locations.slice(o, o + 10).map(point),
          destinations = locations.slice(d, d + 10).map(point);
        await wait(Math.max(0, this.nextMatrixAt - Date.now()), signal);
        this.nextMatrixAt = Date.now() + origins.length * destinations.length * 25;
        const { matrix } = await bounded(
          () =>
            RouteMatrix.computeRouteMatrix({
              origins,
              destinations,
              travelMode: 'DRIVING',
              routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
              departureTime: new Date(context.departureIso),
              fields: ['durationMillis', 'distanceMeters', 'condition', 'error', 'fallbackInfo'],
            }),
          signal,
        );
        if (
          matrix.rows.length !== origins.length ||
          matrix.rows.some((row) => row.items.length !== destinations.length)
        )
          throw new Error('Google returned an incomplete route matrix.');
        matrix.rows.forEach((row, i) =>
          row.items.forEach((item, j) => {
            edges[o + i][d + j] =
              item.condition === 'ROUTE_EXISTS'
                ? normalizeGoogleEdge(item)
                : { seconds: Infinity, meters: Infinity, reachable: false };
          }),
        );
      }
    for (let i = 0; i < size; i++) edges[i][i] = { seconds: 0, meters: 0, reachable: true };
    const value: Matrix = { locations, edges, ...context, provider: this.mode };
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
  async leg(
    origin: Location,
    destination: Location,
    context: TravelContext,
    signal?: AbortSignal,
  ): Promise<Edge> {
    checkAbort(signal);
    if (origin.key === destination.key) return { seconds: 0, meters: 0, reachable: true };
    const { Route } = await bounded(() => importLibrary('routes'), signal);
    const response = await bounded(
      () =>
        Route.computeRoutes({
          origin: point(origin),
          destination: point(destination),
          travelMode: 'DRIVING',
          routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
          departureTime: new Date(context.departureIso),
          fields: ['durationMillis', 'distanceMeters'],
        }),
      signal,
    );
    if (!response.routes?.[0] || response.fallbackInfo)
      return { seconds: Infinity, meters: Infinity, reachable: false };
    return normalizeGoogleEdge(response.routes[0]);
  }
}
