import { it, expect } from 'vitest';
import { planCsv, planJson, instructions, navLink } from '../src/exports/plan';
import { tiny } from './helpers';
import { solveWeek } from '../src/planner/solve';
import { defaultSettings } from '../src/domain/types';
import { parseCsv } from '../src/importers/csv';
import { clockMinutes, zonedDate } from '../src/domain/util';
it('exports complete metadata, every stop, Simulation labels and individual navigation links', () => {
  const p = tiny(3, 1, 3);
  const plan = solveWeek([p], { ...defaultSettings, dates: [p.date] });
  const data = {
    schemaVersion: 1 as const,
    members: p.riders.map((r) => ({
      member_id: r.id,
      display_name: r.id === 'm0' ? '=HYPERLINK("fictitious")' : r.id,
      pickup_address: 'Fiction address',
    })),
    attendance: [],
    availability: [],
  };
  const snapshot = { plan, problems: [p], data, revision: 0 };
  const json = JSON.parse(planJson(snapshot));
  expect(json.simulation).toBe(true);
  expect(json.settings.seed).toBe(42);
  expect(json).not.toHaveProperty('matrix');
  const csv = parseCsv(planCsv(snapshot));
  expect(csv.rows.every((r) => r.mode === 'Simulation' && r.timezone === 'America/New_York')).toBe(
    true,
  );
  expect(csv.rows[0].driver.startsWith("'=")).toBe(true);
  expect(csv.rows.filter((r) => r.role === 'passenger')).toHaveLength(2);
  expect(csv.rows.every((r) => !r.time || /^\d{2}:\d{2}$/.test(r.time))).toBe(true);
  expect(instructions(plan.days[0].routes[0], p, data, true)).not.toMatch(/\b\d{2}:\d{2}:\d{2}\b/);
  expect(
    instructions(plan.days[0].routes[0], p, data, true).match(/https:\/\/www.google.com/g),
  ).toHaveLength(3);
  expect(navLink('12 Fiction & Lane', 'Mock Harbor')).toContain('Fiction%20%26%20Lane');
});

it('displays minutes without rounding a departure later or dropping seconds from routing timestamps', () => {
  expect(clockMinutes(5 * 3600 + 59.9)).toBe('05:00');
  expect(clockMinutes(6 * 3600)).toBe('06:00');
  expect(zonedDate('2026-10-05', 5 * 3600 + 45).toISOString()).toBe('2026-10-05T09:00:45.000Z');
});
