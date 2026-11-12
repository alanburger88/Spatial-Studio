import { projectFieldIndex, type Predicate, type Project, type Rule } from '@iss/model';

/**
 * Plain-language renderings for Business view. Pure functions over the canonical model: they never invent
 * outcomes, they only re-word what the rule/predicate already says. Technical view keeps the raw expressions.
 */

const humanise = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.]/g, ' ').toLowerCase();

/** Friendly field label from the typed data contract (falls back to a humanised path). */
export function fieldLabel(project: Pick<Project, 'documentType' | 'customFields'>, path: string): string {
  const f = projectFieldIndex(project).get(path);
  return f?.label ?? humanise(path.split('.').slice(-1)[0]);
}

function valueText(v: unknown): string {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  if (v === null || v === undefined) return 'empty';
  if (typeof v === 'string') return `“${humanise(v)}”`;
  return String(v);
}

/** "Payment status is “overdue”", "Missed payments is at least 2", "Assistance requested is yes". */
export function predicateSentence(project: Pick<Project, 'documentType' | 'customFields'>, p: Predicate): string {
  switch (p.op) {
    case 'and': return p.args.map((a) => predicateSentence(project, a)).join(' and ');
    case 'or': return p.args.map((a) => predicateSentence(project, a)).join(' or ');
    case 'not': return `not (${predicateSentence(project, p.arg)})`;
    case 'isNull': return `${fieldLabel(project, p.path)} is empty`;
    case 'notNull': return `${fieldLabel(project, p.path)} is present`;
    case 'in': return `${fieldLabel(project, p.path)} is one of ${p.value.map(valueText).join(', ')}`;
    default: {
      const words: Record<string, string> = { eq: 'is', ne: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most' };
      return `${fieldLabel(project, p.path)} ${words[p.op]} ${valueText(p.value)}`;
    }
  }
}

/** Display name of a node or content variant. */
export function nodeTitle(project: Project, id: string): string {
  const n = project.nodes.find((x) => x.id === id);
  if (n) return n.name ?? humanise(id);
  const c = project.contentParts.find((x) => x.id === id);
  return (c as { title?: string; name?: string } | undefined)?.title ?? (c as { name?: string } | undefined)?.name ?? humanise(id);
}

/** What the rule does, in words: "show “Assistance requested” in Payment guidance". */
export function actionSentence(project: Project, rule: Rule): string {
  const a = rule.then;
  switch (a.op) {
    case 'selectVariant': return `show “${nodeTitle(project, a.variantId)}” in ${nodeTitle(project, a.targetNodeId)}`;
    case 'showSection': return `include the “${nodeTitle(project, a.targetNodeId)}” section`;
    case 'requireNodes': return `require ${a.nodeIds.map((id) => `“${nodeTitle(project, id)}”`).join(', ')}`;
    case 'setApprovedLocale': return `use the approved ${a.locale} wording`;
    case 'setPresentationHint': return `apply the “${humanise(a.hint)}” presentation`;
  }
}

/** One-sentence rule summary: "When missed payments is at least 2, show “Payment support” in Payment guidance." */
export function ruleSentence(project: Project, rule: Rule): string {
  const s = `When ${predicateSentence(project, rule.when)}, ${actionSentence(project, rule)}.`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Rule display title: the authored title, else a generated short description of the action. */
export function ruleTitle(project: Project, rule: Rule): string {
  if (rule.title?.trim()) return rule.title.trim();
  const a = actionSentence(project, rule);
  return a.charAt(0).toUpperCase() + a.slice(1);
}
