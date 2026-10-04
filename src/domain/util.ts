import { ZONE } from './types';
export const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
export function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
export const stableId = (s: string, prefix = 'm') => `${prefix}-${hash(normalize(s)).toString(36)}`;
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffled<T>(xs: T[], random: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export const validTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const seconds = (s: string) => Number(s.slice(0, 2)) * 3600 + Number(s.slice(3, 5)) * 60;
export function clock(s: number): string {
  const t = Math.round(s);
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
// User-facing schedules use whole minutes; routing retains its exact seconds.
export const clockMinutes = (s: number): string => clock(Math.floor(s / 60) * 60).slice(0, 5);
export function validDate(s: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number(s.slice(0, 4)) >= 2000 &&
    !Number.isNaN(Date.parse(s)) &&
    new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) === s
  );
}
// Resolve wall time in the specified IANA zone, never the host timezone. Reject DST gaps.
export function zonedDate(date: string, timeSeconds: number): Date {
  if (!validDate(date) || !Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds >= 86400)
    throw new Error('Invalid local date/time.');
  const target = Date.parse(`${date}T${clock(timeSeconds)}Z`);
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let utc = target;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(utc)).map((p) => [p.type, p.value]),
    );
    const wall = Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    );
    const diff = target - wall;
    if (diff === 0) return new Date(utc);
    utc += diff;
  }
  throw new Error(`Local time does not exist in ${ZONE} (daylight saving change).`);
}
export function permutations<T>(xs: T[]): T[][] {
  if (xs.length < 2) return [xs];
  return xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map((p) => [x, ...p]));
}
