import {
  applyCommand, applyJourney, buildContext, languageShortName, projectFieldIndex, shortDigest, tokensIn, tokensInText,
  type Command, type ContentPart, type DocNode, type FieldDef, type Predicate, type ProfileId, type Project, type RichBlock, type RichDoc, type RichInline, type Rule, type SyntheticRecord,
} from '@iss/model';
import { evaluatePredicate, resolve, type Finding, type RNode, type Resolution } from '@iss/resolver';
import type { AssistLink, FindingGroup, FixImpact, FixProposal } from './types';

/**
 * Built-in "Suggest a fix" engine. Pure and deterministic: it reads the project, a finding and the synthetic records,
 * and returns PROPOSALS (never applies anything). Every finding code the resolver, the static rule checks, the model
 * accessibility checks and the page composer can emit is handled; unknown codes get a link, never a guessed change.
 *
 *  - 'change'   a concrete model change, shown with its effect first (see `fixImpact`) and applied as one step;
 *  - 'link'     a person must do it (translations, wording, layout decisions, unsafe links);
 *  - 'scenario' the previewed data is the problem, not the document.
 *
 * 'safe' is reserved for changes that cannot alter what a currently unblocked customer receives.
 */

/* ------------------------------------------------------------------ wording helpers */

const q = (s: string): string => `“${s}”`;
const humanise = (s: string): string => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.]/g, ' ').trim().toLowerCase();
const sentence = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const customers = (n: number): string => plural(n, 'synthetic customer');
const listOf = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

function nodeName(project: Project, id: string | undefined): string {
  if (!id) return 'the document';
  const n = project.nodes.find((x) => x.id === id);
  if (n) return n.name && n.name !== n.id ? n.name : sentence(humanise(id));
  return project.contentParts.find((c) => c.id === id)?.title ?? sentence(humanise(id));
}
function partTitle(project: Project, id: string): string {
  return project.contentParts.find((c) => c.id === id)?.title ?? nodeName(project, id);
}
const ruleName = (r: Rule): string => r.title ?? `rule ${r.id}`;
const groupOf = (r: Rule): string => r.exclusiveGroup ?? ('targetNodeId' in r.then ? r.then.targetNodeId : '');

/* ------------------------------------------------------------------ finding identity */

function pathOf(f: Pick<Finding, 'code' | 'message' | 'details'>): string | undefined {
  const p = f.details?.path;
  if (typeof p === 'string') return p;
  if (f.code !== 'INVALID_BINDING') return undefined;
  return /[“"]([A-Za-z0-9_.]*)[”"]/.exec(f.message ?? '')?.[1] ?? /^([A-Za-z0-9_.]+) is not a collection/.exec(f.message ?? '')?.[1];
}

function findingKey(f: Finding): string {
  return [f.code, f.nodeId ?? '', f.locale ?? '', f.ruleId ?? '', (f.ruleIds ?? []).join('+'), pathOf(f) ?? ''].join('|');
}

/** The same issue on another customer or after a change: code, place and language agree (and the field, when one is named). */
function sameIssue(a: Pick<Finding, 'code' | 'nodeId' | 'locale' | 'message' | 'details'>, b: Finding): boolean {
  if (a.code !== b.code) return false;
  if (a.nodeId !== undefined && a.nodeId !== b.nodeId) return false;
  if (a.locale !== undefined && a.locale !== b.locale) return false;
  const pa = pathOf(a), pb = pathOf(b);
  return pa === undefined || pb === undefined || pa === pb;
}

/* ------------------------------------------------------------------ resolved population (memoised per project object) */

interface Snap { recordId: string; findings: Finding[]; blocked: boolean; matched: string[]; print: string }

function snapOf(res: Resolution): Snap {
  const bits: string[] = [res.locale, res.contentDigest];
  const walk = (n: RNode): void => {
    if (n.variants) bits.push(`${n.id}=${[...n.variants.selected].sort().join('+')}${n.variants.unresolved ? '!' : ''}`);
    bits.push(`${n.id}:${n.visible ? 1 : 0}`);
    n.children.forEach(walk);
  };
  walk(res.root);
  bits.push(...res.findings.map((f) => `${f.severity}:${findingKey(f)}`).sort());
  return { recordId: res.recordId, findings: res.findings, blocked: res.findings.some((f) => f.severity === 'blocking'), matched: res.result.matchedRuleIds, print: bits.join('\n') };
}

const ofType = (project: Project, records: SyntheticRecord[]): SyntheticRecord[] => records.filter((r) => r.documentType === project.documentType);

function snapshots(project: Project, records: SyntheticRecord[], profileId: ProfileId | undefined, journeyCursor: number | null): Snap[] {
  return ofType(project, records).map((record) => snapOf(resolve({ project, record, profileId, journeyCursor })));
}

/** Projects are immutable values, so results are remembered per project object and record list (identity), like `impactOf` does. */
const popCache = new WeakMap<Project, WeakMap<SyntheticRecord[], Map<string, Snap[]>>>();
function population(project: Project, records: SyntheticRecord[], profileId: ProfileId | undefined, journeyCursor: number | null | undefined): Snap[] {
  let byRecords = popCache.get(project);
  if (!byRecords) { byRecords = new WeakMap(); popCache.set(project, byRecords); }
  let byKey = byRecords.get(records);
  if (!byKey) { byKey = new Map(); byRecords.set(records, byKey); }
  const key = `${profileId ?? ''}|${journeyCursor ?? 'base'}|${records.length}`;
  let snaps = byKey.get(key);
  if (!snaps) { snaps = snapshots(project, records, profileId, journeyCursor ?? null); byKey.set(key, snaps); }
  return snaps;
}

/* ------------------------------------------------------------------ closeness */

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const lastSegment = (p: string): string => p.slice(p.lastIndexOf('.') + 1).toLowerCase();
const parentPath = (p: string): string => (p.includes('.') ? p.slice(0, p.lastIndexOf('.')).toLowerCase() : '');

/** The valid field an unknown path most likely meant: judged on the last segment first, then on the whole path. Null unless one is clearly closest. */
function closestField(path: string, pool: FieldDef[]): { best: FieldDef | null; near: FieldDef[] } {
  const a = lastSegment(path);
  const scored = pool.map((field) => {
    const b = lastSegment(field.path);
    let last = editDistance(a, b);
    if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) last = Math.min(last, 1);
    const score = last * 3 + (parentPath(path) === parentPath(field.path) ? 0 : 2) + Math.min(editDistance(path.toLowerCase(), field.path.toLowerCase()), 30) / 100;
    return { field, last, score, len: Math.min(a.length, b.length) };
  }).sort((x, y) => x.score - y.score || (x.field.path < y.field.path ? -1 : 1));
  const near = scored.slice(0, 3).map((s) => s.field);
  const [first, second] = scored;
  if (!first || !a) return { best: null, near };
  const clear = first.last <= Math.max(1, Math.floor(first.len / 3)) && (!second || second.score - first.score >= 3);
  return { best: clear ? first.field : null, near };
}

/** The existing id a mistyped id most likely meant; null unless one is clearly closest. */
function closestId(target: string, ids: string[]): string | null {
  const scored = ids.map((id) => ({ id, d: editDistance(target.toLowerCase(), id.toLowerCase()) })).sort((x, y) => x.d - y.d || (x.id < y.id ? -1 : 1));
  const [first, second] = scored;
  if (!first) return null;
  if (scored.length === 1) return first.id;
  return first.d <= Math.max(1, Math.floor(Math.min(target.length, first.id.length) / 3)) && second.d - first.d >= 2 ? first.id : null;
}

/* ------------------------------------------------------------------ proposal assembly */

type Draft = Omit<FixProposal, 'id' | 'findingCode' | 'source'>;

