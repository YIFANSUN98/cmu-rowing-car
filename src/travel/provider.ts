import type { Edge, Location, Matrix, TravelMode } from '../domain/types';
export interface TravelContext {
  date: string;
  departureIso: string;
}
export interface RouteRequest {
  locations: Location[];
  context: TravelContext;
  boardingSeconds: number;
}
export interface RouteAlternative {
  edges: Edge[];
  geometry?: { lat: number; lng: number }[];
}
export interface MatrixScope {
  origins: number[];
  destinations: number[];
}
export interface TravelProvider {
  readonly mode: TravelMode;
  resolve(
    locations: Location[],
    signal?: AbortSignal,
    progress?: (completed: number, total: number) => void,
  ): Promise<Location[]>;
  matrix(
    locations: Location[],
    context: TravelContext,
    signal?: AbortSignal,
    scope?: MatrixScope,
    progress?: (completed: number, total: number) => void,
  ): Promise<Matrix>;
  leg(
    origin: Location,
    destination: Location,
    context: TravelContext,
    signal?: AbortSignal,
  ): Promise<Edge>;
  // Complete fixed-order routes, including traffic after boarding at intermediate stops.
  // Returned alternatives contain driving-only edges; the planner adds boarding once.
  route?(
    locations: Location[],
    context: TravelContext,
    boardingSeconds: number,
    signal?: AbortSignal,
  ): Promise<Edge[][]>;
  // Results correspond to requests in order; each keeps its own date and boarding time.
  routeBatch?(
    requests: RouteRequest[],
    signal?: AbortSignal,
    progress?: (completed: number, total: number) => void,
  ): Promise<RouteAlternative[][]>;
}
export function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Calculation cancelled.', 'AbortError');
}
export function normalizeGoogleEdge(value: {
  durationMillis?: number | null;
  distanceMeters?: number | null;
  condition?: string | null;
  error?: unknown;
  fallbackInfo?: unknown;
}): Edge {
  const valid =
    value.condition !== 'ROUTE_NOT_FOUND' &&
    !value.error &&
    !value.fallbackInfo &&
    Number.isFinite(value.durationMillis) &&
    Number.isFinite(value.distanceMeters) &&
    value.durationMillis! >= 0 &&
    value.distanceMeters! >= 0;
  return valid
    ? {
        seconds: Math.ceil(value.durationMillis! / 1000),
        meters: value.distanceMeters!,
        reachable: true,
      }
    : { seconds: Infinity, meters: Infinity, reachable: false };
}
