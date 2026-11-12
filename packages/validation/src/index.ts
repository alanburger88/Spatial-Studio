import { fieldIndex, richToPlain, tokensIn, tokensInText, type Project, type SyntheticRecord } from '@iss/model';
import { evaluatePredicate, resolve, type Finding, type Resolution } from '@iss/resolver';
import { buildContext } from '@iss/model';

export type Suite = 'rules' | 'bindings' | 'pagination' | 'parity' | 'accessibility';

export interface ValidationIssue extends Finding {
  suite: Suite;
  issueId: string;
  runId?: string;
  reproduction?: { recordId: string; overrides?: Record<string, unknown>; journeyCursor?: number | null };
}

let counter = 0;
export function toIssue(f: Finding, suite: Suite, extra: Partial<ValidationIssue> = {}): ValidationIssue {
  counter += 1;
  return { ...f, suite, issueId: `${suite}-${f.code}-${f.nodeId ?? 'doc'}-${f.page ?? 0}-${counter}`, ...extra };
}

/**
 * Bounded static rule analysis across the seeded fixture domain.
 * Limits: reachability is evaluated only against the supplied synthetic records — absence of a match
 * is reported as "not reached in fixtures", never as formally unreachable.
 */
export function staticRuleAnalysis(project: Project, records: SyntheticRecord[]): Finding[] {
  const out: Finding[] = [];
  const recs = records.filter((r) => r.documentType === project.documentType);
  const ctxs = recs.map((r) => buildContext(r));
  const rules = project.rules.filter((r) => r.scope === project.documentType && r.enabled !== false);
  const groups = new Map<string, typeof rules>();
  for (const r of rules) if (r.mode === 'exclusive') groups.set(r.exclusiveGroup ?? '', [...(groups.get(r.exclusiveGroup ?? '') ?? []), r]);
  for (const [group, rs] of groups) {
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      if (rs[i].priority !== rs[j].priority) continue;
      const both = ctxs.filter((c) => evaluatePredicate(rs[i].when, c) && evaluatePredicate(rs[j].when, c)).length;
      out.push({ code: 'EQUAL_PRIORITY_EXCLUSIVE_RULES', severity: both ? 'blocking' : 'warning', nodeId: group, ruleIds: [rs[i].id, rs[j].id], source: 'rules-static', message: `${rs[i].id} and ${rs[j].id} share priority ${rs[i].priority} in ${group}; ${both} seeded record(s) match both.`, suggestion: 'Give each exclusive rule a distinct priority.' });
    }
  }
  for (const r of rules) {
    const hits = ctxs.filter((c) => evaluatePredicate(r.when, c)).length;
    if (!hits && r.mode !== 'obligation') out.push({ code: 'RULE_NOT_REACHED_IN_FIXTURES', severity: 'info', ruleId: r.id, source: 'rules-static', message: `${r.id} matched none of the ${recs.length} seeded ${project.documentType} records (bounded fixture analysis, not a formal proof).`, details: { evaluated: recs.length } });
  }
  for (const n of project.nodes) {
    if (n.type !== 'variant-set') continue;
    for (const v of n.variantIds ?? []) {
      const targeted = project.rules.some((r) => r.then.op === 'selectVariant' && r.then.targetNodeId === n.id && r.then.variantId === v && r.enabled !== false);
      if (!targeted && n.fallbackVariantId !== v) out.push({ code: 'VARIANT_WITHOUT_RULE', severity: 'warning', nodeId: n.id, source: 'rules-static', message: `Variant ${v} of ${n.id} is not selected by any enabled rule and is not the fallback — it can never appear.` });
    }
    if (!n.fallbackVariantId) out.push({ code: 'VARIANT_SET_WITHOUT_FALLBACK', severity: 'warning', nodeId: n.id, source: 'rules-static', message: `${n.id} has no fallback; a scenario where no rule matches will be blocked.` });
  }
  return out;
}

