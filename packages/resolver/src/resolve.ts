import {
  applyJourney, buildContext, deepPatch, digestOf, projectFieldIndex, getPath, inlineFromMarkup, isSafeUrl, projectContentDigest, richToPlain, shortDigest,
  languageShortName, localizeProject, projectLanguages, SOURCE_LANGUAGE, sysText,
  CALC_PREFIX, DOCUMENT_DATE_PATH, documentDateUse, evaluateCalculations, exprDependencies, inEffect, isIsoDay, notInEffectWords, predicateLeafPaths, predicateTri,
  allFieldIndex, decideItems, isItemPath, itemCalculationMissing, itemContexts, listOfItemPath, readList, scopeCtx, scopeFieldIndex,
  type CalcResults, type ContentPart, type DocNode, type FieldDef, type Missing, type Predicate, type Project, type RichBlock, type RichDoc, type RichInline, type Rule,
} from '@iss/model';
import { formatCents, formatValue } from './format';
import type { CalculatedOutcome, ChannelTexts, CoreDiagnostic, CoreResult, Finding, RBlock, RInline, RNode, RTableRow, RVariant, Resolution, ResolveInput, SemanticManifest, TraceEntry } from './types';

export const ENGINE_VERSION = 'iss-resolver/1.0.0';
/** Wording that reads as a demand for money. One list, shared with the wording checker's tone rule so the two cannot drift apart. */
export const DEBT_LANGUAGE_PATTERN = String.raw`\b(you owe|owed|amount due|balance due|pay this amount|amount you owe|payment due now)\b`;
const DEBT_LANGUAGE = new RegExp(DEBT_LANGUAGE_PATTERN, 'i');

/* --------------------------------------------------------------- predicates */

export function evaluatePredicate(p: Predicate, ctx: unknown, inputs: Record<string, unknown> = {}): boolean {
  switch (p.op) {
    case 'and': return p.args.map((a) => evaluatePredicate(a, ctx, inputs)).every(Boolean);
    case 'or': return p.args.map((a) => evaluatePredicate(a, ctx, inputs)).some(Boolean);
    case 'not': return !evaluatePredicate(p.arg, ctx, inputs);
    case 'items': {
      // Richer data shapes (wave 5): each item is tested in its own scope; the input recorded is how many match.
      const results = itemContexts(ctx as Record<string, unknown>, p.path).map((sc) => evaluatePredicate(p.where, sc, {}));
      inputs[p.path] = results.filter(Boolean).length;
      return decideItems(p.match, p.count, results) === true;
    }
    case 'isNull': { const v = getPath(ctx, p.path); inputs[p.path] = v; return v === null; }
    case 'notNull': { const v = getPath(ctx, p.path); inputs[p.path] = v; return v !== null; }
    case 'in': { const v = getPath(ctx, p.path); inputs[p.path] = v; return v !== null && p.value.includes(v); }
    default: {
      const v = getPath(ctx, p.path);
      inputs[p.path] = v;
      const val = p.value;
      if (v === null) return false;
      switch (p.op) {
        case 'eq': return v === val;
        case 'ne': return v !== val;
        case 'gt': return val !== null && v > val;
        case 'gte': return val !== null && v >= val;
        case 'lt': return val !== null && v < val;
        case 'lte': return val !== null && v <= val;
      }
    }
  }
  return false;
}

export function predicatePaths(p: Predicate | undefined): string[] {
  if (!p) return [];
  if (p.op === 'and' || p.op === 'or') return p.args.flatMap(predicatePaths);
  if (p.op === 'not') return predicatePaths(p.arg);
  if (p.op === 'items') return [p.path, ...predicatePaths(p.where)];
  return [(p as any).path];
}

export function describePredicate(p: Predicate): string {
  switch (p.op) {
    case 'and': return p.args.map(describePredicate).join(' AND ');
    case 'or': return '(' + p.args.map(describePredicate).join(' OR ') + ')';
    case 'not': return 'NOT (' + describePredicate(p.arg) + ')';
    case 'isNull': return `${p.path} is empty`;
    case 'notNull': return `${p.path} is present`;
    case 'in': return `${p.path} in [${p.value.join(', ')}]`;
    case 'items': return `${p.match === 'atLeast' ? `at least ${p.count ?? 1}` : p.match} of ${p.path} where (${describePredicate(p.where)})`;
    default: {
      const sym: Record<string, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };
      return `${(p as any).path} ${sym[p.op]} ${JSON.stringify((p as any).value)}`;
    }
  }
}

/* ------------------------------------------------------------------ helpers */

function core(f: Finding): CoreDiagnostic {
  const d: CoreDiagnostic = { code: f.code, severity: f.severity };
  if (f.nodeId !== undefined) d.nodeId = f.nodeId;
  if (f.locale !== undefined) d.locale = f.locale;
  if (f.ruleIds !== undefined) d.ruleIds = f.ruleIds;
  if (f.ruleId !== undefined) d.ruleId = f.ruleId;
  return d;
}

interface Ctx {
  project: Project;
  ctx: any;
  locale: string;
  approvedLocale: string | null;
  fields: Map<string, FieldDef>;
  /** Translated fixed wording for the document language. */
  sys: Record<string, string>;
  findings: Finding[];
  parts: Map<string, ContentPart>;
  liabilityConfirmed: boolean;
  /** Set when the document has calculated fields or a date: reports a missing calculated value (or date) shown at `nodeId`. */
  missingValue?: (path: string, nodeId: string) => void;
}

function valueFor(c: Ctx, path: string, nodeId: string, lineage: string[]): { value: unknown; known: boolean } {
  lineage.push(path);
  const known = c.fields.has(path);
  if (!known && !path) {
    // Nothing chosen yet (a table inserted before the project has a list to show).
    const node = c.project.nodes.find((n) => n.id === nodeId);
    const what = node?.type === 'repeating-table' || node?.type === 'chart' ? 'a list' : 'a data field';
    c.findings.push({ code: 'INVALID_BINDING', severity: 'blocking', nodeId, source: 'binding', message: `“${node?.name ?? nodeId}” is not bound to ${what} yet.`, suggestion: `Choose ${what} for it in the Inspector.`, details: { path } });
    return { value: null, known: false };
  }
  if (!known && isItemPath(path)) {
    // Richer data shapes (wave 5): a field of a list's items is read inside a repeating section of that list.
    const all = allFieldIndex(c.project);
    const list = listOfItemPath(path);
    if (all.has(path) && list) {
      c.findings.push({ code: 'INVALID_BINDING', severity: 'blocking', nodeId, source: 'binding', message: `“${all.get(path)!.label}” belongs to each item of “${all.get(list)?.label ?? list}”, so it can only be shown inside a repeating section of that list.`, suggestion: `Move the component into a repeating section of “${all.get(list)?.label ?? list}”, or choose another field.`, details: { path } });
      return { value: null, known: false };
    }
  }
  if (!known) {
    // A document with its own data has no built-in schema to name: its fields are the customer's name and language plus the project's own.
    const allowed = c.project.documentType === 'custom' ? 'Only the customer fields and this project’s own data fields can be used.' : `Only allowlisted ${c.project.documentType} schema paths can be bound.`;
    c.findings.push({ code: 'INVALID_BINDING', severity: 'blocking', nodeId, source: 'binding', message: `Unknown field path “${path}” in ${nodeId}. ${allowed}`, suggestion: 'Pick a field from the token picker.', details: { path } });
    return { value: null, known: false };
  }
  return { value: getPath(c.ctx, path), known: true };
}

function tokenInline(c: Ctx, path: string, nodeId: string, lineage: string[], marks: { bold?: boolean; italic?: boolean }): RInline {
  const { value, known } = valueFor(c, path, nodeId, lineage);
  if (!known) return { kind: 'token', text: `{{${path}}}`, path, missing: true, ...marks };
  const f = c.fields.get(path)!;
  const fmt = f.type === 'cents' ? 'usd-cents' : f.type === 'date' ? 'date' : f.type === 'points' ? 'int' : f.type === 'int' ? 'int' : f.type === 'number' ? 'number' : 'text';
  if (value === null || value === '') { c.missingValue?.(path, nodeId); return { kind: 'token', text: '—', path, missing: true, ...marks }; }
  // Domain guard: never render unconfirmed member liability as an amount.
  if (path === 'claim.patientResponsibilityCents' && !c.liabilityConfirmed) return { kind: 'token', text: sysText(c.sys, 'guardNotYetDetermined'), path, ...marks };
  const out: RInline = { kind: 'token', text: typeof value === 'boolean' ? sysText(c.sys, value ? 'valueYes' : 'valueNo') : formatValue(value, fmt, c.locale), path, ...marks };
  if (f.type === 'cents' && typeof value === 'number') out.cents = value;
  return out;
}

