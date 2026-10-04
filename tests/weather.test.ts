import { expect, it } from 'vitest';
import { parseWeather } from '../src/weather';

it('reads observation units and preserves missing readings instead of displaying zero', () => {
  const properties = {
    timestamp: '2026-09-24T18:25:00Z',
    textDescription: 'Clear',
    temperature: { value: 17, unitCode: 'wmoUnit:degC' },
    windSpeed: { value: 16.09344, unitCode: 'wmoUnit:km_h-1' },
  };
  expect(parseWeather({ properties })).toMatchObject({
    temperatureC: 17,
    windMph: 10,
    description: 'Clear',
  });
  expect(
    parseWeather({
      properties: { ...properties, temperature: { value: null }, windSpeed: { value: null } },
    }),
  ).toMatchObject({ temperatureC: null, windMph: null });
  expect(() => parseWeather({ properties: { timestamp: 'unavailable' } })).toThrow();
});
