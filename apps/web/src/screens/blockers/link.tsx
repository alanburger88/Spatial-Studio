import type { MouseEvent, ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Project, SyntheticRecord } from '@iss/model';
import type { Finding } from '@iss/resolver';
import { blockerIdOf, customerBlockers, documentBlockers } from '@iss/scenarios';
import { currentPreviewDate, useStudio } from '../../state/store';

/**
 * ONE place builds the link from a finding to its root cause on the Blockers screen, so the id always matches the engine's
 * (`blockerIdOf`). Every screen that mentions a blocker uses `ResolveInBlockers` (or `blockerPath`) and nothing else.
 */

/** What a link needs from a finding. Review's list and the batch report carry fewer fields than the resolver's own. */
export type FindingRef = Pick<Finding, 'code' | 'nodeId' | 'locale' | 'ruleId' | 'ruleIds' | 'message' | 'details'>;

const TIE = new Set(['EXCLUSIVE_PRIORITY_TIE', 'EQUAL_PRIORITY_EXCLUSIVE_RULES']);

export const blockersBase = (projectId: string): string => `/studio/${projectId}/blockers`;

/** `/studio/<p>/blockers?blocker=<id>` for an id the engine produced. */
export const blockerPath = (projectId: string, id: string | null): string => (id ? `${blockersBase(projectId)}?blocker=${encodeURIComponent(id)}` : blockersBase(projectId));

/**
 * The id of the blocker a finding belongs to. A tie reported without its rules (the approval check names only the place)
 * is matched against the live blockers; everything else is computed from the finding itself.
 */
export function blockerIdFor(project: Project, records: SyntheticRecord[], f: FindingRef): string {
  if (TIE.has(f.code) && !f.ruleIds?.length && !f.ruleId) {
    const issueDate = currentPreviewDate();
    const hit = documentBlockers(project, records, issueDate ? { issueDate } : undefined).blockers.find((b) => b.id.startsWith('priority-tie~') && (b.finding.nodeId === f.nodeId || b.about.component?.id === f.nodeId));
    if (hit) return hit.id;
  }
  return blockerIdOf(f);
}

const needsLookup = (f: FindingRef): boolean => TIE.has(f.code) && !f.ruleIds?.length && !f.ruleId;

/** "Resolve in Blockers": opens the screen on this finding's root cause. */
export function ResolveInBlockers({ finding, children, className = 'linkbtn', testId = 'resolve-in-blockers', onNavigate }: { finding: FindingRef; children?: ReactNode; className?: string; testId?: string; /** Close a drawer or dialog that is in the way. */ onNavigate?: () => void }) {
  const project = useStudio((s) => s.project);
  const records = useStudio((s) => s.records);
  const navigate = useNavigate();
  if (!project) return null;
  const to = blockerPath(project.projectId, needsLookup(finding) ? null : blockerIdOf(finding));
  const go = (e: MouseEvent) => {
    onNavigate?.();
    if (!needsLookup(finding)) return; // the plain link does the rest
    e.preventDefault();
    navigate(blockerPath(project.projectId, blockerIdFor(project, records, finding)));
  };
  return (
    <Link to={to} className={className} onClick={go} data-testid={testId} data-blocker={needsLookup(finding) ? undefined : blockerIdOf(finding)}>
      {children ?? 'Resolve in Blockers'}
    </Link>
  );
}

/** The blockers that stop one customer (a blocked batch result, a generated customer): the screen lists just those. */
export const blockersOfCustomerPath = (projectId: string, recordId: string): string => `${blockersBase(projectId)}?customer=${encodeURIComponent(recordId)}`;

/**
 * Data Explorer on one customer, with the values a blocker is about highlighted and a banner linking back:
 * `/studio/<p>/data?customer=<id>&blocker=<id>&highlight=<path,path>`. The fields are worked out from the open model.
 */
export function dataExplorerPath(project: Project, records: SyntheticRecord[], recordId: string, blockerId?: string | null): string {
  const q = new URLSearchParams({ customer: recordId });
  if (blockerId) {
    q.set('blocker', blockerId);
    const record = records.find((r) => r.recordId === recordId);
    const issueDate = currentPreviewDate();
    const fields = record ? customerBlockers(project, record, issueDate ? { issueDate } : undefined).find((b) => b.id === blockerId)?.fields ?? [] : [];
    if (fields.length) q.set('highlight', fields.join(','));
  }
  return `/studio/${project.projectId}/data?${q.toString()}`;
}

export function ResolveCustomerInBlockers({ recordId, children, className = 'linkbtn', testId = 'resolve-in-blockers' }: { recordId: string; children?: ReactNode; className?: string; testId?: string }) {
  const projectId = useStudio((s) => s.project?.projectId);
  if (!projectId) return null;
  return <Link to={blockersOfCustomerPath(projectId, recordId)} className={className} data-testid={testId} data-customer={recordId}>{children ?? 'Resolve in Blockers'}</Link>;
}
