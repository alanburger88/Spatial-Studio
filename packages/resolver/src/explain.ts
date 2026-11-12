import { describePredicate, indexTree } from './resolve';
import type { Resolution } from './types';

export interface Explanation {
  runId: string;
  nodeId: string;
  summary: string;
  evidence: Array<{ ruleId: string; outcome: string; condition: string; inputs: Record<string, unknown> }>;
  notRendered?: string;
}

/**
 * Trace-sourced explanation. Every sentence is derived from the deterministic run;
 * nothing is invented. AI layers may rephrase but must cite this evidence.
 */
export function explainNode(res: Resolution, nodeId: string): Explanation {
  const node = indexTree(res.root).get(nodeId);
  if (!node) return { runId: res.runId, nodeId, summary: `${nodeId} is not part of run ${res.runId}.`, evidence: [] };
  const related = res.trace.filter((t) => t.targetNodeId === nodeId || node.ruleIds.includes(t.ruleId));
  const evidence = related.map((t) => ({ ruleId: t.ruleId, outcome: t.outcome, condition: describePredicate(t.expression), inputs: t.predicateInputs }));
  const parts: string[] = [];
  if (!node.visible) {
    parts.push(`${node.name} is not rendered in this scenario: ${node.hiddenReason ?? 'not selected'}.`);
  } else if (node.variants) {
    const sel = node.variants.items.filter((v) => v.selected);
    if (node.variants.unresolved) parts.push(`${node.name} is unresolved: competing rules tie, so no variant is chosen.`);
    else if (sel.length) {
      const v = sel[0];
      const winner = res.trace.find((t) => t.outcome === 'selected' && t.targetNodeId === nodeId && t.kind === 'rule');
      if (winner) {
        const inputs = Object.entries(winner.predicateInputs).map(([k, val]) => `${k} = ${JSON.stringify(val)}`).join(', ');
        parts.push(`“${v.title}” (${v.id}) appears because ${winner.ruleId} matched: ${describePredicate(winner.expression)} with ${inputs}.`);
        const outranked = res.trace.filter((t) => t.outcome === 'outranked' && t.targetNodeId === nodeId);
        if (outranked.length) parts.push(`${outranked.map((t) => `${t.ruleId} (priority ${t.priority})`).join(', ')} also matched but ${winner.ruleId} has higher priority (${winner.priority}).`);
      } else if (v.source === 'fallback') parts.push(`“${v.title}” is the named fallback: none of ${v.candidateRuleIds.length ? 'the targeting rules' : 'its rules'} matched.`);
      else if (v.source === 'section-rule') parts.push(`“${v.title}” is shown by ${v.ruleIds.join(', ')}.`);
      else parts.push(`“${v.title}” was selected by an inline condition.`);
    }
  } else {
    parts.push(`${node.name}: ${node.visibleBecause.join('; ')}.`);
  }
  if (node.dataLineage.length) parts.push(`Data lineage: ${node.dataLineage.join(', ')}.`);
  return { runId: res.runId, nodeId, summary: parts.join(' '), evidence, notRendered: node.visible ? undefined : node.hiddenReason };
}