function inlinesFromRich(c: Ctx, items: Array<RichBlock | RichInline> | undefined, nodeId: string, lineage: string[]): RInline[] {
  const out: RInline[] = [];
  for (const n of items ?? []) {
    if (n.type === 'text') {
      const marks = (n as RichInline).marks ?? [];
      const link = marks.find((m) => m.type === 'link');
      out.push({ kind: 'text', text: (n as RichInline).text ?? '', bold: marks.some((m) => m.type === 'bold') || undefined, italic: marks.some((m) => m.type === 'italic') || undefined, href: link && isSafeUrl(link.attrs?.href) ? link.attrs!.href : undefined });
    } else if (n.type === 'token') {
      const marks = (n as RichInline).marks ?? [];
      out.push(tokenInline(c, (n as RichInline).attrs?.path ?? '', nodeId, lineage, { bold: marks.some((m) => m.type === 'bold') || undefined }));
    } else if (n.type === 'hardBreak') out.push({ kind: 'break', text: '\n' });
  }
  return out;
}

function blocksFromRich(c: Ctx, doc: RichDoc | undefined, nodeId: string, lineage: string[]): RBlock[] {
  const blocks: RBlock[] = [];
  for (const b of doc?.content ?? []) {
    if (b.type === 'heading') blocks.push({ kind: (['h2', 'h2', 'h2', 'h3', 'h4'][b.attrs?.level ?? 2] ?? 'h3') as RBlock['kind'], inlines: inlinesFromRich(c, b.content, nodeId, lineage) });
    else if (b.type === 'paragraph') blocks.push({ kind: 'p', inlines: inlinesFromRich(c, b.content, nodeId, lineage) });
    else if (b.type === 'bulletList' || b.type === 'orderedList') {
      blocks.push({ kind: b.type === 'bulletList' ? 'ul' : 'ol', items: (b.content ?? []).map((li) => inlinesFromRich(c, ((li as RichBlock).content ?? []).flatMap((p) => (p as RichBlock).content ?? []), nodeId, lineage)) });
    }
  }
  return blocks;
}

function textBlocks(c: Ctx, text: string, nodeId: string, lineage: string[]): RBlock[] {
  return text.split(/\n+/).filter(Boolean).map((line) => ({ kind: 'p' as const, inlines: inlinesFromRich(c, inlineFromMarkup(line), nodeId, lineage) }));
}

function partText(c: Ctx, partId: string): { text: string; locale: string; missingLocale: boolean; part?: ContentPart } {
  const part = c.parts.get(partId);
  if (!part) return { text: '', locale: c.locale, missingLocale: false };
  const want = c.approvedLocale ?? 'en-US';
  const localized = part.approvedLocales[want as 'en-US'];
  if (localized) return { text: localized, locale: want, missingLocale: false, part };
  return { text: part.approvedLocales['en-US'] ?? '', locale: 'en-US', missingLocale: want !== 'en-US', part };
}

/**
 * The column a table sums in its footer: the one marked `total`, else the amount column of the two built-in lists
 * (a transaction's amount, a claim's billed amount). Undefined when the table has no total.
 */
export function totalColumnKey(columns: Array<{ key: string; total?: boolean }> | undefined): string | undefined {
  const cols = columns ?? [];
  return (cols.find((col) => col.total) ?? cols.find((col) => col.key === 'amountCents' || col.key === 'billedCents'))?.key;
}

function plainOf(blocks: RBlock[] | undefined): string {
  return (blocks ?? []).map((b) => (b.inlines ?? b.items?.flat() ?? []).map((i) => i.text).join('')).join(' ');
}

/* ------------------------------------------------------------------ resolve */

