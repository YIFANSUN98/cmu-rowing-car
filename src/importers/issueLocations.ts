import type { Issue } from '../domain/types';
import type { FileKind } from '../domain/validation';
import type { InputSource } from './spreadsheet';
import { parseCsv } from './csv';

function friendlyMessage(issue: Issue, source?: InputSource): string {
  if (!issue.field || !source?.fieldLabels?.[issue.field] || !issue.memberName)
    return issue.message;
  const name = issue.memberName;
  if (source.gridDateColumns && issue.date) {
    if (issue.field === 'attending') return `Choose “Yes” or “No” for ${name} on ${issue.date}.`;
    if (issue.field === 'available')
      return `${name} will not be selected to drive. Choose “Yes” in Drivers for ${issue.date} if they can drive.`;
  }
  switch (issue.field) {
    case 'attending':
      return `Choose “Yes” or “No” under “Attending?” for ${name}.`;
    case 'pickup_address':
      return `Enter a pickup address for ${name}.`;
    case 'available':
      return `${name} can ride but will not be selected to drive. If available to drive, choose “Yes” under “Can drive?” and enter “Seats (including driver)”; otherwise choose “No”.`;
    default:
      return issue.message;
  }
}

// Match IDs and dates, never the sorted domain-array position, to locate input rows.
export function locateOperationalIssues(
  issues: Issue[],
  texts: Record<FileKind, string>,
  sources: Partial<Record<FileKind, InputSource>>,
): Issue[] {
  const indices: Partial<Record<FileKind, Map<string, number>>> = {};
  for (const kind of new Set(issues.map((i) => i.inputKind))) {
    if (!kind || !texts[kind]) continue;
    try {
      const table = parseCsv(texts[kind]);
      const index = new Map<string, number>();
      table.rows.forEach((row, n) => {
        const key = JSON.stringify([row.member_id, kind === 'members' ? '' : row.date]);
        if (!index.has(key)) index.set(key, table.rowNumbers[n]);
      });
      indices[kind] = index;
    } catch {
      // The parser reports invalid input separately; never guess a row for it.
    }
  }
  return issues.map((issue) => {
    const kind = issue.inputKind;
    if (!kind || !issue.memberId) return issue;
    const source = sources[kind];
    const line = indices[kind]?.get(
      JSON.stringify([issue.memberId, kind === 'members' ? '' : issue.date]),
    );
    const row = line === undefined ? undefined : (source?.rowMap?.[line] ?? line);
    const column = issue.date ? source?.gridDateColumns?.[issue.date] : undefined;
    return {
      ...issue,
      file: source?.label ?? issue.file,
      message: friendlyMessage(issue, source),
      field:
        column && row !== undefined
          ? `${column}${row}`
          : issue.field
            ? (source?.fieldLabels?.[issue.field] ?? issue.field)
            : undefined,
      row,
    };
  });
}
