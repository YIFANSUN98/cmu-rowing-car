import type { Settings } from './types';
import { seconds, validDate, validTime, zonedDate } from './util';

// Keep historical attendance dates; only estimate requests use future matching weekdays.
export function withComparisonDates(settings: Settings, now = Date.now()): Settings {
  const { comparisonDates: _, ...base } = settings;
  if (
    base.mode === 'mock' ||
    !base.dates.length ||
    base.dates.some((d) => !validDate(d)) ||
    !validTime(base.earliestDeparture)
  )
    return base;
  const first = [...base.dates].sort()[0],
    time = seconds(base.earliestDeparture);
  let weeks = 0;
  const shift = (date: string) =>
    new Date(Date.parse(date + 'T12:00:00Z') + weeks * 7 * 86400000).toISOString().slice(0, 10);
  while (zonedDate(shift(first), time).getTime() <= now) weeks++;
  return weeks
    ? {
        ...base,
        comparisonDates: Object.fromEntries(base.dates.map((date) => [date, shift(date)])),
      }
    : base;
}
