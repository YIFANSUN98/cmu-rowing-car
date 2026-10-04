import { expect, test } from 'vitest';
import { tiny } from './helpers';
import { solveWeek } from '../src/planner/solve';
import { defaultSettings } from '../src/domain/types';
import { publishable, sharePlan, viewSnapshot } from '../src/sharing/plan';
import { instructions, type Snapshot } from '../src/exports/plan';

function checked(): Snapshot {
  const problem = tiny(3, 1, 5);
  problem.matrix.provider = 'tomtom';
  const plan = solveWeek([problem], { ...defaultSettings, dates: [problem.date], mode: 'tomtom' });
  plan.simulation = false;
  plan.verified = true;
  plan.liveRechecked = true;
  return {
    revision: 0,
    problems: [problem],
    plan,
    data: {
      schemaVersion: 1,
      attendance: [],
      availability: [],
      members: [
        ...problem.riders.map((r) => ({
          member_id: r.id,
          display_name: `Name ${r.id}`,
          pickup_address: 'Private input address',
          pickup_notes: 'Private note',
        })),
        { member_id: 'unused', display_name: 'Unused member', pickup_address: 'Unneeded address' },
      ],
    },
  };
}

test('sharing keeps route order/times and instructions while omitting unused input data', () => {
  const snapshot = checked(),
    plan = sharePlan(snapshot);
  const serialized = JSON.stringify(plan);
  expect(serialized).not.toMatch(
    /Unused member|Unneeded address|Private note|Private input address|member_id|attendance|availability|edges/,
  );
  const restored = viewSnapshot({ id: 'publication', publishedAt: '2026-09-24T12:00:00Z', plan });
  const originalRoute = snapshot.plan.days[0].routes[0],
    restoredRoute = restored.plan.days[0].routes[0];
  expect(instructions(restoredRoute, restored.problems[0], restored.data, false)).toBe(
    instructions(originalRoute, snapshot.problems[0], snapshot.data, false),
  );
  expect(restoredRoute.departure).toBe(originalRoute.departure);
  expect(restoredRoute.stops.map((s) => s.arrival)).toEqual(
    originalRoute.stops.map((s) => s.arrival),
  );
});

test('publication excludes stale, unchecked, simulated, and incomplete drafts', () => {
  expect(publishable(checked(), false)).toBe(true);
  expect(publishable(checked(), true)).toBe(false);
  for (const change of [
    (s: Snapshot) => {
      s.plan.liveRechecked = false;
    },
    (s: Snapshot) => {
      s.plan.verified = false;
    },
    (s: Snapshot) => {
      s.plan.simulation = true;
    },
    (s: Snapshot) => {
      s.plan.days[0].status = 'capacity';
    },
    (s: Snapshot) => {
      s.plan.days[0].unassigned.push('missing');
    },
    (s: Snapshot) => {
      s.plan.days[0].unresolved.push('unknown');
    },
    (s: Snapshot) => {
      s.data.scenario = { seed: 1, kind: 'example', candidateIds: [] };
    },
  ]) {
    const snapshot = checked();
    change(snapshot);
    expect(publishable(snapshot, false)).toBe(false);
    expect(() => sharePlan(snapshot)).toThrow();
  }
});
