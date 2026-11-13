import { dayWords, type Project } from '@iss/model';
import { usePreviewDate, useStudio } from '../../state/store';
import { quickPicks } from './model';

/**
 * "As issued on" inside a check (coverage, generate test customers): says which day the check works on and offers the
 * boundary days and the day before each. Nothing for a document that does not use dates.
 */
export function IssuedOnPicks({ project, what, testId }: { project: Project; what: string; testId: string }) {
  const issueDate = usePreviewDate();
  const setIssueDate = useStudio((s) => s.setIssueDate);
  if (!project.documentDate) return null;
  const picks = quickPicks(project);
  return (
    <div className="callout info dt-check-date" data-testid={testId} data-value={issueDate ?? ''}>
      <span>{issueDate ? `${what} as issued on ${dayWords(issueDate)}.` : project.documentDate.source === 'field' ? `${what} with each customer’s own date. Pick a day to check as issued on that day.` : `${what} on the day before the first change (no preview date is set). Pick a day to check as issued on that day.`}</span>
      {picks.length > 0 && (
        <span className="row wrap dt-check-picks" role="group" aria-label="Check as issued on">
          {picks.map((p) => (
            <button key={`${p.side}-${p.boundary}`} type="button" className={`btn sm ${issueDate === p.day ? 'primary' : ''}`} aria-pressed={issueDate === p.day} onClick={() => setIssueDate(p.day)} data-testid={`${testId}-${p.day}`}>
              {dayWords(p.day)}{p.side === 'before' ? ' (day before)' : ''}
            </button>
          ))}
          {issueDate && <button type="button" className="btn sm ghost" onClick={() => setIssueDate(null)} data-testid={`${testId}-clear`}>Clear</button>}
        </span>
      )}
    </div>
  );
}
