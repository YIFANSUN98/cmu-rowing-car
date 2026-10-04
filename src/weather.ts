// Public Pittsburgh observations; no member data or browser location is sent.
export const WEATHER_URL =
  'https://api.weather.gov/stations/KAGC/observations/latest?require_qc=true';
export const WEATHER_SOURCE = 'https://forecast.weather.gov/data/obhistory/KAGC.html';
export interface WeatherObservation {
  observedAt: string;
  description: string;
  temperatureC: number | null;
  windMph: number | null;
}
export function parseWeather(value: unknown): WeatherObservation {
  const p = (value as { properties?: Record<string, any> } | null)?.properties;
  if (!p || typeof p.timestamp !== 'string' || !Number.isFinite(Date.parse(p.timestamp)))
    throw new Error('Weather observation unavailable.');
  const temperature = p.temperature,
    wind = p.windSpeed;
  return {
    observedAt: p.timestamp,
    description:
      typeof p.textDescription === 'string' && p.textDescription.trim()
        ? p.textDescription
        : 'Conditions unavailable',
    temperatureC:
      temperature?.unitCode === 'wmoUnit:degC' &&
      typeof temperature.value === 'number' &&
      Number.isFinite(temperature.value)
        ? temperature.value
        : null,
    windMph:
      wind?.unitCode === 'wmoUnit:km_h-1' &&
      typeof wind.value === 'number' &&
      Number.isFinite(wind.value) &&
      wind.value >= 0
        ? wind.value / 1.609344
        : null,
  };
}