function finish(finding: Finding, drafts: Draft[]): FixProposal[] {
  const seen = new Set<string>();
  const out: FixProposal[] = [];
  for (const d of drafts) {
    const id = 'fix-' + shortDigest({ code: finding.code, node: finding.nodeId ?? null, locale: finding.locale ?? null, rule: finding.ruleId ?? null, rules: finding.ruleIds ?? null, path: pathOf(finding) ?? null, kind: d.kind, title: d.title, commands: d.commands ?? null, link: d.link ?? null }, 14);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, findingCode: finding.code, ...d, source: 'builtin' });
  }
  return out;
}

const linkDraft = (title: string, explanation: string, link: AssistLink): Draft => ({ kind: 'link', title, explanation, link, risk: 'review' });

/** A change proposal, checked against the command bus first: a change the model would refuse becomes a link that says why. */
function changeDraft(project: Project, d: { title: string; explanation: string; commands: Command[]; risk: 'safe' | 'review'; riskReason?: string }, fallback: AssistLink): Draft {
  const r = applyCommand(project, { type: 'BATCH', label: d.title, commands: d.commands });
  if (r.ok) return { kind: 'change', ...d };
  return linkDraft(d.title, `This cannot be changed for you here: ${r.message}`, fallback);
}

const designLink = (project: Project, nodeId: string | undefined, label = 'Open in Design', textId?: string): AssistLink => {
  const known = !!nodeId && project.nodes.some((n) => n.id === nodeId);
  return { view: 'design', ...(known ? { nodeId } : {}), ...(textId ? { textId } : {}), label };
};
const rulesLink = (ruleId: string | undefined, nodeId: string | undefined, label = 'Open in Rules & Data'): AssistLink => ({ view: 'rules-data', ...(ruleId ? { ruleId } : {}), ...(nodeId ? { nodeId } : {}), label });

/* ------------------------------------------------------------------ priority ties */

/** How narrow a condition is: an exact value pins one case, a range admits many, "is not" excludes only one. */
function specificity(p: Predicate): number {
  switch (p.op) {
    case 'and': return p.args.reduce((s, a) => s + specificity(a), 0);
    case 'or': return p.args.length ? Math.min(...p.args.map(specificity)) : 0;
    case 'not': return 0.5;
    case 'eq': case 'isNull': return 3;
    case 'in': return p.value.length <= 1 ? 3 : 2;
    case 'gt': case 'gte': case 'lt': case 'lte': return 1;
    default: return 0.5;
  }
}

function tieFixes(project: Project, f: Finding, ctx: FixCtx): Draft[] {
  const link = rulesLink(f.ruleIds?.[0], f.nodeId, 'Open the rules');
  const tied = (f.ruleIds ?? []).map((id) => project.rules.find((r) => r.id === id)).filter((r): r is Rule => !!r && r.enabled !== false && r.mode === 'exclusive');
  if (tied.length < 2 || tied.some((r) => r.priority !== tied[0].priority)) {
    return [linkDraft('Review the priorities of these rules', 'In the current model these rules no longer share a priority, so there is nothing to change for you. Check them in Rules & Data.', link)];
  }
  const p = tied[0].priority;
  const group = groupOf(tied[0]);
  const ids = new Set(tied.map((r) => r.id));
  const peers = project.rules.filter((r) => r.scope === project.documentType && r.enabled !== false && r.mode === 'exclusive' && groupOf(r) === group && !ids.has(r.id));
  const higher = peers.filter((r) => r.priority > p).map((r) => r.priority);
  const lower = peers.filter((r) => r.priority < p).map((r) => r.priority);
  const equalPeer = peers.some((r) => r.priority === p);
  // Stay strictly between the neighbouring priorities, so nobody who matches only one of the rules is affected.
  const up = higher.length ? Math.min(50, Math.floor((Math.min(...higher) - p) / 2)) : Math.min(50, 10000 - p);
  const down = equalPeer ? 0 : lower.length ? Math.min(50, Math.floor((p - Math.max(...lower)) / 2)) : Math.min(50, p);

  const snaps = population(project, ctx.records, ctx.profileId, ctx.journeyCursor);
  const both = snaps.filter((s) => tied.every((r) => s.matched.includes(r.id))).length;
  const matchSet = new Map(tied.map((r) => [r.id, new Set(snaps.filter((s) => s.matched.includes(r.id)).map((s) => s.recordId))]));
  const subset = (a: Rule, b: Rule): boolean => { const A = matchSet.get(a.id)!, B = matchSet.get(b.id)!; return A.size < B.size && [...A].every((x) => B.has(x)); };
  const order = tied.map((r, i) => ({ r, i })).sort((x, y) => (subset(x.r, y.r) ? -1 : subset(y.r, x.r) ? 1 : specificity(y.r.when) - specificity(x.r.when) || x.i - y.i)).map((x) => x.r);
  const runnerUp = order[1];
  const why = subset(order[0], runnerUp) ? 'it applies to fewer customers, so it is the more specific rule'
    : specificity(order[0].when) > specificity(runnerUp.when) ? 'its condition is the narrower one'
    : '';

  const names = listOf(tied.map((r) => q(ruleName(r))));
  const all = tied.length === 2 ? 'both' : 'all of them';
  const stuck = snaps.filter((s) => s.findings.some((x) => x.code === 'EXCLUSIVE_PRIORITY_TIE' && tied.every((r) => (x.ruleIds ?? []).includes(r.id)))).length;
  const whoToday = !both ? `no synthetic customer matches ${all} today, so this only prevents a future tie`
    : `${customers(both)} match${both === 1 ? 'es' : ''} ${all} today${stuck === both ? ' and get no message' : stuck ? `, and ${stuck} of them get no message` : ', but a higher-priority rule decides for them'}`;
  const drafts: Draft[] = [];
  for (const [i, winner] of order.slice(0, 3).entries()) {
    const others = tied.filter((r) => r.id !== winner.id);
    const message = winner.then.op === 'selectVariant' ? partTitle(project, winner.then.variantId) : null;
    let title: string;
    let commands: Command[];
    if (up >= 1) { title = `Raise the priority of ${q(ruleName(winner))}`; commands = [{ type: 'UPSERT_RULE', rule: { ...winner, priority: p + up } }]; }
    else if (down >= 1) { title = `Lower the priority of ${listOf(others.map((r) => q(ruleName(r))))}`; commands = others.map((r) => ({ type: 'UPSERT_RULE', rule: { ...r, priority: p - down } })); }
    else continue;
    drafts.push(changeDraft(project, {
      title,
      explanation: `${names} have the same priority, so no message is chosen when ${tied.length === 2 ? 'both' : 'several'} apply (${whoToday}). With this change ${q(ruleName(winner))} wins${message ? ` and those customers get the ${q(message)} message` : ''}. Customers who match only one of these rules are not affected.${i === 0 && why ? ` It is suggested first because ${why}.` : ''}`,
      commands, risk: 'review', riskReason: `Decides which message customers get when ${names} apply together.`,
    }, link));
  }
  drafts.push(linkDraft('Narrow one of the conditions instead', `If ${names} should never apply to the same customer, tighten one condition in Rules & Data so they no longer overlap.`, link));
  return drafts;
}

/* ------------------------------------------------------------------ fallback message */

