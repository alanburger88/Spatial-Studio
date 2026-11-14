import {
  channelConfig, diffProjects, LIBRARY_KIND_LABEL, WORDING_RULE_KIND_LABEL, EMAIL_SECTION_LABELS, languageName, periodInWords, projectLanguages, richToPlain, SOURCE_LANGUAGE, tokensOfText, translatableStrings, translationStatus,
  type ChannelConfig, type DocNode, type GlossaryEntry, type Predicate, type Project, type SyntheticRecord,
} from '@iss/model';
import { resolve } from '@iss/resolver';
import { impactOf, type ImpactChange, type ImpactRecord } from '../impact';
import { runTestCases } from '../testCases';
import type { ChangeSummary } from './types';
import { actionWords, conditionWords, countWords, fieldWords, listWords, nodeWords, ruleWords } from './writing';

/**
 * What changed between two versions of a project, for the person who has to approve it: one plain sentence per change
 * grouped by area, what it does to the synthetic customers, and what to look at first. Pure and computed: it builds on
 * the structural diff (`diffProjects`) and on the engine's own before/after results (`impactOf`, `resolve`).
 */

type Area = ChangeSummary['sections'][number]['area'];
const AREA_ORDER: Area[] = ['wording', 'rules', 'layout', 'translations', 'channels', 'settings', 'tests'];
const AREA_TITLE: Record<Area, string> = {
  wording: 'Wording', rules: 'Rules and conditions', layout: 'Layout and components', translations: 'Translations',
  channels: 'Email and text message', settings: 'Settings', tests: 'Tests',
};
/** A section never lists more than this many sentences of one kind; the rest is counted. */
const LIST_MAX = 6;

const clip = (s: string, n = 90): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const q = (s: string | null | undefined, n = 90): string => `“${clip(s ?? '', n)}”`;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const conjuncts = (p: Predicate): Predicate[] => (p.op === 'and' ? p.args.flatMap(conjuncts) : [p]);
const key = (p: Predicate): string => JSON.stringify(p);

/** "…and 9 more labels" */
function collapse(list: string[], noun: string, max = LIST_MAX): string[] {
  if (list.length <= max) return list;
  const rest = list.length - (max - 1);
  return [...list.slice(0, max - 1), `…and ${rest} more ${noun}`];
}

const CHANNEL_TOKEN_WORDS: Record<string, string> = { 'issuer.name': 'the issuer’s name', 'issuer.product': 'the product name', keyFacts: 'the key figures', link: 'the link' };
const FORMAT_WORDS: Record<string, string> = { 'usd-cents': 'an amount in dollars', date: 'a date', text: 'plain text', int: 'a whole number', percent: 'a percentage', points: 'points' };
const BRAND_WORDS: Record<string, string> = { primary: 'main brand colour', accent: 'accent colour', text: 'text colour', fontFamily: 'document font', logoDataUri: 'brand logo', logoAlt: 'logo description' };
const OTHER_WORDS: Record<string, string> = { issuer: 'issuer details', rootNodeId: 'document structure', documentType: 'kind of document', schemaVersion: 'file format version', accessiblePdfRequired: 'whether an accessible PDF is required' };

/** Blocking finding in plain words. `where` is the component or text the finding is about. */
function blockingWords(code: string, where: string): string {
  const at = where ? `“${where}”` : 'the document';
  switch (code) {
    case 'EXCLUSIVE_PRIORITY_TIE': return `two rules tie for ${at}`;
    case 'NO_VARIANT_MATCH': return `no rule matches for ${at} and it has no fallback`;
    case 'REQUIRED_TRANSLATION_MISSING': return `a required translation of ${at} is missing`;
    case 'MISSING_CONTENT_PART': return `${at} points to wording that does not exist`;
    case 'UNKNOWN_VARIANT': return `a rule chooses a message that ${at} does not have`;
    case 'REQUIRED_NODE_MISSING': return `required content ${at} is missing from the document`;
    case 'INVALID_BINDING': return `${at} uses a data field that does not exist`;
    case 'NULL_BINDING': return `${at} has no value but must have one`;
    case 'UNSAFE_URL': return `the link in ${at} is not a safe web address`;
    case 'UNCONFIRMED_DEBT_LANGUAGE': return `${at} words an unconfirmed amount as owed`;
    case 'UNCONFIRMED_MEMBER_LIABILITY': case 'CLAIM_RECONCILIATION_FAILED': case 'BALANCE_RECONCILIATION_FAILED': case 'INCONSISTENT_PAYMENT_STATE': case 'RECORD_TYPE_MISMATCH':
      return 'the customer’s data does not add up';
    default: return `${code.toLowerCase().replace(/_/g, ' ')}${where ? ` in ${at}` : ''}`;
  }
}

/** Customer-visible text of a component, with data tokens written as {{path}}. */
function nodeText(n: DocNode | undefined): string {
  if (!n) return '';
  return [
    n.content ? richToPlain(n.content) : '', n.headerFooter?.text ?? '', n.explanation ? `${n.explanation.title} ${n.explanation.summary} ${n.explanation.details}` : '',
    n.action ? `${n.action.label} ${n.action.fallbackText}` : '', n.qr?.caption ?? '', n.label ?? '', n.caption ?? '', n.fallbackText ?? '',
  ].filter(Boolean).join(' ');
}

/**
 * `opts.issueDate` is "as issued on": the customer impact (who changes, who becomes blocked) is worked out on that day,
 * the same day the screen previews. Without it, or for a document without a date source, nothing changes.
 */
