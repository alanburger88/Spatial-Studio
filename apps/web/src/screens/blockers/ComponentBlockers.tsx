import { useMemo } from 'react';
import { documentBlockers } from '@iss/scenarios';
import { usePreviewDate, useStudio } from '../../state/store';
import { plural } from './labels';
import { ResolveInBlockers } from './link';

/** The blockers that are about one component, for the Design inspector's Review tab; each opens its root cause on the Blockers screen. */
export function ComponentBlockers({ nodeId }: { nodeId: string }) {
  const project = useStudio((s) => s.project);
  const records = useStudio((s) => s.records);
  const issueDate = usePreviewDate();
  const found = useMemo(() => {
    if (!project) return null;
    const r = documentBlockers(project, records, issueDate ? { issueDate } : undefined);
    return { checked: r.checked, list: r.blockers.filter((b) => b.about.component?.id === nodeId || b.finding.nodeId === nodeId) };
  }, [project, records, nodeId, issueDate]);
  if (!found) return null;
  if (!found.list.length) return <p className="muted" data-testid="insp-no-blockers">Nothing about this component stops the document being issued to any of the {found.checked} synthetic customers checked.</p>;
  return (
    <ul className="list-rows" data-testid="insp-blockers" aria-label="Blockers about this component">
      {found.list.map((b) => (
        <li key={b.id} data-blocker={b.id} style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '6px 0' }}>
          <strong style={{ fontSize: 12.5 }}>{b.title}</strong>
          <span className="muted" style={{ fontSize: 12 }}>{b.customerCount ? `Stops ${plural(b.customerCount, 'customer')}.` : 'No customer is stopped yet.'}</span>
          <span><ResolveInBlockers finding={b.finding} /></span>
        </li>
      ))}
    </ul>
  );
}