function fallbackFixes(project: Project, f: Finding, ctx: FixCtx): Draft[] {
  const node = project.nodes.find((n) => n.id === f.nodeId);
  const design = designLink(project, f.nodeId, 'Choose the fallback in Design');
  if (!node || node.type !== 'variant-set') return [linkDraft('Choose a fallback message', 'This set of messages could not be found in the current model. Open the document and check it.', design)];
  const variants = node.variantIds ?? [];
  if (node.fallbackVariantId && variants.includes(node.fallbackVariantId)) return [];
  const parts = new Set(project.contentParts.map((c) => c.id));
  const usable = variants.filter((v) => parts.has(v));
  const set = nodeName(project, node.id);
  if (!usable.length) return [linkDraft(`Add a message to ${q(set)} first`, `${q(set)} has no message with wording yet, so there is nothing to use as a fallback.`, design)];
  const rules = project.rules.filter((r) => r.scope === project.documentType && r.enabled !== false && r.then.op === 'selectVariant' && r.then.targetNodeId === node.id);
  const selects = (r: Rule): string => (r.then.op === 'selectVariant' ? r.then.variantId : '');
  const orphans = usable.filter((v) => !rules.some((r) => selects(r) === v) && !node.variantConditions?.[v]);
  const named = usable.find((v) => /\b(standard|default|general|fallback)\b/.test(`${humanise(v)} ${partTitle(project, v).toLowerCase()}`));
  const lowest = [...rules].filter((r) => usable.includes(selects(r))).sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1))[0];
  let pick: string;
  let why: string;
  if (orphans.length === 1) { pick = orphans[0]; why = 'It is the only message no rule selects, so the fallback is the only way it can appear.'; }
  else if (named) { pick = named; why = 'Its name marks it as the standard message.'; }
  else if (lowest) { pick = selects(lowest); why = `It is the message of the lowest-priority rule (${q(ruleName(lowest))}).`; }
  else { pick = usable[0]; why = 'It is the first message in the set.'; }
  const affected = population(project, ctx.records, ctx.profileId, ctx.journeyCursor).filter((s) => s.findings.some((x) => x.code === 'NO_VARIANT_MATCH' && x.nodeId === node.id)).length;
  return [
    changeDraft(project, {
      title: `Make ${q(partTitle(project, pick))} the fallback message of ${q(set)}`,
      explanation: `${q(set)} has no fallback, so a customer whom no rule matches gets no message and the document is blocked. With a fallback that customer receives ${q(partTitle(project, pick))}. ${why} ${affected ? `${sentence(customers(affected))} ${affected === 1 ? 'is' : 'are'} blocked for this reason today and will receive it.` : 'No synthetic customer is in that position today, so nothing changes for them.'}`,
      commands: [{ type: 'UPDATE_NODE', nodeId: node.id, patch: { fallbackVariantId: pick } }],
      risk: affected ? 'review' : 'safe',
      ...(affected ? { riskReason: `Decides which message ${customers(affected)} who ${affected === 1 ? 'is' : 'are'} blocked today will receive.` } : {}),
    }, design),
    linkDraft('Choose a different fallback message', `Pick the fallback of ${q(set)} yourself in the Design view.`, design),
  ];
}

/* ------------------------------------------------------------------ table continuation */

function continuationFixes(project: Project, f: Finding): Draft[] {
  const node = project.nodes.find((n) => n.id === f.nodeId);
  const design = designLink(project, f.nodeId);
  const table = nodeName(project, f.nodeId);
  if (!node || node.type !== 'repeating-table') return [linkDraft('Check the table layout', 'The table this issue refers to could not be found in the current model.', design)];
  if (node.flowContinuation !== false) {
    return [linkDraft(`Make room for the total row of ${q(table)}`, `${q(table)} already continues on the next page, but its total row still does not fit. Give the table more room or reduce the space above it in the Design view.`, design)];
  }
  const clipped = typeof f.details?.rowsClipped === 'number' ? f.details.rowsClipped : null;
  const placed = typeof f.details?.rowsPlaced === 'number' ? f.details.rowsPlaced : null;
  const what = f.code === 'TABLE_TOTAL_CLIPPED' ? 'its total row does not fit on the page'
    : clipped !== null && placed !== null ? `${clipped} of ${clipped + placed} rows do not fit on the page` : 'some rows do not fit on the page';
  return [changeDraft(project, {
    title: `Let ${q(table)} continue on the next page`,
    explanation: `${q(table)} is set to stay on one page, so ${what}. Turning continuation on lets the remaining rows flow to the following pages. Customers whose table already fits on one page get exactly the same document.`,
    commands: [{ type: 'UPDATE_NODE', nodeId: node.id, patch: { flowContinuation: true } }],
    risk: 'safe',
  }, design)];
}

/* ------------------------------------------------------------------ unknown data fields */

interface Usage { node?: DocNode; binding: boolean; content: boolean; header: boolean; series: boolean; parts: ContentPart[] }

function usageOf(project: Project, nodeId: string, path: string): Usage {
  const node = project.nodes.find((n) => n.id === nodeId);
  const partIds = new Set<string>([nodeId, ...(node?.variantIds ?? []), ...(node?.contentPartId ? [node.contentPartId] : [])]);
  const parts = project.contentParts.filter((c) => partIds.has(c.id) && [...Object.values(c.approvedLocales), ...Object.values(c.draftLocales ?? {})].some((t) => tokensInText(t ?? '').includes(path)));
  return {
    node,
    binding: !!node && (node.binding ?? '') === path && ['bound-field', 'summary-metric', 'repeating-table', 'chart'].includes(node.type),
    content: !!node && tokensIn(node.content).includes(path),
    header: !!node?.headerFooter && tokensInText(node.headerFooter.text).includes(path),
    series: !!node?.chart?.series?.some((s) => s.path === path),
    parts,
  };
}
const used = (u: Usage): boolean => u.binding || u.content || u.header || u.series || u.parts.length > 0;

