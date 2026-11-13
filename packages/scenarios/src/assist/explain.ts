import { languageName, languageShortName, projectLanguages, SOURCE_LANGUAGE, type Predicate, type Project } from '@iss/model';
import { indexTree, type RNode, type Resolution, type TraceEntry } from '@iss/resolver';
import type { Explanation } from './types';
import { conditionWords, countWords, fieldWords, listWords, nodeWords, ruleWords, valueWords } from './writing';

/**
 * "Why does this customer get this?" in plain words. Every sentence restates something the resolver recorded for this
 * run (its trace, the resolved component, the findings and the translation report); nothing is inferred beyond it.
 * Rules are called by their titles and components by their names.
 */

const MAX_STEPS = 6;
const lower1 = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const isComparison = (p: Predicate): boolean => p.op === 'eq' && (typeof p.value === 'string' || typeof p.value === 'boolean');

export function explainNode(project: Project, res: Resolution, nodeId: string): Explanation {
  const index = indexTree(res.root);
  const ruleIds: string[] = [];
  const cite = (id: string | undefined) => { if (id && project.rules.some((r) => r.id === id) && !ruleIds.includes(id)) ruleIds.push(id); };

  const customer = res.effectiveRecord?.customer;
  const who = `${customer?.givenName ?? ''} ${customer?.familyName ?? ''}`.trim() || 'this customer';
  const partTitle = (id: string): string => nodeWords({ nodes: [], contentParts: project.contentParts }, id);
  const ruleTitle = (id: string): string => {
    const r = project.rules.find((x) => x.id === id);
    cite(id);
    return r ? ruleWords(project, r) : id;
  };
  const ruleName = (id: string): string => `the rule “${ruleTitle(id)}”`;
  const RuleName = (id: string): string => `The rule “${ruleTitle(id)}”`;
  /** The values the engine read for a condition: "missed payments is 2 and assistance requested is no". */
  const facts = (t: TraceEntry): string => {
    const parts = Object.entries(t.predicateInputs).map(([path, v]) => `${lower1(fieldWords(project, path))} is ${valueWords(project, path, v)}`);
    return parts.length ? listWords(parts, 4, 'more values') : 'no values were needed';
  };
  const becauseMatched = (t: TraceEntry): string => (isComparison(t.expression) ? `because ${conditionWords(project, t.expression)}` : `when ${conditionWords(project, t.expression)}; for ${who}, ${facts(t)}`);
  const needs = (t: TraceEntry): string => `applies only when ${conditionWords(project, t.expression)}; for ${who}, ${facts(t)}`;

  /* ---- which component */
  let node = index.get(nodeId);
  let askedVariant: string | null = null;
  if (!node) {
    const parent = [...index.values()].find((n) => n.variants?.items.some((v) => v.id === nodeId));
    if (parent) { node = parent; askedVariant = nodeId; }
  }
  if (!node) {
    const known = project.nodes.find((n) => n.id === nodeId) ?? null;
    return known
      ? { headline: `“${nodeWords(project, nodeId)}” is not part of the document put together for ${who}.`, steps: ['It exists in the design but is not placed anywhere in the document, so no customer gets it.'], ruleIds: [], variantId: null, nodeId }
      : { headline: 'This is not a component of the document, so there is nothing to explain.', steps: [], ruleIds: [], variantId: null, nodeId };
  }
  const n: RNode = node;
  const name = nodeWords(project, n.id);
  const targeting = res.trace.filter((t) => t.targetNodeId === n.id);
  const ruleEntries = targeting.filter((t) => t.kind === 'rule');
  const inlineEntries = targeting.filter((t) => t.kind === 'inline-condition' && !t.ruleId.endsWith(':visibleWhen'));
  const ownCondition = targeting.find((t) => t.ruleId === `${n.id}:visibleWhen`);
  const hasFinding = (code: string): boolean => res.findings.some((f) => f.code === code && f.nodeId === n.id);

  let headline = '';
  const steps: string[] = [];
  let variantId: string | null = null;

  /** Rules (or conditions) that did not match, a few by name and the rest counted. */
  const didNotMatch = (entries: TraceEntry[], individually: number) => {
    const missed = entries.filter((t) => t.enabled && !t.matched);
    for (const t of missed.slice(0, individually)) {
      if (t.kind === 'rule') steps.push(`${RuleName(t.ruleId)} did not match: it ${needs(t)}.`);
      else steps.push(`“${partTitle(t.ruleId.slice(n.id.length + 1))}” is shown when ${conditionWords(project, t.expression)}; for ${who}, ${facts(t)}.`);
    }
    const rest = missed.slice(individually);
    if (rest.length) {
      const names = rest.map((t) => `“${t.kind === 'rule' ? ruleTitle(t.ruleId) : partTitle(t.ruleId.slice(n.id.length + 1))}”`);
      steps.push(`${countWords(rest.length, individually ? 'other rule' : 'rule')} for this component did not match${individually ? ' either' : ''}: ${listWords(names, 3, 'more')}.`);
    }
    for (const t of entries.filter((x) => !x.enabled)) steps.push(`${RuleName(t.ruleId)} is switched off, so it was not considered.`);
  };

  /** Why a component is not shown: a short clause for the headline, and the detail. */
  const whyHidden = (h: RNode): string => {
    const reason = h.hiddenReason ?? '';
    const hTargeting = res.trace.filter((t) => t.targetNodeId === h.id);
    if (reason.startsWith('Condition not met')) {
      const c = hTargeting.find((t) => t.ruleId === `${h.id}:visibleWhen`);
      if (c) steps.push(`It is shown only when ${conditionWords(project, c.expression)}.`, `For ${who}, ${facts(c)}.`);
      return 'its condition is not met';
    }
    if (reason.startsWith('No rule shows this section')) {
      const rules = hTargeting.filter((t) => t.kind === 'rule');
      if (!rules.length) steps.push('No rule is set up to show it.');
      for (const t of rules.slice(0, 3)) {
        if (!t.enabled) steps.push(`${RuleName(t.ruleId)} would show it, but that rule is switched off.`);
        else steps.push(`${RuleName(t.ruleId)} would show it, but it ${needs(t)}.`);
      }
      if (rules.length > 3) steps.push(`${countWords(rules.length - 3, 'more rule')} could show it; none matched.`);
      return 'no rule that shows it matched';
    }
    if (reason.startsWith('No branch condition matched')) {
      for (const t of hTargeting.filter((x) => x.kind === 'inline-condition' && !x.ruleId.endsWith(':visibleWhen')).slice(0, 3)) {
        steps.push(`“${partTitle(t.ruleId.slice(h.id.length + 1))}” is shown when ${conditionWords(project, t.expression)}; for ${who}, ${facts(t)}.`);
      }
      return 'none of its conditions is met and it has no fallback';
    }
    if (reason.startsWith('Suppressed')) {
      steps.push('It is set to disappear when it has no value to show.');
      return `${lower1(h.field ? fieldWords(project, h.field.path) : 'its value')} is empty for this customer`;
    }
    if (reason) steps.push(`The engine recorded this reason: ${reason.replace(/\.$/, '')}.`);
    return 'the engine left it out';
  };

  if (!n.visible) {
    /* ---- not shown */
    if ((n.hiddenReason ?? '').startsWith('Parent section')) {
      // the nearest section above it that is hidden for a reason of its own
      const path: RNode[] = [];
      const find = (cur: RNode, trail: RNode[]): boolean => { if (cur.id === n.id) { path.push(...trail); return true; } return cur.children.some((c) => find(c, [...trail, cur])); };
      find(res.root, []);
      const cause = [...path].reverse().find((a) => !a.visible && !(a.hiddenReason ?? '').startsWith('Parent section'));
      if (cause) {
        const why = whyHidden(cause);
        headline = `“${name}” is not shown to ${who} because it sits inside “${nodeWords(project, cause.id)}”, which is not shown.`;
        steps.unshift(`“${nodeWords(project, cause.id)}” is hidden because ${why}.`);
      } else headline = `“${name}” is not shown to ${who} because the section it sits in is not shown.`;
    } else {
      const why = whyHidden(n);
      headline = `“${name}” is not shown to ${who} because ${why}.`;
    }
  } else if (n.variants) {
    /* ---- a message or section chosen by rules or conditions */
    const selected = n.variants.items.filter((v) => v.selected);
    variantId = selected[0]?.id ?? null;
    if (n.variants.unresolved) {
      const tied = ruleEntries.filter((t) => t.outcome === 'tie');
      if (tied.length) {
        headline = `Nothing can be chosen for “${name}” for ${who}: ${tied.length === 2 ? 'two rules' : `${tied.length} rules`} match with the same priority.`;
        for (const t of tied.slice(0, 3)) steps.push(`${RuleName(t.ruleId)}${t.action?.op === 'selectVariant' ? ` would show “${partTitle(t.action.variantId)}” and` : ''} matches ${becauseMatched(t)}.`);
        steps.push(`${tied.length === 2 ? 'Both have' : 'They all have'} priority ${tied[0].priority}, so ${tied.length === 2 ? 'neither' : 'none'} wins and no message is chosen.`);
        const lower = ruleEntries.filter((t) => t.outcome === 'outranked');
        if (lower.length) steps.push(`${listWords(lower.map((t) => `${ruleName(t.ruleId)} (priority ${t.priority})`), 2, 'more rules')} also matched but rank${lower.length === 1 ? 's' : ''} lower.`);
        if (hasFinding('EXCLUSIVE_PRIORITY_TIE')) steps.push('This blocks the document until one rule’s priority is changed or a condition is narrowed.');
      } else {
        headline = `Nothing can be chosen for “${name}” for ${who}: no rule matched and there is no fallback.`;
        didNotMatch(ruleEntries, 3);
        if (hasFinding('NO_VARIANT_MATCH')) steps.push('This blocks the document until a fallback or a matching rule is added.');
      }
    } else if (selected.length) {
      const sv = selected[0];
      const title = partTitle(sv.id);
      if (sv.source === 'rule') {
        const winner = ruleEntries.find((t) => t.outcome === 'selected');
        if (winner) {
          headline = `${who} gets “${title}” in “${name}” because ${ruleName(winner.ruleId)} matched.`;
          steps.push(`It matched ${becauseMatched(winner)}.`);
          const lost = ruleEntries.filter((t) => t.outcome === 'outranked');
          for (const t of lost.slice(0, 2)) {
            steps.push(`${RuleName(t.ruleId)} also matched${t.action?.op === 'selectVariant' ? ` and would show “${partTitle(t.action.variantId)}”` : ''}, but the winning rule has the higher priority (${winner.priority} against ${t.priority}).`);
          }
          if (lost.length > 2) steps.push(`${countWords(lost.length - 2, 'more rule')} matched with a lower priority.`);
          didNotMatch(ruleEntries, lost.length ? 0 : 1);
        } else {
          headline = `${who} gets “${title}” in “${name}”; a rule chose it.`;
          sv.ruleIds.forEach(cite);
        }
      } else if (sv.source === 'fallback') {
        const candidates = [...ruleEntries, ...inlineEntries];
        headline = `${who} gets “${title}” in “${name}” as the fallback, because no ${ruleEntries.length || !inlineEntries.length ? 'rule' : 'condition'} for it matched.`;
        if (!candidates.length) steps.push('No rule is set up for this component, so the fallback is always used.');
        didNotMatch(candidates, 2);
      } else if (sv.source === 'section-rule') {
        const by = sv.ruleIds.map((id) => ruleEntries.find((t) => t.ruleId === id) ?? res.trace.find((t) => t.ruleId === id)).filter((t): t is TraceEntry => !!t);
        headline = `“${name}” is shown to ${who} because ${listWords(sv.ruleIds.map((id) => ruleName(id)), 3, 'more rules')} matched.`;
        for (const t of by.slice(0, 3)) steps.push(by.length === 1 ? `It matched ${becauseMatched(t)}.` : `${RuleName(t.ruleId)} matched ${becauseMatched(t)}.`);
        steps.push('Without a matching rule this section stays hidden.');
      } else {
        const met = inlineEntries.filter((t) => t.matched && t.outcome === 'selected');
        headline = `“${name}” is shown to ${who} because its condition is met.`;
        for (const t of met.slice(0, 3)) steps.push(`“${partTitle(t.ruleId.slice(n.id.length + 1))}” is shown when ${conditionWords(project, t.expression)}; for ${who}, ${facts(t)}.`);
      }
    } else {
      headline = `“${name}” is part of the document for ${who}, with no message chosen.`;
    }
    if (n.required) {
      const by = project.rules.filter((r) => r.then.op === 'requireNodes' && r.then.nodeIds.includes(n.id) && n.ruleIds.includes(r.id));
      steps.push(by.length ? `It must always be included: ${listWords(by.map((r) => ruleName(r.id)), 2, 'more rules')} require${by.length === 1 ? 's' : ''} it.` : 'It must always be included: it is marked as required in the design.');
    }
  } else if (n.required) {
    /* ---- required content */
    const by = project.rules.filter((r) => r.then.op === 'requireNodes' && r.then.nodeIds.includes(n.id) && n.ruleIds.includes(r.id));
    if (by.length) {
      headline = `“${name}” is always shown to ${who}: ${listWords(by.map((r) => ruleName(r.id)), 2, 'more rules')} require${by.length === 1 ? 's' : ''} it.`;
      for (const r of by.slice(0, 2)) { const t = res.trace.find((x) => x.ruleId === r.id); if (t) steps.push(by.length === 1 ? `That rule applies ${becauseMatched(t)}.` : `${RuleName(r.id)} applies ${becauseMatched(t)}.`); }
    } else headline = `“${name}” is always shown to ${who}: it is marked as required in the design.`;
    steps.push('Required content is never hidden by a condition or an empty value.');
  } else if (ownCondition?.matched) {
    /* ---- shown by its own condition */
    headline = `“${name}” is shown to ${who} because its condition is met.`;
    steps.push(`It is shown when ${conditionWords(project, ownCondition.expression)}; for ${who}, ${facts(ownCondition)}.`);
  } else {
    headline = `“${name}” is always shown; no rule decides this.`;
    steps.push('It has no condition and no rule shows, hides or chooses it, so every customer gets it.');
  }

  /* ---- a message that was asked about by its own name */
  if (askedVariant && askedVariant !== variantId) {
    const asked = partTitle(askedVariant);
    const own = ruleEntries.filter((t) => t.action?.op === 'selectVariant' && t.action.variantId === askedVariant);
    const first = headline;
    headline = `${who} does not get “${asked}” in “${name}”.`;
    const about: string[] = [first];
    for (const t of own.slice(0, 2)) {
      if (!t.enabled) about.push(`${RuleName(t.ruleId)}, which shows “${asked}”, is switched off.`);
      else if (t.outcome === 'outranked') about.push(`${RuleName(t.ruleId)}, which shows “${asked}”, matched but was outranked (its priority is ${t.priority}).`);
      else if (t.outcome === 'tie') about.push(`${RuleName(t.ruleId)}, which shows “${asked}”, is tied with another rule.`);
      else if (!t.matched) about.push(`${RuleName(t.ruleId)}, which shows “${asked}”, did not match: it ${needs(t)}.`);
    }
    if (!own.length) about.push(`No rule shows “${asked}”${n.variants?.fallbackVariantId === askedVariant ? '; it is the fallback, used only when no rule matches' : ''}.`);
    // the rules just described are not repeated further down
    const told = own.slice(0, 2).map((t) => `${RuleName(t.ruleId)} `);
    const others = steps.filter((x) => !told.some((p) => x.startsWith(p)));
    const lead = others.length && others[0].startsWith('It matched') ? others.splice(0, 1) : [];
    steps.length = 0;
    steps.push(about[0], ...lead, ...about.slice(1), ...others);
  }

  /* ---- facts the engine recorded about how it is shown */
  if (n.visible) {
    if (n.field?.guarded) steps.push('The amount is not shown as owed, because the member’s responsibility has not been confirmed.');
    const hintRule = (hint: string): string | null => {
      const t = res.trace.find((x) => x.kind === 'rule' && x.matched && x.action?.op === 'setPresentationHint' && x.action.hint === hint);
      return t ? RuleName(t.ruleId) : null;
    };
    if (n.table && n.visibleBecause.some((r) => r.includes('repeat headings'))) { const r = hintRule('repeating-table-headings-and-continuation'); if (r) steps.push(`${r} matched, so the column headings repeat on every page.`); }
    if (n.table && !n.table.rows.length) steps.push('There are no rows for this customer, so the table says that instead of showing an empty grid.');
    if (n.action && n.visibleBecause.some((r) => r.includes('interactive action'))) { const r = hintRule('interactive-action-with-print-fallback'); if (r) steps.push(`${r} matched, so the link is a button on the web page with a printed alternative.`); }
    if (n.action && n.visibleBecause.some((r) => r.includes('print-friendly'))) { const r = hintRule('print-friendly-guidance'); if (r) steps.push(`${r} matched, so the printed wording is used instead of a button.`); }
  }

  /* ---- language and drafts */
  const tail: string[] = [];
  const lang = languageName(res.locale);
  const short = languageShortName(res.locale);
  const localeRule = res.trace.find((t) => t.kind === 'rule' && t.matched && t.action?.op === 'setApprovedLocale' && t.action.locale === res.locale);
  if (res.locale === SOURCE_LANGUAGE) tail.push(`The document is in ${lang}.`);
  else if (localeRule) tail.push(`The document is in ${lang} because ${ruleName(localeRule.ruleId)} matched.`);
  else if (projectLanguages(project).includes(res.locale)) tail.push(`The document is in ${lang}, the customer’s preferred language.`);
  else tail.push(`The wording is in English; dates and amounts are written the ${lang} way.`);
  if (res.locale !== SOURCE_LANGUAGE && n.visible) {
    const partIds = new Set<string>([...(n.variants?.selected ?? []), ...(n.disclosure ? [n.disclosure.contentPartId] : [])]);
    const mine = (id: string): boolean => id.startsWith(`@${n.id}/`) || partIds.has(id) || (id.startsWith('@title/') && partIds.has(id.slice('@title/'.length)));
    const drafts = (res.translation?.draftsShown ?? []).filter(mine);
    const missing = (res.translation?.missing ?? []).filter(mine);
    const missingPart = (n.variants?.items ?? []).some((v) => v.selected && v.missingLocale);
    if (drafts.length) tail.push(`The ${short} wording shown here is a draft that has not been approved yet; this is a preview.`);
    else if (missing.length || missingPart) tail.push(`Some of this wording has no approved ${short} translation, so the English text is shown.`);
  }

  const room = Math.max(1, MAX_STEPS - tail.length);
  return { headline, steps: [...steps.slice(0, room), ...tail], ruleIds, variantId, nodeId };
}
