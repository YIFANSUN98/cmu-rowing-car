import { expect, test } from 'vitest';
import * as XLSX from 'xlsx';
import { tiny } from './helpers';
import { defaultSettings } from '../src/domain/types';
import { solveWeek } from '../src/planner/solve';
import { checkDay } from '../src/planner/check';
import { recheckPlan } from '../src/travel/recheck';
import { sharePlan, viewSnapshot, publishable } from '../src/sharing/plan';
import { cleanPlan } from '../src/sharing/schema';
import { createPlanWorkbook } from '../src/exports/excel';
const settings = { ...defaultSettings, uberFallback: true };
test('capacity overflow preserves every person, real drivers and four-person shared pickups', () => {
  const p = tiny(12, 1, 5);
  for (const r of p.riders.slice(1)) r.location = 1;
  const plan = solveWeek([p], { ...settings, dates: [p.date] });
  const day = plan.days[0];
  expect(plan.verified).toBe(true);
  expect(day.routes).toHaveLength(1);
  expect(day.rideShares?.map((r) => r.memberIds.length).sort()).toEqual([3, 4]);
  expect(day.rideShares?.flatMap((r) => r.memberIds)).not.toContain('m0');
  expect(checkDay(p, day)).toEqual([]);
  expect(plan.drivingSeconds).toBe(
    [...day.routes, ...day.rideShares!].reduce((n, r) => n + r.drivingSeconds, 0),
  );
  expect(
    checkDay(p, {
      ...day,
      rideShares: day.rideShares!.map((r) => ({ ...r, pickupTime: r.pickupTime + 60 })),
    }).length,
  ).toBeGreaterThan(0);
});
test('no available drivers still gets explicit bookable Uber groups, never invented drivers', () => {
  const p = tiny(5, 0);
  p.riders.forEach((r) => (r.location = 0));
  const plan = solveWeek([p], { ...settings, dates: [p.date] });
  expect(plan.verified).toBe(true);
  expect(plan.days[0].routes).toEqual([]);
  expect(plan.days[0].rideShares?.map((r) => r.memberIds.length)).toEqual([4, 1]);
  expect(checkDay(p, plan.days[0])).toEqual([]);
});
test('requested Uber is retained even with enough seats; ordinary attendance uses cars', () => {
  const p = tiny(4, 1, 5);
  const usual = solveWeek([p], settings);
  expect(usual.days[0].rideShares ?? []).toEqual([]);
  p.riders[3].requiresUber = true;
  const plan = solveWeek([p], settings);
  expect(plan.days[0].rideShares?.[0].memberIds).toEqual(['m3']);
  expect(checkDay(p, plan.days[0])).toEqual([]);
  p.riders[3].ready = p.deadline;
  expect(solveWeek([p], settings).verified).toBe(false);
});
test('live Uber check reschedules earlier; publication and Excel retain Uber and independent trips', async () => {
  const p = tiny(6, 1, 5);
  p.independent = ['own'];
  p.matrix.provider = 'tomtom';
  const plan = solveWeek([p], { ...settings, mode: 'tomtom', dates: [p.date] });
  const provider = {
    mode: 'tomtom' as const,
    resolve: async () => p.matrix.locations,
    matrix: async () => p.matrix,
    leg: async (a: any, b: any) => {
      const i = p.matrix.locations.indexOf(a),
        j = p.matrix.locations.indexOf(b);
      return { ...p.matrix.edges[i][j], seconds: p.matrix.edges[i][j].seconds + 60 };
    },
  };
  const checked = await recheckPlan(plan, [p], provider);
  expect(checked.verified).toBe(true);
  expect(checkDay(p, checked.days[0], true)).toEqual([]);
  const data = {
    schemaVersion: 1 as const,
    members: [
      ...p.riders.map((r) => ({
        member_id: r.id,
        display_name: r.id,
        pickup_address: 'Private original',
      })),
      { member_id: 'own', display_name: 'Independent Person', pickup_address: 'Private unused' },
    ],
    attendance: [],
    availability: [],
  };
  const snapshot = { revision: 0, data, problems: [p], plan: checked };
  expect(publishable(snapshot, false)).toBe(true);
  const shared = cleanPlan(sharePlan(snapshot));
  expect(shared.days[0].rideShares?.[0].names).toHaveLength(1);
  expect(JSON.stringify(shared)).not.toContain('Private');
  const restored = viewSnapshot({
    id: 'test',
    publishedAt: new Date().toISOString(),
    plan: shared,
  });
  expect(restored.plan.days[0].independent).toHaveLength(1);
  expect(restored.plan.days[0].rideShares?.[0].memberIds).toHaveLength(1);
  const book = createPlanWorkbook(restored),
    text = XLSX.utils.sheet_to_csv(book.Sheets[p.date]);
  expect(text).toContain('booking required');
  expect(text).toContain('Independent Person');
  const invalid = structuredClone(shared);
  invalid.days[0].rideShares![0].names = Array(5).fill('bad');
  expect(() => cleanPlan(invalid)).toThrow();
  checked.settings.comparisonDates = { [p.date]: '2026-10-12' };
  expect(publishable(snapshot, false)).toBe(false);
});
test('unreachable live Uber route makes the day incomplete rather than publishing old estimates', async () => {
  const p = tiny(2, 0);
  p.riders.forEach((r) => (r.location = 0));
  const plan = solveWeek([p], settings);
  const checked = await recheckPlan(plan, [p], {
    mode: 'tomtom',
    resolve: async () => [],
    matrix: async () => p.matrix,
    leg: async () => ({ reachable: false, seconds: Infinity, meters: Infinity }),
  });
  expect(checked.verified).toBe(false);
  expect(checked.days[0].unassigned).toHaveLength(2);
  expect(checked.days[0].rideShares).toEqual([]);
});

test('Uber candidate search shares a strict evaluation budget across alternatives', () => {
  const p = tiny(9, 1, 5);
  const plan = solveWeek([p], { ...settings, evaluationBudget: 2 });
  expect(plan.search.evaluations).toBeLessThanOrEqual(2);
  expect(plan.verified).toBe(false);
});
