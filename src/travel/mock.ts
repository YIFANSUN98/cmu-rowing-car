import { hash } from '../domain/util';
import type { Edge, Location, Matrix } from '../domain/types';
import type { TravelContext, TravelProvider } from './provider';
import { checkAbort } from './provider';
export class MockTravelProvider implements TravelProvider {
  readonly mode = 'mock' as const;
  async resolve(locations: Location[], signal?: AbortSignal) {
    checkAbort(signal);
    return locations;
  }
  async leg(
    a: Location,
    b: Location,
    _context: TravelContext,
    signal?: AbortSignal,
  ): Promise<Edge> {
    checkAbort(signal);
    if (a.key === b.key) return { seconds: 0, meters: 0, reachable: true };
    const point = (l: Location) => {
      const h = hash(l.key);
      return [h % 4000, Math.floor(h / 4000) % 4000];
    };
    const p = point(a),
      q = point(b);
    const meters = Math.round(Math.hypot(p[0] - q[0], p[1] - q[1]) * 1.25) + 150;
    return {
      seconds: Math.round(meters / 9) + 30 + (hash(a.key + '>' + b.key) % 50),
      meters,
      reachable: true,
    };
  }
  async matrix(
    locations: Location[],
    context: TravelContext,
    signal?: AbortSignal,
  ): Promise<Matrix> {
    const edges: Edge[][] = [];
    for (const a of locations) {
      const row: Edge[] = [];
      for (const b of locations) row.push(await this.leg(a, b, context, signal));
      edges.push(row);
    }
    return { locations, edges, ...context, provider: this.mode };
  }
}
