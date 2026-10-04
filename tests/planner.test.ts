import { describe, it, expect } from 'vitest';
import { defaultSettings } from '../src/domain/types';
import { tiny } from './helpers';
import { optimizeCar } from '../src/planner/route';
import { checkDay } from '../src/planner/check';
import { dailyAlternatives, solveWeek } from '../src/planner/solve';
import { permutations } from '../src/domain/util';
import { makeDemo } from '../src/domain/scenarios';
import { prepareProblems } from '../src/domain/prepare';
import { MockTravelProvider } from '../src/travel/mock';
describe('daily search and independent constraints', () => {
  it('agrees with exhaustive driver/assignment/order reference in a tiny asymmetric case', () => {
    const p = tiny(4, 3, 3);
    p.matrix.edges[0][1].seconds = 550;
    p.matrix.edges[1][0].seconds = 80;
    let best = Infinity;
    for (let mask = 1; mask < 8; mask++) {
      const drivers = p.drivers.filter((_, i) => mask & (1 << i)),
        remaining = p.riders.filter((r) => !drivers.some((d) => d.id === r.id));
      const buckets = drivers.map(() => [] as number[]);
      const enumerate = (i: number) => {
        if (i === remaining.length) {
          let total = 0;
          for (let c = 0; c < drivers.length; c++) {
            if (buckets[c].length >= drivers[c].seats) return;
            let cost = Infinity;
            for (const order of permutations(buckets[c])) {
              const points = [drivers[c].start, ...order, p.destination];
              let seconds = 0;
              for (let j = 0; j < points.length - 1; j++)
                seconds += p.matrix.edges[points[j]][points[j + 1]].seconds;
              cost = Math.min(cost, seconds);
            }
            total += cost;
          }
          best = Math.min(best, total);
          return;
        }
        for (let c = 0; c < drivers.length; c++) {
          buckets[c].push(remaining[i].location);
          enumerate(i + 1);
          buckets[c].pop();
        }
      };
      enumerate(0);
    }
    const result = dailyAlternatives(p, defaultSettings);
    expect(result.plan.status).toBe('feasible');
    expect(result.alternatives[0].seconds).toBe(best);
    expect(checkDay(p, result.plan)).toEqual([]);
  });
  it('carries an available but unselected driver as a passenger, never twice', () => {
    const p = tiny(3, 2, 3);
    const result = dailyAlternatives(p, defaultSettings).plan;
    expect(result.routes).toHaveLength(1);
    const r = result.routes[0];
    expect(r.passengerIds).toContain(p.drivers.find((d) => d.id !== r.driverId)!.id);
    expect(checkDay(p, result)).toEqual([]);
    expect(checkDay(p, { routes: [r, { ...r }] }).some((e) => e.includes('exactly once'))).toBe(
      true,
    );
  });
  it('shares one stop, keeps each rider as one seat, and handles directed edges', () => {
    const p = tiny(4, 1, 4);
    p.riders[2].location = 1;
    p.riders[3].location = 1;
    p.matrix.edges[0][1].seconds = 333;
    p.matrix.edges[1][0].seconds = 999;
    const route = optimizeCar(p, p.drivers[0], ['m1', 'm2', 'm3'])!;
    expect(route.stops).toHaveLength(1);
    expect(route.stops[0].occupancy).toBe(4);
    expect(route.drivingSeconds).toBe(333 + p.matrix.edges[1][4].seconds);
    expect(route.durationSeconds - route.drivingSeconds).toBe(60);
    expect(checkDay(p, { routes: [route] })).toEqual([]);
  });
  it('optimizes pickup order exactly and does not turn unreachable edges into zero', () => {
    const p = tiny(3, 1, 3);
    p.matrix.edges[0][1].seconds = 999;
    p.matrix.edges[0][2].seconds = 10;
    p.matrix.edges[2][1].seconds = 10;
    const r = optimizeCar(p, p.drivers[0], ['m1', 'm2'])!;
    expect(r.stops.map((s) => s.memberIds[0])).toEqual(['m2', 'm1']);
    p.matrix.edges.forEach((row) => {
      row[p.destination] = { seconds: Infinity, meters: Infinity, reachable: false };
    });
    expect(dailyAlternatives(p, defaultSettings).plan.status).toBe('timing');
  });
  it('enforces readiness, service, earliest departure, max duration and buffered arrival', () => {
    const p = tiny(3, 1, 3);
    const r = optimizeCar(p, p.drivers[0], ['m1', 'm2'])!;
    expect(r.arrival).toBe(18600);
    expect(r.durationSeconds - r.drivingSeconds).toBe(120);
    p.riders[1].ready = 18600;
    expect(optimizeCar(p, p.drivers[0], ['m1', 'm2'])).toBeNull();
    p.riders[1].ready = 14400;
    p.drivers[0].earliest = 18600;
    expect(optimizeCar(p, p.drivers[0], ['m1', 'm2'])).toBeNull();
    p.drivers[0].earliest = 14400;
    p.drivers[0].maxSeconds = 30;
    expect(optimizeCar(p, p.drivers[0], ['m1', 'm2'])).toBeNull();
  });
  it('reports current capacity contradictions and treats bounded search as inconclusive', () => {
    const p = tiny(4, 0);
    p.unknownAvailability = ['m1'];
    const zero = dailyAlternatives(p, defaultSettings).plan;
    expect(zero.status).toBe('capacity');
    expect(zero.unassigned).toHaveLength(4);
    expect(zero.messages.join('')).toContain('unknown');
    const larger = tiny(9, 3, 4);
    const limited = dailyAlternatives(larger, { ...defaultSettings, evaluationBudget: 1 }).plan;
    expect(limited.status).toBe('search-exhausted');
    expect(limited.budgetExhausted).toBe(true);
    expect(limited.messages.join('')).toContain('not proof');
  });
  it('retains a feasible result when later budget expires', () => {
    const p = tiny(3, 3, 3);
    const result = dailyAlternatives(p, { ...defaultSettings, evaluationBudget: 8 });
    expect(result.plan.status).toBe('feasible');
    expect(checkDay(p, result.plan)).toEqual([]);
  });
  it('detects tampered endpoints, times, passenger lists, totals and eligibility', () => {
    const p = tiny(3, 1, 3),
      r = optimizeCar(p, p.drivers[0], ['m1', 'm2'])!;
    for (const change of [
      { start: 99 },
      { arrival: 19000 },
      { seats: 6 },
      { passengerIds: [] },
      { drivingSeconds: 1 },
      { driverId: 'invented' },
    ])
      expect(checkDay(p, { routes: [{ ...r, ...change }] }).length).toBeGreaterThan(0);
  });
});
describe('weekly choice', () => {
  it('changes earlier-day choices for availability-adjusted fairness within allowance', () => {
    const days = Array.from({ length: 3 }, (_, i) => {
      const p = tiny(3, i === 2 ? 1 : 2, 3);
      p.date = `2026-10-0${5 + i}`;
      p.matrix.edges.forEach((row, r) =>
        row.forEach((e, c) => {
          e.seconds = r === c ? 0 : 100;
          e.meters = r === c ? 0 : 1000;
        }),
      );
      return p;
    });
    const result = solveWeek(days, {
      ...defaultSettings,
      dates: days.map((p) => p.date),
      fairnessAllowance: 0.1,
    });
    expect(result.verified).toBe(true);
    expect(result.usage.find((u) => u.id === 'm0')?.daysDriven).toBe(2);
    expect(result.usage.find((u) => u.id === 'm1')?.daysDriven).toBe(1);
    expect(result.drivingSeconds).toBeLessThanOrEqual(result.baselineDrivingSeconds * 1.1);
    expect(result.days.every((d) => d.routes.length === 1)).toBe(true);
    expect(result.fairnessScore).toBeCloseTo(0.08);
  });
  it('reproduces row-reordered inputs and excludes self/external/false drivers', async () => {
    const data = makeDemo({ people: 10, driverCount: 3 });
    const s = { ...defaultSettings, dates: [data.attendance[0].date] };
    data.attendance.find((a) => a.member_id === 'demo-001')!.transport_mode = 'self';
    const a = await prepareProblems(data, s, new MockTravelProvider());
    const b = await prepareProblems(
      {
        ...data,
        members: [...data.members].reverse(),
        attendance: [...data.attendance].reverse(),
        availability: [...data.availability].reverse(),
      },
      s,
      new MockTravelProvider(),
    );
    expect(a[0].drivers.some((d) => d.id === 'demo-001')).toBe(false);
    expect(solveWeek(a, s, data).days).toEqual(solveWeek(b, s, data).days);
  });
  it('marks simulated availability even when routing mode is google', () => {
    const p = tiny(3, 1, 3);
    const data = makeDemo();
    const result = solveWeek(
      [p],
      { ...defaultSettings, mode: 'google', dates: ['2026-10-05'] },
      data,
    );
    expect(result.simulation).toBe(true);
  });
});