function replaceTokenInDoc(doc: RichDoc, from: string, to: string): RichDoc {
  const walk = (n: RichBlock | RichInline): RichBlock | RichInline => {
    if (n.type === 'token') { const t = n as RichInline; return t.attrs?.path === from ? { ...t, attrs: { ...t.attrs, path: to } } : t; }
    const b = n as RichBlock;
    return Array.isArray(b.content) ? { ...b, content: b.content.map(walk) } : n;
  };
  return { type: 'doc', content: doc.content.map((b) => walk(b) as RichBlock) };
}
function replaceTokenInText(text: string, from: string, to: string): string {
  return text.replace(new RegExp(`\\{\\{\\s*${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g'), `{{${to}}}`);
}

function bindingFixes(project: Project, f: Finding): Draft[] {
  const nodeId = f.nodeId ?? '';
  const path = pathOf(f) ?? '';
  const where = nodeName(project, nodeId);
  const u = usageOf(project, nodeId, path);
  const design = u.node ? designLink(project, nodeId) : ({ view: 'content', textId: nodeId, label: 'Open in Content & Translations' } satisfies AssistLink);
  const fields = [...projectFieldIndex(project).values()];
  if (!used(u)) return [linkDraft(`Choose a data field for ${q(where)}`, `${q(where)} refers to a data field that does not exist${path ? ` (${path})` : ''}. It could not be located in the current model, so check it and pick a field from the list.`, design)];

  const wantsList = u.binding && !!u.node && (u.node.type === 'repeating-table' || (u.node.type === 'chart' && !u.node.chart?.series?.length));
  const pool = fields.filter((x) => (x.type === 'array') === wantsList && x.path !== path);
  const known = fields.find((x) => x.path === path);
  let target: FieldDef | null;
  let near: FieldDef[];
  if (known) { target = pool.length === 1 ? pool[0] : null; near = pool.slice(0, 3); }
  else ({ best: target, near } = closestField(path, pool));
  const problem = known ? `${q(where)} needs a list of rows, but ${q(known.label)} is a single value` : `${q(where)} refers to a data field that does not exist (${path || 'none chosen'})`;
  if (!target) {
    return [linkDraft(`Choose a data field for ${q(where)}`, `${problem}. No existing field is clearly the one that was meant${near.length ? ` (the nearest are ${listOf(near.map((n) => q(n.label)))})` : ''}, so pick the right one from the field list.`, design)];
  }
  const to = target.path;
  const protectedPart = u.parts.find((c) => c.type === 'disclosure' || project.nodes.some((n) => n.type === 'disclosure' && n.contentPartId === c.id && n.protected));
  if (protectedPart) return [linkDraft(`Correct the data field in ${q(protectedPart.title)}`, `${problem}. The closest existing field is ${q(target.label)}, but this is protected, approved wording: it can only be changed with the “New approved version” action and a reason.`, { view: 'content', textId: protectedPart.id, label: 'Open in Content & Translations' })];

  const commands: Command[] = [];
  if (u.node) {
    const patch: Partial<Omit<DocNode, 'id' | 'type' | 'children'>> = {};
    if (u.binding) patch.binding = to;
    if (u.content && u.node.content) patch.content = replaceTokenInDoc(u.node.content, path, to);
    if (u.header && u.node.headerFooter) patch.headerFooter = { ...u.node.headerFooter, text: replaceTokenInText(u.node.headerFooter.text, path, to) };
    if (u.series && u.node.chart) patch.chart = { ...u.node.chart, series: (u.node.chart.series ?? []).map((s) => (s.path === path ? { ...s, path: to } : s)) };
    if (Object.keys(patch).length) commands.push({ type: 'UPDATE_NODE', nodeId: u.node.id, patch });
  }
  const swapAll = (texts: Partial<Record<string, string>>): Partial<Record<string, string>> => Object.fromEntries(Object.entries(texts).map(([l, t]) => [l, replaceTokenInText(t ?? '', path, to)]));
  for (const c of u.parts) commands.push({ type: 'UPSERT_CONTENT_PART', part: { ...c, approvedLocales: swapAll(c.approvedLocales), ...(c.draftLocales ? { draftLocales: swapAll(c.draftLocales) } : {}) } });
  const staleTranslations = Object.entries(project.strings ?? {}).some(([id, t]) => id.startsWith(`@${nodeId}/`) && [...Object.values(t.approved ?? {}), ...Object.values(t.draft ?? {})].some((x) => tokensInText(x).includes(path)));
  return [
    changeDraft(project, {
      title: `Use ${q(target.label)} in ${q(where)}`,
      explanation: `${problem}. The closest existing field is ${q(target.label)}${known ? '' : ` (${to})`}, so this replaces the reference with it. Check that it is the value you meant: every customer will see it in this place.${staleTranslations ? ' Translated versions of this text still use the old field and need the same correction.' : ''}`,
      commands, risk: 'review', riskReason: 'Decides which value customers see here; the match is by name only.',
    }, design),
    linkDraft('Pick a different field', `Choose the data field for ${q(where)} yourself from the field list.`, design),
  ];
}

/* ------------------------------------------------------------------ accessibility texts */

function altFixes(project: Project, f: Finding): Draft[] {
  const node = project.nodes.find((n) => n.id === f.nodeId);
  const design = designLink(project, f.nodeId, 'Open in Design', f.nodeId ? `@${f.nodeId}/image.alt` : undefined);
  if (!node || node.type !== 'image') return [linkDraft('Describe the image', 'The image this issue refers to could not be found in the current model.', design)];
  if (node.decorative || node.image?.alt?.trim()) return [];
  const name = nodeName(project, node.id);
  return [
    changeDraft(project, {
      title: `Describe the image as ${q(name)}`,
      explanation: `${q(name)} has no description for people who use a screen reader. This uses the name the image has in the document as its description. Check that it says what the picture shows.`,
      commands: [{ type: 'UPDATE_NODE', nodeId: node.id, patch: { image: { ...(node.image ?? { src: '' }), alt: name } } }],
      risk: 'review', riskReason: 'The description is only a suggestion taken from the name of the image.',
    }, design),
    changeDraft(project, {
      title: `Mark ${q(name)} as decorative`,
      explanation: 'A decorative picture needs no description: screen readers skip it. Choose this only when the picture carries no information.',
      commands: [{ type: 'UPDATE_NODE', nodeId: node.id, patch: { decorative: true } }],
      risk: 'review', riskReason: 'Only right when the picture carries no information.',
    }, design),
  ];
}

function chartTitleFixes(project: Project, f: Finding): Draft[] {
  const node = project.nodes.find((n) => n.id === f.nodeId);
  const design = designLink(project, f.nodeId, 'Open in Design', f.nodeId ? `@${f.nodeId}/chart.title` : undefined);
  if (!node || node.type !== 'chart' || !node.chart) return [linkDraft('Give the chart a title', 'A chart needs a title so that its text alternative makes sense. Add one in the Design view.', design)];
  if (node.chart.title?.trim()) return [];
  const name = nodeName(project, node.id);
  return [changeDraft(project, {
    title: `Title the chart ${q(name)}`,
    explanation: `The chart has no title, so its text alternative has nothing to introduce the figures. This uses the name the chart has in the document. Customers will see it above the chart, so check the wording.`,
    commands: [{ type: 'UPDATE_NODE', nodeId: node.id, patch: { chart: { ...node.chart, title: name } } }],
    risk: 'review', riskReason: 'The title is customer-visible wording suggested from the name of the chart.',
  }, design)];
}

/* ------------------------------------------------------------------ rules that point at something missing */

function unknownVariantFixes(project: Project, f: Finding): Draft[] {
  const rule = project.rules.find((r) => r.id === (f.ruleId ?? f.ruleIds?.[0]));
  const node = project.nodes.find((n) => n.id === f.nodeId);
  const link = rulesLink(rule?.id, f.nodeId, 'Open the rule');
  if (!rule || rule.then.op !== 'selectVariant' || !node) return [linkDraft('Check which message this rule selects', 'A rule selects a message that is not part of this set. Open the rule and choose an existing message.', link)];
  const variants = node.variantIds ?? [];
  if (variants.includes(rule.then.variantId)) return [];
  const drafts: Draft[] = [];
  const guess = closestId(rule.then.variantId, variants);
  if (guess) {
    drafts.push(changeDraft(project, {
      title: `Point ${q(ruleName(rule))} at ${q(partTitle(project, guess))}`,
      explanation: `${q(ruleName(rule))} selects a message that no longer exists in ${q(nodeName(project, node.id))}. ${variants.length === 1 ? `${q(partTitle(project, guess))} is the only message left in the set` : `${q(partTitle(project, guess))} is the closest by name`}, so this makes the rule select it. Customers who match the rule will receive that message.`,
      commands: [{ type: 'UPSERT_RULE', rule: { ...rule, then: { ...rule.then, variantId: guess } } }],
      risk: 'review', riskReason: 'Decides which message the customers who match this rule receive.',
    }, link));
  }
  drafts.push(changeDraft(project, {
    title: `Turn off ${q(ruleName(rule))}`,
    explanation: `${q(ruleName(rule))} selects a message that no longer exists in ${q(nodeName(project, node.id))}, which blocks every customer it matches. With the rule off, those customers get the message of the next rule that matches, or the fallback.`,
    commands: [{ type: 'SET_RULE_ENABLED', ruleId: rule.id, enabled: false }],
    risk: 'review', riskReason: 'Customers who match this rule will receive a different message.',
  }, link));
  drafts.push(linkDraft('Choose the message yourself', `Open ${q(ruleName(rule))} and pick which message it should select.`, link));
  return drafts;
}

function unknownSectionFixes(project: Project, f: Finding): Draft[] {
  const target = f.nodeId ?? '';
  const rules = (f.ruleIds ?? (f.ruleId ? [f.ruleId] : [])).map((id) => project.rules.find((r) => r.id === id)).filter((r): r is Rule => !!r && r.then.op === 'showSection' && r.then.targetNodeId === target);
  const link = rulesLink(rules[0]?.id ?? f.ruleIds?.[0], undefined, 'Open the rule');
  if (!rules.length) return [linkDraft('Check which section this rule shows', 'A rule shows a section that does not exist. Open the rule and choose an existing section.', link)];
  const names = listOf(rules.map((r) => q(ruleName(r))));
  const nodeIds = new Set(project.nodes.map((n) => n.id));
  const sections = [...project.nodes.filter((n) => n.ruleDriven).map((n) => n.id), ...project.contentParts.filter((c) => !nodeIds.has(c.id) && c.type !== 'disclosure').map((c) => c.id)];
  const drafts: Draft[] = [];
  const guess = sections.length > 1 ? closestId(target, sections) : null;
  if (guess) {
    drafts.push(changeDraft(project, {
      title: `Point ${names} at ${q(nodeName(project, guess))}`,
      explanation: `${names} ${rules.length === 1 ? 'shows' : 'show'} a section that does not exist (${target}). ${q(nodeName(project, guess))} is the closest by name, so this makes the rule show it. Customers who match will then see that section.`,
      commands: rules.map((r) => ({ type: 'UPSERT_RULE', rule: { ...r, then: { op: 'showSection', targetNodeId: guess } } })),
      risk: 'review', riskReason: 'Customers who match the rule will see a section they do not see today.',
    }, link));
  }
  const additive = rules.filter((r) => r.mode !== 'obligation');
  if (additive.length) {
    drafts.push(changeDraft(project, {
      title: `Turn off ${listOf(additive.map((r) => q(ruleName(r))))}`,
      explanation: `${names} ${rules.length === 1 ? 'shows' : 'show'} a section that does not exist (${target}), so it has no effect today. Turning it off removes the warning and changes nothing customers receive.`,
      commands: additive.map((r) => ({ type: 'SET_RULE_ENABLED', ruleId: r.id, enabled: false })),
      risk: 'review', riskReason: 'The section this rule was meant to show stays missing; turning the rule off only removes the warning.',
    }, link));
  }
  drafts.push(linkDraft('Choose the section yourself', `Open ${names} and pick the section to show, or add the missing section to the document.`, link));
  return drafts;
}

function missingPartFixes(project: Project, f: Finding): Draft[] {
  const node = project.nodes.find((n) => n.id === f.nodeId);
  const design = designLink(project, f.nodeId);
  if (!node) return [linkDraft('Add the missing wording', 'A message or disclosure has no approved wording. Open the document and add it.', design)];
  const parts = new Set(project.contentParts.map((c) => c.id));
  const set = nodeName(project, node.id);
  if (node.type === 'disclosure') {
    if (parts.has(node.contentPartId ?? node.id)) return [];
    return [linkDraft(`Add the approved wording for ${q(set)}`, `${q(set)} is a disclosure without approved wording, so every document is blocked. Approved disclosure text must be supplied by a person.`, design)];
  }
  const missing = (node.variantIds ?? []).filter((v) => !parts.has(v));
  if (!missing.length) return [];
  const named = /^Variant (\S+) of /.exec(f.message ?? '')?.[1];
  const drafts: Draft[] = [];
  for (const v of missing.filter((m) => !named || !missing.includes(named) || m === named)) {
    const referenced = node.fallbackVariantId === v || !!node.variantConditions?.[v] || project.rules.some((r) => r.then.op === 'selectVariant' && r.then.targetNodeId === node.id && r.then.variantId === v);
    if (referenced) continue;
    drafts.push(changeDraft(project, {
      title: `Remove the empty message ${q(sentence(humanise(v)))} from ${q(set)}`,
      explanation: `${q(set)} lists a message that has no wording, which blocks every document. No rule selects it and it is not the fallback, so no customer could receive it. Removing the empty entry unblocks the document; choose this only if the message is not meant to be written.`,
      commands: [{ type: 'REMOVE_VARIANT', nodeId: node.id, variantId: v }],
      risk: 'review', riskReason: 'Removes a message from the set; write the wording instead if the message is still wanted.',
    }, design));
  }
  drafts.push(linkDraft(`Write the missing wording in ${q(set)}`, `${q(set)} lists a message that has no wording, which blocks every document. Wording is written by a person: add it in the Design view.`, design));
  return drafts;
}

/* ------------------------------------------------------------------ translations (never approved for anyone) */

function translationFixes(project: Project, f: Finding): Draft[] {
  const locale = f.locale ?? '';
  const lang = locale ? languageShortName(locale) : 'the other language';
  const ids = Array.isArray(f.details?.ids) ? (f.details.ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const textId = f.nodeId ?? ids[0];
  const link: AssistLink = { view: 'content', ...(locale ? { locale } : {}), ...(textId ? { textId } : {}), label: 'Open Content & Translations' };
  const part = project.contentParts.find((c) => c.id === f.nodeId);
  const name = part?.title ?? (f.nodeId ? nodeName(project, f.nodeId) : '');
  const never = 'A person must review and approve it; the assistant never approves text.';
  switch (f.code) {
    case 'REQUIRED_TRANSLATION_MISSING':
      return [linkDraft(`Write and approve the ${lang} text for ${q(name)}`, `${q(name)} must appear in every document, and it has no approved ${lang} version, so customers who read ${lang} are blocked. ${part?.draftLocales?.[locale]?.trim() ? `A ${lang} draft exists and is waiting for review.` : 'Translation at send time is not allowed.'} ${never}`, link)];
    case 'TRANSLATION_MISSING_OPTIONAL':
      return [linkDraft(`Write and approve the ${lang} text for ${q(name)}`, `${q(name)} has no approved ${lang} version, so customers who read ${lang} see this section in English. ${part?.draftLocales?.[locale]?.trim() ? `A ${lang} draft exists and is waiting for review.` : ''} ${never}`.replace(/\s+/g, ' '), link)];
    case 'UNAPPROVED_TRANSLATION_SHOWN':
      return [linkDraft(`Review the ${lang} drafts`, `This preview shows ${ids.length ? plural(ids.length, `${lang} text`) : `${lang} texts`} that ${ids.length === 1 ? 'is' : 'are'} still a draft. Exports use approved text only, so customers would get English there until the drafts are approved. ${never}`, link)];
    default:
      return [linkDraft(`Translate the remaining ${lang} texts`, `${ids.length ? sentence(plural(ids.length, 'label or other text', 'labels or other texts')) : 'Some labels or other texts'} ${ids.length === 1 ? 'has' : 'have'} no approved ${lang} translation, so English is shown in those places. ${never}`, link)];
  }
}

/* ------------------------------------------------------------------ data problems (no document change) */

const DATA_PROBLEM: Record<string, string> = {
  RECORD_TYPE_MISMATCH: 'The selected customer record belongs to a different kind of document than this project.',
  INCONSISTENT_PAYMENT_STATE: 'The data says the account is up to date and also lists missed payments. Both cannot be true, so the document is held back rather than guessing which message applies.',
  BALANCE_RECONCILIATION_FAILED: 'The new balance does not equal the previous balance plus purchases, minus payments, plus fees.',
  UNCONFIRMED_MEMBER_LIABILITY: 'The claim is denied pending review and the member’s liability is not confirmed, yet the data supplies an amount for the member to pay. The document will not present that amount as owed.',
  CLAIM_RECONCILIATION_FAILED: 'The claim amounts do not add up: billed must equal the adjustment plus the allowed amount, and allowed must equal what the plan paid plus the member’s share.',
  NULL_BINDING: 'A value this document must show is empty for this customer.',
};

function scenarioFixes(project: Project, f: Finding, ctx: FixCtx): Draft[] {
  const record = ctx.recordId ? ctx.records.find((r) => r.recordId === ctx.recordId) : undefined;
  const has = (overrides: Record<string, unknown> | undefined, journeyCursor: number | null): boolean => !!record && resolve({ project, record, overrides, journeyCursor, profileId: ctx.profileId }).findings.some((x) => sameIssue(f, x));
  const hasOverrides = !!ctx.overrides && Object.keys(ctx.overrides).length > 0;
  const cursor = ctx.journeyCursor ?? null;
  const step = cursor !== null ? project.journey.events[Math.min(cursor, project.journey.events.length - 1)] : undefined;
  let title = 'Correct the customer data';
  let origin = 'Correct the source data, or the what-if values if you changed any.';
  if (f.code === 'RECORD_TYPE_MISMATCH') { title = 'Choose a customer of this document type'; origin = 'Pick a customer record that belongs to this document.'; }
  else if (record && has(undefined, null)) origin = 'It comes from the sample record itself, so the source data must be corrected.';
  else if (record && step && has(undefined, cursor)) { title = `Review the journey step ${q(step.label ?? humanise(step.eventType))}`; origin = `It appears at the journey step ${q(step.label ?? humanise(step.eventType))}: the step leaves the data in this state. Correct the step or the data it starts from.`; }
  else if (record && hasOverrides) { title = 'Adjust the what-if values'; origin = 'It is caused by the what-if values in this preview: change or clear them.'; }
  const drafts: Draft[] = [{ kind: 'scenario', title, explanation: `${DATA_PROBLEM[f.code] ?? 'The data being previewed is not consistent.'} ${origin} The document itself is not at fault, so no document change is proposed.`, risk: 'review' }];
  if (f.code === 'NULL_BINDING') drafts.push(linkDraft(`Decide what ${q(nodeName(project, f.nodeId))} shows when the value is empty`, `${q(nodeName(project, f.nodeId))} is set to stop the document when its value is empty. If an empty value is acceptable, choose a fallback text or hide the field in the Design view.`, designLink(project, f.nodeId)));
  return drafts;
}

/* ------------------------------------------------------------------ everything else: a person decides */

function textIdFor(project: Project, nodeId: string | undefined): string | undefined {
  const n = project.nodes.find((x) => x.id === nodeId);
  if (!n) return undefined;
  if (n.type === 'rich-text') return `@${n.id}/content`;
  if (n.type === 'header-footer') return `@${n.id}/headerFooter`;
  if (n.type === 'action-link') return `@${n.id}/action.label`;
  return n.label !== undefined ? `@${n.id}/label` : undefined;
}

function personFixes(project: Project, f: Finding): Draft[] {
  const name = nodeName(project, f.nodeId);
  const design = designLink(project, f.nodeId);
  switch (f.code) {
    case 'UNCONFIRMED_DEBT_LANGUAGE':
      return [linkDraft(`Reword ${q(name)} so it does not read as a bill`, `${q(name)} uses wording such as “amount due” or “you owe” while the member’s liability is not confirmed. An explanation of benefits is not a bill, so the wording must be neutral. Wording is changed by a person.`, designLink(project, f.nodeId, 'Edit the wording', textIdFor(project, f.nodeId)))];
    case 'UNSAFE_URL':
      return [linkDraft(`Replace the link in ${q(name)}`, `The link in ${q(name)} is not a secure https address, so it is not shown to customers. Enter the correct address in the Design view.`, design)];
    case 'REQUIRED_NODE_MISSING': {
      const rule = project.rules.find((r) => r.id === f.ruleId);
      return [linkDraft('Restore the mandatory section', `${rule ? q(ruleName(rule)) : 'A rule'} requires a section that is no longer in the document (${f.nodeId ?? 'unknown'}). Mandatory content is a compliance decision: put the section back, or have the rule updated by someone who may change it.`, rulesLink(f.ruleId, undefined, 'Open the rule'))];
    }
    case 'VARIANT_WITHOUT_RULE': {
      const v = /^Variant (\S+) of /.exec(f.message ?? '')?.[1];
      const msg = v ? q(partTitle(project, v)) : 'One message';
      return [linkDraft(`Add a rule that selects ${v ? msg : 'the unused message'}`, `${msg} in ${q(name)} is not selected by any rule and is not the fallback, so no customer can receive it. Decide when it should appear and add a rule, or remove it.`, rulesLink(undefined, f.nodeId))];
    }
    case 'RULE_NOT_REACHED_IN_FIXTURES': {
      const rule = project.rules.find((r) => r.id === f.ruleId);
      return [linkDraft(`Check ${rule ? q(ruleName(rule)) : 'the rule'} with a what-if`, 'No sample customer matches this rule. That is not an error, but the rule is untested: the coverage check can build a scenario that reaches it and pin it as a test.', rulesLink(f.ruleId, undefined, 'Open the rule'))];
    }
    case 'A11Y_LINK_TEXT':
      return [linkDraft(`Give the link in ${q(name)} a descriptive label`, 'A label such as “click here” says nothing to someone using a screen reader. Describe where the link goes.', designLink(project, f.nodeId, 'Edit the label', textIdFor(project, f.nodeId)))];
    case 'A11Y_TABLE_HEADERS':
      return [linkDraft(`Add column headings to ${q(name)}`, 'A table without column headings cannot be read out meaningfully. Add the columns in the Design view.', design)];
    case 'A11Y_TOKEN_ONLY_TEXT':
      return [linkDraft(`Consider a label for ${q(name)}`, 'This text shows only data values. A few words saying what the value is help every reader.', design)];
    case 'A11Y_NO_H1':
      return [linkDraft('Add a main heading to the document', 'The document has no top-level heading, so people using a screen reader cannot tell what it is. Add a heading to the title text.', design)];
    case 'ORPHANED_HEADING': {
      const node = project.nodes.find((n) => n.id === f.nodeId);
      if (node && node.layout?.paged?.mode !== 'fixed' && !node.layout?.paged?.keepWithNext) {
        return [changeDraft(project, {
          title: `Keep ${q(name)} together with what follows it`,
          explanation: `${q(name)} can end up alone at the bottom of a page while its content starts on the next one. This keeps the heading with the content that follows. Page breaks move for the customers this happens to.`,
          commands: [{ type: 'SET_LAYOUT', nodeId: node.id, profile: 'paged', layout: { keepWithNext: true } }],
          risk: 'review', riskReason: 'Moves a page break for customers whose heading lands at the bottom of a page.',
        }, design)];
      }
      return [linkDraft(`Adjust the layout around ${q(name)}`, `${q(name)} ends a page while its content continues on the next. Change the spacing or order in the Design view.`, design)];
    }
    case 'KEEP_TOGETHER_CANNOT_FIT': {
      const node = project.nodes.find((n) => n.id === f.nodeId);
      if (node && node.layout?.paged?.keepTogether) {
        const table = node.type === 'repeating-table';
        return [changeDraft(project, {
          title: `Let ${q(name)} continue on the next ${table ? 'page' : 'page or column'}`,
          explanation: `${q(name)} is set to keep together, but it is taller than an empty page or column, so it cannot be placed in one piece. Turning keep together off lets ${table ? 'its rows continue on the next page or column' : 'it be placed as before keep together was set'}. Page breaks move for the customers this happens to.`,
          commands: [{ type: 'SET_LAYOUT', nodeId: node.id, profile: 'paged', layout: { keepTogether: false } }],
          risk: 'review', riskReason: 'Moves page breaks for customers whose component no longer fits one page or column.',
        }, design), linkDraft(`Give ${q(name)} more room`, `Shorten ${q(name)}, or make the flow area of the page template taller in the Page panel of the Design view.`, design)];
      }
      return [linkDraft(`Make ${q(name)} fit on a page`, `${q(name)} is taller than an empty page or column. Shorten it or give it more room in the Design view.`, design)];
    }
    case 'FIXED_OFF_PAGE':
      return [linkDraft(`Move ${q(name)} onto the page`, `${q(name)} is fixed partly outside the page (for example after the paper or orientation changed). Move or resize it in the Design view.`, design)];
    case 'FIXED_FLOW_ADJUSTED':
      return [linkDraft(`Move ${q(name)} clear of the flowing content`, `${q(name)} is fixed on the page where flowing content also runs. The content was kept clear of it, but the page has less room. Move or resize the element in the Design view if that is not intended.`, design)];
    case 'ROW_TALLER_THAN_REGION':
      return [linkDraft(`Shorten the rows of ${q(name)}`, `A single row of ${q(name)} is taller than the space a page offers. Reduce the content of the row or give the table more room.`, design)];
    case 'BLOCK_OVERFLOW':
      return [linkDraft(`Make ${q(name)} fit on a page`, `${q(name)} is taller than the space a page offers and is cut off. Shorten it, split it or give it more room in the Design view.`, design)];
    case 'PARITY_MISMATCH':
      return [linkDraft('Compare the outputs', 'The PDF or web version does not contain the same facts as the resolved document. Open Validate & Compare to see which fact differs.', { view: 'validate', label: 'Open Validate & Compare' })];
    default:
      break;
  }
  if (f.severity === 'info') return [];
  if (f.source === 'accessibility') return [linkDraft(f.nodeId ? `Fix the accessibility issue in ${q(name)}` : 'Fix the accessibility issue', `${f.message} This needs a design decision.`, design)];
  if (f.source === 'composer') return [linkDraft(f.nodeId ? `Adjust the page layout of ${q(name)}` : 'Adjust the page layout', `${f.message} This needs a layout decision.`, design)];
  return [linkDraft(f.nodeId ? `Look at ${q(name)}` : 'Look at this issue', `${f.message} No automatic fix is available for this kind of issue.`, f.nodeId && project.nodes.some((n) => n.id === f.nodeId) ? design : { view: 'validate', label: 'Open Validate & Compare' })];
}

/* ------------------------------------------------------------------ public API */

interface FixCtx { records: SyntheticRecord[]; recordId?: string; overrides?: Record<string, unknown>; journeyCursor?: number | null; profileId?: ProfileId }

function draftsFor(project: Project, f: Finding, ctx: FixCtx): Draft[] {
  switch (f.code) {
    case 'EXCLUSIVE_PRIORITY_TIE':
    case 'EQUAL_PRIORITY_EXCLUSIVE_RULES': return tieFixes(project, f, ctx);
    case 'NO_VARIANT_MATCH':
    case 'VARIANT_SET_WITHOUT_FALLBACK': return fallbackFixes(project, f, ctx);
    case 'FLOW_OVERFLOW_NO_CONTINUATION':
    case 'TABLE_TOTAL_CLIPPED': return continuationFixes(project, f);
    case 'INVALID_BINDING': return bindingFixes(project, f);
    case 'IMAGE_ALT_MISSING':
    case 'A11Y_IMAGE_ALT': return altFixes(project, f);
    case 'A11Y_CHART_TITLE': return chartTitleFixes(project, f);
    case 'UNKNOWN_VARIANT': return unknownVariantFixes(project, f);
    case 'UNKNOWN_SECTION': return unknownSectionFixes(project, f);
    case 'MISSING_CONTENT_PART': return missingPartFixes(project, f);
    case 'REQUIRED_TRANSLATION_MISSING':
    case 'TRANSLATION_MISSING_OPTIONAL':
    case 'TRANSLATION_MISSING_TEXT':
    case 'UNAPPROVED_TRANSLATION_SHOWN': return translationFixes(project, f);
    case 'RECORD_TYPE_MISMATCH':
    case 'INCONSISTENT_PAYMENT_STATE':
    case 'BALANCE_RECONCILIATION_FAILED':
    case 'UNCONFIRMED_MEMBER_LIABILITY':
    case 'CLAIM_RECONCILIATION_FAILED':
    case 'NULL_BINDING': return scenarioFixes(project, f, ctx);
    case 'FALLBACK_SELECTED': return [];
    default: return personFixes(project, f);
  }
}

/** Proposals for one finding, best first. Never applies anything; an empty list means there is nothing to do (information only). */
export function proposeFixes(project: Project, finding: Finding, ctx: { records: SyntheticRecord[]; recordId?: string; overrides?: Record<string, unknown>; journeyCursor?: number | null; profileId?: ProfileId }): FixProposal[] {
  return finish(finding, draftsFor(project, finding, ctx));
}

/**
 * The population after a change. A change that touches only rules cannot alter anything for a customer whom none of
 * the changed rules matches (before or after), so those customers keep their "before" result and are not resolved again.
 */
function afterSnapshots(before: Project, after: Project, records: SyntheticRecord[], beforeSnaps: Snap[], profileId: ProfileId | undefined, journeyCursor: number | null): Snap[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])] as Array<keyof Project>;
  const rulesOnly = keys.every((k) => k === 'rules' || k === 'modelVersion' || before[k] === after[k]);
  if (!rulesOnly) return snapshots(after, records, profileId, journeyCursor);
  const was = new Map(before.rules.map((r) => [r.id, r]));
  const now = new Map(after.rules.map((r) => [r.id, r]));
  const conditions: Predicate[] = [];
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(id), b = now.get(id);
    if (a === b) continue;
    if (a) conditions.push(a.when);
    if (b) conditions.push(b.when);
  }
  const events = after.journey?.events ?? [];
  return ofType(after, records).map((record, i) => {
    const ctx = buildContext(applyJourney(record, events, journeyCursor).record);
    return conditions.some((w) => evaluatePredicate(w, ctx)) ? snapOf(resolve({ project: after, record, profileId, journeyCursor })) : beforeSnaps[i];
  });
}

/** Whether the model after a change no longer has the issue, for findings no sample customer shows (what-ifs, static checks, page composition). Null = cannot tell. */
function resolvedInModel(after: Project, f: Pick<Finding, 'code' | 'nodeId' | 'ruleId' | 'ruleIds' | 'message' | 'details'>): boolean | null {
  const node = after.nodes.find((n) => n.id === f.nodeId);
  const rulesOf = (): Rule[] => [...(f.ruleIds ?? []), ...(f.ruleId ? [f.ruleId] : [])].map((id) => after.rules.find((r) => r.id === id)).filter((r): r is Rule => !!r);
  switch (f.code) {
    case 'EXCLUSIVE_PRIORITY_TIE':
    case 'EQUAL_PRIORITY_EXCLUSIVE_RULES': {
      const live = rulesOf().filter((r) => r.enabled !== false);
      if (!f.ruleIds?.length) return null;
      const top = Math.max(...live.map((r) => r.priority));
      return live.filter((r) => r.priority === top).length <= 1;
    }
    case 'NO_VARIANT_MATCH':
    case 'VARIANT_SET_WITHOUT_FALLBACK': return !!node?.fallbackVariantId && (node.variantIds ?? []).includes(node.fallbackVariantId);
    // Model-level only: the composer confirms the pages (a total row can still be too tall for any page).
    case 'FLOW_OVERFLOW_NO_CONTINUATION':
    case 'TABLE_TOTAL_CLIPPED': return !!node && node.flowContinuation !== false;
    // Model-level only, like the table fixes: the composer confirms the pages.
    case 'KEEP_TOGETHER_CANNOT_FIT': return !!node && !node.layout?.paged?.keepTogether;
    case 'INVALID_BINDING': { const path = pathOf(f); return path === undefined ? null : !used(usageOf(after, f.nodeId ?? '', path)); }
    case 'IMAGE_ALT_MISSING':
    case 'A11Y_IMAGE_ALT': return !!node && (!!node.decorative || !!node.image?.alt?.trim());
    case 'A11Y_CHART_TITLE': return !!node?.chart?.title?.trim();
    case 'UNKNOWN_VARIANT': return rulesOf().every((r) => r.enabled === false || (r.then.op === 'selectVariant' && (node?.variantIds ?? []).includes(r.then.variantId)));
    case 'UNKNOWN_SECTION': return rulesOf().every((r) => r.enabled === false || (r.then.op === 'showSection' && (after.nodes.some((n) => n.id === (r.then as { targetNodeId: string }).targetNodeId) || after.contentParts.some((c) => c.id === (r.then as { targetNodeId: string }).targetNodeId))));
    case 'MISSING_CONTENT_PART': return !!node && (node.type === 'disclosure' ? after.contentParts.some((c) => c.id === (node.contentPartId ?? node.id)) : (node.variantIds ?? []).every((v) => after.contentParts.some((c) => c.id === v)));
    default: return null;
  }
}

/** The effect of a proposal on every synthetic customer of the document type, before anything is applied. */
export function fixImpact(project: Project, proposal: FixProposal, records: SyntheticRecord[], opts?: { finding?: Finding; profileId?: ProfileId; journeyCursor?: number | null }): FixImpact {
  const total = ofType(project, records).length;
  const none = (summary: string): FixImpact => ({ resolves: false, unblocked: [], newlyBlocked: [], changedCustomers: 0, totalCustomers: total, summary });
  if (proposal.kind === 'link') return none('Nothing changes until a person makes this edit; the issue stays open until then.');
  if (proposal.kind === 'scenario') return none('No document change is proposed: the previewed data has to be corrected, so no customer is affected.');
  if (!proposal.commands?.length) return none('This suggestion contains no change to apply.');
  const applied = applyCommand(project, { type: 'BATCH', label: proposal.title, commands: proposal.commands });
  if (!applied.ok) return none(`This change cannot be applied to the current model: ${applied.message}`);

  const cursor = opts?.journeyCursor ?? null;
  const before = population(project, records, opts?.profileId, cursor);
  const after = afterSnapshots(project, applied.project, records, before, opts?.profileId, cursor);
  const unblocked: string[] = [];
  const newlyBlocked: string[] = [];
  let changed = 0;
  before.forEach((b, i) => {
    const a = after[i];
    if (b.blocked && !a.blocked) unblocked.push(b.recordId);
    if (!b.blocked && a.blocked) newlyBlocked.push(b.recordId);
    if (b.print !== a.print) changed++;
  });

  const issue = opts?.finding ?? { code: proposal.findingCode, message: '' };
  const had = before.map((b, i) => (b.findings.some((x) => sameIssue(issue, x)) ? i : -1)).filter((i) => i >= 0);
  let resolves: boolean;
  let how: 'customers' | 'model' | 'unknown' = 'customers';
  if (had.length) resolves = had.every((i) => !after[i].findings.some((x) => sameIssue(issue, x)));
  else { const m = resolvedInModel(applied.project, issue); resolves = m === true; how = m === null ? 'unknown' : 'model'; }

  const others = changed - unblocked.length;
  const composer = ['FLOW_OVERFLOW_NO_CONTINUATION', 'TABLE_TOTAL_CLIPPED', 'ORPHANED_HEADING', 'KEEP_TOGETHER_CANNOT_FIT'].includes(issue.code);
  let summary: string;
  if (newlyBlocked.length) summary = `This would block ${customers(newlyBlocked.length)} who ${newlyBlocked.length === 1 ? 'is' : 'are'} fine today${unblocked.length ? `, while unblocking ${unblocked.length}` : ''}; review it before applying.`;
  else if (how === 'unknown') summary = changed ? `${changed} of ${total} synthetic customers are affected, but it could not be confirmed that the issue is resolved${composer ? ' until the pages are composed again' : ''}.` : `None of the ${total} synthetic customers receives anything different; whether the issue is resolved could not be confirmed${composer ? ' until the pages are composed again' : ' on the sample customers'}.`;
  else if (!resolves) summary = changed ? `This does not fully resolve the issue: ${changed} of ${total} synthetic customers are affected${unblocked.length ? ` and ${unblocked.length} ${unblocked.length === 1 ? 'is' : 'are'} unblocked` : ''}, but the issue remains for some.` : `This does not resolve the issue; none of the ${total} synthetic customers receives anything different.`;
  else if (unblocked.length) summary = `Resolves the issue and unblocks ${unblocked.length} of ${total} synthetic customers; ${others > 0 ? `${others} more ${others === 1 ? 'is' : 'are'} affected` : 'nobody else is affected'}.`;
  else if (changed) summary = `Resolves the issue; ${changed} of ${total} synthetic customers ${changed === 1 ? 'is' : 'are'} affected and nobody is newly blocked.`;
  else summary = `Resolves the issue; none of the ${total} synthetic customers receives anything different today${composer ? ' (page layout is confirmed when the pages are composed again)' : ''}.`;
  return { resolves, unblocked, newlyBlocked, changedCustomers: changed, totalCustomers: total, summary };
}

const SEVERITY_RANK: Record<string, number> = { blocking: 0, error: 1, warning: 2, info: 3 };

/** Blocking and warning findings across every record of the project's document type (baseline or the given journey step), grouped. */
export function groupFindings(project: Project, records: SyntheticRecord[], opts?: { profileId?: ProfileId; journeyCursor?: number | null }): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const s of population(project, records, opts?.profileId, opts?.journeyCursor)) {
    for (const f of s.findings) {
      if (f.severity === 'info') continue;
      const key = findingKey(f);
      let g = groups.get(key);
      if (!g) { g = { key, finding: f, recordIds: [] }; groups.set(key, g); }
      if (!g.recordIds.includes(s.recordId)) g.recordIds.push(s.recordId);
    }
  }
  return [...groups.values()].sort((a, b) => (SEVERITY_RANK[a.finding.severity] ?? 9) - (SEVERITY_RANK[b.finding.severity] ?? 9) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The "Fix all safe issues" plan: for each group the first proposal with risk 'safe' whose impact resolves it and blocks nobody new.
 * `opts.findings` (optional) adds findings this package cannot compute itself: static rule checks and page-composition
 * diagnostics, exactly as their own checks emit them.
 */
export function safeFixPlan(project: Project, records: SyntheticRecord[], opts?: { profileId?: ProfileId; journeyCursor?: number | null; findings?: Finding[] }): { items: Array<{ group: FindingGroup; proposal: FixProposal; impact: FixImpact }>; batch: Command | null; skipped: Array<{ group: FindingGroup; reason: string }> } {
  const groups = groupFindings(project, records, opts);
  const known = new Set(groups.map((g) => g.key));
  for (const f of opts?.findings ?? []) {
    if (f.severity === 'info' || known.has(findingKey(f))) continue;
    known.add(findingKey(f));
    groups.push({ key: findingKey(f), finding: f, recordIds: [] });
  }
  const items: Array<{ group: FindingGroup; proposal: FixProposal; impact: FixImpact }> = [];
  const skipped: Array<{ group: FindingGroup; reason: string }> = [];
  const commands: Command[] = [];
  const taken = new Set<string>();
  let running = project;
  for (const group of groups) {
    const proposals = proposeFixes(project, group.finding, { records, recordId: group.recordIds[0], journeyCursor: opts?.journeyCursor, profileId: opts?.profileId });
    const safe = proposals.filter((p) => p.kind === 'change' && p.risk === 'safe' && !!p.commands?.length);
    let chosen: { proposal: FixProposal; impact: FixImpact } | null = null;
    for (const proposal of safe) {
      const impact = fixImpact(project, proposal, records, { finding: group.finding, profileId: opts?.profileId, journeyCursor: opts?.journeyCursor });
      if (impact.resolves && !impact.newlyBlocked.length) { chosen = { proposal, impact }; break; }
    }
    if (!chosen) {
      const first = proposals[0];
      skipped.push({ group, reason: !first ? 'No fix is available for this kind of issue.'
        : safe.length ? 'The safe fix could not be confirmed on the sample customers.'
        : first.kind === 'scenario' ? 'The previewed data is the problem, not the document.'
        : first.kind === 'link' ? `Needs a person: ${first.title}.`
        : `Needs your review: ${first.riskReason ?? first.title}` });
      continue;
    }
    const fresh = (chosen.proposal.commands ?? []).filter((c) => !taken.has(shortDigest(c, 24)));
    if (fresh.length) {
      const r = applyCommand(running, { type: 'BATCH', label: chosen.proposal.title, commands: fresh });
      if (!r.ok) { skipped.push({ group, reason: 'This fix cannot be combined with the other safe fixes; apply it on its own.' }); continue; }
      running = r.project;
      for (const c of fresh) { taken.add(shortDigest(c, 24)); commands.push(c); }
    }
    items.push({ group, ...chosen });
  }
  if (!commands.length) return { items, batch: null, skipped };
  if (items.length > 1) {
    // The fixes were each checked alone; make sure that together they still block nobody new.
    const before = population(project, records, opts?.profileId, opts?.journeyCursor);
    const after = snapshots(running, records, opts?.profileId, opts?.journeyCursor ?? null);
    if (before.some((b, i) => !b.blocked && after[i].blocked)) {
      return { items: [], batch: null, skipped: [...skipped, ...items.map((it) => ({ group: it.group, reason: 'Together, the safe fixes would block a customer who is fine today; apply them one at a time.' }))] };
    }
  }
  return { items, batch: { type: 'BATCH', label: `Fix ${plural(items.length, 'safe issue')}`, commands }, skipped };
}
