import { expect, test } from 'vitest';
import { browserData } from './fixtures/browser';
import { defaultSettings } from '../src/domain/types';
import {
  createManualDraft,
  applyManualDraft,
  manualDraftErrors,
  moveManualPerson,
  setManualDriver,
  generateManualPlan,
  draftFromPublication,
} from '../src/planner/manual';
import type { RouteRequest, TravelProvider } from '../src/travel/provider';
import { checkDay } from '../src/planner/check';
import { sharePlan } from '../src/sharing/plan';
import { createPlanWorkbook } from '../src/exports/excel';
import * as XLSX from 'xlsx';

function setup() {
  const data = browserData(),
    date = data.attendance[0].date;
  data.members = data.members.slice(0, 4);
  const ids = data.members.map((m) => m.member_id);
  data.members.forEach((m, i) => {
    m.pickup_address = `${10 + i} Example Street, Pittsburgh, PA 15213`;
    m.pickup_lat = 40.43 + i * 0.001;
    m.pickup_lng = -79.94;
  });
  data.attendance = data.attendance
    .filter((a) => ids.includes(a.member_id))
    .map((a) => ({ ...a, attending: 'true', transport_mode: 'carpool' }));
  data.availability = data.availability
    .filter((a) => ids.includes(a.member_id))
    .map((a) => ({ ...a, available: 'false' }));
  const settings = {
    ...defaultSettings,
    dates: [date],
    mode: 'tomtom' as const,
    destinationConfirmed: true,
    uberFallback: true,
  };
  const draft = createManualDraft(data, settings);
  draft.days[0].cars = [
    {
      id: 'first',
      driverId: ids[0],
      passengerIds: [ids[3], ids[1], ids[2]],
      seats: 5,
      leaveAt: '',
    },
  ];
  const requests: RouteRequest[][] = [];
  const provider: TravelProvider = {
    mode: 'tomtom',
    resolve: async (locations) =>
      locations.map((l, i) => ({ ...l, lat: l.lat ?? 40.46 + i * 0.001, lng: l.lng ?? -79.9 })),
    matrix: async () => {
      throw Error('Manual generation must not request a matrix');
    },
    leg: async () => ({ seconds: 60, meters: 100, reachable: true }),
    routeBatch: async (batch) => {
      requests.push(structuredClone(batch));
      return batch.map((r) => [
        {
          edges: r.locations.slice(1).map(() => ({ seconds: 60, meters: 100, reachable: true })),
          geometry: r.locations.map((l) => ({ lat: l.lat!, lng: l.lng! })),
        },
      ]);
    },
  };
  return { data, settings, draft, provider, requests, ids };
}

test('manual generation promotes a replacement driver and preserves every chosen pickup order through final checks and exports', async () => {
  const { data, settings, draft, provider, requests, ids } = setup(),
    before = structuredClone(data);
  const generated = await generateManualPlan(data, draft, settings, provider);
  expect(data).toEqual(before);
  expect(generated.plan.verified).toBe(true);
  expect(generated.plan.manuallyEdited).toBe(true);
  expect(generated.plan.days[0].routes[0].stops.flatMap((s) => s.memberIds)).toEqual([
    ids[3],
    ids[1],
    ids[2],
  ]);
  expect(checkDay(generated.problems[0], generated.plan.days[0], true)).toEqual([]);
  expect(requests).toHaveLength(2);
  expect(requests.every((batch) => batch.length === 1)).toBe(true);
  expect(requests[0][0].locations).toEqual(requests[1][0].locations);
  const snapshot = { ...generated, revision: 1 },
    shared = sharePlan(snapshot);
  expect(shared.days[0].routes[0].stops.flatMap((s) => s.names)).toEqual(
    [3, 1, 2].map((i) => data.members[i].display_name),
  );
  const rows = XLSX.utils.sheet_to_json<string[]>(
    createPlanWorkbook(snapshot).Sheets[settings.dates[0]],
    { header: 1 },
  );
  expect(rows.slice(4, 7).map((r) => r[0])).toEqual(
    [3, 1, 2].map((i) => data.members[i].display_name),
  );
});

