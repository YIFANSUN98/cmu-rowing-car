import { expect, it } from 'vitest';
import type { Issue } from '../src/domain/types';
import { groupReviewIssues } from '../src/importers/reviewIssues';

it('combines a member row across dates without merging distinct people, rows, or daily decisions', () => {
  const pickup: Issue = {
    file: 'members.xlsx · Members',
    row: 4,
    inputKind: 'members',
    memberId: 'example-a',
    field: 'Pickup address',
    message: 'Check pickup',
    severity: 'error',
    date: '2026-10-06',
  };
  const daily: Issue = {
    ...pickup,
    file: 'attendance.xlsx · Attendance',
    inputKind: 'attendance',
    field: 'Attending?',
    message: 'Choose attendance',
  };
  const issues = [
    pickup,
    { ...pickup, date: '2026-10-07' },
    { ...pickup, memberId: 'example-b' },
    { ...pickup, row: 5 },
    daily,
    { ...daily, date: '2026-10-07' },
  ];
  const original = structuredClone(issues);
  const result = groupReviewIssues(issues);
  expect(result).toHaveLength(5);
  expect(result.find((issue) => issue.dates.length === 2)?.dates).toEqual([
    '2026-10-06',
    '2026-10-07',
  ]);
  expect(result.filter((issue) => issue.inputKind === 'attendance')).toHaveLength(2);
  expect(issues).toEqual(original);
  expect(
    groupReviewIssues([
      { ...pickup, row: undefined },
      { ...pickup, row: undefined, date: '2026-10-07' },
    ]),
  ).toHaveLength(2);
});
