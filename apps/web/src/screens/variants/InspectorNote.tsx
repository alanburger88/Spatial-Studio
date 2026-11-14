import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { isBaseComponent, type DocNode, type Project } from '@iss/model';
import { useStudio } from '../../state/store';
import './variants.css';

/**
 * Variants (wave 5) in the Design Studio inspector: on a component that comes from the base, a calm note saying what stays
 * the base's and why, with a link that opens the base at that component; after a refused change, the refusal itself.
 * The lock is enforced by the command bus (`applyCommand`); this only explains it.
 */
const baseLink = (project: Project, nodeId: string) => `/studio/${project.variantOf!.projectId}/design?node=${encodeURIComponent(nodeId)}`;

export function VariantNodeNote({ project, node, differs }: { project: Project; node: DocNode; differs?: string[] }) {
  const v = project.variantOf;
  const refusal = useStudio((s) => (s.lastRejection?.code === 'VARIANT_LOCKED' && Date.now() - s.lastRejection.at < 60_000 ? s.lastRejection : null));
  if (!v) return null;
  const fromBase = isBaseComponent(project, node.id);
  return (
    <div className="vr-insp-note" data-testid="variant-node-note">
      {refusal && (!refusal.nodeId || refusal.nodeId === node.id) && (
        <div className="callout warning" role="status" data-testid="variant-locked-message">
          <strong>Not changed.</strong> {refusal.message} <Link to={baseLink(project, refusal.nodeId ?? node.id)} data-testid="variant-open-in-base">Open it in the base</Link>
        </div>
      )}
      {fromBase
        ? <p className="muted">From the base “{v.baseTitle}”. Its place and size stay the base’s; its wording and settings are this variant’s to change.{differs?.length ? <span title={differs.join('\n')}> It differs from the base in {differs.length === 1 ? 'one way' : `${differs.length} ways`} (see Overview).</span> : null} <Link to={baseLink(project, node.id)} data-testid="variant-node-open-base">Open it in the base</Link></p>
        : <p className="muted">This variant’s own component: it can be moved, resized and removed freely.</p>}
    </div>
  );
}

/** The Layout tab of a base component in a variant: shown, but read-only, with the reason. */
export function LockedLayout({ project, node, children }: { project: Project; node: DocNode; children: ReactNode }) {
  if (!project.variantOf || !isBaseComponent(project, node.id)) return <>{children}</>;
  return (
    <fieldset disabled className="lib-readonly" data-testid="variant-layout-locked" aria-describedby="vr-layout-why">
      <p id="vr-layout-why" className="lib-readonly-why">The position and size of this component come from the base document “{project.variantOf.baseTitle}”. Change them there, or detach this variant. <Link to={baseLink(project, node.id)}>Open it in the base</Link></p>
      {children}
    </fieldset>
  );
}