export function summarizeChanges(before: Project, after: Project, records: SyntheticRecord[], opts: { issueDate?: string | null } = {}): ChangeSummary {
  const issueDate = opts.issueDate ?? null;
  const d = diffProjects(before, after);
  const mine = records.filter((r) => r.documentType === after.documentType);

  const items: Record<Area, string[]> = { wording: [], rules: [], layout: [], translations: [], channels: [], settings: [], tests: [] };
  const count: Record<Area, number> = { wording: 0, rules: 0, layout: 0, translations: 0, channels: 0, settings: 0, tests: 0 };
  const add = (area: Area, sentence: string, n = 1) => { items[area].push(sentence); count[area] += n; };

  // attention material, gathered while walking the changes
  const disclosureNotes: string[] = [];
  const fallbackNotes: Array<{ nodeId: string; text: string }> = [];
  const amountNotes: string[] = [];
  const translationNotes: string[] = [];

  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const beforeParts = new Map(before.contentParts.map((c) => [c.id, c]));
  const afterParts = new Map(after.contentParts.map((c) => [c.id, c]));
  const nameOf = (id: string): string => (afterNodes.has(id) || afterParts.has(id) ? nodeWords(after, id) : nodeWords(before, id));
  const partName = (id: string): string => afterParts.get(id)?.title ?? beforeParts.get(id)?.title ?? nameOf(id);
  const requiredIds = (p: Project): Set<string> => {
    const ids = new Set<string>();
    for (const r of p.rules) if (r.then.op === 'requireNodes' && r.enabled !== false) r.then.nodeIds.forEach((i) => ids.add(i));
    for (const n of p.nodes) { if (n.required) { ids.add(n.id); if (n.contentPartId) ids.add(n.contentPartId); } if (n.type === 'disclosure') ids.add(n.contentPartId ?? n.id); }
    return ids;
  };
  const requiredBefore = requiredIds(before);
  const tokenWords = (path: string): string => CHANNEL_TOKEN_WORDS[path] ?? (path.startsWith('{') ? `the value ${path}` : fieldWords(after, path));
  /** "“X” no longer shows Payment due date" when the data shown inside a text changes. */
  const tokenChange = (label: string, from: string, to: string) => {
    const a = tokensOfText(from), b = tokensOfText(to);
    const gone = [...new Set(a.filter((t) => !b.includes(t)))], come = [...new Set(b.filter((t) => !a.includes(t)))];
    if (gone.length) amountNotes.push(`${label} no longer shows ${listWords(gone.map(tokenWords), 3, 'more values')}`);
    if (come.length) amountNotes.push(`${label} now shows ${listWords(come.map(tokenWords), 3, 'more values')}`);
  };

  /* ------------------------------------------------------------------ wording: messages and disclosures */
  const labelChanges: string[] = [];
  for (const c of d.content.added) add('wording', `New ${afterParts.get(c.id)?.type === 'disclosure' ? 'disclosure' : 'message'} ${q(c.name)} added`);
  for (const c of d.content.removed) {
    const wasDisclosure = beforeParts.get(c.id)?.type === 'disclosure';
    add('wording', `${wasDisclosure ? 'Disclosure' : 'Message'} ${q(c.name)} removed`);
    if (wasDisclosure || requiredBefore.has(c.id)) disclosureNotes.push(`the required wording ${q(c.name)} was removed`);
  }
  for (const r of d.content.renamed) labelChanges.push(`The heading ${q(r.from)} is now ${q(r.to)}`);
  for (const c of d.content.changed) {
    if (c.locale !== SOURCE_LANGUAGE || c.kind !== 'approved') continue;
    const was = beforeParts.get(c.partId)?.approvedLocales[SOURCE_LANGUAGE] ?? '', now = afterParts.get(c.partId)?.approvedLocales[SOURCE_LANGUAGE] ?? '';
    add('wording', now ? `The wording of ${q(c.title)} now reads ${q(now)}` : `The English wording of ${q(c.title)} was removed`);
    tokenChange(q(c.title), was, now);
    if (afterParts.get(c.partId)?.type === 'disclosure' || requiredBefore.has(c.partId)) disclosureNotes.push(`the required wording ${q(c.title)} was changed`);
    for (const loc of projectLanguages(after)) {
      const t = afterParts.get(c.partId)?.approvedLocales[loc];
      if (t?.trim() && t === beforeParts.get(c.partId)?.approvedLocales[loc]) translationNotes.push(`the English of ${q(c.title)} changed but its approved ${languageName(loc)} translation did not`);
    }
  }

  /* ------------------------------------------------------------------ components */
  const moved: string[] = [];
  const otherDetails: string[] = [];
  for (const c of d.components.added) add('layout', `${q(c.name)} added`);
  for (const c of d.components.removed) {
    add('layout', `${q(c.name)} removed`);
    const was = beforeNodes.get(c.id);
    if (requiredBefore.has(c.id) || was?.type === 'disclosure') disclosureNotes.push(`the required content ${q(c.name)} was removed`);
    if (was?.binding) amountNotes.push(`${q(c.name)}, which showed ${fieldWords(before, was.binding)}, was removed`);
  }
  for (const c of d.components.changed) {
    const a = beforeNodes.get(c.id), b = afterNodes.get(c.id);
    if (!a || !b) continue;
    const name = q(b.name ?? a.name ?? nameOf(c.id));
    let textChanged = false, detail = false;
    for (const f of c.fields) {
      switch (f) {
        case 'content': case 'headerFooter': case 'explanation': case 'qr': {
          const now = f === 'content' ? richToPlain(b.content) : f === 'headerFooter' ? b.headerFooter?.text ?? '' : f === 'qr' ? b.qr?.caption ?? '' : b.explanation ? `${b.explanation.title}: ${b.explanation.summary}` : '';
          add('wording', now.trim() ? `The text of ${name} now reads ${q(now)}` : `The text of ${name} was removed`);
          textChanged = true;
          break;
        }
        case 'action': {
          if (a.action?.label !== b.action?.label || a.action?.fallbackText !== b.action?.fallbackText) { add('wording', `The link wording of ${name} changed${b.action?.label ? ` to ${q(b.action.label)}` : ''}`); textChanged = true; }
          if (a.action?.url !== b.action?.url) add('wording', `The link of ${name} now goes to ${b.action?.url ?? 'nowhere'}`);
          break;
        }
        case 'label': labelChanges.push(b.label ? `The label ${q(a.label ?? a.name ?? c.id)} is now ${q(b.label)}` : `The label of ${name} was removed`); break;
        case 'caption': labelChanges.push(`The title of ${name} is now ${q(b.caption)}`); break;
        case 'fallbackText': add('wording', `The text ${name} shows when it has no value is now ${q(b.fallbackText)}`); break;
        case 'columns': {
          const ac = a.columns ?? [], bc = b.columns ?? [];
          for (const col of bc) {
            const old = ac.find((x) => x.key === col.key);
            if (!old) add('layout', `Column ${q(col.label)} added to ${name}`);
            else {
              if (old.label !== col.label) labelChanges.push(`The column ${q(old.label)} of ${name} is now ${q(col.label)}`);
              if (old.format !== col.format) { add('layout', `Column ${q(col.label)} of ${name} is now shown as ${FORMAT_WORDS[col.format ?? 'text'] ?? col.format}`); amountNotes.push(`column ${q(col.label)} of ${name} is formatted differently`); }
              if (old.domainRole !== col.domainRole) { add('layout', `The safeguard on column ${q(col.label)} of ${name} changed`); amountNotes.push(`the safeguard on column ${q(col.label)} of ${name} changed`); }
            }
          }
          for (const col of ac) if (!bc.some((x) => x.key === col.key)) add('layout', `Column ${q(col.label)} removed from ${name}`);
          if (same(ac.map((x) => x.key).sort(), bc.map((x) => x.key).sort()) && !same(ac.map((x) => x.key), bc.map((x) => x.key))) add('layout', `The columns of ${name} were reordered`);
          break;
        }
        case 'chart': {
          if (a.chart?.title !== b.chart?.title) labelChanges.push(`The chart title of ${name} is now ${q(b.chart?.title)}`);
          const al = (a.chart?.series ?? []).map((x) => x.label), bl = (b.chart?.series ?? []).map((x) => x.label);
          if (!same(al, bl)) labelChanges.push(`The series names of the chart ${name} changed`);
          const ap = (a.chart?.series ?? []).map((x) => x.path), bp = (b.chart?.series ?? []).map((x) => x.path);
          if (!same(ap, bp) || a.chart?.valueKey !== b.chart?.valueKey || a.chart?.groupBy !== b.chart?.groupBy) { add('layout', `The chart ${name} now draws different data`); amountNotes.push(`the chart ${name} draws different data`); }
          else if (!same({ ...a.chart, title: '', series: [] }, { ...b.chart, title: '', series: [] })) detail = true;
          break;
        }
        case 'image': {
          if (a.image?.alt !== b.image?.alt) add('wording', `The description of the picture ${name} is now ${q(b.image?.alt)}`);
          if (a.image?.src !== b.image?.src) add('layout', `The picture ${name} was replaced`);
          else if (a.image?.fit !== b.image?.fit) detail = true;
          break;
        }
        case 'layout': moved.push(name); break;
        case 'children': {
          const ai = a.children ?? [], bi = b.children ?? [];
          const sameSet = same([...ai].sort(), [...bi].sort());
          if (sameSet) add('layout', `The order of the components inside ${name} changed`);
          else {
            const movedIn = bi.filter((x) => !ai.includes(x) && beforeNodes.has(x)), movedOut = ai.filter((x) => !bi.includes(x) && afterNodes.has(x));
            for (const x of movedIn) add('layout', `${q(nameOf(x))} was moved into ${name}`);
            if (!movedIn.length && movedOut.length === 0 && !same(ai.filter((x) => bi.includes(x)), bi.filter((x) => ai.includes(x)))) add('layout', `The order of the components inside ${name} changed`);
          }
          break;
        }
        case 'name': add('layout', `The component ${q(a.name ?? c.id)} was renamed ${q(b.name ?? c.id)}`); break;
        case 'styleId': add('layout', b.styleId ? `${name} now uses the text style ${q(after.styles?.find((s) => s.id === b.styleId)?.name ?? b.styleId)}` : `${name} no longer uses a named text style`); break;
        case 'visibleWhen':
          add('rules', !b.visibleWhen ? `${name} no longer has a condition and is always shown` : !a.visibleWhen ? `${name} is now shown only when ${conditionWords(after, b.visibleWhen)}` : `${name} is now shown when ${conditionWords(after, b.visibleWhen)} (before: when ${conditionWords(before, a.visibleWhen)})`);
          break;
        case 'ruleDriven': add('rules', b.ruleDriven ? `${name} now appears only when a rule shows it` : `${name} no longer waits for a rule to show it`); break;
        case 'variantIds': {
          const av = a.variantIds ?? [], bv = b.variantIds ?? [];
          for (const v of bv) if (!av.includes(v)) add('rules', `The message ${q(partName(v))} can now be chosen in ${name}`);
          for (const v of av) if (!bv.includes(v)) add('rules', `The message ${q(partName(v))} can no longer be chosen in ${name}`);
          if (same([...av].sort(), [...bv].sort()) && !same(av, bv)) add('rules', `The order of the messages in ${name} changed`);
          break;
        }
        case 'fallbackVariantId':
          if (!b.fallbackVariantId) { add('rules', `${name} no longer has a fallback message`); fallbackNotes.push({ nodeId: c.id, text: `${name} no longer has a fallback (it was ${q(partName(a.fallbackVariantId ?? ''))}), so a customer no rule matches gets no message there and cannot get a document` }); }
          else add('rules', a.fallbackVariantId ? `The fallback message of ${name} is now ${q(partName(b.fallbackVariantId))} (before: ${q(partName(a.fallbackVariantId))})` : `${name} now has a fallback message: ${q(partName(b.fallbackVariantId))}`);
          break;
        case 'variantConditions': add('rules', `The conditions that choose a message in ${name} changed`); break;
        case 'required':
          add('rules', b.required ? `${name} is now required content` : `${name} is no longer required content`);
          if (!b.required) disclosureNotes.push(`${name} is no longer required`);
          break;
        case 'contentPartId':
          add('wording', `${name} now shows the wording ${q(partName(b.contentPartId ?? ''))}`);
          if (requiredBefore.has(c.id) || a.type === 'disclosure') disclosureNotes.push(`${name} now shows different wording`);
          break;
        case 'binding':
          add('layout', `${name} now shows ${b.binding ? fieldWords(after, b.binding) : 'no data'}${a.binding ? ` instead of ${fieldWords(before, a.binding)}` : ''}`);
          amountNotes.push(`${name} now shows ${b.binding ? fieldWords(after, b.binding) : 'no data'}${a.binding ? ` instead of ${fieldWords(before, a.binding)}` : ''}`);
          break;
        case 'formatter':
          add('layout', `${name} is now written as ${FORMAT_WORDS[b.formatter ?? 'text'] ?? b.formatter}`);
          amountNotes.push(`${name} is now written as ${FORMAT_WORDS[b.formatter ?? 'text'] ?? b.formatter}`);
          break;
        case 'domainRole':
          add('layout', `The safeguard on the amount ${name} changed`);
          amountNotes.push(`the safeguard on the amount ${name} changed`);
          break;
        case 'nullPolicy': add('layout', `What ${name} shows when it has no value changed`); break;
        case 'effective': add('rules', b.effective ? `${name} is now shown only ${periodInWords(b.effective)}${a.effective ? ` (before: ${periodInWords(a.effective)})` : ''}` : `${name} is no longer limited to a period`); break;
        case 'variantPeriods': {
          const ids = [...new Set([...Object.keys(a.variantPeriods ?? {}), ...Object.keys(b.variantPeriods ?? {})])].sort();
          for (const v of ids) if (!same(a.variantPeriods?.[v], b.variantPeriods?.[v])) add('rules', b.variantPeriods?.[v] ? `The message ${q(partName(v))} in ${name} can now be chosen only ${periodInWords(b.variantPeriods[v])}` : `The message ${q(partName(v))} in ${name} is no longer limited to a period`);
          break;
        }
        case 'totalFrom':
          add('layout', b.totalFrom ? `The footer of ${name} now shows ${fieldWords(after, b.totalFrom)}` : `The footer of ${name} adds up its amount column again`);
          amountNotes.push(`the total in the footer of ${name} changed`);
          break;
        default: detail = true;
      }
    }
    if (textChanged) {
      tokenChange(name, nodeText(a), nodeText(b));
      if (requiredBefore.has(c.id)) disclosureNotes.push(`the required content ${name} has new wording`);
    }
    if (detail) otherDetails.push(name);
  }
  if (labelChanges.length) { items.wording.push(...collapse(labelChanges, 'labels')); count.wording += labelChanges.length; }
  if (moved.length) { items.layout.push(moved.length <= 3 ? `${listWords(moved, 3)} ${moved.length === 1 ? 'was' : 'were'} moved or resized` : `${listWords(moved, 3, 'components')} were moved or resized`); count.layout += moved.length; }
  if (otherDetails.length) { items.layout.push(`Other details of ${listWords(otherDetails, 3, 'components')} changed`); count.layout += otherDetails.length; }
  for (const p of d.profiles.changed) add('layout', `The page or output settings of ${q(p.name)} changed`);
  items.layout = collapse(items.layout, 'layout changes');

  /* ------------------------------------------------------------------ rules */
  for (const r of d.rules.added) {
    add('rules', `New rule ${q(ruleWords(after, r.rule))}: when ${conditionWords(after, r.rule.when)}, ${actionWords(after, r.rule.then)}${r.enabled ? '' : ' (switched off)'}`);
    if (r.rule.mode === 'obligation') disclosureNotes.push(`the new rule ${q(ruleWords(after, r.rule))} makes content required`);
  }
  for (const r of d.rules.removed) {
    add('rules', `Rule ${q(ruleWords(before, r.rule))} removed`);
    if (r.rule.mode === 'obligation') disclosureNotes.push(`the rule ${q(ruleWords(before, r.rule))}, which made content required, was removed`);
  }
  for (const c of d.rules.changed) {
    const name = q(ruleWords(after, c.after));
    const said: string[] = [];
    if (c.condition) {
      const was = conjuncts(c.before.when), now = conjuncts(c.after.when);
      const added = now.filter((x) => !was.some((y) => key(y) === key(x))), dropped = was.filter((x) => !now.some((y) => key(y) === key(x)));
      if (added.length && !dropped.length) said.push(`now also requires that ${listWords(added.map((x) => conditionWords(after, x)), 4)}`);
      else if (dropped.length && !added.length) said.push(`no longer requires that ${listWords(dropped.map((x) => conditionWords(before, x)), 4)}`);
      else said.push(`now applies when ${conditionWords(after, c.after.when)} (before: when ${conditionWords(before, c.before.when)})`);
    }
    if (c.action) said.push(`now does this: ${actionWords(after, c.after.then)} (before: ${actionWords(before, c.before.then)})`);
    if (c.priority) said.push(`has priority ${c.priority.to} instead of ${c.priority.from}`);
    if (c.enabled) said.push(c.enabled.to ? 'is switched on again' : 'is switched off');
    if (c.mode) said.push(`changed kind from ${c.mode.from} to ${c.mode.to}`);
    if (c.period) said.push(c.after.effective ? `is now in effect ${c.period.to} (before: ${c.period.from})` : 'is no longer limited to a period');
    if (c.title) said.unshift(`was renamed (before: ${q(c.title.from ?? ruleWords(before, c.before))})`);
    const rest = c.fields.filter((f) => !['when', 'then', 'priority', 'enabled', 'mode', 'title', 'version', 'effective'].includes(f));
    if (rest.length) said.push('has other details changed');
    if (!said.length) continue; // only its version counter moved
    add('rules', `Rule ${name} ${listWords(said, 4)}`);
    if ((c.before.mode === 'obligation' || c.after.mode === 'obligation') && (c.action || c.condition || c.enabled || c.mode)) disclosureNotes.push(`the rule ${name}, which makes content required, changed`);
  }
  /* calculated fields, lookup tables and the document's date */
  for (const c of d.calculations.added) add('rules', `New calculation ${q(c.name)}`);
  for (const c of d.calculations.removed) add('rules', `Calculation ${q(c.name)} removed`);
  for (const c of d.calculations.changed) {
    add('rules', c.formula ? `Calculation ${q(c.name)} is now worked out as ${c.formula.to} (before: ${c.formula.from})` : `Calculation ${q(c.name)} changed (${listWords(c.fields.map((f) => (f === 'label' ? 'its name' : f === 'type' ? 'the kind of value it gives' : f === 'description' ? 'its description' : f)), 3)})`);
    if (c.formula || c.fields.includes('type')) amountNotes.push(`the calculation ${q(c.name)} changed, so every value shown from it may differ`);
  }
  for (const t of d.lookupTables.added) add('rules', `New lookup table ${q(t.name)}`);
  for (const t of d.lookupTables.removed) add('rules', `Lookup table ${q(t.name)} removed`);
  for (const t of d.lookupTables.changed) {
    add('rules', `Lookup table ${q(t.name)} changed${t.rows.from !== t.rows.to ? ` (${countWords(t.rows.to, 'row')} instead of ${t.rows.from})` : ''}`);
    amountNotes.push(`the lookup table ${q(t.name)} changed, so values read from it may differ`);
  }
  if (d.documentDate) add('rules', d.documentDate.to ? `The document’s date is now ${d.documentDate.to}${d.documentDate.from ? ` (before: ${d.documentDate.from})` : ''}` : 'The document no longer uses its date');
  items.rules = collapse(items.rules, 'rule and condition changes');

  /* ------------------------------------------------------------------ translations */
  interface Ev { id: string; title: string; locale: string; kind: 'approved' | 'draft'; from: string | null; to: string | null }
  const events: Ev[] = [];
  for (const c of d.content.changed) if (c.locale !== SOURCE_LANGUAGE) events.push({ id: c.partId, title: c.title, locale: c.locale, kind: c.kind, from: c.from, to: c.to });
  const stringTitles = new Map<string, string>();
  const stringIds = new Set([...Object.keys(before.strings ?? {}), ...Object.keys(after.strings ?? {})]);
  if (stringIds.size) { for (const s of translatableStrings(before)) stringTitles.set(s.id, s.title); for (const s of translatableStrings(after)) stringTitles.set(s.id, s.title); }
  for (const id of [...stringIds].sort()) {
    const a = before.strings?.[id], b = after.strings?.[id];
    for (const kind of ['approved', 'draft'] as const) {
      const la = (kind === 'approved' ? a?.approved : a?.draft) ?? {}, lb = (kind === 'approved' ? b?.approved : b?.draft) ?? {};
      for (const loc of [...new Set([...Object.keys(la), ...Object.keys(lb)])].sort()) {
        const from = la[loc] ?? null, to = lb[loc] ?? null;
        if (from !== to) events.push({ id, title: stringTitles.get(id) ?? id, locale: loc, kind, from, to });
      }
    }
  }
  let approvedTotal = 0, draftTotal = 0, otherTranslation = 0;
  for (const loc of [...new Set(events.map((e) => e.locale))].sort()) {
    const lang = languageName(loc);
    const ev = events.filter((e) => e.locale === loc);
    const approved = ev.filter((e) => e.kind === 'approved' && e.to?.trim());
    const approvedIds = new Set(approved.map((e) => e.id));
    const unapproved = ev.filter((e) => e.kind === 'approved' && !e.to?.trim());
    const drafted = ev.filter((e) => e.kind === 'draft' && e.to?.trim() && !approvedIds.has(e.id));
    const discarded = ev.filter((e) => e.kind === 'draft' && !e.to?.trim() && !approvedIds.has(e.id));
    const names = (list: Ev[]): string => listWords(list.map((e) => q(e.title, 50)), 3, 'more');
    if (approved.length) { items.translations.push(`${countWords(approved.length, `${lang} translation`)} approved: ${names(approved)}`); approvedTotal += approved.length; }
    if (drafted.length) {
      items.translations.push(`${countWords(drafted.length, `${lang} draft`)} added or edited, not approved yet: ${names(drafted)}`);
      draftTotal += drafted.length;
      translationNotes.unshift(`${countWords(drafted.length, `${lang} draft`)} in this change ${drafted.length === 1 ? 'is' : 'are'} not approved yet, so customers keep getting the approved or the English text`);
    }
    if (unapproved.length) {
      items.translations.push(`${countWords(unapproved.length, `approved ${lang} translation`)} removed: ${names(unapproved)}`);
      otherTranslation += unapproved.length;
      translationNotes.unshift(`${countWords(unapproved.length, `approved ${lang} translation`)} ${unapproved.length === 1 ? 'was' : 'were'} removed (${names(unapproved)})`);
    }
    if (discarded.length) { items.translations.push(`${countWords(discarded.length, `${lang} draft`)} discarded: ${names(discarded)}`); otherTranslation += discarded.length; }
  }
  // translations whose English changed after they were approved (labels, headings, email and SMS wording)
  if (after.strings && Object.keys(after.strings).length) {
    for (const loc of projectLanguages(after)) {
      const was = new Set(translationStatus(before, loc).rows.filter((r) => r.sourceChanged).map((r) => r.partId));
      const stale = translationStatus(after, loc).rows.filter((r) => r.sourceChanged && !was.has(r.partId));
      if (!stale.length) continue;
      const names = listWords(stale.map((r) => q(r.title, 50)), 3, 'more');
      items.translations.push(`The English of ${countWords(stale.length, 'text')} changed after ${stale.length === 1 ? 'its' : 'their'} ${languageName(loc)} translation was approved: ${names}`);
      otherTranslation += stale.length;
      translationNotes.push(`the English of ${names} changed after the ${languageName(loc)} translation was approved, so that translation may be out of date`);
    }
  }
  count.translations = approvedTotal + draftTotal + otherTranslation;

  /* ------------------------------------------------------------------ email and text message */
  const cb: ChannelConfig = channelConfig(before), ca: ChannelConfig = channelConfig(after);
  const channelTexts: Array<[string, string, string]> = [
    ['The email subject line', cb.email.subject, ca.email.subject], ['The email preview text', cb.email.preheader, ca.email.preheader], ['The email heading', cb.email.title, ca.email.title],
    ['The email opening text', cb.email.intro, ca.email.intro], ['The email closing text', cb.email.closing, ca.email.closing], ['The heading above the key figures in the email', cb.email.keyFactsHeading, ca.email.keyFactsHeading],
    ['The text message', cb.sms.text, ca.sms.text],
  ];
  for (const [what, was, now] of channelTexts) {
    if (was === now) continue;
    add('channels', !now.trim() ? `${what} was removed` : !was.trim() ? `${what} was added: ${q(now, 120)}` : `${what} now reads ${q(now, 120)}`);
    tokenChange(what.replace(/^The /, 'the '), was, now);
    if (/NOT A BILL/i.test(was) && !/NOT A BILL/i.test(now)) disclosureNotes.push(`${what.replace(/^The /, 'the ')} no longer says “THIS IS NOT A BILL”`);
  }
  for (const s of ca.email.sections) {
    const old = cb.email.sections.find((x) => x.id === s.id);
    if (old && old.show !== s.show) add('channels', `The email section ${q(EMAIL_SECTION_LABELS[s.id] ?? s.id)} is now ${s.show ? 'shown' : 'hidden'}`);
  }
  if (!same(cb.email.sections.map((s) => s.id), ca.email.sections.map((s) => s.id))) add('channels', 'The order of the email sections changed');

  /* ------------------------------------------------------------------ settings */
  // Shared library: what the document took from the library, moved to another version of, or made its own.
  if (d.library) {
    const kind = (k: string) => (LIBRARY_KIND_LABEL as Record<string, string>)[k]?.toLowerCase() ?? k;
    for (const l of d.library.linked) add('settings', `Now uses the library ${kind(l.kind)} ${q(l.title)} (version ${l.version}), read-only in this document`);
    for (const l of d.library.updated) add('settings', `The library ${kind(l.kind)} ${q(l.title)} was updated from version ${l.from} to version ${l.version}`);
    for (const l of d.library.unlinked) add('settings', `The library ${kind(l.kind)} ${q(l.title)} was unlinked: its content is now this document’s own`);
  }
  // The document's own wording rules (wave 2): what it now asks of its wording.
  if (d.wordingRules) {
    const rw = (r: { kind: string; phrase?: string; severity: string }) => `${(WORDING_RULE_KIND_LABEL as Record<string, string>)[r.kind] ?? r.kind}${r.phrase ? ` ${q(r.phrase)}` : ''} (${r.severity})`;
    for (const r of d.wordingRules.added) add('wording', `Wording rule added: ${rw(r)}`);
    for (const r of d.wordingRules.removed) add('wording', `Wording rule removed: ${rw(r)}`);
    for (const r of d.wordingRules.changed) add('wording', `Wording rule changed: ${rw(r)}${r.severityChange ? `, now a “${r.severityChange.to}” (was a “${r.severityChange.from}”)` : ''}`);
  }
  // Mappings to a production system (wave 3): never change what a customer gets, only what is handed over.
  if (d.mappings) {
    for (const m of d.mappings.added) add('settings', `Mapping ${q(m.name)} added, for ${q(m.system)}`);
    for (const m of d.mappings.removed) add('settings', `Mapping ${q(m.name)} removed`);
    for (const m of d.mappings.changed) {
      const parts: string[] = [];
      if (m.renamed) parts.push(`renamed from ${q(m.renamed.from)}`);
      if (m.systemChange) parts.push(`now for ${q(m.systemChange.to)}`);
      if (m.description) parts.push('its description changed');
      if (m.targetFields) parts.push(`the target’s field list now has ${countWords(m.targetFields.to, 'field')}`);
      const e = m.entries;
      const decided = [e.added ? `${countWords(e.added, 'field')} mapped` : '', e.changed ? `${countWords(e.changed, 'field')} changed` : '', e.removed ? `${countWords(e.removed, 'field')} cleared` : ''].filter(Boolean);
      if (decided.length) parts.push(decided.join(', '));
      add('settings', `Mapping ${q(m.name)}: ${parts.join('; ')}`);
    }
  }
  if (d.title) add('settings', `The project was renamed from ${q(d.title.from)} to ${q(d.title.to)}`);
  const langsBefore = projectLanguages(before), langsAfter = projectLanguages(after);
  for (const l of langsAfter) if (!langsBefore.includes(l)) add('settings', `Language added: ${languageName(l)}`);
  for (const l of langsBefore) if (!langsAfter.includes(l)) add('settings', `Language removed: ${languageName(l)}`);
  for (const s of d.styles.added) add('settings', `Text style ${q(s.name)} added`);
  for (const s of d.styles.removed) add('settings', `Text style ${q(s.name)} removed`);
  for (const s of d.styles.changed) add('settings', `Text style ${q(s.name)} changed`);
  for (const b of d.brand.changed) add('settings', b.to === null ? `The ${BRAND_WORDS[b.field] ?? b.field} was removed` : b.field === 'logoDataUri' ? 'The brand logo was replaced' : `The ${BRAND_WORDS[b.field] ?? b.field} is now ${b.to}${b.from ? ` (before: ${b.from})` : ''}`);
  for (const loc of [...new Set([...Object.keys(before.glossary ?? {}), ...Object.keys(after.glossary ?? {})])].sort()) {
    const a: GlossaryEntry[] = before.glossary?.[loc] ?? [], b: GlossaryEntry[] = after.glossary?.[loc] ?? [];
    const k = (g: GlossaryEntry) => g.source.trim().toLowerCase();
    const added = b.filter((g) => !a.some((x) => k(x) === k(g))).length, removed = a.filter((g) => !b.some((x) => k(x) === k(g))).length;
    const changed = b.filter((g) => { const o = a.find((x) => k(x) === k(g)); return o && !same(o, g); }).length;
    const parts = [added ? `${countWords(added, 'term')} added` : '', changed ? `${countWords(changed, 'term')} changed` : '', removed ? `${countWords(removed, 'term')} removed` : ''].filter(Boolean);
    if (parts.length) add('settings', `${languageName(loc)} glossary: ${parts.join(', ')}`, added + changed + removed);
  }
  for (const f of d.customFields.added) add('settings', `Data field ${q(f.name)} added`);
  for (const f of d.customFields.removed) add('settings', `Data field ${q(f.name)} removed`);
  for (const f of d.customFields.changed) add('settings', `Data field ${q(f.name)} changed`);
  for (const j of d.journey.added) add('settings', `Journey step ${q(j.name)} added`);
  for (const j of d.journey.removed) add('settings', `Journey step ${q(j.name)} removed`);
  for (const j of d.journey.changed) add('settings', `Journey step ${q(j.name)} changed`);
  const handledElsewhere = new Set(['strings', 'translationOrigins', 'channels', 'glossary', 'languages']);
  const others = d.other.filter((o) => !handledElsewhere.has(o));
  if (others.length) add('settings', `Other project details changed: ${listWords(others.map((o) => OTHER_WORDS[o] ?? o.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()), 4)}`, others.length);
  items.settings = collapse(items.settings, 'settings');

  /* ------------------------------------------------------------------ tests */
  for (const t of d.testCases.added) add('tests', `Test ${q(t.name)} added`);
  for (const t of d.testCases.removed) add('tests', `Test ${q(t.name)} removed`);
  for (const t of d.testCases.changed) add('tests', `Test ${q(t.name)} changed`);
  items.tests = collapse(items.tests, 'tests');
  items.wording = items.wording.length > LIST_MAX + 2 ? collapse(items.wording, 'wording changes', LIST_MAX + 2) : items.wording;

  /* ------------------------------------------------------------------ nothing changed */
  const total = AREA_ORDER.reduce((s, a) => s + count[a], 0);
  if (!total) {
    return { headline: 'No changes', sections: [], impact: { changedCustomers: 0, totalCustomers: mine.length, newlyBlocked: 0, unblocked: 0, examples: [] }, attention: [], source: 'builtin' };
  }

  /* ------------------------------------------------------------------ what it does to customers */
  const impact = impactOf(before, after, records, issueDate);
  const byId = new Map(mine.map((r) => [r.recordId, r]));
  const blocked = (p: Project, r: SyntheticRecord): boolean => resolve({ project: p, record: r, overrides: {}, journeyCursor: null, ...(issueDate ? { issueDate } : {}) }).findings.some((f) => f.severity === 'blocking');
  const newlyBlockedNames: string[] = [], unblockedNames: string[] = [];
  for (const c of impact.changed) {
    if (!c.changes.some((x) => x.kind === 'blocking')) continue;
    const rec = byId.get(c.recordId);
    if (!rec) continue;
    const was = blocked(before, rec), now = blocked(after, rec);
    if (!was && now) newlyBlockedNames.push(c.name);
    if (was && !now) unblockedNames.push(c.name);
  }
  const variantName = (ids: string): string => ids.split(', ').filter(Boolean).map((id) => `“${partName(id)}”`).join(' and ');
  const describe = (c: ImpactChange): string => {
    if (c.kind === 'blocking') return c.after ? `Can no longer get a document: ${blockingWords(c.after, c.nodeId ? nameOf(c.nodeId) : '')}` : `No longer blocked (before: ${blockingWords(c.before, c.nodeId ? nameOf(c.nodeId) : '')})`;
    if (c.kind === 'variant') return c.before && c.after ? `Now gets ${variantName(c.after)} instead of ${variantName(c.before)} in “${nameOf(c.nodeId)}”` : c.after ? `Now gets ${variantName(c.after)} in “${nameOf(c.nodeId)}”` : `No longer gets ${variantName(c.before) || 'a message'} in “${nameOf(c.nodeId)}”`;
    if (c.kind === 'locale') return `The document language changes from ${languageName(c.before)} to ${languageName(c.after)}`;
    return `“${nameOf(c.nodeId)}” is now ${c.after}`;
  };
  const weight = (c: ImpactChange): number => (c.kind === 'blocking' && c.after ? 0 : c.kind === 'variant' ? 1 : c.kind === 'locale' ? 2 : c.kind === 'blocking' ? 3 : 4);
  const mainChange = (r: ImpactRecord): ImpactChange => [...r.changes].sort((a, b) => weight(a) - weight(b))[0];
  const candidates = impact.changed.map((r) => ({ recordId: r.recordId, name: r.name, what: describe(mainChange(r)), w: weight(mainChange(r)) })).sort((a, b) => a.w - b.w);
  const examples: ChangeSummary['impact']['examples'] = [];
  const seenWhat = new Set<string>();
  for (const c of candidates) { if (examples.length >= 5) break; if (seenWhat.has(c.what)) continue; seenWhat.add(c.what); examples.push({ recordId: c.recordId, name: c.name, what: c.what }); }
  for (const c of candidates) { if (examples.length >= 5) break; if (!examples.some((e) => e.recordId === c.recordId)) examples.push({ recordId: c.recordId, name: c.name, what: c.what }); }

  /* ------------------------------------------------------------------ what to look at first */
  const attention: string[] = [];
  const people = (n: number): string => countWords(n, 'synthetic customer');
  const forExample = (names: string[]): string => (names.length ? `, for example ${listWords(names, 2)}` : '');
  const sentence = (s: string): string => { const t = s.trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

  // 1. new blocking problems
  const newBlocking = new Map<string, number>();
  for (const c of impact.changed) for (const x of c.changes) if (x.kind === 'blocking' && x.after) { const w = blockingWords(x.after, x.nodeId ? nameOf(x.nodeId) : ''); newBlocking.set(w, (newBlocking.get(w) ?? 0) + 1); }
  if (newBlocking.size) {
    const reasons = listWords([...newBlocking].sort((a, b) => b[1] - a[1]).map(([w]) => w), 3, 'more problems');
    const also = impact.changed.filter((c) => c.changes.some((x) => x.kind === 'blocking' && x.after)).length - newlyBlockedNames.length;
    if (newlyBlockedNames.length) attention.push(`${people(newlyBlockedNames.length)} can no longer get a document: ${reasons}${forExample(newlyBlockedNames)}.${also > 0 ? ` ${people(also)} already blocked before ${also === 1 ? 'has' : 'have'} a further blocking problem.` : ''}`);
    else attention.push(`${people(also)} already blocked before ${also === 1 ? 'has' : 'have'} a further blocking problem: ${reasons}.`);
  }
  // 2. pinned tests that pass before and fail after
  const tests = (after.testCases ?? []).slice(0, 60);
  if (tests.length) {
    const failing = runTestCases(after, records, tests).filter((t) => !t.pass);
    if (failing.length) {
      const wasFailing = new Set(runTestCases(before, records, (before.testCases ?? []).filter((t) => failing.some((f) => f.testId === t.id))).filter((t) => !t.pass).map((t) => t.testId));
      const broke = failing.filter((f) => !wasFailing.has(f.testId));
      if (broke.length) attention.push(`${countWords(broke.length, 'pinned test')} ${broke.length === 1 ? 'fails' : 'fail'} with this version: ${listWords(broke.map((t) => q(t.name, 50)), 3, 'more')}.`);
    }
  }
  // 3. required content and disclosures
  if (disclosureNotes.length) attention.push(`Required content changed: ${listWords([...new Set(disclosureNotes)], 3, 'more changes')}.`);
  // 4. customers who get a different message, section or language
  const movedCustomers = impact.changed.filter((c) => c.changes.some((x) => x.kind === 'variant'));
  if (movedCustomers.length) {
    const pairs = new Map<string, number>();
    for (const c of movedCustomers) for (const x of c.changes) if (x.kind === 'variant') {
      const w = x.before && x.after ? `from ${variantName(x.before)} to ${variantName(x.after)} in “${nameOf(x.nodeId)}”` : x.after ? `to ${variantName(x.after)} in “${nameOf(x.nodeId)}”, which they did not get before` : `away from ${variantName(x.before) || 'their message'} in “${nameOf(x.nodeId)}”, with nothing in its place`;
      pairs.set(w, (pairs.get(w) ?? 0) + 1);
    }
    const top = [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${n} ${w}`);
    const cause = count.rules ? 'The rule changes move' : 'This version moves';
    attention.push(`${cause} ${people(movedCustomers.length)} to a different message: ${top.join('; ')}${pairs.size > 3 ? `; and ${pairs.size - 3} more kinds of move` : ''}.`);
  }
  const hiddenShown = new Map<string, number>();
  for (const c of impact.changed) for (const x of c.changes) if (x.kind === 'section') { const w = `“${nameOf(x.nodeId)}” is now ${x.after}`; hiddenShown.set(w, (hiddenShown.get(w) ?? 0) + 1); }
  if (hiddenShown.size) attention.push(`${listWords([...hiddenShown].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} for ${people(n)}`), 2, 'more components')}.`);
  const languageMoves = impact.changed.filter((c) => c.changes.some((x) => x.kind === 'locale')).length;
  if (languageMoves) attention.push(`${people(languageMoves)} now ${languageMoves === 1 ? 'gets' : 'get'} the document in a different language.`);
  // 5. translations that are not approved, were removed or may be out of date
  if (translationNotes.length) attention.push(`${sentence(listWords([...new Set(translationNotes)], 3, 'more translation points'))}.`);
  // 6. fallbacks that were removed
  for (const f of fallbackNotes) {
    const hit = impact.changed.filter((c) => c.changes.some((x) => x.kind === 'blocking' && x.after === 'NO_VARIANT_MATCH' && x.nodeId === f.nodeId)).length;
    attention.push(`${sentence(f.text)}: ${hit ? `this now happens to ${people(hit)}` : 'no synthetic customer is in that position today'}.`);
  }
  // 7. amounts and other data shown
  if (amountNotes.length) attention.push(`Check the figures: ${listWords([...new Set(amountNotes)], 3, 'more changes to the data shown')}.`);
  // 8. good news last
  if (unblockedNames.length) attention.push(`${people(unblockedNames.length)} who could not get a document before can now${forExample(unblockedNames)}.`);

  /* ------------------------------------------------------------------ headline */
  const head: string[] = [];
  if (count.wording) head.push(countWords(count.wording, 'wording change'));
  if (count.rules) head.push(countWords(count.rules, 'rule change'));
  if (count.layout) head.push(countWords(count.layout, 'layout change'));
  if (approvedTotal) head.push(`${countWords(approvedTotal, 'translation')} approved`);
  if (draftTotal) head.push(countWords(draftTotal, 'translation draft'));
  if (otherTranslation) head.push(countWords(otherTranslation, 'other translation change'));
  if (count.channels) head.push(countWords(count.channels, 'email or text message change'));
  if (count.settings) head.push(countWords(count.settings, 'settings change'));
  if (count.tests) head.push(countWords(count.tests, 'test change'));

  return {
    headline: head.join(', ').replace(/^./, (ch) => ch.toUpperCase()),
    sections: AREA_ORDER.filter((a) => items[a].length).map((a) => ({ area: a, title: AREA_TITLE[a], items: items[a] })),
    impact: { changedCustomers: impact.changed.length, totalCustomers: impact.evaluated, newlyBlocked: newlyBlockedNames.length, unblocked: unblockedNames.length, examples },
    attention,
    source: 'builtin',
  };
}
