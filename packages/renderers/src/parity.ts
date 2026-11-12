import type { SemanticManifest } from '@iss/resolver';
import { canonicalJson } from '@iss/model';

/** Manifest extracted from a rendered output DOM by EXTRACTOR_JS. */
export interface ExtractedManifest {
  visibleNodeIds: string[];
  money: Record<string, number>;
  guardedLiabilityNodeIds: string[];
  disclosures: Array<{ nodeId: string; contentPartId: string; version: number; contentHash: string }>;
  selectedVariants: Record<string, string | null>;
  tableRows: Record<string, number>;
  tableTotalsCents: Record<string, number>;
  actions: Array<{ nodeId: string; url: string }>;
  identity: Record<string, string>;
  text?: string;
}

export interface ParityCheck {
  id: string;
  label: string;
  status: 'match' | 'mismatch' | 'allowed-difference';
  blocking: boolean;
  expected: unknown;
  pdf?: unknown;
  html?: unknown;
  note?: string;
}

export interface ParityReport {
  ok: boolean;
  checks: ParityCheck[];
  allowedDifferences: string[];
}

const eq = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/**
 * Semantic parity: compares the resolver's expected facts with what each output actually contains.
 * Layout, page count, interactivity and explanatory expansion may differ; money, member liability,
 * mandatory disclosures, selected variants, identity and row/total facts may not.
 */
export function compareManifests(expected: SemanticManifest, pdf?: ExtractedManifest, html?: ExtractedManifest): ParityReport {
  const checks: ParityCheck[] = [];
  const outputs = { pdf, html };
  const add = (id: string, label: string, exp: unknown, pick: (m: ExtractedManifest) => unknown, blocking = true, note?: string) => {
    const vals: Record<string, unknown> = {};
    let ok = true;
    for (const [k, m] of Object.entries(outputs)) if (m) { vals[k] = pick(m); if (!eq(vals[k], exp)) ok = false; }
    checks.push({ id, label, status: ok ? 'match' : 'mismatch', blocking, expected: exp, pdf: vals.pdf, html: vals.html, note });
  };
  add('selected-variants', 'Selected variants', expected.selectedVariants, (m) => m.selectedVariants);
  add('money', 'Monetary values (integer cents) by node', expected.money, (m) => m.money);
  add('member-liability', 'Guarded (unconfirmed) member liability', expected.guardedLiabilityNodeIds, (m) => m.guardedLiabilityNodeIds);
  add('disclosures', 'Mandatory disclosures (id, version, content hash)', expected.disclosures.slice().sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1)), (m) => m.disclosures);
  add('required-nodes', 'Required semantic nodes present', expected.requiredNodeIds, (m) => expected.requiredNodeIds.filter((id) => m.visibleNodeIds.includes(id)));
  add('table-rows', 'Table row counts', expected.tableRows, (m) => m.tableRows);
  add('table-totals', 'Table totals (cents)', expected.tableTotalsCents, (m) => m.tableTotalsCents);
  add('identity', 'Customer identity', { name: expected.identity.name, ...(expected.identity.account ? { account: expected.identity.account } : {}), ...(expected.identity.memberId ? { memberId: expected.identity.memberId } : {}) }, (m) => m.identity);
  add('actions', 'Action destinations', expected.actions.map((a) => a.url).sort(), (m) => m.actions.map((a) => a.url).sort(), false, 'HTML renders an active link; PDF prints the URL/QR fallback.');

  // Visible-node differences are allowed only for non-semantic nodes (no money, disclosure, variant or table facts).
  const semantic = new Set([...Object.keys(expected.money), ...expected.disclosures.map((d) => d.nodeId), ...Object.keys(expected.selectedVariants), ...Object.keys(expected.tableRows), ...expected.requiredNodeIds]);
  const allowed: string[] = [];
  for (const [k, m] of Object.entries(outputs)) {
    if (!m) continue;
    const missing = expected.visibleNodeIds.filter((id) => !m.visibleNodeIds.includes(id));
    const semMissing = missing.filter((id) => semantic.has(id));
    if (semMissing.length) checks.push({ id: `${k}-semantic-omission`, label: `${k.toUpperCase()} omits semantic nodes`, status: 'mismatch', blocking: true, expected: semMissing, [k]: [] });
    const nonSem = missing.filter((id) => !semantic.has(id));
    if (nonSem.length) allowed.push(`${k.toUpperCase()} profile omits presentation-only nodes: ${nonSem.join(', ')}`);
  }
  allowed.push('Page geometry, page count and pagination differ by design (paged vs responsive).');
  allowed.push('HTML adds sorting, filtering, expandable explanations and chart tooltips; PDF shows explanations expanded.');
  const ok = !checks.some((c) => c.status === 'mismatch' && c.blocking);
  return { ok, checks, allowedDifferences: allowed };
}
