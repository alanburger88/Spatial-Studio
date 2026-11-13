import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { dayWords, isIsoDay, type Project } from '@iss/model';
import { usePreviewDate, useStudio } from '../../state/store';

/**
 * The studio's shared preview date ("As issued on") inside a screen that works something out with the document's date
 * (Calculations, Lookup tables): the same value as the status bar and the Dates screen, so changing it here changes it
 * everywhere. Says what is used without one, and links to Dates. Nothing for a document that does not use dates.
 */
export function PreviewDateField({ project, testId, what }: { project: Project; testId: string; /** "The values here are worked out" */ what: string }) {
  const issueDate = usePreviewDate();
  const setIssueDate = useStudio((s) => s.setIssueDate);
  const [text, setText] = useState(issueDate ?? '');
  useEffect(() => setText(issueDate ?? ''), [issueDate]);
  if (!project.documentDate) return null;
  const id = `${testId}-input`;
  return (
    <div className="field preview-date-field" data-testid={testId} data-value={issueDate ?? ''}>
      <label htmlFor={id}>As issued on</label>
      <span className="row">
        <input id={id} className="input" type="date" value={text} data-testid={`${testId}-input`}
          onChange={(e) => { setText(e.target.value); if (isIsoDay(e.target.value)) setIssueDate(e.target.value); else if (!e.target.value) setIssueDate(null); }} />
        {issueDate && <button type="button" className="btn sm ghost" onClick={() => setIssueDate(null)} data-testid={`${testId}-clear`}>Clear</button>}
      </span>
      <span className="hint" data-testid={`${testId}-words`}>
        {issueDate
          ? `${what} as issued on ${dayWords(issueDate)}, the studio’s preview date.`
          : project.documentDate.source === 'field'
            ? `${what} with each customer’s own date. Pick a day to see them as issued on that day.`
            : `The document’s date is given for each run, so a value that uses it needs a preview date.`}
        {' '}<Link to={`/studio/${project.projectId}/dates`} data-testid={`${testId}-dates-link`}>Dates</Link> shows what changes on which day.
      </span>
    </div>
  );
}