/** Validates every token and binding in the project against the typed data contract. */
export function bindingAnalysis(project: Project): Finding[] {
  const fields = fieldIndex(project.documentType);
  const out: Finding[] = [];
  const check = (nodeId: string, path: string, where: string) => { if (!fields.has(path)) out.push({ code: 'INVALID_BINDING', severity: 'blocking', nodeId, source: 'binding', message: `${where} references unknown field “${path}”.`, details: { path } }); };
  for (const n of project.nodes) {
    if (n.binding) check(n.id, n.binding, 'Binding');
    tokensIn(n.content).forEach((p) => check(n.id, p, 'Token'));
    if (n.headerFooter) tokensInText(n.headerFooter.text).forEach((p) => check(n.id, p, 'Header token'));
    for (const s of n.chart?.series ?? []) check(n.id, s.path, 'Chart series');
  }
  const referenced = new Set<string>();
  for (const n of project.nodes) { (n.variantIds ?? []).forEach((v) => referenced.add(v)); if (n.contentPartId) referenced.add(n.contentPartId); }
  for (const r of project.rules) if (r.then.op === 'showSection') referenced.add(r.then.targetNodeId);
  for (const c of project.contentParts.filter((x) => referenced.has(x.id))) for (const t of Object.values(c.approvedLocales)) tokensInText(t ?? '').forEach((p) => { if (!fields.has(p)) out.push({ code: 'INVALID_BINDING', severity: 'warning', nodeId: c.id, source: 'binding', message: `Content part ${c.id} references unknown field “${p}”.` }); });
  return out;
}

/** Static accessibility checks on the model (complements axe-core on rendered HTML). Not a certification. */
export function modelAccessibility(project: Project, res: Resolution): Finding[] {
  const out: Finding[] = [];
  for (const n of project.nodes) {
    if (n.type === 'image' && !n.decorative && !n.image?.alt?.trim()) out.push({ code: 'A11Y_IMAGE_ALT', severity: 'warning', nodeId: n.id, source: 'accessibility', message: `Image ${n.id} needs alternative text.` });
    if (n.type === 'action-link' && /^(click here|here|link)$/i.test(n.action?.label ?? '')) out.push({ code: 'A11Y_LINK_TEXT', severity: 'warning', nodeId: n.id, source: 'accessibility', message: `Action label “${n.action?.label}” is not descriptive.` });
    if (n.type === 'chart' && !n.chart?.title) out.push({ code: 'A11Y_CHART_TITLE', severity: 'warning', nodeId: n.id, source: 'accessibility', message: `Chart ${n.id} needs a title for its text alternative.` });
    if (n.type === 'repeating-table' && !(n.columns ?? []).length) out.push({ code: 'A11Y_TABLE_HEADERS', severity: 'warning', nodeId: n.id, source: 'accessibility', message: `Table ${n.id} has no column headers.` });
    if (n.type === 'rich-text' && richToPlain(n.content).length > 0 && /^\s*$/.test(richToPlain(n.content).replace(/\{\{[^}]+\}\}/g, ''))) out.push({ code: 'A11Y_TOKEN_ONLY_TEXT', severity: 'info', nodeId: n.id, source: 'accessibility', message: `${n.id} consists only of data tokens; consider a label.` });
  }
  if (!res.root.children.some((c) => c.visible && c.text?.some((b) => b.kind === 'h2'))) out.push({ code: 'A11Y_NO_H1', severity: 'warning', source: 'accessibility', message: 'Document has no top-level heading.' });
  return out;
}

/** Map an axe-core violation list (from the browser) to findings with source node lineage. */
export function axeToFindings(violations: Array<{ id: string; impact?: string; help: string; nodes: Array<{ target: string[]; nodeId?: string | null }> }>): Finding[] {
  return violations.flatMap((v) => v.nodes.slice(0, 5).map((n) => ({
    code: `AXE_${v.id.toUpperCase().replace(/-/g, '_')}`,
    severity: (v.impact === 'critical' || v.impact === 'serious' ? 'error' : 'warning') as Finding['severity'],
    nodeId: n.nodeId ?? undefined,
    source: 'accessibility' as const,
    message: `${v.help} (${n.target.join(' ')})`,
    details: { rule: v.id, impact: v.impact },
  })));
}

export { resolve };