test('published arrangements reopen against the roster and reject ambiguous or missing identities', async () => {
  const { data, settings, draft, provider, ids } = setup();
  draft.days[0] = moveManualPerson(draft.days[0], ids[3], 'absent');
  const generated = await generateManualPlan(data, draft, settings, provider);
  const publication = {
    id: 'published',
    publishedAt: new Date().toISOString(),
    plan: sharePlan({ ...generated, revision: 1 }),
  };
  const restored = draftFromPublication(data, settings, publication);
  expect(restored.days[0].cars[0].passengerIds).toEqual([ids[1], ids[2]]);
  expect(restored.days[0].people.find((p) => p.id === ids[3])?.mode).toBe('absent');
  expect(manualDraftErrors(restored, data)).toEqual([]);
  data.members[1].display_name = 'Renamed person';
  expect(() => draftFromPublication(data, settings, publication)).toThrow(
    'matching saved Excel files',
  );
});

test('replacing a driver and moving riders cannot silently drop the previous driver or leave duplicate assignments', () => {
  const { data, draft, ids } = setup();
  let day = setManualDriver(draft.days[0], 'first', ids[1]);
  expect(day.cars[0].passengerIds).not.toContain(ids[1]);
  expect(manualDraftErrors({ ...draft, days: [day] }, data).join(' ')).toContain(
    `Assign ${data.members[0].display_name}`,
  );
  day = moveManualPerson(day, ids[0], 'absent');
  expect(manualDraftErrors({ ...draft, days: [day] }, data)).toEqual([]);
  day = moveManualPerson(day, ids[3], 'uber');
  expect(day.cars[0].passengerIds).not.toContain(ids[3]);
  day.cars[0].passengerIds.push(ids[2]);
  expect(manualDraftErrors({ ...draft, days: [day] }, data).join(' ')).toContain('more than once');
});

test('overfilled and incomplete arrangements are rejected before routing', async () => {
  const { data, settings, draft, provider, requests } = setup();
  draft.days[0].cars[0].seats = 3;
  await expect(generateManualPlan(data, draft, settings, provider)).rejects.toThrow(
    '4 people for 3 seats',
  );
  expect(requests).toHaveLength(0);
  draft.days[0].cars[0].seats = 5;
  draft.days[0].cars[0].driverId = '';
  expect(() => applyManualDraft(data, draft)).toThrow('Choose a driver');
});

test('explicit departures remain fixed and late routes are rejected without publishing a shifted time', async () => {
  const { data, settings, draft, provider } = setup();
  draft.days[0].cars[0].leaveAt = '04:45';
  const fixed = await generateManualPlan(data, draft, settings, provider);
  expect(fixed.plan.days[0].routes[0].departure).toBe(17100);
  expect(
    createManualDraft(fixed.data, settings, { ...fixed, revision: 1 }).days[0].cars[0].leaveAt,
  ).toBe('04:45');
  draft.days[0].cars[0].leaveAt = '05:14';
  await expect(generateManualPlan(data, draft, settings, provider)).rejects.toThrow(
    'Arrival misses',
  );
});

test('pickup edits, an absent member, and Uber / independent travel apply to only the edited dates', async () => {
  const { data, settings, draft, provider, ids } = setup();
  const old = structuredClone(data);
  data.attendance.push({ ...data.attendance[0], date: '2026-10-06' });
  draft.days[0] = moveManualPerson(draft.days[0], ids[1], 'uber');
  draft.days[0] = moveManualPerson(draft.days[0], ids[2], 'self');
  draft.days[0] = moveManualPerson(draft.days[0], ids[3], 'absent');
  draft.days[0].people[0].pickup = '500 Replacement St, Pittsburgh, PA 15213';
  const generated = await generateManualPlan(data, draft, settings, provider),
    day = generated.plan.days[0];
  expect(day.routes[0].passengerIds).toEqual([]);
  expect(day.rideShares?.[0].memberIds).toEqual([ids[1]]);
  expect(day.independent).toEqual([ids[2]]);
  expect(generated.data.attendance.find((a) => a.date === '2026-10-06')).toEqual(
    data.attendance.at(-1),
  );
  expect(generated.problems[0].matrix.locations[day.routes[0].start].address).toBe(
    '500 Replacement St, Pittsburgh, PA 15213',
  );
  expect(data.members).toEqual(old.members);
});

