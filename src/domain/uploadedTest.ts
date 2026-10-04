import type { Dataset, ScenarioConfig } from './types';

// An explicit, reversible mock-only interpretation; never modifies source inputs.
export function makeUploadedTest(data: Dataset, candidateIds: string[], seed: number): Dataset {
  if (data.scenario?.uploadedTest)
    throw new Error('Reupload input files before preparing another test.');
  const candidates = [...new Set(candidateIds)].sort();
  if (!candidates.length) throw new Error('Choose at least one hypothetical driver for this test.');
  if (candidates.some((id) => !data.members.some((m) => m.member_id === id)))
    throw new Error('A selected test driver is missing from members.');
  if (!Number.isInteger(seed)) throw new Error('Use an integer seed.');
  const assumptions: NonNullable<ScenarioConfig['uploadedTest']>['assumptions'] = [];
  const record = (
    memberId: string,
    field: string,
    original: unknown,
    assumed: unknown,
    date?: string,
  ) => {
    assumptions.push({
      memberId,
      field,
      original: String(original ?? ''),
      assumed: String(assumed ?? ''),
      ...(date ? { date } : {}),
    });
  };
  const members = [...data.members]
    .sort((a, b) => a.member_id.localeCompare(b.member_id))
    .map((m, i) => {
      const pickup = `Fictitious test pickup ${i + 1}, Demo Harbor`;
      record(
        m.member_id,
        'pickup',
        JSON.stringify({
          address: m.pickup_address,
          lat: m.pickup_lat,
          lng: m.pickup_lng,
        }),
        pickup,
      );
      return {
        ...m,
        pickup_address: pickup,
        pickup_lat: undefined,
        pickup_lng: undefined,
        pickup_notes:
          'Fictitious pickup for this mock test. The source pickup remains unreviewed and unchanged.',
      };
    });
  const attendance = [...data.attendance]
    .sort((a, b) => (a.date + a.member_id).localeCompare(b.date + b.member_id))
    .map((a) => {
      if (a.attending === 'unknown') record(a.member_id, 'attending', 'unknown', 'true', a.date);
      const attending = a.attending === 'unknown' ? ('true' as const) : a.attending;
      const transport =
        attending === 'true' && a.transport_mode === 'unknown'
          ? ('carpool' as const)
          : a.transport_mode;
      if (transport !== a.transport_mode)
        record(a.member_id, 'transport_mode', a.transport_mode, transport, a.date);
      if (a.pickup_override)
        record(
          a.member_id,
          'pickup_override',
          a.pickup_override,
          'Use fictitious test pickup',
          a.date,
        );
      return {
        ...a,
        attending,
        transport_mode: transport,
        pickup_override: '',
        notes: [
          a.notes,
          'MOCK TEST: unknown attendance assumed present; unknown travel assumed carpool; labels kept separate.',
        ]
          .filter(Boolean)
          .join(' '),
      };
    });
  const availability = attendance.map((a) => {
    const original = data.availability.find(
      (v) => v.date === a.date && v.member_id === a.member_id,
    );
    const available =
      a.attending === 'true' && a.transport_mode === 'carpool' && candidates.includes(a.member_id);
    record(
      a.member_id,
      'driver_availability',
      JSON.stringify(original ?? { available: 'unknown' }),
      available
        ? 'Hypothetically available with 5 seats, including driver'
        : 'Not available in this test',
      a.date,
    );
    return {
      date: a.date,
      member_id: a.member_id,
      available: available ? ('true' as const) : ('false' as const),
      total_seats: available ? 5 : undefined,
      source: 'simulated' as const,
      earliest_departure: original?.earliest_departure,
      max_route_minutes: original?.max_route_minutes,
    };
  });
  return {
    schemaVersion: 1,
    members,
    attendance,
    availability,
    scenario: {
      kind: 'uploaded-test',
      seed,
      candidateIds: candidates,
      uploadedTest: { version: 1, assumptions },
    },
  };
}
