import { Link } from 'react-router-dom';
import { exprDependencies, type Project } from '@iss/model';
import type { Finding } from '@iss/resolver';

/**
 * For a calculated value that cannot be worked out (`CALCULATION_MISSING`) or finds no row (`LOOKUP_NO_MATCH`): links to
 * the calculation, and to the lookup table it reads when that is known (the one table the calculation, or the
 * calculations it is worked out from, reads).
 */

/** The calculation a finding is about, and the lookup table it reads when exactly one is involved. */
export function calcTargetsOf(project: Project, finding: Pick<Finding, 'code' | 'details'>): { calc: { key: string; label: string } | null; table: { id: string; title: string } | null } {
  if (finding.code !== 'CALCULATION_MISSING' && finding.code !== 'LOOKUP_NO_MATCH') return { calc: null, table: null };
  const path = typeof finding.details?.path === 'string' ? finding.details.path : '';
  const key = path.startsWith('calc.') ? path.slice('calc.'.length) : '';
  const calcs = project.calculatedFields ?? [];
  const calc = calcs.find((c) => c.key === key);
  if (!calc) return { calc: null, table: null };
  if (finding.code !== 'LOOKUP_NO_MATCH') return { calc: { key, label: calc.label }, table: null };
  // The tables read by this calculation and by every calculation it is worked out from.
  const tables = new Set<string>();
  const seen = new Set<string>();
  const walk = (k: string) => {
    if (seen.has(k)) return;
    seen.add(k);
    const c = calcs.find((x) => x.key === k);
    if (!c) return;
    const deps = exprDependencies(c.expr);
    deps.tables.forEach((t) => tables.add(t));
    deps.calcs.forEach(walk);
  };
  walk(key);
  const only = tables.size === 1 ? project.lookupTables?.find((t) => t.id === [...tables][0]) : undefined;
  return { calc: { key, label: calc.label }, table: only ? { id: only.id, title: only.title } : null };
}

export function CalcLinks({ project, finding }: { project: Project; finding: Pick<Finding, 'code' | 'details'> }) {
  const { calc, table } = calcTargetsOf(project, finding);
  if (!calc) return null;
  const base = `/studio/${project.projectId}`;
  return (
    <>
      <Link className="btn" to={`${base}/calculations?calc=${encodeURIComponent(calc.key)}`} data-testid="bl-open-calc">Open the calculation “{calc.label}”</Link>
      {table && <Link className="btn" to={`${base}/lookup-tables?table=${encodeURIComponent(table.id)}`} data-testid="bl-open-table">Open the lookup table “{table.title}”</Link>}
    </>
  );
}
