import * as XLSX from 'xlsx';
import { normalize, stableId, validDate } from '../domain/util';
import type { Member } from '../domain/types';
// Historical evidence only; pickup status is not part of the planner's inputs.
export interface LegacyMember extends Member {
  pickup_status: 'candidate' | 'missing' | 'conflict';
}
export interface SourceRef {
  workbook: string;
  sheet: string;
  cell: string;
}
export interface Evidence {
  label: string;
  memberId: string;
  role: 'rower' | 'driver-list' | 'driver' | 'passenger' | 'self' | 'external';
  source: SourceRef;
  group?: string;
  pickup?: string;
  pickupSource?: SourceRef;
}
export interface LegacyIssue {
  code: string;
  message: string;
  source?: SourceRef;
  memberId?: string;
  suggestions?: string[];
}
export interface LegacyOptions {
  aliases?: Record<string, string>;
  dates?: Record<string, string>;
}
export interface LegacyReport {
  schemaVersion: 1;
  draft: true;
  members: LegacyMember[];
  evidence: Evidence[];
  attendance: {
    date: string;
    member_id: string;
    attending: 'unknown';
    transport_mode: 'unknown';
    weekday: string;
    sourceDay: string;
    evidenceRoles: string[];
    assignmentOnly: boolean;
  }[];
  pickups: Record<string, { value: string; source: SourceRef }[]>;
  historicalOwnership: Record<string, { value: string; source: SourceRef }>;
  issues: LegacyIssue[];
  sheets: {
    workbook: string;
    sheet: string;
    weekday: string;
    rowerCount: number;
    assignedCount: number;
    merges: string[];
  }[];
  identityReview: {
    label: string;
    memberId: string;
    suggestions: string[];
    sources: SourceRef[];
  }[];
}
export function weekday(s: string): string | undefined {
  return (
    {
      mon: 'Monday',
      monday: 'Monday',
      tues: 'Tuesday',
      tue: 'Tuesday',
      tuesday: 'Tuesday',
      wed: 'Wednesday',
      wednesday: 'Wednesday',
      thrus: 'Thursday',
      thrudasy: 'Thursday',
      thursday: 'Thursday',
      thurs: 'Thursday',
      thu: 'Thursday',
      fri: 'Friday',
      friday: 'Friday',
      sat: 'Saturday',
      saturday: 'Saturday',
      sun: 'Sunday',
      sunday: 'Sunday',
    } as Record<string, string>
  )[normalize(s)];
}
const labelKind = (s: string): 'self' | 'external' | undefined =>
  /uber|external/i.test(s)
    ? 'external'
    : /on (their|your|my) own|independent|self.?travel|^drive\s+(themselves|yourself|ourselves)$/i.test(
          s.trim(),
        )
      ? 'self'
      : undefined;
const person = (s: string) =>
  Boolean(s.trim()) &&
  !/^(novice|varsity|rowers?|drivers?|divers|names?|address|car\s*#?\s*\d+|total|notes?)$/i.test(
    s.trim(),
  ) &&
  !labelKind(s);
const locationValue = (s: string) =>
  s.trim() && !/study abroad|^n\/?a$|^none$|^no$|^unknown$|^inactive$/i.test(s);
