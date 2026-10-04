import { expect, it, vi } from 'vitest';
import { makeDemo, simulateAvailability } from '../src/domain/scenarios';
import { makeUploadedTest } from '../src/domain/uploadedTest';
import { defaultSettings } from '../src/domain/types';
import { operationalIssues } from '../src/domain/validation';
import { prepareProblems } from '../src/domain/prepare';
import { MockTravelProvider } from '../src/travel/mock';
import { solveWeek } from '../src/planner/solve';
import { planJson, planCsv } from '../src/exports/plan';

function incomplete() {
  const data = makeDemo({ people: 10, driverCount: 3 });
  data.members[0].pickup_address = '';
  data.attendance[0].attending = 'unknown';
  data.attendance[1].transport_mode = 'unknown';
  data.attendance[7].attending = 'false';
  data.attendance[8].transport_mode = 'self';
  data.attendance[9].transport_mode = 'external';
  data.attendance[2].pickup_override = 'Reviewed sample override';
  data.attendance[2].ready_after = '04:10';
  return data;
}
it('runs an explicit upload-based simulation without altering inputs, merging labels, or dropping participants', async () => {
  const original = incomplete(),
    before = structuredClone(original);
  const ids = original.scenario!.candidateIds;
  const data = makeUploadedTest(original, ids, 42);
  expect(original).toEqual(before);
  expect(data.members.map((m) => m.member_id)).toEqual(original.members.map((m) => m.member_id));
  expect(data.attendance[0].attending).toBe('true');
  expect(data.attendance[1].transport_mode).toBe('carpool');
  expect(data.attendance[7].attending).toBe('false');
  expect(data.attendance[8].transport_mode).toBe('self');
  expect(data.attendance[9].transport_mode).toBe('external');
  expect(data.attendance[2].ready_after).toBe('04:10');
  expect(data.attendance[2].pickup_override).toBe('');
  expect(data.availability.every((v) => v.source === 'simulated')).toBe(true);
  expect(
    data.availability.filter((v) => v.available === 'true').every((v) => ids.includes(v.member_id)),
  ).toBe(true);
  const settings = { ...defaultSettings, dates: [...new Set(data.attendance.map((a) => a.date))] };
  expect(operationalIssues(original, settings).some((i) => i.severity === 'error')).toBe(true);
  expect(operationalIssues(data, settings)).toEqual([]);
  const problems = await prepareProblems(data, settings, new MockTravelProvider());
  const plan = solveWeek(problems, settings, data);
  expect(plan.verified).toBe(true);
  expect(plan.days.every((d) => d.status === 'feasible')).toBe(true);
  expect(plan.simulation).toBe(true);
  const snapshot = { plan, problems, data, revision: 0 };
  const exported = JSON.parse(planJson(snapshot));
  expect(
    exported.scenario.uploadedTest.assumptions.some(
      (a: { field: string }) => a.field === 'attending',
    ),
  ).toBe(true);
  expect(exported.driverInstructions.join('')).toContain('Do not use as real driving instructions');
  expect(planJson(snapshot)).not.toContain('https://www.google.com/maps');
  expect(planCsv(snapshot)).not.toContain('https://www.google.com/maps');
  expect(
    makeUploadedTest(
      {
        ...original,
        members: [...original.members].reverse(),
        attendance: [...original.attendance].reverse(),
        availability: [...original.availability].reverse(),
      },
      [...ids].reverse(),
      42,
    ),
  ).toEqual(data);
});
it('blocks live routing before provider calls and prevents losing assumptions through another scenario', async () => {
  const original = incomplete(),
    data = makeUploadedTest(original, original.scenario!.candidateIds, 42);
  const settings = { ...defaultSettings, mode: 'google' as const, dates: ['2026-10-05'] };
  expect(
    operationalIssues(data, settings).some((i) =>
      i.message.includes('Reupload reviewed input files'),
    ),
  ).toBe(true);
  const provider = new MockTravelProvider();
  const resolve = vi.spyOn(provider, 'resolve');
  await expect(prepareProblems(data, settings, provider)).rejects.toThrow('only use Mock');
  expect(resolve).not.toHaveBeenCalled();
  await expect(
    prepareProblems(
      data,
      { ...settings, mode: 'mock' },
      {
        ...provider,
        mode: 'google',
        resolve: provider.resolve,
        matrix: provider.matrix,
        leg: provider.leg,
      },
    ),
  ).rejects.toThrow('only use Mock');
  expect(() =>
    simulateAvailability(data, {
      kind: 'broad',
      candidateIds: original.scenario!.candidateIds,
      seed: 42,
    }),
  ).toThrow('Reupload reviewed input files');
  expect(() => makeUploadedTest(original, [], 42)).toThrow('Choose at least one');
});
it('still reports a real capacity contradiction in the test instead of fabricating extra drivers', async () => {
  const original = incomplete();
  const data = makeUploadedTest(original, [original.members[0].member_id], 42);
  const settings = { ...defaultSettings, dates: ['2026-10-05'] };
  const plan = solveWeek(
    await prepareProblems(data, settings, new MockTravelProvider()),
    settings,
    data,
  );
  expect(plan.days[0].status).toBe('capacity');
  expect(plan.verified).toBe(false);
});