test('a live routing error or cancellation leaves the original draft untouched', async () => {
  const { data, settings, draft, provider } = setup();
  const before = structuredClone(draft);
  provider.routeBatch = async () => {
    throw Error('Routing unavailable');
  };
  await expect(generateManualPlan(data, draft, settings, provider)).rejects.toThrow(
    'Routing unavailable',
  );
  expect(draft).toEqual(before);
  const abort = new AbortController();
  abort.abort();
  await expect(generateManualPlan(data, draft, settings, provider, abort.signal)).rejects.toThrow();
  expect(draft).toEqual(before);
});

test('empty Excel pickup overrides keep member addresses and coordinate-only pickups remain usable', async () => {
  const { data, settings, provider } = setup();
  data.attendance.forEach((a) => (a.pickup_override = ''));
  const draft = createManualDraft(data, settings);
  expect(draft.days[0].people[1].pickup).toBe(data.members[1].pickup_address);
  data.members[1].pickup_address = '';
  const coords = createManualDraft(data, settings);
  coords.days[0].cars = [
    {
      id: 'car',
      driverId: data.members[0].member_id,
      passengerIds: data.members.slice(1).map((m) => m.member_id),
      seats: 5,
      leaveAt: '',
    },
  ];
  const generated = await generateManualPlan(data, coords, settings, provider);
  expect(generated.plan.verified).toBe(true);
});

test('late live traffic rejects a fixed departure instead of silently moving it earlier', async () => {
  const { data, settings, draft, provider, requests } = setup();
  draft.days[0].cars[0].leaveAt = '05:05';
  provider.routeBatch = async (batch) => {
    requests.push(batch);
    return batch.map((r) => [
      {
        edges: r.locations
          .slice(1)
          .map(() => ({ seconds: requests.length === 1 ? 60 : 120, meters: 100, reachable: true })),
      },
    ]);
  };
  await expect(generateManualPlan(data, draft, settings, provider)).rejects.toThrow(
    'Live timing verification failed',
  );
  expect(
    requests.every((batch) => batch.every((r) => r.context.departureIso.includes('T09:05:00'))),
  ).toBe(true);
});

test('out-of-order date entries keep each day’s own driver when generated and reopened', async () => {
  const { data, settings, draft, provider, ids } = setup();
  const second = structuredClone(draft.days[0]);
  second.date = '2026-10-06';
  second.cars[0].driverId = ids[1];
  second.cars[0].passengerIds = [ids[0], ids[2], ids[3]];
  draft.days.unshift(second);
  const generated = await generateManualPlan(
    data,
    draft,
    { ...settings, dates: draft.days.map((d) => d.date) },
    provider,
  );
  expect(generated.plan.days.map((d) => [d.date, d.routes[0].driverId])).toEqual([
    ['2026-10-05', ids[0]],
    ['2026-10-06', ids[1]],
  ]);
  const plan = sharePlan({ ...generated, revision: 1 });
  plan.days.reverse();
  const restored = draftFromPublication(data, settings, { id: 'test', publishedAt: '', plan });
  expect(restored.days.map((d) => [d.date, d.cars[0].driverId])).toEqual([
    ['2026-10-05', ids[0]],
    ['2026-10-06', ids[1]],
  ]);
});

test('an explicit early departure supports special practices without a hidden 04:00 limit', async () => {
  const { data, settings, draft, provider } = setup();
  draft.deadline = '04:15';
  draft.days[0].cars[0].leaveAt = '03:45';
  draft.days[0].people.forEach((p) => {
    p.readyAfter = '03:45';
  });
  const result = await generateManualPlan(data, draft, settings, provider);
  expect(result.plan.days[0].routes[0].departure).toBe(13500);
  expect(result.plan.settings.earliestDeparture).toBe('03:45');
  expect(result.plan.verified).toBe(true);
});