export function importLegacy(
  books: { name: string; workbook: XLSX.WorkBook }[],
  options: LegacyOptions = {},
): LegacyReport {
  const report: LegacyReport = {
    schemaVersion: 1,
    draft: true,
    members: [],
    evidence: [],
    attendance: [],
    pickups: {},
    historicalOwnership: {},
    issues: [],
    sheets: [],
    identityReview: [],
  };
  const exact = new Map<string, string>();
  const memberMap = new Map<string, LegacyMember>();
  const unresolved = new Map<string, LegacyReport['identityReview'][number]>();
  const addPickup = (id: string, value: string, source: SourceRef) => {
    if (!value.trim()) return;
    if (!locationValue(value)) {
      report.issues.push({
        code: 'non-location',
        message: `Non-location status: ${value}`,
        source,
        memberId: id,
      });
      return;
    }
    (report.pickups[id] ??= []).push({ value, source });
  };
  const addMember = (label: string, provisional: boolean, source: SourceRef) => {
    const id = stableId(label, provisional ? 'p' : 'm');
    const prev = memberMap.get(id);
    if (prev && normalize(prev.display_name) !== normalize(label))
      throw new Error('Stable ID collision: supply explicit reviewed IDs.');
    if (!prev) {
      const m: LegacyMember = {
        member_id: id,
        display_name: label.trim(),
        pickup_address: '',
        pickup_status: 'missing',
      };
      report.members.push(m);
      memberMap.set(id, m);
    } else if (!provisional)
      report.issues.push({
        code: 'duplicate-roster-label',
        message: `Duplicate normalized roster label ${label}; review whether these are distinct people.`,
        source,
        memberId: id,
      });
    return id;
  };
  for (const { name, workbook } of books) {
    const sheet = workbook.Sheets.INFO;
    if (!sheet) continue;
    // Only A/B/E are read; birthdays, phones, Andrew IDs never enter artifacts.
    const rows = Object.keys(sheet)
      .filter((k) => /^A\d+$/.test(k))
      .map((k) => Number(k.slice(1)))
      .sort((a, b) => a - b);
    for (const row of rows) {
      const value = String(sheet['A' + row]?.v ?? '').trim();
      if (!person(value) || row === 1) continue;
      const ref = { workbook: name, sheet: 'INFO', cell: 'A' + row };
      const id = addMember(value, false, ref);
      exact.set(normalize(value), id);
      addPickup(id, String(sheet['B' + row]?.v ?? ''), { ...ref, cell: 'B' + row });
      const ownership = String(sheet['E' + row]?.v ?? '');
      if (ownership)
        report.historicalOwnership[id] = { value: ownership, source: { ...ref, cell: 'E' + row } };
    }
  }
  const roster = [...report.members];
  const identify = (label: string, source: SourceRef) => {
    const norm = normalize(label);
    if (exact.has(norm)) return exact.get(norm)!;
    const approved = Object.entries(options.aliases ?? {}).find(
      ([k]) => normalize(k) === norm,
    )?.[1];
    if (approved) {
      if (!memberMap.has(approved))
        throw new Error(`Alias for ${label} refers to an unknown roster ID.`);
      return approved;
    }
    if (unresolved.has(norm)) {
      const row = unresolved.get(norm)!;
      row.sources.push(source);
      return row.memberId;
    }
    const parts = norm.replace(/\./g, '').split(' ');
    const suggestions = roster
      .filter((m) => {
        const p = normalize(m.display_name).split(' ');
        return p[0] === parts[0] && (parts.length === 1 || p.at(-1)!.startsWith(parts.at(-1)!));
      })
      .map((m) => m.member_id);
    // Typo suggestions are evidence for review only, never automatic identity merges.
    if (!suggestions.length) {
      for (const m of roster) {
        const a = normalize(m.display_name).split(' ')[0],
          b = parts[0];
        if (a.length > 2 && b.length > 2 && editDistance(a, b) <= 1) suggestions.push(m.member_id);
      }
    }
    const id = addMember(label, true, source);
    const review = { label, memberId: id, suggestions, sources: [source] };
    unresolved.set(norm, review);
    report.identityReview.push(review);
    report.issues.push({
      code: 'identity-review',
      message: `Review exact label “${label}”; no abbreviation/nickname/typo merge approved.`,
      source,
      memberId: id,
      suggestions,
    });
    return id;
  };
  for (const { name, workbook } of books)
    for (const sheetName of workbook.SheetNames) {
      const day = weekday(sheetName);
      if (!day) continue;
      const sheet = workbook.Sheets[sheetName];
      const cell = (r: number, c: number) =>
        String(sheet[XLSX.utils.encode_cell({ r, c })]?.v ?? '').trim();
      const ref = (r: number, c: number): SourceRef => ({
        workbook: name,
        sheet: sheetName,
        cell: XLSX.utils.encode_cell({ r, c }),
      });
      const coords = Object.keys(sheet)
        .filter((k) => !k.startsWith('!'))
        .map((k) => XLSX.utils.decode_cell(k));
      if (!coords.length) continue;
      const end = Math.max(...coords.map((x) => x.r));
      const cols = Math.max(...coords.map((x) => x.c));
      const dayEvidence: Evidence[] = [];
      const used = new Set<string>();
      const evidence = (
        r: number,
        c: number,
        role: Evidence['role'],
        group?: string,
        pickup?: string,
      ) => {
        const label = cell(r, c);
        if (!person(label)) return;
        const source = ref(r, c),
          id = identify(label, source);
        const e: Evidence = { label, memberId: id, role, source, group };
        if (pickup) {
          e.pickup = pickup;
          e.pickupSource = ref(r, c + 1);
          addPickup(id, pickup, e.pickupSource);
        }
        dayEvidence.push(e);
        used.add(source.cell);
      };
      for (let r = 0; r <= end; r++) {
        if (person(cell(r, 0))) evidence(r, 0, 'driver-list');
        if (person(cell(r, 1))) evidence(r, 1, 'rower');
      }
      const groups: { r: number; c: number; kind?: 'self' | 'external'; numbered: boolean }[] = [];
      for (let r = 0; r <= Math.min(end, 8); r++)
        for (let c = 3; c <= cols; c++) {
          const text = cell(r, c);
          if (/^car\s*#?\s*\d+/i.test(text)) {
            groups.push({ r: r + 1, c, numbered: true, kind: labelKind(cell(r + 1, c)) });
            used.add(ref(r, c).cell);
            used.add(ref(r + 1, c).cell);
          } else if (labelKind(text) && !groups.some((g) => g.r === r && g.c === c)) {
            groups.push({ r, c, numbered: false, kind: labelKind(text) });
            used.add(ref(r, c).cell);
          }
        }
      for (const group of groups) {
        const key = ref(group.r, group.c).cell;
        if (!group.kind) evidence(group.r, group.c, 'driver', key);
        for (let r = group.r + 1; r <= end; r++) {
          if (!cell(r, group.c)) break;
          if (/^car\s*#?/i.test(cell(r, group.c)) || labelKind(cell(r, group.c))) break;
          evidence(r, group.c, group.kind ?? 'passenger', key, cell(r, group.c + 1));
          if (cell(r, group.c + 1)) used.add(ref(r, group.c + 1).cell);
        }
      }
      if (day === 'Saturday' && !groups.length) {
        report.issues.push({
          code: 'unresolved-layout',
          message:
            'Nonstandard Saturday grouping including D9:F13: review manually. Values retained as layout evidence, not inferred assignments or availability.',
          source: ref(8, 3),
        });
      }
      // Preserve unknown group cells as review issues without inventing who is a driver.
      for (const pos of coords) {
        if (pos.c < 3 || !cell(pos.r, pos.c) || used.has(ref(pos.r, pos.c).cell)) continue;
        report.issues.push({
          code: 'unparsed-group-cell',
          message: `Unresolved group value: ${cell(pos.r, pos.c)}`,
          source: ref(pos.r, pos.c),
        });
      }
      const drivers = new Set(
          dayEvidence.filter((e) => e.role === 'driver').map((e) => e.memberId),
        ),
        listed = new Set(
          dayEvidence.filter((e) => e.role === 'driver-list').map((e) => e.memberId),
        );
      if ([...new Set([...drivers, ...listed])].some((id) => drivers.has(id) !== listed.has(id)))
        report.issues.push({
          code: 'driver-list-disagreement',
          message:
            'Selected car drivers and left-hand driver list differ. Neither establishes a factual availability matrix.',
          source: ref(0, 0),
        });
      const sourceDay = name + '::' + sheetName;
      const supplied = options.dates?.[sourceDay] ?? '';
      if (
        supplied &&
        (!validDate(supplied) ||
          new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(
            new Date(supplied + 'T12:00:00Z'),
          ) !== day)
      )
        throw new Error(`Invalid date or weekday mismatch in mapping for ${sourceDay}.`);
      if (!supplied)
        report.issues.push({
          code: 'missing-date',
          message:
            'Supply an explicit source-day to calendar-date mapping. Filename year is not a practice date.',
          source: ref(0, 0),
        });
      for (const id of new Set(dayEvidence.map((e) => e.memberId))) {
        const roles = [...new Set(dayEvidence.filter((e) => e.memberId === id).map((e) => e.role))];
        const assignmentOnly = !roles.includes('rower');
        report.attendance.push({
          date: supplied,
          member_id: id,
          attending: 'unknown',
          transport_mode: 'unknown',
          weekday: day,
          sourceDay,
          evidenceRoles: roles,
          assignmentOnly,
        });
        if (assignmentOnly)
          report.issues.push({
            code: 'attendance-disagreement',
            message:
              'Assignment/list-only person retained as attendance candidate; review before confirming.',
            source: dayEvidence.find((e) => e.memberId === id)!.source,
            memberId: id,
          });
        if (
          roles.some((r) => r === 'self' || r === 'external') &&
          roles.some((r) => r === 'driver' || r === 'passenger')
        )
          report.issues.push({
            code: 'transport-conflict',
            message: 'Conflicting historical transport roles.',
            memberId: id,
            source: dayEvidence.find((e) => e.memberId === id)!.source,
          });
      }
      report.evidence.push(...dayEvidence);
      report.sheets.push({
        workbook: name,
        sheet: sheetName,
        weekday: day,
        rowerCount: dayEvidence.filter((e) => e.role === 'rower').length,
        assignedCount: dayEvidence.filter((e) =>
          ['driver', 'passenger', 'self', 'external'].includes(e.role),
        ).length,
        merges: (sheet['!merges'] ?? []).map((m) => XLSX.utils.encode_range(m)),
      });
    }
  for (const m of report.members) {
    const values = report.pickups[m.member_id] ?? [];
    const distinct = [...new Map(values.map((v) => [normalize(v.value), v.value])).values()];
    m.pickup_address = distinct[0] ?? '';
    m.pickup_status = distinct.length > 1 ? 'conflict' : distinct.length ? 'candidate' : 'missing';
    if (distinct.length > 1)
      report.issues.push({
        code: 'pickup-conflict',
        message:
          'Multiple pickup descriptions retained; choose a reviewed default and/or date-specific override.',
        memberId: m.member_id,
      });
  }
  report.members.sort((a, b) => a.member_id.localeCompare(b.member_id));
  return report;
}
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
