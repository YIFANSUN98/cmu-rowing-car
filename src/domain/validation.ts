import type { Dataset, Issue, Settings, Attendance, Availability } from './types';
import { SCHEMA_VERSION, ZONE } from './types';
import { parseCsv } from '../importers/csv';
import { validDate, validTime, seconds, zonedDate } from './util';
export type FileKind = 'members' | 'attendance' | 'availability';
export const headers: Record<FileKind, string[]> = {
  members: [
    'member_id',
    'display_name',
    'pickup_address',
    'pickup_lat',
    'pickup_lng',
    'pickup_notes',
  ],
  attendance: [
    'date',
    'member_id',
    'attending',
    'transport_mode',
    'pickup_override',
    'ready_after',
    'notes',
  ],
  availability: [
    'date',
    'member_id',
    'available',
    'total_seats',
    'source',
    'start_address',
    'earliest_departure',
    'max_route_minutes',
  ],
};
export const requiredColumns: Record<FileKind, number> = {
  members: 3,
  attendance: 4,
  availability: 5,
};
export function parseInput(
  kind: FileKind,
  text: string,
): { rows: Record<string, string>[]; issues: Issue[]; rowNumbers: number[] } {
  const file = kind === 'availability' ? 'driver_availability.csv' : kind + '.csv';
  try {
    const t = parseCsv(text);
    const issues: Issue[] = [];
    for (const h of headers[kind].slice(0, requiredColumns[kind]))
      if (!t.headers.includes(h))
        issues.push({
          file,
          row: 1,
          field: h,
          severity: 'error',
          message: `Missing column ${h}. Download the template.`,
        });
    return { ...t, issues };
  } catch (e) {
    return {
      rows: [],
      rowNumbers: [],
      issues: [{ file, severity: 'error', message: String((e as Error).message) }],
    };
  }
}
export function parseDataset(texts: Record<FileKind, string>): { data: Dataset; issues: Issue[] } {
  const issues: Issue[] = [];
  const data: Dataset = {
    schemaVersion: SCHEMA_VERSION,
    members: [],
    attendance: [],
    availability: [],
  };
  const sourceRows: Record<FileKind, number[]> = { members: [], attendance: [], availability: [] };
  for (const kind of ['members', 'attendance', 'availability'] as const) {
    const p = parseInput(kind, texts[kind]);
    sourceRows[kind] = p.rowNumbers;
    issues.push(...p.issues);
    if (p.issues.some((x) => x.severity === 'error')) continue;
    const seen = new Set<string>();
    p.rows.forEach((r, i) => {
      const file = kind === 'availability' ? 'driver_availability.csv' : kind + '.csv';
      const issue = (field: string, message: string) =>
        issues.push({
          file,
          row: p.rowNumbers[i],
          field,
          message,
          severity: 'error',
          date: r.date,
        });
      const en = (field: string, values: string[]) => {
        if (!values.includes(r[field])) issue(field, `Use ${values.join(' | ')}.`);
      };
      if (!r.member_id) issue('member_id', 'A stable member_id is required.');
      const key = kind === 'members' ? r.member_id : r.date + '|' + r.member_id;
      if (seen.has(key))
        issue('member_id', 'Duplicate person record. Keep one reviewed row per person/date.');
      seen.add(key);
      if (kind !== 'members' && !validDate(r.date))
        issue('date', 'Use a real calendar date in YYYY-MM-DD format.');
      if (kind === 'members') {
        if (!r.display_name) issue('display_name', 'Display name is required.');
        const hasLat = Boolean(r.pickup_lat),
          hasLng = Boolean(r.pickup_lng);
        if (hasLat !== hasLng)
          issue('pickup_lat', 'Provide both latitude and longitude, or leave both blank.');
        for (const [f, max] of [
          ['pickup_lat', 90],
          ['pickup_lng', 180],
        ] as const)
          if (r[f] && (!Number.isFinite(Number(r[f])) || Math.abs(Number(r[f])) > max))
            issue(f, `Must be a finite number between -${max} and ${max}.`);
        data.members.push({
          member_id: r.member_id,
          display_name: r.display_name,
          pickup_address: r.pickup_address,
          pickup_lat: hasLat ? Number(r.pickup_lat) : undefined,
          pickup_lng: hasLng ? Number(r.pickup_lng) : undefined,
          pickup_notes: r.pickup_notes,
        });
      } else if (kind === 'attendance') {
        en('attending', ['true', 'false', 'unknown']);
        en('transport_mode', ['carpool', 'self', 'external', 'uber', 'unknown']);
        if (r.ready_after && !validTime(r.ready_after))
          issue('ready_after', 'Use HH:MM in America/New_York.');
        data.attendance.push({
          ...Object.fromEntries(headers.attendance.map((h) => [h, r[h] ?? ''])),
        } as unknown as Attendance);
      } else {
        en('available', ['true', 'false', 'unknown']);
        en('source', ['confirmed', 'simulated']);
        if (
          (r.available === 'true' || r.total_seats) &&
          (!/^\d+$/.test(r.total_seats) || Number(r.total_seats) < 1 || Number(r.total_seats) > 5)
        )
          issue('total_seats', 'Provide an integer 1–5 including the driver.');
        if (r.earliest_departure && !validTime(r.earliest_departure))
          issue('earliest_departure', 'Use HH:MM in America/New_York.');
        if (
          r.max_route_minutes &&
          (!Number.isFinite(Number(r.max_route_minutes)) || Number(r.max_route_minutes) <= 0)
        )
          issue('max_route_minutes', 'Must be a positive number.');
        data.availability.push({
          date: r.date,
          member_id: r.member_id,
          available: r.available as Availability['available'],
          source: r.source as Availability['source'],
          total_seats: r.total_seats ? Number(r.total_seats) : undefined,
          start_address: r.start_address,
          earliest_departure: r.earliest_departure,
          max_route_minutes: r.max_route_minutes ? Number(r.max_route_minutes) : undefined,
        });
      }
    });
  }
  const ids = new Set(data.members.map((m) => m.member_id));
  for (const kind of ['attendance', 'availability'] as const)
    data[kind].forEach((r, i) => {
      if (!ids.has(r.member_id))
        issues.push({
          file: kind === 'availability' ? 'driver_availability.csv' : 'attendance.csv',
          row: sourceRows[kind][i],
          field: 'member_id',
          date: r.date,
          severity: 'error',
          message: `Unknown member_id “${r.member_id}”. Add the member or correct this reference.`,
        });
    });
  data.members.sort((a, b) => a.member_id.localeCompare(b.member_id));
  data.attendance.sort((a, b) => (a.date + a.member_id).localeCompare(b.date + b.member_id));
  data.availability.sort((a, b) => (a.date + a.member_id).localeCompare(b.date + b.member_id));
  return { data, issues };
}
export function operationalIssues(data: Dataset, s: Settings): Issue[] {
  const issues: Issue[] = [];
  const add = (
    message: string,
    date?: string,
    field?: string,
    severity: Issue['severity'] = 'error',
    record?: Pick<Issue, 'inputKind' | 'memberId' | 'memberName'>,
  ) =>
    issues.push({
      file: record?.inputKind
        ? record.inputKind === 'availability'
          ? 'driver_availability.csv'
          : `${record.inputKind}.csv`
        : 'planning',
      message,
      date,
      field,
      severity,
      ...record,
    });
  if (data.scenario?.uploadedTest && s.mode !== 'mock')
    add(
      'This uploaded-data test uses fictitious pickups and assumptions. Reupload reviewed input files before using online routing.',
    );
  if (s.timezone !== ZONE) add('Timezone must be America/New_York.');
  if (
    !s.dates.length ||
    s.dates.length > 7 ||
    new Set(s.dates).size !== s.dates.length ||
    s.dates.some((d) => !validDate(d))
  )
    add('Select 1–7 unique calendar dates.');
  if (!validTime(s.deadline) || !validTime(s.earliestDeparture))
    add('Use valid HH:MM planning times.');
  for (const [key, min, max] of [
    ['bufferMinutes', 0, 120],
    ['boardingSeconds', 0, 600],
    ['maxRouteMinutes', 1, 180],
    ['fairnessAllowance', 0, 1],
    ['subsetLimit', 1, 512],
    ['evaluationBudget', 1, 1000000],
    ['beamWidth', 1, 256],
  ] as const)
    if (!Number.isFinite(s[key]) || s[key] < min || s[key] > max)
      add(`${key} must be between ${min} and ${max}.`);
  if (!Number.isInteger(s.seed)) add('Seed must be an integer.');
  if (seconds(s.deadline) - s.bufferMinutes * 60 <= seconds(s.earliestDeparture))
    add(
      `Arrival deadline must be after ${s.earliestDeparture}${s.bufferMinutes ? ' plus the arrival buffer' : ''}.`,
    );
  if (s.mode !== 'mock' && (!s.destination.trim() || !s.destinationConfirmed))
    add('Enter and confirm the actual boathouse destination before calculating online.');
  for (const date of s.dates) {
    try {
      const estimateDate = s.comparisonDates?.[date] ?? date;
      if (!validDate(estimateDate)) {
        add('Invalid comparison estimate date.', date);
        continue;
      }
      const departure = zonedDate(estimateDate, seconds(s.earliestDeparture));
      const arrival = zonedDate(estimateDate, seconds(s.deadline));
      if (
        Math.abs(
          (arrival.getTime() - departure.getTime()) / 1000 -
            (seconds(s.deadline) - seconds(s.earliestDeparture)),
        ) > 1
      )
        add(
          'The planning window crosses a daylight-saving clock change. Choose an earliest departure of 03:00 or later on this date.',
          date,
        );
      if (s.mode !== 'mock' && departure.getTime() <= Date.now())
        add('Online driving estimates require a future practice date.', date);
    } catch (e) {
      add((e as Error).message, date);
    }
    for (const a of data.attendance.filter((a) => a.date === date)) {
      const m = data.members.find((m) => m.member_id === a.member_id);
      const person = m ? m.display_name : a.member_id;
      const personRecord = { memberId: a.member_id, memberName: person };
      const attendanceRecord = { inputKind: 'attendance' as const, ...personRecord };
      if (a.attending === 'unknown') {
        add(
          `Attendance remains unknown for ${person}. Confirm true or false for this date.`,
          date,
          'attending',
          'error',
          attendanceRecord,
        );
        continue;
      }
      if (a.attending !== 'true') continue;
      if (a.transport_mode === 'unknown') {
        add(
          `Choose carpool, self, or external transport for ${person}.`,
          date,
          'transport_mode',
          'error',
          attendanceRecord,
        );
        continue;
      }
      if (a.transport_mode !== 'carpool' && a.transport_mode !== 'uber') continue;
      if (!m) {
        add(`Missing member ${a.member_id}.`, date, 'member_id', 'error', attendanceRecord);
        continue;
      }
      if (!a.pickup_override && !m.pickup_address.trim() && m.pickup_lat === undefined)
        add(`Enter a pickup address for ${person}.`, date, 'pickup_address', 'error', {
          inputKind: 'members',
          ...personRecord,
        });
      const v = data.availability.find((v) => v.date === date && v.member_id === a.member_id);
      if (!v || v.available === 'unknown')
        add(
          `Driver availability unknown for ${person}; not selectable as a driver. Confirm true with total_seats (including the driver), or false if unavailable.`,
          date,
          'available',
          'warning',
          { inputKind: 'availability', ...personRecord },
        );
    }
  }
  return issues;
}
