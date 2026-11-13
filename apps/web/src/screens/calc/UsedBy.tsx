import { Link, useNavigate } from 'react-router-dom';
import type { CalculationUse, Project } from '@iss/model';
import { useStudio } from '../../state/store';
import { ruleTitle } from '../../ui/plain';

/**
 * Where a calculation is used, each a link. The engine gives each place as a structured entry (`calculationUsage` →
 * `uses`: a rule, another calculation, a part of the document, wording, the email or SMS), so a link always goes to
 * the right thing, even when two of them have the same name.
 */

export interface UsePlace { key: string; label: string; to?: string; nodeId?: string; kind: string }

export function usePlaces(project: Project, uses: CalculationUse[]): UsePlace[] {
  const base = `/studio/${project.projectId}`;
  return uses.map((u): UsePlace => {
    const key = `${u.kind}|${u.id}|${u.label}`;
    switch (u.kind) {
      case 'rule': {
        const r = project.rules.find((x) => x.id === u.id);
        return { key, kind: 'Rule', label: r ? `${u.id} · ${ruleTitle(project, r)}` : u.id, to: `${base}/rules-data?rule=${encodeURIComponent(u.id)}` };
      }
      case 'calculation': {
        const c = project.calculatedFields?.find((x) => x.key === u.id);
        return { key, kind: 'Calculation', label: c?.label ?? u.label, to: `${base}/calculations?calc=${encodeURIComponent(u.id)}` };
      }
      case 'channel': return { key, kind: 'Email and SMS', label: u.label, to: `${base}/channels` };
      case 'component': {
        const n = project.nodes.find((x) => x.id === u.nodeId);
        return { key, kind: n?.type === 'repeating-table' ? 'Table' : 'Wording', label: u.label, nodeId: u.nodeId };
      }
      default: return { key, kind: 'Wording', label: u.label, ...(u.nodeId ? { nodeId: u.nodeId } : { to: `${base}/content` }) };
    }
  });
}

/** A list of places, each a link (or a button that selects the part of the document and opens the design). */
export function UsedBy({ places, testId }: { places: UsePlace[]; testId?: string }) {
  const navigate = useNavigate();
  const project = useStudio((s) => s.project)!;
  if (!places.length) return <p className="muted calc-none" data-testid={testId}>Nothing uses it yet.</p>;
  return (
    <ul className="calc-used" data-testid={testId}>
      {places.map((p) => (
        <li key={p.key}>
          <span className="chip">{p.kind}</span>{' '}
          {p.to ? <Link to={p.to}>{p.label}</Link>
            : p.nodeId ? <button type="button" className="linklike" onClick={() => { useStudio.getState().select(p.nodeId!, null); navigate(`/studio/${project.projectId}/design`); }}>{p.label}</button>
            : <span>{p.label}</span>}
        </li>
      ))}
    </ul>
  );
}
