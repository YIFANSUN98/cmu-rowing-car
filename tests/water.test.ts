import { expect, it } from 'vitest';
import { parseFlow } from '../src/water';
const reading = {
  monitoring_location_id: 'USGS-03049500',
  parameter_code: '00060',
  time: '2026-09-24T21:15:00Z',
  value: '21700',
  unit_of_measure: 'ft^3/s',
};
const payload = (...properties: Record<string, unknown>[]) => ({
  features: properties.map((p) => ({ properties: p })),
});

it('selects the newest discharge observation at the intended upstream gauge', () => {
  expect(
    parseFlow(
      payload({ ...reading, time: '2026-09-24T21:00:00Z', value: '20000' }, reading, {
        ...reading,
        monitoring_location_id: 'USGS-elsewhere',
        time: '2026-09-24T21:30:00Z',
        value: '25000',
      }),
    ),
  ).toEqual({ observedAt: reading.time, cubicFeetPerSecond: 21700 });
  expect(parseFlow(payload({ ...reading, value: '0' })).cubicFeetPerSecond).toBe(0);
});

it('does not invent a reading for missing, invalid or incorrectly measured data', () => {
  for (const value of [null, '', 'Ice', '-999999', '-1', Infinity])
    expect(() => parseFlow(payload({ ...reading, value }))).toThrow();
  for (const update of [{ parameter_code: '00065' }, { unit_of_measure: 'm' }, { time: 'invalid' }])
    expect(() => parseFlow(payload({ ...reading, ...update }))).toThrow();
  expect(() => parseFlow({ features: [] })).toThrow();
});
