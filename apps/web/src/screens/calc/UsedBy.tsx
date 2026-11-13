import { Link, useNavigate } from 'react-router-dom';
import type { Project } from '@iss/model';
import { useStudio } from '../../state/store';
import { ruleTitle } from '../../ui/plain';

/**
 * Where a calculation or lookup table is used, each a link. The engine names each place in words (`calculationUsage`);
 * this turns the words back into the thing they name: a rule, another calculation, a part of the document, the email or SMS.
 */

export interface UsePlace { text: string; label: string; to?: string; nodeId?: string; kind: string }

export function usePlaces(project: Project, where: string[]): UsePlace[] {
  const base = `/studio/${project.projectId}`;
  return where.map((text): UsePlace => {
    const rule = /^rule (\S+)$/.exec(text);
    if (rule) {
      const r = project.rules.find((x) => x.id === rule[1]);
      return { text, kind: 'Rule', label: r ? `${rule[1]} · ${ruleTitle(project, r)}` : rule[1], to: `${base}/rules-data?rule=${encodeURIComponent(rule[1])}` };
    }
    const calc = /^calculation “(.*)”$/.exec(text);
    if (calc) {
      const c = project.calculatedFields?.find((x) => x.label === calc[1]);
      return { text, kind: 'Calculation', label: calc[1], to: c ? `${base}/calculations?calc=${encodeURIComponent(c.key)}` : undefined };
    }
    if (/^(Email|SMS) · /.test(text)) return { text, kind: 'Email and SMS', label: text, to: `${base}/channels` };
    const node = project.nodes.find((n) => (n.name ?? n.id) === text || text.startsWith(`${n.name ?? n.id} · `));
    if (node) return { text, kind: node.type === 'repeating-table' ? 'Table' : 'Wording', label: text, nodeId: node.id };
    return { text, kind: 'Wording', label: text, to: `${base}/content` };
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
        <li key={p.text}>
          <span className="chip">{p.kind}</span>{' '}
          {p.to ? <Link to={p.to}>{p.label}</Link>
            : p.nodeId ? <button type="button" className="linklike" onClick={() => { useStudio.getState().select(p.nodeId!, null); navigate(`/studio/${project.projectId}/design`); }}>{p.label}</button>
            : <span>{p.label}</span>}
        </li>
      ))}
    </ul>
  );
}
