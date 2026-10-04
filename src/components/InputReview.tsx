import { useState } from 'react';
import type { Issue } from '../domain/types';
import { downloadReview, groupReviewIssues } from '../importers/reviewIssues';
import type { ReviewIssue } from '../importers/reviewIssues';

function IssueList({ issues }: { issues: ReviewIssue[] }) {
  return (
    <ul>
      {issues.map((issue, n) => (
        <li key={n} className={issue.severity}>
          <b>
            {issue.file}
            {issue.row ? ` · row ${issue.row}` : ''}
            {issue.field ? ` · ${issue.field}` : ''}
          </b>
          <div>{issue.message}</div>
          {issue.dates.length > 0 && (
            <small>
              {issue.dates.length > 1 ? 'Applies to ' : ''}
              {issue.dates.join(', ')}
            </small>
          )}
        </li>
      ))}
    </ul>
  );
}

export function InputReview({ issues, loaded }: { issues: Issue[]; loaded: boolean }) {
  const [downloadError, setDownloadError] = useState('');
  const grouped = groupReviewIssues(issues);
  const required = grouped.filter((issue) => issue.severity === 'error');
  const notices = grouped.filter((issue) => issue.severity === 'warning');
  if (!grouped.length) return null;
  return (
    <details className="issues" open={required.length > 0}>
      <summary>
        {required.length
          ? `${required.length} ${required.length === 1 ? 'item needs' : 'items need'} review`
          : `${notices.length} ${notices.length === 1 ? 'notice' : 'notices'} · planning is available`}
      </summary>
      {loaded && required.length > 0 && (
        <p>
          Files loaded successfully. Update the rows below in your sheets, then download and upload
          the changed .xlsx files. Each member’s pickup is listed once for all affected dates.
        </p>
      )}
      {required.length > 0 && <IssueList issues={required} />}
      {notices.length > 0 && (
        <details className="review-notices">
          <summary>{notices.length} notices · do not block planning</summary>
          {notices.some((issue) => issue.inputKind === 'availability') && (
            <p>
              Only people marked “Yes” in Drivers for the selected date can be selected to drive.
            </p>
          )}
          <IssueList issues={notices} />
        </details>
      )}
      <button
        className="text-button"
        onClick={() => {
          setDownloadError('');
          downloadReview(grouped).catch(() =>
            setDownloadError('Could not download the review. Please try again.'),
          );
        }}
      >
        Download review (.xlsx) ↓
      </button>
      {downloadError && <p role="alert">{downloadError}</p>}
    </details>
  );
}
