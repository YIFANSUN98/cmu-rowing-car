import type { Issue } from '../domain/types';

export interface ReviewIssue extends Issue {
  dates: string[];
}

// A Members row applies to every practice date. Show its correction once while
// retaining all affected dates; attendance and driver rows remain date-specific.
export function groupReviewIssues(issues: Issue[]): ReviewIssue[] {
  const groups = new Map<string, ReviewIssue>();
  for (const issue of issues) {
    const key = JSON.stringify([
      issue.file,
      issue.inputKind,
      issue.row,
      issue.memberId,
      issue.field,
      issue.message,
      issue.severity,
      issue.inputKind === 'members' && issue.row !== undefined && issue.memberId
        ? undefined
        : issue.date,
    ]);
    const existing = groups.get(key);
    if (existing) {
      if (issue.date && !existing.dates.includes(issue.date)) existing.dates.push(issue.date);
    } else {
      groups.set(key, { ...issue, dates: issue.date ? [issue.date] : [] });
    }
  }
  return [...groups.values()]
    .map((issue) => ({ ...issue, dates: issue.dates.sort() }))
    .sort((a, b) => a.file.localeCompare(b.file) || (a.row ?? 0) - (b.row ?? 0));
}

export async function createReviewWorkbook(issues: ReviewIssue[]) {
  const XLSX = await import('xlsx');
  const book = XLSX.utils.book_new();
  for (const severity of ['error', 'warning'] as const) {
    const selected = issues.filter((issue) => issue.severity === severity);
    if (!selected.length) continue;
    const sheet = XLSX.utils.aoa_to_sheet([
      ['File', 'Row', 'Name', 'Dates', 'Column', 'What to change'],
      ...selected.map((issue) => [
        issue.file,
        issue.row ?? '',
        issue.memberName ?? '',
        issue.dates.join(', '),
        issue.field ?? '',
        issue.message,
      ]),
    ]);
    sheet['!cols'] = [40, 8, 24, 48, 24, 100].map((wch) => ({ wch }));
    sheet['!autofilter'] = { ref: sheet['!ref']! };
    XLSX.utils.book_append_sheet(
      book,
      sheet,
      severity === 'error' ? 'Required changes' : 'Notices',
    );
  }
  return book;
}

export async function downloadReview(issues: ReviewIssue[]) {
  const XLSX = await import('xlsx');
  XLSX.writeFile(await createReviewWorkbook(issues), 'input-review.xlsx');
}