export function resolve(input: ResolveInput): Resolution {
  const { project } = input;
  const profileId = input.profileId ?? 'paged-pdf';
  const claimIndex = input.claimIndex ?? 0;
  const journeyCursor = input.journeyCursor ?? null;
  const docType = project.documentType;
  const findings: Finding[] = [];

  // 1–2. Normalize: nonmutating overrides, then deterministic journey events.
  const patched = deepPatch(input.record as any, input.overrides);
  const { record: effective, steps } = applyJourney(patched, project.journey?.events ?? [], journeyCursor, claimIndex);
  if (effective.documentType !== docType) {
    findings.push({ code: 'RECORD_TYPE_MISMATCH', severity: 'blocking', source: 'resolver', message: `Record ${effective.recordId} is a ${effective.documentType}, project expects ${docType}.` });
  }
  // 3. Derived fields (versioned pure registry).
  const ctx = buildContext(effective, claimIndex);
  let nodes = new Map(project.nodes.map((n) => [n.id, n]));

  // 3b. The document's date and the calculated fields (only for a document that has them; others are untouched).
  const dateSource = project.documentDate;
  let issueDate: string | null = null;
  let issueGiven = false;
  if (dateSource) {
    if (input.issueDate !== undefined && input.issueDate !== null) {
      if (isIsoDay(input.issueDate)) { issueDate = input.issueDate; issueGiven = true; }
      else findings.push({ code: 'ISSUE_DATE_INVALID', severity: 'blocking', source: 'resolver', message: 'The date given for this run is not a date. Write it as YYYY-MM-DD, for example 2027-01-31.', suggestion: 'Correct the “as issued on” date.' });
    } else if (dateSource.source === 'field') {
      const v = getPath(ctx, dateSource.path);
      if (isIsoDay(v)) issueDate = v;
    }
    (ctx as Record<string, unknown>).document = { date: issueDate };
  }
  const calcs: CalcResults | null = project.calculatedFields?.length ? evaluateCalculations(project, ctx, issueDate) : null;
  const depth = !!dateSource || !!calcs;
  const NO_DATE: Missing = { code: 'no-date', message: 'The document has no date for this customer.' };
  const askedFor = new WeakMap<Missing, string>();
  /** Whether a path is a calculated value (or the document's date) that is missing for this customer. */
  const missingAt = (path: string, scoped?: unknown): Missing | null => {
    let m: Missing | null = null;
    if (calcs && path.startsWith(CALC_PREFIX)) {
      const k = path.slice(CALC_PREFIX.length);
      if (k in calcs.values && calcs.values[k] === null) m = calcs.missing[k] ?? null;
      // A calculation that belongs to a list, read in the scope of one of its items (wave 5).
      else if (scoped && typeof scoped === 'object') m = itemCalculationMissing<Missing>(scoped, k);
    }
    else if (dateSource && path === DOCUMENT_DATE_PATH && !issueDate) m = NO_DATE;
    if (!m) return null;
    const copy = { ...m };
    askedFor.set(copy, path);
    return copy;
  };
  const depthPaths = (p: Predicate | undefined) => predicateLeafPaths(p).some((x) => x.startsWith(CALC_PREFIX) || x === DOCUMENT_DATE_PATH);
  /** A condition: true, false, or the missing value it could not be decided without. `at` is the context (an item's scope inside a repeating section). */
  const test = (p: Predicate, inputs: Record<string, unknown>, at: unknown = ctx): boolean | Missing => (depth && depthPaths(p) ? predicateTri(p, at, missingAt, inputs) : evaluatePredicate(p, at, inputs));
  /** Where each missing calculated value (or the date) is needed, and how badly. */
  const needs = new Map<string, { severity: 'blocking' | 'warning'; where: Set<string>; missing: Missing }>();
  const need = (m: Missing, severity: 'blocking' | 'warning', where: string) => {
    const path = askedFor.get(m) ?? DOCUMENT_DATE_PATH;
    const n = needs.get(path) ?? { severity, where: new Set<string>(), missing: m };
    if (severity === 'blocking') n.severity = 'blocking';
    n.where.add(where);
    needs.set(path, n);
  };
  const undecided = (m: Missing) => ({ path: askedFor.get(m) ?? DOCUMENT_DATE_PATH, reason: m.message });
  /** Conditional sections that are not in effect on the document's date. */
  const offNodes = new Set(dateSource ? project.nodes.filter((n) => n.effective && n.type === 'conditional-region' && !inEffect(n.effective, issueDate)).map((n) => n.id) : []);
  let parts = new Map(project.contentParts.map((p) => [p.id, p]));

  // 4. Evaluate every rule against the snapshot.
  const trace: TraceEntry[] = [];
  const matched: string[] = [];
  const additive: string[] = [];
  const mandatory: string[] = [];
  const exclusive = new Map<string, Rule[]>();
  const sectionsShown = new Map<string, string[]>();
  const hints: string[] = [];
  let approvedLocale: string | null = null;
  let translationRuleId: string | null = null;
  for (const rule of project.rules) {
    if (rule.scope !== docType) continue;
    const inputs: Record<string, unknown> = {};
    if (rule.enabled === false) {
      evaluatePredicate(rule.when, ctx, inputs);
      trace.push({ ruleId: rule.id, kind: 'rule', version: rule.version, mode: rule.mode, priority: rule.priority, enabled: false, matched: false, predicateInputs: inputs, expression: rule.when, action: rule.then, outcome: 'disabled', note: 'Rule disabled in the editor; not evaluated as a match.' });
      continue;
    }
    if (dateSource && (rule.effective || ('targetNodeId' in rule.then && offNodes.has(rule.then.targetNodeId)))) {
      const off = rule.effective && !inEffect(rule.effective, issueDate);
      if (off || ('targetNodeId' in rule.then && offNodes.has(rule.then.targetNodeId))) {
        evaluatePredicate(rule.when, ctx, inputs);
        const target = 'targetNodeId' in rule.then ? rule.then.targetNodeId : undefined;
        const targetNode = target ? nodes.get(target) : undefined;
        const note = off ? notInEffectWords(rule.effective!, issueDate) : `The section “${targetNode?.name ?? target}” it shows is not in effect. ${notInEffectWords(targetNode!.effective!, issueDate)}`;
        trace.push({ ruleId: rule.id, kind: 'rule', version: rule.version, mode: rule.mode, priority: rule.priority, enabled: true, matched: false, predicateInputs: inputs, expression: rule.when, action: rule.then, ...(target ? { targetNodeId: target } : {}), outcome: 'out-of-scope', note, period: { period: off ? rule.effective! : targetNode!.effective!, issueDate } });
        continue;
      }
    }
    const tested = test(rule.when, inputs);
    const isMatch = tested === true;
    const entry: TraceEntry = { ruleId: rule.id, kind: 'rule', version: rule.version, mode: rule.mode, priority: rule.priority, enabled: true, matched: isMatch, predicateInputs: inputs, expression: rule.when, action: rule.then, outcome: isMatch ? 'applied' : 'not-matched' };
    if ('targetNodeId' in rule.then) entry.targetNodeId = rule.then.targetNodeId;
    if (typeof tested !== 'boolean') { entry.undecided = undecided(tested); entry.note = `Could not be decided: ${tested.message}`; need(tested, 'blocking', `rule ${rule.id}`); }
    if (rule.effective) entry.period = { period: rule.effective, issueDate };
    trace.push(entry);
    if (!isMatch) continue;
    matched.push(rule.id);
    if (rule.mode === 'exclusive') {
      const group = rule.exclusiveGroup ?? (rule.then as any).targetNodeId;
      exclusive.set(group, [...(exclusive.get(group) ?? []), rule]);
    } else if (rule.mode === 'obligation') {
      entry.outcome = 'required';
      const ids = rule.then.op === 'requireNodes' ? rule.then.nodeIds : [];
      mandatory.push(...ids);
      for (const id of ids) if (!nodes.has(id)) findings.push({ code: 'REQUIRED_NODE_MISSING', severity: 'blocking', nodeId: id, ruleId: rule.id, source: 'resolver', message: `Mandatory node ${id} required by ${rule.id} is missing from the project.` });
    } else {
      additive.push(rule.id);
      const a = rule.then;
      if (a.op === 'showSection') sectionsShown.set(a.targetNodeId, [...(sectionsShown.get(a.targetNodeId) ?? []), rule.id]);
      if (a.op === 'setPresentationHint' && !hints.includes(a.hint)) hints.push(a.hint);
      if (a.op === 'setApprovedLocale') { approvedLocale = a.locale; translationRuleId = rule.id; }
    }
  }

  // 5. Exclusive variant precedence (+ conditional regions). Mandatory first, then additive, then exclusive.
  const selected: Record<string, string | null> = {};
  const regionSelections = new Map<string, { ids: string[]; source: RVariant['source']; ruleIds: string[]; unresolved: boolean }>();
  const traceById = new Map(trace.map((t) => [t.ruleId, t]));
  for (const node of project.nodes) {
    if (node.type !== 'variant-set' && node.type !== 'conditional-region') continue;
    if (offNodes.has(node.id)) { regionSelections.set(node.id, { ids: [], source: null, ruleIds: [], unresolved: false }); continue; }
    let hits = [...(exclusive.get(node.id) ?? [])].sort((a, b) => b.priority - a.priority);
    // An alternative outside its period cannot be chosen; neither can a fallback outside its period.
    const variantOff = (vid: string | undefined) => !!vid && !!dateSource && !!node.variantPeriods?.[vid] && !inEffect(node.variantPeriods[vid], issueDate);
    if (dateSource && node.variantPeriods) {
      hits = hits.filter((r) => {
        const vid = (r.then as { variantId?: string }).variantId;
        if (!variantOff(vid)) return true;
        const t = traceById.get(r.id);
        if (t) { t.outcome = 'out-of-scope'; t.matched = false; t.note = `The alternative “${parts.get(vid!)?.title ?? vid}” it chooses is not in effect. ${notInEffectWords(node.variantPeriods![vid!], issueDate)}`; t.period = { period: node.variantPeriods![vid!], issueDate }; }
        const mi = matched.indexOf(r.id); if (mi >= 0) matched.splice(mi, 1);
        return false;
      });
    }
    const fallbackId = variantOff(node.fallbackVariantId) ? undefined : node.fallbackVariantId;
    let ids: string[] = [];
    let source: RVariant['source'] = null;
    let ruleIds: string[] = [];
    let unresolved = false;
    if (hits.length > 1 && hits[0].priority === hits[1].priority) {
      const tied = hits.filter((r) => r.priority === hits[0].priority).map((r) => r.id);
      findings.push({ code: 'EXCLUSIVE_PRIORITY_TIE', severity: 'blocking', nodeId: node.id, ruleIds: tied, source: 'resolver', message: `Rules ${tied.join(' and ')} both match ${node.id} at priority ${hits[0].priority}. No winner is chosen silently.`, suggestion: 'Change one rule priority or narrow a condition.' });
      tied.forEach((id) => { const t = traceById.get(id); if (t) t.outcome = 'tie'; });
      hits.slice(tied.length).forEach((r) => { const t = traceById.get(r.id); if (t) t.outcome = 'outranked'; });
      unresolved = true;
    } else if (hits.length) {
      const winner = hits[0];
      const variantId = (winner.then as any).variantId as string;
      ids = [variantId]; source = 'rule'; ruleIds = [winner.id];
      const t = traceById.get(winner.id); if (t) t.outcome = 'selected';
      hits.slice(1).forEach((r) => { const tt = traceById.get(r.id); if (tt) { tt.outcome = 'outranked'; tt.note = `Outranked by ${winner.id} (priority ${winner.priority} > ${r.priority}).`; } });
      if (!node.variantIds?.includes(variantId)) findings.push({ code: 'UNKNOWN_VARIANT', severity: 'blocking', nodeId: node.id, ruleId: winner.id, source: 'resolver', message: `${winner.id} selects ${variantId}, which is not a variant of ${node.id}.` });
    } else if (node.type === 'conditional-region' && node.ruleDriven) {
      const by = sectionsShown.get(node.id);
      if (by) { ids = [node.fallbackVariantId ?? node.variantIds?.[0] ?? node.id]; source = 'section-rule'; ruleIds = by; }
    } else if (node.type === 'conditional-region' && node.variantConditions && Object.keys(node.variantConditions).length) {
      for (const vid of node.variantIds ?? []) {
        const cond = node.variantConditions[vid];
        if (!cond) continue;
        const inputs: Record<string, unknown> = {};
        if (variantOff(vid)) {
          evaluatePredicate(cond, ctx, inputs);
          trace.push({ ruleId: `${node.id}:${vid}`, kind: 'inline-condition', mode: 'inline', enabled: true, matched: false, predicateInputs: inputs, expression: cond, targetNodeId: node.id, outcome: 'out-of-scope', note: notInEffectWords(node.variantPeriods![vid], issueDate), period: { period: node.variantPeriods![vid], issueDate } });
          continue;
        }
        const tested = test(cond, inputs);
        const ok = tested === true;
        if (typeof tested !== 'boolean') need(tested, 'blocking', node.name ?? node.id);
        trace.push({ ruleId: `${node.id}:${vid}`, kind: 'inline-condition', mode: 'inline', enabled: true, matched: ok, predicateInputs: inputs, expression: cond, targetNodeId: node.id, outcome: ok && (node.policy === 'additive' || !ids.length) ? 'selected' : ok ? 'outranked' : 'not-matched', ...(typeof tested !== 'boolean' ? { undecided: undecided(tested), note: `Could not be decided: ${tested.message}` } : {}) });
        if (ok && (node.policy === 'additive' || !ids.length)) { ids.push(vid); source = 'inline'; ruleIds.push(`${node.id}:${vid}`); }
      }
      if (!ids.length && fallbackId) { ids = [fallbackId]; source = 'fallback'; }
    } else if (fallbackId) {
      ids = [fallbackId]; source = 'fallback';
      findings.push({ code: 'FALLBACK_SELECTED', severity: 'info', nodeId: node.id, source: 'resolver', message: `No exclusive rule matched ${node.id}; the named fallback ${fallbackId} was selected and recorded.` });
    } else if (node.type === 'variant-set') {
      unresolved = true;
      const fallbackOff = !!node.fallbackVariantId && fallbackId === undefined;
      findings.push({ code: 'NO_VARIANT_MATCH', severity: 'blocking', nodeId: node.id, source: 'resolver', message: fallbackOff ? `No exclusive rule matched ${node.id}, and its fallback “${parts.get(node.fallbackVariantId!)?.title ?? node.fallbackVariantId}” is not in effect: ${notInEffectWords(node.variantPeriods![node.fallbackVariantId!], issueDate)}` : `No exclusive rule matched ${node.id} and it has no fallback variant.`, suggestion: fallbackOff ? 'Give the message an alternative that is in effect on this date, or change the fallback’s period.' : 'Add a fallback variant or a matching rule.' });
    }
    if (node.type === 'variant-set') selected[node.id] = unresolved ? null : ids[0] ?? null;
    regionSelections.set(node.id, { ids, source, ruleIds, unresolved });
  }

  // Domain invariants.
  if (docType === 'credit-statement' && (effective as any).card) {
    const card = (effective as any).card;
    if (card.paymentStatus === 'current' && (card.missedPayments ?? 0) > 0) findings.push({ code: 'INCONSISTENT_PAYMENT_STATE', severity: 'blocking', nodeId: 'payment-guidance', source: 'domain', message: `Input is contradictory: paymentStatus=current with missedPayments=${card.missedPayments}. Priority is not used to hide this.`, suggestion: 'Correct the record or scenario overrides.' });
    if (card.newBalanceCents !== (card.previousBalanceCents ?? 0) + (card.purchasesCents ?? 0) - (card.paymentsCreditsCents ?? 0) + (card.interestFeesCents ?? 0)) findings.push({ code: 'BALANCE_RECONCILIATION_FAILED', severity: 'blocking', nodeId: 'billing-summary', source: 'domain', message: `New balance ${formatCents(card.newBalanceCents)} ≠ previous + purchases − payments + fees.` });
  }
  const claim = ctx.claim as any;
  const liabilityConfirmed = docType !== 'eob' || claim?.liabilityConfirmed === true;
  if (docType === 'eob' && claim && Object.keys(claim).length) {
    if (claim.status === 'denied-pending-review' && !claim.liabilityConfirmed && (claim.patientResponsibilityCents ?? 0) > 0) findings.push({ code: 'UNCONFIRMED_MEMBER_LIABILITY', severity: 'blocking', nodeId: 'totals-and-terms', source: 'domain', message: `Claim ${claim.claimId} is denied pending review with unconfirmed liability, but ${formatCents(claim.patientResponsibilityCents)} is supplied as member responsibility. It will not be shown as owed.` });
    if (claim.status === 'processed-covered' && (claim.billedCents !== claim.allowedCents + claim.contractualAdjustmentCents || claim.allowedCents !== claim.planPaidCents + claim.patientResponsibilityCents)) findings.push({ code: 'CLAIM_RECONCILIATION_FAILED', severity: 'blocking', nodeId: 'totals-and-terms', source: 'domain', message: `Claim ${claim.claimId} does not reconcile: billed = adjustment + allowed and allowed = plan paid + member responsibility must hold.` });
  }

  // Document language: a rule may set it (R07); otherwise a customer whose preferred language is one of the project's
  // languages gets the document in that language, under the same obligations.
  const preferred = effective.customer?.locale as string | undefined;
  if (!approvedLocale && preferred && preferred !== SOURCE_LANGUAGE && projectLanguages(project).includes(preferred)) { approvedLocale = preferred; translationRuleId = 'project-language'; }

  // Translation obligations (R07 does not authorize runtime machine translation).
  if (translationRuleId && approvedLocale) {
    const required = new Set<string>(mandatory);
    Object.values(selected).forEach((v) => v && required.add(v));
    for (const id of [...required].sort()) {
      const part = parts.get(id);
      if (part && !part.approvedLocales[approvedLocale as 'en-US']) findings.push({ code: 'REQUIRED_TRANSLATION_MISSING', severity: 'blocking', nodeId: id, locale: approvedLocale, source: 'resolver', message: `No approved ${approvedLocale} version of “${part.title}” (${id}). Runtime machine translation is not permitted.`, suggestion: `Open Content & Translations, write or draft the ${languageShortName(approvedLocale)} text and approve it.` });
    }
  }

  // Everything a customer reads, in the document language. Obligations above were checked against approved text only;
  // previews (includeDrafts) may additionally show unapproved drafts, which is reported and never reaches a clean export.
  const localized = localizeProject(project, approvedLocale, { includeDrafts: input.includeDrafts === true });
  nodes = new Map(localized.project.nodes.map((n) => [n.id, n]));
  parts = new Map(localized.project.contentParts.map((p) => [p.id, p]));
  if (approvedLocale && approvedLocale !== SOURCE_LANGUAGE) {
    const lang = languageShortName(approvedLocale);
    if (localized.draftsShown.length) findings.push({ code: 'UNAPPROVED_TRANSLATION_SHOWN', severity: 'warning', locale: approvedLocale, source: 'translation', message: `This preview shows ${localized.draftsShown.length} ${lang} text${localized.draftsShown.length === 1 ? '' : 's'} that ${localized.draftsShown.length === 1 ? 'is' : 'are'} not approved yet. Exports use approved text only.`, suggestion: 'Review the drafts in Content & Translations and approve them.', details: { ids: localized.draftsShown } });
    if (localized.missing.length) findings.push({ code: 'TRANSLATION_MISSING_TEXT', severity: 'warning', locale: approvedLocale, source: 'translation', message: `${localized.missing.length} label${localized.missing.length === 1 ? '' : 's'} or other text${localized.missing.length === 1 ? ' has' : 's have'} no approved ${lang} translation; the English text is shown.`, suggestion: `Open Content & Translations and translate the remaining ${lang} texts.`, details: { ids: localized.missing } });
  }

  const requiredSet = new Set(mandatory);
  for (const n of project.nodes) if (n.required) requiredSet.add(n.id);
  const c: Ctx = { project: localized.project, ctx, locale: approvedLocale ?? (effective.customer?.locale as string) ?? 'en-US', approvedLocale, fields: projectFieldIndex(project), sys: localized.system, findings, parts, liabilityConfirmed };
  const missingValueAt = (at: unknown): Ctx['missingValue'] => (path, nodeId) => {
    const m = missingAt(path, at);
    // A component of a later item of a repeating section is `<id>~<n>`: it is named by the component it repeats.
    const own = nodeId.replace(/~\d+$/, '');
    if (m) need(m, requiredSet.has(own) ? 'blocking' : 'warning', nodeId.startsWith('@email/') ? 'the email' : nodeId.startsWith('@sms/') ? 'the text message (SMS)' : nodes.get(own)?.name ?? own);
  };
  if (depth) c.missingValue = missingValueAt(ctx);

  // Email and SMS wording, resolved with the same field formatting and guards as document text. `{{keyFacts}}` and
  // `{{link}}` stay in place for the channel renderers, which know the document's key figures and action links.
  const quiet: Ctx = { ...c, findings: [] };
  const issuerText = (t: string) => t.replace(/\{\{\s*issuer\.name\s*\}\}/g, project.issuer?.name ?? 'Issuer').replace(/\{\{\s*issuer\.product\s*\}\}/g, project.issuer?.product ?? project.issuer?.name ?? 'Issuer');
  const chBlocks = (t: string, id: string) => (t.trim() ? textBlocks(quiet, issuerText(t), id, []) : []);
  const chPlain = (t: string, id: string) => chBlocks(t, id).map((b) => (b.inlines ?? []).map((i) => i.text).join('')).join(' ').trim();
  const ch = localized.channels;
  const channelTexts: ChannelTexts = {
    subject: chPlain(ch.email.subject, '@email/subject'), preheader: chPlain(ch.email.preheader, '@email/preheader'), title: chPlain(ch.email.title, '@email/title'),
    keyFactsHeading: chPlain(ch.email.keyFactsHeading, '@email/keyFactsHeading'), intro: chBlocks(ch.email.intro, '@email/intro'), closing: chBlocks(ch.email.closing, '@email/closing'),
    sms: chPlain(ch.sms.text, '@sms/text'), sections: ch.email.sections,
  };

  // 6. Resolved communication tree.
  const ruleTargets = new Map<string, string[]>();
  for (const r of project.rules) if (r.scope === docType && 'targetNodeId' in r.then) ruleTargets.set(r.then.targetNodeId, [...(ruleTargets.get(r.then.targetNodeId) ?? []), r.id]);

  /** Richer data shapes (wave 5): the scope of one item of a repeating section (its context, its id suffix, which item). */
  interface ItemScope { c: Ctx; suffix: string; item: NonNullable<RNode['repeatItem']> }
  const baseC = c;
  const buildNode = (node: DocNode, ancestorsHidden: boolean, scope?: ItemScope): RNode => {
    const c = scope?.c ?? baseC;
    const at = c.ctx;
    const rid = scope?.suffix ? `${node.id}${scope.suffix}` : node.id;
    const lineage: string[] = [];
    const reasons: string[] = [];
    let visible = !ancestorsHidden;
    let hiddenReason: string | undefined = ancestorsHidden ? 'Parent section is not rendered.' : undefined;
    const r: RNode = { id: rid, type: node.type, name: node.name ?? node.id, visible: true, visibleBecause: reasons, ruleIds: [], dataLineage: lineage, layout: node.layout, decorative: node.decorative, required: requiredSet.has(node.id) || undefined, children: [] };
    if (scope) { r.repeatItem = scope.item; if (scope.suffix) r.instanceOf = node.id; }
    if (requiredSet.has(node.id)) {
      const by = project.rules.filter((x) => x.then.op === 'requireNodes' && x.then.nodeIds.includes(node.id) && matched.includes(x.id)).map((x) => x.id);
      reasons.push(by.length ? `Mandatory: required by ${by.join(', ')}` : 'Mandatory component');
      r.ruleIds.push(...by);
    }
    if (dateSource && node.effective && visible && !requiredSet.has(node.id) && !inEffect(node.effective, issueDate)) {
      visible = false;
      hiddenReason = notInEffectWords(node.effective, issueDate);
      trace.push({ ruleId: `${rid}:period`, kind: 'inline-condition', mode: 'inline', enabled: true, matched: false, predicateInputs: {}, expression: { op: 'and', args: [] }, targetNodeId: node.id, outcome: 'out-of-scope', note: hiddenReason, period: { period: node.effective, issueDate } });
    }
    if (node.visibleWhen && visible) {
      const inputs: Record<string, unknown> = {};
      const tested = test(node.visibleWhen, inputs, at);
      const ok = tested === true;
      if (typeof tested !== 'boolean' && !requiredSet.has(node.id)) need(tested, 'blocking', node.name ?? node.id);
      trace.push({ ruleId: `${rid}:visibleWhen`, kind: 'inline-condition', mode: 'inline', enabled: true, matched: ok, predicateInputs: inputs, expression: node.visibleWhen, targetNodeId: rid, outcome: ok ? 'applied' : 'not-matched', ...(typeof tested !== 'boolean' ? { undecided: undecided(tested), note: `Could not be decided: ${tested.message}` } : {}) });
      lineage.push(...predicatePaths(node.visibleWhen));
      if (!ok && !requiredSet.has(node.id)) { visible = false; hiddenReason = `Condition not met: ${describePredicate(node.visibleWhen)}`; }
      else reasons.push(`Condition met: ${describePredicate(node.visibleWhen)}`);
    }

    switch (node.type) {
      case 'rich-text':
        r.text = blocksFromRich(c, node.content, node.id, lineage);
        break;
      case 'bound-field':
      case 'summary-metric': {
        const path = node.binding ?? '';
        const { value, known } = valueFor(c, path, node.id, lineage);
        const f = c.fields.get(path);
        const formatter = node.formatter ?? (f?.type === 'cents' ? 'usd-cents' : f?.type === 'date' ? 'date' : f?.type === 'number' ? 'number' : 'text');
        // Yes/no values use the document language's own words where they have been translated (as tokens in text do).
        const yesNo = typeof value === 'boolean' && formatter === 'text' ? c.sys[value ? 'valueYes' : 'valueNo'] : undefined;
        let display = known ? yesNo ?? formatValue(value, formatter, c.locale) : `{{${path}}}`;
        const missing = !known || value === null || value === '';
        if (missing && known) c.missingValue?.(path, node.id);
        let guarded = false;
        if (missing && known) {
          const policy = node.nullPolicy ?? 'fallback';
          if (policy === 'fallback') display = node.fallbackText ?? '—';
          else if (policy === 'blank') display = '';
          else if (policy === 'suppress') { if (!requiredSet.has(node.id)) { visible = false; hiddenReason = `Suppressed: ${path} has no value (null policy “suppress”).`; } }
          else if (policy === 'error') findings.push({ code: 'NULL_BINDING', severity: 'blocking', nodeId: node.id, source: 'binding', message: `${path} is empty but ${node.id} requires a value (null policy “error”).` });
        }
        if ((node.domainRole === 'member-liability' || path === 'claim.patientResponsibilityCents') && docType === 'eob' && !liabilityConfirmed) {
          guarded = true;
          display = sysText(c.sys, 'guardNotDetermined');
          reasons.push('Liability guard: member responsibility is unconfirmed, so no amount is presented as owed.');
        }
        if (docType === 'eob' && !liabilityConfirmed && DEBT_LANGUAGE.test(node.label ?? '') && f?.type === 'cents') {
          findings.push({ code: 'UNCONFIRMED_DEBT_LANGUAGE', severity: 'blocking', nodeId: node.id, source: 'domain', message: `“${node.label}” presents ${path} as an amount owed while member liability is unconfirmed. EOBs are not bills.`, suggestion: 'Use neutral wording or bind an approved, confirmed liability field.' });
        }
        r.field = { label: node.label ?? f?.label ?? path, path, raw: value, display, missing, guarded: guarded || undefined, importance: node.importance, formatter };
        if (f?.type === 'cents' && typeof value === 'number' && !guarded) r.field.cents = value;
        break;
      }
      case 'repeating-table': {
        const path = node.binding ?? '';
        const { value, known } = valueFor(c, path, node.id, lineage);
        const rows: RTableRow[] = [];
        let total = 0;
        let hasMoney = false;
        // One of the project's own lists that a customer simply does not have (no value at all) is an empty table, not a broken binding.
        const absentList = known && value === null && path.startsWith('custom.') && c.fields.get(path)?.type === 'array';
        if (known && !Array.isArray(value) && !absentList) findings.push({ code: 'INVALID_BINDING', severity: 'blocking', nodeId: node.id, source: 'binding', message: `${path} is not a collection.` });
        // The column that is summed: the one marked for it, else the amount column of the built-in lists.
        // A document with its own data sums only the column marked for a total; the built-in kinds also their amount column.
        const amountKey = docType === 'custom' ? node.columns?.find((col) => col.total)?.key : totalColumnKey(node.columns);
        (Array.isArray(value) ? value : []).forEach((item: any, i: number) => {
          const cells: RTableRow['cells'] = {};
          for (const col of node.columns ?? []) {
            // A column of a group in the row is read by its dotted key (`holder.name`, wave 5).
            const raw = (col.key.includes('.') ? getPath(item, col.key) : item?.[col.key]) ?? null;
            const rowGuard = col.domainRole === 'member-liability' && docType === 'eob' && item?.liabilityConfirmed !== true;
            cells[col.key] = rowGuard ? { raw, display: sysText(c.sys, 'guardUnderReview'), guarded: true } : { raw, display: formatValue(raw, col.format, c.locale), ...(col.format === 'usd-cents' && typeof raw === 'number' ? { cents: raw } : {}) };
          }
          if (amountKey && typeof item?.[amountKey] === 'number') { total += item[amountKey]; hasMoney = true; }
          rows.push({ id: String(item?.id ?? item?.claimId ?? `${node.id}-row-${i + 1}`), cells });
        });
        if (node.totalFrom) {
          // The footer shows a chosen amount (a calculated or data field) instead of the column sum.
          const t = valueFor(c, node.totalFrom, node.id, lineage);
          if (t.known && typeof t.value === 'number' && Number.isSafeInteger(t.value)) { total = t.value; hasMoney = true; }
          else { hasMoney = false; if (t.known) c.missingValue?.(node.totalFrom, node.id); }
        }
        const hinted = hints.includes('repeating-table-headings-and-continuation');
        const repeatHeader = node.repeatHeader === 'always' || (node.repeatHeader !== 'never' && hinted);
        if (hinted) reasons.push('R10 hint: repeat headings and continuation enabled');
        r.table = { path, columns: node.columns ?? [], rows, repeatHeader, continuation: node.flowContinuation !== false, caption: node.caption ?? node.name ?? 'Table', totalCents: hasMoney ? total : undefined, sortable: node.sortable !== false, filterable: node.filterable !== false };
        if (!rows.length) reasons.push('Empty collection: table shows an explicit empty state');
        break;
      }
      case 'chart': {
        const ch = node.chart ?? { kind: 'bar' as const };
        const data: Array<{ label: string; value: number; display: string }> = [];
        // Amounts are shown as money; a whole-number field or column (a count, a quantity) as a plain number.
        const shown = (v: number, type: string | undefined) => (type === 'int' || type === 'points' ? formatValue(v, 'int', c.locale) : formatCents(v, c.locale));
        if (ch.series?.length) {
          for (const s of ch.series) {
            const { value, known } = valueFor(c, s.path, node.id, lineage);
            if (known && value === null) c.missingValue?.(s.path, node.id);
            if (!known || typeof value !== 'number' || value <= 0) continue;
            if (s.path === 'claim.patientResponsibilityCents' && !liabilityConfirmed) continue;
            data.push({ label: s.label, value, display: shown(value, c.fields.get(s.path)?.type) });
          }
        } else if (node.binding) {
          const { value } = valueFor(c, node.binding, node.id, lineage);
          const valueType = c.fields.get(node.binding)?.itemFields?.find((it) => it.key === (ch.valueKey ?? 'amountCents'))?.type;
          const groups = new Map<string, number>();
          for (const item of Array.isArray(value) ? value : []) {
            const key = String(item?.[ch.groupBy ?? 'merchant'] ?? 'Other');
            groups.set(key, (groups.get(key) ?? 0) + (Number.isInteger(item?.[ch.valueKey ?? 'amountCents']) ? item[ch.valueKey ?? 'amountCents'] : 0));
          }
          // A series over time keeps the order of the list's rows (the last `limit` of them); otherwise the biggest come first.
          const entries = [...groups.entries()];
          const ordered = ch.order === 'data' ? entries.slice(Math.max(0, entries.length - (ch.limit ?? 5))) : entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, ch.limit ?? 5);
          ordered.forEach(([label, v]) => data.push({ label, value: v, display: shown(v, valueType) }));
        }
        const summary = data.length ? `${ch.title ?? 'Chart'}: ` + data.map((d) => `${d.label} ${d.display}`).join('; ') + '.' : `${ch.title ?? 'Chart'}: no data for this scenario.`;
        r.chart = { kind: ch.kind, title: ch.title ?? 'Chart', data, summary };
        break;
      }
      case 'variant-set':
      case 'conditional-region': {
        let sel = regionSelections.get(node.id)!;
        if (scope && node.type === 'conditional-region' && !node.ruleDriven && node.variantConditions && Object.keys(node.variantConditions).length) {
          // Inside a repeating section (wave 5): the section's own conditions are decided for each item.
          const ids: string[] = [];
          for (const vid of node.variantIds ?? []) {
            const cond = node.variantConditions[vid];
            if (!cond) continue;
            const inputs: Record<string, unknown> = {};
            const tested = test(cond, inputs, at);
            if (typeof tested !== 'boolean') need(tested, 'blocking', node.name ?? node.id);
            const ok = tested === true && (node.policy === 'additive' || !ids.length);
            trace.push({ ruleId: `${rid}:${vid}`, kind: 'inline-condition', mode: 'inline', enabled: true, matched: tested === true, predicateInputs: inputs, expression: cond, targetNodeId: rid, outcome: ok ? 'selected' : tested === true ? 'outranked' : 'not-matched' });
            if (ok) ids.push(vid);
          }
          const fb = !ids.length && node.fallbackVariantId ? [node.fallbackVariantId] : [];
          sel = { ids: ids.length ? ids : fb, source: ids.length ? 'inline' : fb.length ? 'fallback' : null, ruleIds: ids.map((v) => `${rid}:${v}`), unresolved: false };
        }
        const items: RVariant[] = (node.variantIds ?? []).map((vid) => {
          const pt = partText(c, vid);
          const candidateRuleIds = project.rules.filter((x) => x.then.op === 'selectVariant' && x.then.targetNodeId === node.id && x.then.variantId === vid).map((x) => x.id);
          const isSel = sel.ids.includes(vid);
          return {
            id: vid, title: pt.part?.title ?? vid, contentVersion: pt.part?.version ?? null,
            matched: candidateRuleIds.some((id) => matched.includes(id)) || (sel.source === 'inline' && isSel) || (sel.source === 'section-rule' && isSel),
            selected: isSel, isFallback: node.fallbackVariantId === vid,
            ruleIds: isSel ? sel.ruleIds : candidateRuleIds.filter((id) => matched.includes(id)),
            candidateRuleIds,
            source: isSel ? sel.source : null,
            text: pt.part ? textBlocks(c, pt.text, node.id, isSel ? lineage : []) : [{ kind: 'p', inlines: [{ kind: 'text', text: `Missing content part ${vid}`, missing: true }] }],
            locale: pt.locale, missingLocale: pt.missingLocale || undefined,
          };
        });
        for (const vid of node.variantIds ?? []) if (!parts.has(vid)) findings.push({ code: 'MISSING_CONTENT_PART', severity: 'blocking', nodeId: node.id, source: 'resolver', message: `Variant ${vid} of ${node.id} has no content part.` });
        r.variants = { policy: node.policy ?? 'exclusive', selected: sel.ids, fallbackVariantId: node.fallbackVariantId, items, unresolved: sel.unresolved };
        r.ruleIds.push(...sel.ruleIds);
        const rulePaths = (ruleTargets.get(node.id) ?? []).flatMap((id) => predicatePaths(project.rules.find((x) => x.id === id)?.when));
        lineage.push(...rulePaths, ...Object.values(node.variantConditions ?? {}).flatMap(predicatePaths));
        if (sel.unresolved) reasons.push('Unresolved: blocking rule diagnostic');
        else if (sel.ids.length) {
          const how = sel.source === 'rule' ? `selected by ${sel.ruleIds.join(', ')}` : sel.source === 'section-rule' ? `shown by ${sel.ruleIds.join(', ')}` : sel.source === 'inline' ? 'inline condition matched' : 'named fallback (no rule matched)';
          reasons.push(`${sel.ids.join(', ')} — ${how}`);
        } else if (visible) {
          visible = false;
          hiddenReason = node.ruleDriven ? `No rule shows this section (${(ruleTargets.get(node.id) ?? []).join(', ') || 'no targeting rule'}).` : 'No branch condition matched and no fallback is defined.';
        }
        const selectedItems = items.filter((v) => v.selected);
        r.text = selectedItems.flatMap((v) => v.text);
        if (selectedItems.length === 1) r.contentVersion = `${selectedItems[0].id}@v${selectedItems[0].contentVersion}`;
        if (node.ruleDriven && visible && approvedLocale) {
          for (const v of selectedItems) if (v.missingLocale) findings.push({ code: 'TRANSLATION_MISSING_OPTIONAL', severity: 'warning', nodeId: v.id, locale: approvedLocale, source: 'resolver', message: `Optional section ${v.id} has no approved ${approvedLocale} text; English approved text is shown.` });
        }
        break;
      }
      case 'disclosure': {
        const pid = node.contentPartId ?? node.id;
        const pt = partText(c, pid);
        if (!pt.part) findings.push({ code: 'MISSING_CONTENT_PART', severity: 'blocking', nodeId: node.id, source: 'resolver', message: `Disclosure ${node.id} references missing approved content ${pid}.` });
        r.text = textBlocks(c, pt.text, node.id, lineage);
        r.disclosure = { contentPartId: pid, version: pt.part?.version ?? 0, contentHash: shortDigest({ id: pid, text: pt.part?.approvedLocales ?? {}, version: pt.part?.version ?? 0 }, 16), title: pt.part?.title ?? node.name ?? pid, jurisdiction: node.jurisdiction ?? [] };
        r.contentVersion = `${pid}@v${pt.part?.version ?? 0}`;
        break;
      }
      case 'action-link': {
        const a = node.action!;
        const safe = isSafeUrl(a?.url);
        if (!safe) findings.push({ code: 'UNSAFE_URL', severity: 'blocking', nodeId: node.id, source: 'binding', message: `Action URL for ${node.id} is not an allowed https URL.` });
        r.action = { label: a?.label ?? 'Action', url: safe ? a.url : '', fallbackText: a?.fallbackText ?? '', interactive: !hints.includes('print-friendly-guidance') };
        if (hints.includes('interactive-action-with-print-fallback')) reasons.push('R08: interactive action in HTML with printed fallback');
        if (hints.includes('print-friendly-guidance')) reasons.push('R09: print-friendly guidance, no interactive-only dependency');
        break;
      }
      case 'qr-code': {
        const safe = isSafeUrl(node.qr?.url);
        if (!safe) findings.push({ code: 'UNSAFE_URL', severity: 'blocking', nodeId: node.id, source: 'binding', message: `QR destination for ${node.id} is not an allowed https URL.` });
        r.qr = { url: safe ? node.qr!.url : '', caption: node.qr?.caption ?? '' };
        break;
      }
      case 'expandable-explanation':
        r.explanation = { title: node.explanation?.title ?? '', summary: node.explanation?.summary ?? '', details: node.explanation?.details ?? '' };
        break;
      case 'image':
        r.image = { src: node.image?.src ?? '', alt: node.image?.alt ?? '', fit: node.image?.fit ?? 'contain' };
        if (!node.decorative && !node.image?.alt) findings.push({ code: 'IMAGE_ALT_MISSING', severity: 'warning', nodeId: node.id, source: 'accessibility', message: `Image ${node.id} has no alternative text.` });
        break;
      case 'shape':
        r.shape = { ...(node.shape ?? { kind: 'line' }) };
        break;
      case 'header-footer':
        r.headerFooter = { role: node.headerFooter?.role ?? 'document-header', repeat: node.headerFooter?.repeat ?? false, inlines: inlinesFromRich(c, inlineFromMarkup(node.headerFooter?.text ?? ''), node.id, lineage) };
        break;
      case 'container':
        break;
    }

    if (!reasons.length && visible) reasons.push('Always rendered (no condition)');
    r.visible = visible;
    if (!visible) r.hiddenReason = hiddenReason;
    const kids = (node.children ?? []).map((cid) => nodes.get(cid)).filter((n): n is DocNode => !!n);
    if (node.type === 'container' && node.repeat) {
      // Richer data shapes (wave 5): a repeating section lays its content out once for each item of its list.
      const list = node.repeat.list;
      lineage.push(list);
      const label = c.fields.get(list)?.label ?? list;
      const items = itemContexts(at as Record<string, unknown>, list);
      r.repeat = { list, label, count: items.length, newPage: !!node.repeat.newPage, keepHeading: !!node.repeat.keepHeading };
      const fields = scopeFieldIndex(project, list);
      const scoped = (sc: Record<string, unknown>, quiet: boolean): Ctx => ({ ...c, ctx: sc, fields, ...(quiet ? { findings: [] } : {}), ...(depth ? { missingValue: quiet ? undefined : missingValueAt(sc) } : {}) });
      if (!items.length) {
        if (visible) { visible = false; hiddenReason = `No items in “${label}” for this customer.`; }
        // Laid out once, hidden, for an empty item: the components exist (for the canvas and checks) and report nothing.
        const empty = scoped(scopeCtx(at as Record<string, unknown>, list, {}, -1), true);
        r.children = kids.map((k, j) => buildNode(k, true, { c: empty, suffix: '', item: { section: rid, index: 1, count: 0, first: j === 0 } }));
      } else {
        r.children = items.flatMap((sc, i) => {
          const ic = scoped(sc, false);
          return kids.map((k, j) => {
            const out = buildNode(k, !visible, { c: ic, suffix: i ? `~${i + 1}` : '', item: { section: rid, index: i + 1, count: items.length, first: j === 0 } });
            if (j === 0 && i > 0 && node.repeat!.newPage) out.layout = { ...out.layout, paged: { ...(out.layout?.paged ?? { mode: 'flow' as const }), breakBefore: 'page' } };
            return out;
          });
        });
        reasons.push(`Repeated for ${items.length} item${items.length === 1 ? '' : 's'} of “${label}”`);
      }
      if (!reasons.length && visible) reasons.push('Always rendered (no condition)');
      r.visible = visible;
      if (!visible) r.hiddenReason = hiddenReason;
      r.dataLineage = [...new Set(lineage)];
      return r;
    }
    r.dataLineage = [...new Set(lineage)];
    r.children = kids.map((n) => buildNode(n, !visible, scope && { ...scope, item: { ...scope.item, first: false } }));
    return r;
  };

  const rootNode = nodes.get(project.rootNodeId);
  const root: RNode = rootNode ? buildNode(rootNode, false) : { id: project.rootNodeId, type: 'container', name: 'Missing root', visible: true, visibleBecause: [], ruleIds: [], dataLineage: [], children: [] };

  // Materialize showSection targets that are content parts rather than nodes (stable provenance).
  for (const [target, ruleIds] of sectionsShown) {
    if (nodes.has(target)) continue;
    const pt = partText(c, target);
    if (!pt.part) { findings.push({ code: 'UNKNOWN_SECTION', severity: 'warning', nodeId: target, ruleIds, source: 'resolver', message: `${ruleIds.join(', ')} shows ${target}, which is neither a node nor a content part.` }); continue; }
    const mat: RNode = { id: target, type: 'conditional-region', name: pt.part.title, visible: true, materialized: true, visibleBecause: [`Materialized by ${ruleIds.join(', ')} from content part ${target}`], ruleIds, dataLineage: [], children: [], text: textBlocks(c, pt.text, target, []), contentVersion: `${target}@v${pt.part.version}`, layout: { paged: { mode: 'flow', widthPct: 100, spaceBeforePt: 10 }, html: { area: 'main', span: 12 } } };
    const disclosureIdx = root.children.findIndex((ch) => ch.type === 'disclosure' && ch.required);
    root.children.splice(disclosureIdx >= 0 ? disclosureIdx : root.children.length, 0, mat);
  }

  // Unconfirmed debt language in visible text content (EOB domain guard).
  if (docType === 'eob' && !liabilityConfirmed) {
    const walk = (n: RNode) => {
      if (n.visible && (n.type === 'rich-text' || n.type === 'header-footer') && DEBT_LANGUAGE.test(plainOf(n.text) + ' ' + (n.headerFooter?.inlines.map((i) => i.text).join('') ?? '')) && !n.required) {
        findings.push({ code: 'UNCONFIRMED_DEBT_LANGUAGE', severity: 'blocking', nodeId: n.id, source: 'domain', message: `${n.id} uses amount-owed language while member liability is unconfirmed. An EOB is not a bill.`, suggestion: 'Remove “owed / amount due” wording or confirm liability through an approved field.' });
      }
      n.children.forEach(walk);
    };
    walk(root);
  }

  // 6b. Missing calculated values and a missing date, where the document needs them.
  if (dateSource && !issueDate && !findings.some((f) => f.code === 'ISSUE_DATE_INVALID')) {
    const use = documentDateUse(project);
    const dateNeeds = [...needs.entries()].filter(([, n]) => n.missing.code === 'no-date');
    const blocking = use.periods > 0 || dateNeeds.some(([, n]) => n.severity === 'blocking');
    if (blocking || dateNeeds.length) {
      const field = dateSource.source === 'field' ? projectFieldIndex(project).get(dateSource.path) : undefined;
      findings.push({
        code: 'DOCUMENT_DATE_MISSING', severity: blocking ? 'blocking' : 'warning', source: 'binding',
        message: `This document’s ${use.periods ? 'content' : 'wording'} depends on its date, and this customer has none.`,
        suggestion: dateSource.source === 'field' ? `Fill in “${field?.label ?? dateSource.path}” for this customer, or give a date for the run.` : 'Give the date for the run (“as issued on”).',
        details: { path: DOCUMENT_DATE_PATH, ...(dateSource.source === 'field' ? { input: dateSource.path } : {}), usedBy: [...new Set(dateNeeds.flatMap(([, n]) => [...n.where]))].sort() },
      });
    }
  }
  for (const [path, n] of needs) {
    if (n.missing.code === 'no-date') continue;
    const key = path.startsWith(CALC_PREFIX) ? path.slice(CALC_PREFIX.length) : path;
    const label = project.calculatedFields?.find((x) => x.key === key)?.label ?? key;
    const lookup = n.missing.code === 'no-lookup-row' || n.missing.code === 'no-lookup-value';
    const usedBy = [...n.where].sort();
    findings.push({
      code: lookup ? 'LOOKUP_NO_MATCH' : 'CALCULATION_MISSING', severity: n.severity, source: 'binding',
      message: `“${label}” could not be worked out for this customer: ${n.missing.message} It is used by ${usedBy.slice(0, 3).join(', ')}${usedBy.length > 3 ? ` and ${usedBy.length - 3} more` : ''}.`,
      suggestion: n.missing.code === 'input-missing' ? `Fill in the missing value in this customer’s data, or change “${label}” so it copes without it (for example with IF … IS EMPTY).`
        : n.missing.code === 'division-by-zero' ? `Change “${label}” so it never divides by zero (for example with IF), or correct this customer’s data.`
        : lookup ? 'Add a row that covers this customer to the lookup table, or give the table a default row.'
        : `Check the calculation “${label}”.`,
      details: { path, reason: n.missing.code, ...(n.missing.path ? { input: n.missing.path } : {}), ...(n.missing.via?.length ? { via: n.missing.via } : {}), usedBy },
    });
  }

  // 7. Facts and semantic manifest.
  // A document with its own data has no facts the engine knows by name: everything it shows is in the tree and the manifest.
  const documentFacts: Record<string, unknown> = docType === 'custom' ? {} : docType === 'credit-statement'
    ? { newBalanceCents: (effective as any).card?.newBalanceCents ?? null, minimumDueCents: (effective as any).card?.minimumDueCents ?? null, transactionCount: Array.isArray((effective as any).card?.transactions) ? (effective as any).card.transactions.length : 0 }
    : (() => { const cl = Object.keys(claim ?? {}).length ? claim : null; return { claimId: cl ? cl.claimId : null, billedCents: cl ? cl.billedCents : null, allowedCents: cl ? cl.allowedCents : null, planPaidCents: cl ? cl.planPaidCents : null, patientResponsibilityCents: cl ? cl.patientResponsibilityCents : null, liabilityConfirmed: cl ? cl.liabilityConfirmed : null, notABill: true }; })();

  const coreDiagnostics = findings.filter((f) => f.severity !== 'info' && ['resolver', 'domain', 'binding'].includes(f.source) && f.code !== 'TRANSLATION_MISSING_OPTIONAL').map(core).sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : (a.nodeId ?? '') < (b.nodeId ?? '') ? -1 : (a.nodeId ?? '') > (b.nodeId ?? '') ? 1 : 0));
  const result: CoreResult = {
    recordId: effective.recordId,
    documentType: docType,
    selectedVariants: selected,
    matchedRuleIds: [...matched].sort(),
    additiveRuleIds: [...additive].sort(),
    requiredNodes: [...new Set(mandatory)].sort(),
    diagnostics: coreDiagnostics,
    documentFacts,
  };
  result.resultDigest = digestOf(result);

  const manifest = buildResolverManifest(project, effective, root, result, c.locale);
  const projectDigest = projectContentDigest(project);
  const rulesDigest = digestOf(project.rules);
  const runId = 'run-' + shortDigest({ projectDigest, recordId: effective.recordId, overrides: input.overrides ?? {}, journeyCursor, claimIndex, profileId, engine: ENGINE_VERSION, ...(localized.draftsShown.length ? { includeDrafts: true } : {}), ...(issueGiven ? { issueDate } : {}) }, 16);
  // Content digest is content-addressed: excludes producer and the model version counter.
  const { producer: _p, modelVersion: _mv, ...manifestCore } = manifest;

  return {
    runId, projectId: project.projectId, modelVersion: project.modelVersion, projectDigest, recordId: effective.recordId, profileId, journeyCursor,
    rulesDigest, engineVersion: ENGINE_VERSION, locale: c.locale, hints, result, trace, findings, root, semanticManifest: manifest,
    contentDigest: digestOf(manifestCore), journeySteps: steps, effectiveRecord: effective,
    channelTexts, systemStrings: localized.system, translation: { locale: c.locale, draftsShown: localized.draftsShown, missing: localized.missing },
    ...(dateSource ? { documentDate: { date: issueDate, source: dateSource.source, given: issueGiven } } : {}),
    ...(calcs ? { calculated: calculatedOutcomes(project, calcs) } : {}),
  };
}

/** Each calculated field's value or why it is missing, with what it reads. */
function calculatedOutcomes(project: Project, calcs: CalcResults): Record<string, CalculatedOutcome> {
  const shape = outcomeShape(project);
  const out: Record<string, CalculatedOutcome> = {};
  for (const key of calcs.order) {
    const s = shape.get(key);
    if (!s) continue;
    out[key] = { label: s.label, type: s.type, value: calcs.values[key] ?? null, ...(calcs.missing[key] ? { missing: calcs.missing[key] } : {}), inputs: s.inputs, inputNames: s.inputNames };
  }
  return out;
}

/** What each calculation reads, by path and by name: the same for every customer, so worked out once per project. */
const SHAPES = new WeakMap<Project, Map<string, Pick<CalculatedOutcome, 'label' | 'type' | 'inputs' | 'inputNames'>>>();
function outcomeShape(project: Project): Map<string, Pick<CalculatedOutcome, 'label' | 'type' | 'inputs' | 'inputNames'>> {
  const hit = SHAPES.get(project);
  if (hit) return hit;
  const byKey = new Map((project.calculatedFields ?? []).map((x) => [x.key, x]));
  const fields = projectFieldIndex(project);
  const shape = new Map<string, Pick<CalculatedOutcome, 'label' | 'type' | 'inputs' | 'inputNames'>>();
  for (const def of byKey.values()) {
    const d = exprDependencies(def.expr);
    const inputs = [...d.fields, ...d.lists, ...d.calcs.map((k) => `${CALC_PREFIX}${k}`), ...(d.usesIssueDate ? [DOCUMENT_DATE_PATH] : [])];
    shape.set(def.key, { label: def.label, type: def.type, inputs, inputNames: inputs.map((x) => (x === DOCUMENT_DATE_PATH ? 'the document’s date' : x.startsWith(CALC_PREFIX) ? byKey.get(x.slice(CALC_PREFIX.length))?.label ?? x : fields.get(x)?.label ?? x)) });
  }
  SHAPES.set(project, shape);
  return shape;
}

/** The resolver's expected semantic facts — what every output adapter must preserve. */
export function buildResolverManifest(project: Project, record: any, root: RNode, result: CoreResult, locale: string): SemanticManifest {
  const visible: string[] = [];
  const money: Record<string, number> = {};
  const guarded: string[] = [];
  const disclosures: SemanticManifest['disclosures'] = [];
  const tableRows: Record<string, number> = {};
  const tableTotals: Record<string, number> = {};
  const actions: SemanticManifest['actions'] = [];
  const walk = (n: RNode) => {
    if (!n.visible) return;
    if (!n.decorative && n.type !== 'container') visible.push(n.id);
    if (n.field?.cents !== undefined) money[n.id] = n.field.cents;
    if (n.field?.guarded) guarded.push(n.id);
    if (n.disclosure) disclosures.push({ nodeId: n.id, contentPartId: n.disclosure.contentPartId, version: n.disclosure.version, contentHash: n.disclosure.contentHash });
    if (n.table) { tableRows[n.id] = n.table.rows.length; if (n.table.totalCents !== undefined) tableTotals[n.id] = n.table.totalCents; }
    if (n.action?.url) actions.push({ nodeId: n.id, url: n.action.url });
    n.children.forEach(walk);
  };
  walk(root);
  let identity: Record<string, string> = { name: `${record.customer?.givenName ?? ''} ${record.customer?.familyName ?? ''}`.trim() };
  if (record.card?.maskedAccount) identity.account = record.card.maskedAccount;
  if (record.card?.issuedAt) identity.statementDate = record.card.issuedAt;
  if (record.member?.memberId) identity.memberId = record.member.memberId;
  if (project.documentType === 'custom') {
    // A document with its own data may show the customer's name in full, in part or not at all (an empty page shows
    // nothing). Its identity is the name as far as the document shows it, which is what every output can be checked against.
    const shownNames: Record<string, string> = {};
    const see = (path: string | undefined, text: string) => { if ((path === 'customer.givenName' || path === 'customer.familyName') && !(path in shownNames)) shownNames[path] = text.trim(); };
    const seen = (n: RNode) => {
      if (!n.visible) return;
      for (const b of n.text ?? []) for (const i of [...(b.inlines ?? []), ...(b.items ?? []).flat()]) if (i.kind === 'token') see(i.path, i.text);
      for (const i of n.headerFooter?.inlines ?? []) if (i.kind === 'token') see(i.path, i.text);
      if (n.type === 'bound-field' && n.field) see(n.field.path, n.field.display);
      n.children.forEach(seen);
    };
    seen(root);
    const name = [shownNames['customer.givenName'], shownNames['customer.familyName']].filter(Boolean).join(' ');
    identity = name ? { name } : {};
  }
  return {
    schema: 'semantic-manifest/1', producer: 'resolver', projectId: project.projectId, modelVersion: project.modelVersion, recordId: record.recordId, documentType: project.documentType, locale,
    selectedVariants: result.selectedVariants, requiredNodeIds: result.requiredNodes, visibleNodeIds: visible.sort(), money, guardedLiabilityNodeIds: guarded.sort(), disclosures, identity, tableRows, tableTotalsCents: tableTotals, actions, facts: result.documentFacts,
  };
}

/** Flatten the resolved tree into an id → node index. */
export function indexTree(root: RNode): Map<string, RNode> {
  const m = new Map<string, RNode>();
  const walk = (n: RNode) => { m.set(n.id, n); n.children.forEach(walk); };
  walk(root);
  return m;
}

export { richToPlain };
