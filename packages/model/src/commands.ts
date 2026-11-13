import { produce } from 'immer';
import { CATALOG_BY_TYPE, starterContentParts } from './catalog';
import { digestOf } from './digest';
import { isSafeUrl, sanitizeRichDoc, tokensIn } from './rich';
import { projectFieldIndex, validateCustomFields } from './fields';
import { isSupportedLanguage, languageName, languageShortName, projectLanguages, SOURCE_LANGUAGE } from './languages';
import { isStringId, translatableStrings } from './strings';
import { tokensOfText } from './translations';
import { CHANNEL_TEXT_LIMITS, CHANNEL_TOKENS, EMAIL_SECTION_IDS } from './channels';
import { RECORD_ID_PATTERN } from './types';
import type { CalculatedField, ChannelConfig, DocumentDateSource, EffectivePeriod, GlossaryEntry, LookupTable, TranslationOrigin } from './types';
import { CALC_MAX, exprDependencies, predicateLeafPaths, validateCalculatedFields } from './expressions';
import { documentDateUse, isConditionalSection, periodProblem } from './effective';
import { CALC_PREFIX } from './fields';
import { isIsoDay } from './isoDate';
import { LOOKUP_TABLES_MAX, validateLookupTable } from './lookup';
import type { BrandKit, ContentPart, CustomField, DocNode, Locale, TestCase, TextStyle, JourneyEvent, NodeLayout, PagedLayout, Predicate, PresentationProfile, Project, ResponsiveLayout, Rule } from './types';
import { validatePredicate, validateRule } from './validate';
import { applyPageDesignPatch, pagedFlowProblems, pagedProfileOf, pageDesignLabel, pageDesignProblems, pageSizePt, refitFixedLayouts, type PageDesignPatch } from './pageDesign';

/**
 * Unified typed command bus. Every authoring mutation is one of these commands.
 * `applyCommand` is pure: it validates and returns a new immutable project (modelVersion+1)
 * or a structured rejection that leaves the model untouched.
 */
export type Command =
  | { type: 'INSERT_NODE'; node: DocNode; parentId: string; index?: number }
  | { type: 'DELETE_NODE'; nodeId: string }
  | { type: 'MOVE_NODE'; nodeId: string; parentId: string; index: number }
  | { type: 'UPDATE_NODE'; nodeId: string; patch: Partial<Omit<DocNode, 'id' | 'type' | 'children'>> }
  | { type: 'SET_LAYOUT'; nodeId: string; profile: 'paged' | 'html'; layout: Partial<PagedLayout & ResponsiveLayout> }
  | { type: 'DUPLICATE_NODE'; nodeId: string; newId: string }
  | { type: 'UPSERT_RULE'; rule: Rule }
  | { type: 'DELETE_RULE'; ruleId: string }
  | { type: 'SET_RULE_ENABLED'; ruleId: string; enabled: boolean }
  | { type: 'UPSERT_CONTENT_PART'; part: ContentPart; advanced?: boolean; reason?: string }
  | { type: 'ADD_VARIANT'; nodeId: string; variantId: string; title: string; text: string; when?: Predicate }
  | { type: 'REMOVE_VARIANT'; nodeId: string; variantId: string }
  | { type: 'SET_VARIANT_CONDITION'; nodeId: string; variantId: string; when: Predicate | null }
  | { type: 'SET_JOURNEY'; events: JourneyEvent[] }
  | { type: 'UPDATE_PROFILE'; profileId: string; patch: Partial<PresentationProfile> }
  | { type: 'SET_CUSTOM_FIELDS'; fields: CustomField[] }
  | { type: 'SET_STYLES'; styles: TextStyle[] }
  | { type: 'SET_BRAND'; brand: BrandKit | null }
  | { type: 'UPSERT_TEST_CASE'; testCase: TestCase }
  | { type: 'DELETE_TEST_CASE'; testCaseId: string }
  /** `partId` is a content-part id or a string id (`@node/field`, `@email/subject`, …). `origin` marks an untouched AI or sample draft. */
  | { type: 'SET_TRANSLATION_DRAFT'; partId: string; locale: Locale; text: string | null; origin?: TranslationOrigin }
  | { type: 'APPROVE_TRANSLATION'; partId: string; locale: Locale }
  /** Many drafts in one undoable step (AI first pass, bundled samples, CSV). Never approves anything. */
  | { type: 'SET_TRANSLATION_DRAFTS'; locale: Locale; items: Array<{ id: string; text: string }>; origin?: TranslationOrigin }
  /** Approve several drafts in one undoable step. Drafts whose data tokens differ from the English text are refused as a whole. */
  | { type: 'APPROVE_TRANSLATIONS'; locale: Locale; ids: string[] }
  | { type: 'ADD_LANGUAGE'; locale: Locale }
  | { type: 'REMOVE_LANGUAGE'; locale: Locale }
  | { type: 'SET_CHANNELS'; channels: ChannelConfig }
  | { type: 'SET_GLOSSARY'; locale: Locale; entries: GlossaryEntry[] }
  /** Where the document's date comes from (null: the document does not use dates; refused while anything does). */
  | { type: 'SET_DOCUMENT_DATE'; source: DocumentDateSource | null }
  /** Adds a calculated field (at `index`, default the end) or changes the one with the same key. */
  | { type: 'UPSERT_CALCULATED_FIELD'; field: CalculatedField; index?: number }
  | { type: 'DELETE_CALCULATED_FIELD'; key: string }
  | { type: 'MOVE_CALCULATED_FIELD'; key: string; index: number }
  /** Adds a lookup table (at `index`, default the end) or replaces the one with the same id (rows included). */
  | { type: 'UPSERT_LOOKUP_TABLE'; table: LookupTable; index?: number }
  | { type: 'DELETE_LOOKUP_TABLE'; tableId: string }
  | { type: 'MOVE_LOOKUP_TABLE'; tableId: string; index: number }
  /** In effect from/until (null: always). The document must say where its date comes from first. */
  | { type: 'SET_RULE_PERIOD'; ruleId: string; period: EffectivePeriod | null }
  | { type: 'SET_VARIANT_PERIOD'; nodeId: string; variantId: string; period: EffectivePeriod | null }
  | { type: 'SET_SECTION_PERIOD'; nodeId: string; period: EffectivePeriod | null }
  /** Several commands applied in order as ONE undoable step (assistant fixes). All or nothing: the first rejection rejects the batch. */
  | { type: 'BATCH'; label: string; commands: Command[] }
  /** Paper, orientation, margins and page templates of the paged outputs (PDF and the AFP simulation together). */
  | { type: 'SET_PAGE_DESIGN'; patch: PageDesignPatch }
  /** "Accessible PDF is required" for this document (failed PDF accessibility checks become blockers). Off removes the setting. */
  | { type: 'SET_ACCESSIBLE_PDF_REQUIRED'; required: boolean }
  | { type: 'RESTORE_SNAPSHOT'; project: Project; label: string };

export type CommandResult =
  | { ok: true; project: Project; label: string }
  | { ok: false; code: string; message: string; nodeId?: string };

export function nodeMap(project: Project): Map<string, DocNode> {
  return new Map(project.nodes.map((n) => [n.id, n]));
}

export function parentOf(project: Project, nodeId: string): DocNode | undefined {
  return project.nodes.find((n) => n.children?.includes(nodeId));
}

export function descendants(project: Project, nodeId: string): string[] {
  const map = nodeMap(project);
  const out: string[] = [];
  const walk = (id: string) => { for (const c of map.get(id)?.children ?? []) { out.push(c); walk(c); } };
  walk(nodeId);
  return out;
}

/** Required (obligation-rule) node IDs for the project scope. */
export function requiredNodeIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const r of project.rules) if (r.then.op === 'requireNodes' && r.enabled !== false) r.then.nodeIds.forEach((i) => ids.add(i));
  for (const n of project.nodes) if (n.required) ids.add(n.id);
  return ids;
}

/** Why a component cannot be dropped into `parentId` (null when allowed). Used by canvas previews and the bus. */
export function dropRejection(project: Project, parentId: string, childType: DocNode['type']): string | null {
  const parent = nodeMap(project).get(parentId);
  if (!parent) return `Unknown drop target ${parentId}.`;
  if (parent.type === 'disclosure') return `“${parent.name ?? parent.id}” is a protected disclosure. Approved disclosure text cannot contain other components.`;
  if (parent.type === 'header-footer') return `“${parent.name ?? parent.id}” is reserved page chrome and cannot contain components.`;
  if (parent.type === 'variant-set' || parent.type === 'conditional-region') return `Variants are named content alternatives. Use “Add variant” in the Inspector instead of dropping components into ${parent.id}.`;
  if (!CATALOG_BY_TYPE[parent.type].canContainChildren) return `${CATALOG_BY_TYPE[parent.type].label} (${parent.id}) cannot contain child components.`;
  if (parent.locked) return `${parent.id} is locked.`;
  if (childType === 'header-footer' && parent.id !== project.rootNodeId) return 'Header/footer chrome can only be placed at document level.';
  return null;
}

function bump(project: Project, recipe: (draft: Project) => void): Project {
  return produce(project, (d) => { recipe(d as Project); d.modelVersion = project.modelVersion + 1; });
}

function reject(code: string, message: string, nodeId?: string): CommandResult {
  return { ok: false, code, message, nodeId };
}

function validateNodeShape(node: DocNode, project: Project): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(node.id)) return `Invalid node id “${node.id}”.`;
  if (!CATALOG_BY_TYPE[node.type]) return `Unknown component type ${node.type}.`;
  if (node.styleId && !(project.styles ?? []).some((s) => s.id === node.styleId)) return `Unknown text style “${node.styleId}”.`;
  if (node.action && !isSafeUrl(node.action.url)) return `Unsafe action URL. Only https:// links are allowed.`;
  if (node.qr && !isSafeUrl(node.qr.url)) return `Unsafe QR destination. Only https:// links are allowed.`;
  if (node.visibleWhen) { const e = validatePredicate(node.visibleWhen, projectFieldIndex(project)); if (e.length) return e[0]; }
  for (const p of Object.values(node.variantConditions ?? {})) { const e = validatePredicate(p, projectFieldIndex(project)); if (e.length) return e[0]; }
  if (node.effective !== undefined || node.variantPeriods !== undefined) {
    if (!project.documentDate) return 'Choose where the document’s date comes from before giving anything a period.';
    if (node.effective !== undefined) {
      const bad = periodProblem(node.effective); if (bad) return bad;
      if (!isConditionalSection(node) || node.id === project.rootNodeId) return 'Only a conditional section can be in effect for a period.';
      if (requiredNodeIds(project).has(node.id)) return 'A required section is always shown, so it cannot be limited to a period.';
    }
    for (const [v, p] of Object.entries(node.variantPeriods ?? {})) {
      if (!(node.variantIds ?? []).includes(v)) return `${v} is not an alternative of ${node.name ?? node.id}.`;
      const bad = periodProblem(p); if (bad) return bad;
    }
  }
  if (node.totalFrom !== undefined) {
    if (node.type !== 'repeating-table') return 'Only a table has a total in its footer.';
    const f = projectFieldIndex(project).get(node.totalFrom);
    if (!f || f.type !== 'cents') return `The footer total must be an amount field; ${node.totalFrom} is not one.`;
  }
  return null;
}


export function applyCommand(project: Project, cmd: Command): CommandResult {
  const map = nodeMap(project);
  switch (cmd.type) {
    case 'INSERT_NODE': {
      if (map.has(cmd.node.id)) return reject('DUPLICATE_ID', `Node ${cmd.node.id} already exists.`);
      const why = dropRejection(project, cmd.parentId, cmd.node.type);
      if (why) return reject('INVALID_DROP_TARGET', why, cmd.parentId);
      const shape = validateNodeShape(cmd.node, project);
      if (shape) return reject('INVALID_NODE', shape, cmd.node.id);
      const node = cmd.node.content ? { ...cmd.node, content: sanitizeRichDoc(cmd.node.content).doc } : cmd.node;
      // A message or disclosure that brings wording of its own (a project with no wording yet) gets it in the same step.
      const starters = starterContentParts(node, new Set(project.contentParts.map((c) => c.id)));
      return { ok: true, label: `Insert ${CATALOG_BY_TYPE[node.type].label}`, project: bump(project, (d) => {
        d.nodes.push(node);
        d.contentParts.push(...starters);
        const parent = d.nodes.find((n) => n.id === cmd.parentId)!;
        parent.children = parent.children ?? [];
        const idx = cmd.index === undefined ? parent.children.length : Math.max(0, Math.min(cmd.index, parent.children.length));
        parent.children.splice(idx, 0, node.id);
      }) };
    }
    case 'DELETE_NODE': {
      const node = map.get(cmd.nodeId);
      if (!node) return reject('NOT_FOUND', `Unknown node ${cmd.nodeId}.`);
      if (cmd.nodeId === project.rootNodeId) return reject('PROTECTED', 'The document root cannot be deleted.', cmd.nodeId);
      const req = requiredNodeIds(project);
      const removed = [cmd.nodeId, ...descendants(project, cmd.nodeId)];
      const hit = removed.find((id) => req.has(id));
      if (hit) return reject('PROTECTED_OBLIGATION', `${hit} is required by an obligation rule and cannot be deleted. Reposition it instead.`, hit);
      if (node.locked) return reject('LOCKED', `${cmd.nodeId} is locked.`, cmd.nodeId);
      return { ok: true, label: `Delete ${node.name ?? node.id}`, project: bump(project, (d) => {
        d.nodes = d.nodes.filter((n) => !removed.includes(n.id));
        for (const n of d.nodes) if (n.children) n.children = n.children.filter((c) => !removed.includes(c));
      }) };
    }
    case 'MOVE_NODE': {
      const node = map.get(cmd.nodeId);
      if (!node) return reject('NOT_FOUND', `Unknown node ${cmd.nodeId}.`);
      if (cmd.nodeId === cmd.parentId || descendants(project, cmd.nodeId).includes(cmd.parentId)) return reject('INVALID_DROP_TARGET', 'A component cannot be moved inside itself.', cmd.nodeId);
      const why = dropRejection(project, cmd.parentId, node.type);
      if (why) return reject('INVALID_DROP_TARGET', why, cmd.parentId);
      if (node.locked) return reject('LOCKED', `${cmd.nodeId} is locked.`, cmd.nodeId);
      return { ok: true, label: `Move ${node.name ?? node.id}`, project: bump(project, (d) => {
        for (const n of d.nodes) if (n.children) n.children = n.children.filter((c) => c !== cmd.nodeId);
        const parent = d.nodes.find((n) => n.id === cmd.parentId)!;
        parent.children = parent.children ?? [];
        parent.children.splice(Math.max(0, Math.min(cmd.index, parent.children.length)), 0, cmd.nodeId);
      }) };
    }
    case 'UPDATE_NODE': {
      const node = map.get(cmd.nodeId);
      if (!node) return reject('NOT_FOUND', `Unknown node ${cmd.nodeId}.`);
      if (node.locked && !('locked' in cmd.patch)) return reject('LOCKED', `${cmd.nodeId} is locked. Unlock it first.`, cmd.nodeId);
      if (node.type === 'disclosure' && node.required && ('contentPartId' in cmd.patch || 'required' in cmd.patch)) return reject('PROTECTED_OBLIGATION', 'A mandatory disclosure cannot be re-pointed or made optional. Edit the approved content version with the advanced action.', cmd.nodeId);
      const merged = { ...node, ...cmd.patch } as DocNode;
      const shape = validateNodeShape(merged, project);
      if (shape) return reject('INVALID_NODE', shape, cmd.nodeId);
      const patch = { ...cmd.patch } as Partial<DocNode>;
      if (patch.content) patch.content = sanitizeRichDoc(patch.content).doc;
      return { ok: true, label: `Edit ${node.name ?? node.id}`, project: bump(project, (d) => {
        const target = d.nodes.find((n) => n.id === cmd.nodeId)!;
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete (target as any)[k];
          else (target as any)[k] = v;
        }
      }) };
    }
    case 'SET_LAYOUT': {
      const node = map.get(cmd.nodeId);
      if (!node) return reject('NOT_FOUND', `Unknown node ${cmd.nodeId}.`);
      if (node.locked) return reject('LOCKED', `${cmd.nodeId} is locked.`, cmd.nodeId);
      const l = cmd.layout as Record<string, unknown>;
      for (const k of ['xPt', 'yPt', 'wPt', 'hPt', 'widthPct', 'spaceBeforePt', 'span']) {
        if (k in l && l[k] !== undefined && (typeof l[k] !== 'number' || !Number.isFinite(l[k] as number))) return reject('INVALID_LAYOUT', `${k} must be a number.`, cmd.nodeId);
      }
      if (cmd.profile === 'paged') {
        const next = { ...(node.layout?.paged ?? { mode: 'flow' }), ...cmd.layout } as PagedLayout;
        if (next.mode === 'fixed') {
          if ((next.wPt ?? 0) < 8 || (next.hPt ?? 0) < 4) return reject('INVALID_LAYOUT', 'Fixed elements must be at least 8×4 pt.', cmd.nodeId);
          const page = pageSizePt(pagedProfileOf(project));
          if ((next.xPt ?? 0) < 0 || (next.yPt ?? 0) < 0 || (next.xPt ?? 0) + (next.wPt ?? 0) > page.widthPt + 0.01 || (next.yPt ?? 0) + (next.hPt ?? 0) > page.heightPt + 0.01) return reject('INVALID_LAYOUT', page.paper.id === 'US-Letter' && !page.landscape ? 'Fixed element must stay within the US-Letter page (612×792 pt).' : `Fixed element must stay within the ${page.paper.label} page (${Math.round(page.widthPt)}×${Math.round(page.heightPt)} pt).`, cmd.nodeId);
          if (next.pages !== undefined && !['first', 'all', 'following', 'last'].includes(next.pages)) return reject('INVALID_LAYOUT', 'A fixed element appears on the first, following, last or all pages.', cmd.nodeId);
        }
        const flowProblem = pagedFlowProblems(cmd.layout as Record<string, unknown>);
        if (flowProblem) return reject('INVALID_LAYOUT', flowProblem, cmd.nodeId);
        if (next.widthPct !== undefined && (next.widthPct < 10 || next.widthPct > 100)) return reject('INVALID_LAYOUT', 'Flow width must be between 10% and 100%.', cmd.nodeId);
      }
      return { ok: true, label: `Layout ${node.name ?? node.id} (${cmd.profile === 'paged' ? 'paged' : 'HTML'})`, project: bump(project, (d) => {
        const target = d.nodes.find((n) => n.id === cmd.nodeId)!;
        const layout: NodeLayout = target.layout ?? {};
        if (cmd.profile === 'paged') layout.paged = { ...(layout.paged ?? { mode: 'flow' }), ...cmd.layout } as PagedLayout;
        else layout.html = { ...(layout.html ?? {}), ...cmd.layout } as ResponsiveLayout;
        target.layout = layout;
      }) };
    }
    case 'DUPLICATE_NODE': {
      const node = map.get(cmd.nodeId);
      if (!node) return reject('NOT_FOUND', `Unknown node ${cmd.nodeId}.`);
      if (map.has(cmd.newId)) return reject('DUPLICATE_ID', `${cmd.newId} exists.`);
      if (node.children?.length) return reject('UNSUPPORTED', 'Duplicating containers with children is not supported in the POC.', cmd.nodeId);
      if (node.type === 'disclosure' || node.type === 'variant-set') return reject('UNSUPPORTED', 'Mandatory disclosures and variant sets cannot be duplicated (stable identity).', cmd.nodeId);
      const parent = parentOf(project, cmd.nodeId);
      if (!parent) return reject('NOT_FOUND', 'Node has no parent.');
      const copy: DocNode = JSON.parse(JSON.stringify(node));
      copy.id = cmd.newId; copy.name = `${node.name ?? node.id} copy`;
      if (copy.layout?.paged?.mode === 'fixed') copy.layout.paged = { ...copy.layout.paged, xPt: Math.min(560, (copy.layout.paged.xPt ?? 0) + 12), yPt: Math.min(760, (copy.layout.paged.yPt ?? 0) + 12) };
      return { ok: true, label: `Duplicate ${node.name ?? node.id}`, project: bump(project, (d) => {
        d.nodes.push(copy);
        const p = d.nodes.find((n) => n.id === parent.id)!;
        p.children!.splice(p.children!.indexOf(cmd.nodeId) + 1, 0, copy.id);
      }) };
    }
    case 'UPSERT_RULE': {
      const errors = validateRule(cmd.rule, project);
      if (errors.length) return reject('INVALID_RULE', errors.join(' '), cmd.rule.id);
      const existing = project.rules.find((r) => r.id === cmd.rule.id);
      const rule: Rule = { ...cmd.rule, version: existing ? Math.max(existing.version, cmd.rule.version ?? 0) + (digestOf(existing) === digestOf(cmd.rule) ? 0 : 1) : cmd.rule.version || 1 };
      return { ok: true, label: `${existing ? 'Edit' : 'Add'} rule ${rule.id}`, project: bump(project, (d) => {
        const i = d.rules.findIndex((r) => r.id === rule.id);
        if (i >= 0) d.rules[i] = rule; else d.rules.push(rule);
      }) };
    }
    case 'DELETE_RULE': {
      const r = project.rules.find((x) => x.id === cmd.ruleId);
      if (!r) return reject('NOT_FOUND', `Unknown rule ${cmd.ruleId}.`);
      if (r.mode === 'obligation') return reject('PROTECTED_OBLIGATION', `${r.id} is an obligation rule and cannot be deleted.`);
      return { ok: true, label: `Delete rule ${r.id}`, project: bump(project, (d) => { d.rules = d.rules.filter((x) => x.id !== cmd.ruleId); }) };
    }
    case 'SET_RULE_ENABLED': {
      const r = project.rules.find((x) => x.id === cmd.ruleId);
      if (!r) return reject('NOT_FOUND', `Unknown rule ${cmd.ruleId}.`);
      if (r.mode === 'obligation' && !cmd.enabled) return reject('PROTECTED_OBLIGATION', `${r.id} enforces mandatory content and cannot be disabled.`);
      return { ok: true, label: `${cmd.enabled ? 'Enable' : 'Disable'} rule ${r.id}`, project: bump(project, (d) => {
        const t = d.rules.find((x) => x.id === cmd.ruleId)!; t.enabled = cmd.enabled; t.version += 1;
      }) };
    }
    case 'UPSERT_CONTENT_PART': {
      const existing = project.contentParts.find((c) => c.id === cmd.part.id);
      const isProtected = existing?.type === 'disclosure' || project.nodes.some((n) => n.type === 'disclosure' && n.contentPartId === cmd.part.id && n.protected);
      if (isProtected && existing && !cmd.advanced) return reject('PROTECTED_CONTENT', `“${existing.title}” is approved disclosure text. Use the advanced “New approved version” action with a reason.`);
      for (const text of Object.values(cmd.part.approvedLocales)) if (/<\s*\/?\s*[a-z]/i.test(text ?? '')) return reject('UNSAFE_CONTENT', 'Raw HTML is not allowed in content.');
      const part: ContentPart = { ...cmd.part, version: existing ? existing.version + 1 : 1 };
      return { ok: true, label: `${existing ? 'Edit' : 'Add'} content ${part.id} v${part.version}`, project: bump(project, (d) => {
        const i = d.contentParts.findIndex((c) => c.id === part.id);
        if (i >= 0) d.contentParts[i] = part; else d.contentParts.push(part);
      }) };
    }
    case 'ADD_VARIANT': {
      const node = map.get(cmd.nodeId);
      if (!node || (node.type !== 'variant-set' && node.type !== 'conditional-region')) return reject('INVALID_TARGET', 'Variants can only be added to a Variant Set or Conditional Region.', cmd.nodeId);
      if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(cmd.variantId)) return reject('INVALID_ID', `Invalid variant id ${cmd.variantId}.`);
      if (node.variantIds?.includes(cmd.variantId)) return reject('DUPLICATE_ID', `Variant ${cmd.variantId} already exists in ${node.id}.`);
      if (/<\s*\/?\s*[a-z]/i.test(cmd.text)) return reject('UNSAFE_CONTENT', 'Raw HTML is not allowed in content.');
      if (cmd.when) { const e = validatePredicate(cmd.when, projectFieldIndex(project)); if (e.length) return reject('INVALID_RULE', e.join(' ')); }
      const partExists = project.contentParts.some((c) => c.id === cmd.variantId);
      return { ok: true, label: `Add variant ${cmd.title}`, project: bump(project, (d) => {
        const t = d.nodes.find((n) => n.id === cmd.nodeId)!;
        t.variantIds = [...(t.variantIds ?? []), cmd.variantId];
        if (cmd.when) t.variantConditions = { ...(t.variantConditions ?? {}), [cmd.variantId]: cmd.when };
        if (!partExists) d.contentParts.push({ id: cmd.variantId, version: 1, title: cmd.title, approvedLocales: { 'en-US': cmd.text }, syntheticDemoOnly: true, type: 'text' });
      }) };
    }
    case 'REMOVE_VARIANT': {
      const node = map.get(cmd.nodeId);
      if (!node?.variantIds?.includes(cmd.variantId)) return reject('NOT_FOUND', `Variant ${cmd.variantId} not in ${cmd.nodeId}.`);
      if (node.fallbackVariantId === cmd.variantId) return reject('PROTECTED', 'Remove or change the fallback designation before deleting the fallback variant.', cmd.nodeId);
      return { ok: true, label: `Remove variant ${cmd.variantId}`, project: bump(project, (d) => {
        const t = d.nodes.find((n) => n.id === cmd.nodeId)!;
        t.variantIds = t.variantIds!.filter((v) => v !== cmd.variantId);
        if (t.variantConditions) delete t.variantConditions[cmd.variantId];
        if (t.variantPeriods?.[cmd.variantId]) { const all = { ...t.variantPeriods }; delete all[cmd.variantId]; if (Object.keys(all).length) t.variantPeriods = all; else delete t.variantPeriods; }
      }) };
    }
    case 'SET_VARIANT_CONDITION': {
      const node = map.get(cmd.nodeId);
      if (!node?.variantIds?.includes(cmd.variantId)) return reject('NOT_FOUND', `Variant ${cmd.variantId} not in ${cmd.nodeId}.`);
      if (cmd.when) { const e = validatePredicate(cmd.when, projectFieldIndex(project)); if (e.length) return reject('INVALID_RULE', e.join(' ')); }
      return { ok: true, label: `Condition for ${cmd.variantId}`, project: bump(project, (d) => {
        const t = d.nodes.find((n) => n.id === cmd.nodeId)!;
        const conds = { ...(t.variantConditions ?? {}) };
        if (cmd.when) conds[cmd.variantId] = cmd.when; else delete conds[cmd.variantId];
        t.variantConditions = conds;
      }) };
    }
    case 'SET_JOURNEY': {
      const ids = new Set<string>();
      for (const e of cmd.events) {
        if (!e.eventId || ids.has(e.eventId)) return reject('INVALID_EVENT', `Duplicate or missing event id ${e.eventId}.`);
        ids.add(e.eventId);
        for (const eff of e.effects) if (eff.op !== 'set' || !/^[a-zA-Z0-9_.]+$/.test(eff.path)) return reject('INVALID_EVENT', `Invalid effect in ${e.eventId}.`);
      }
      return { ok: true, label: 'Edit journey events', project: bump(project, (d) => { d.journey.events = cmd.events; }) };
    }
    case 'UPDATE_PROFILE': {
      if (!project.presentationProfiles.some((p) => p.id === cmd.profileId)) return reject('NOT_FOUND', `Unknown profile ${cmd.profileId}.`);
      const merged = { ...project.presentationProfiles.find((p) => p.id === cmd.profileId)!, ...cmd.patch };
      if (merged.kind !== 'responsive') { const e = pageDesignProblems(merged); if (e.length) return reject('INVALID_PAGE_DESIGN', e[0]); }
      return { ok: true, label: `Edit profile ${cmd.profileId}`, project: bump(project, (d) => {
        const i = d.presentationProfiles.findIndex((p) => p.id === cmd.profileId);
        d.presentationProfiles[i] = { ...d.presentationProfiles[i], ...cmd.patch, id: d.presentationProfiles[i].id };
      }) };
    }
    case 'SET_CUSTOM_FIELDS': {
      const errs = validateCustomFields(project.documentType, cmd.fields);
      if (errs.length) return reject('INVALID_FIELDS', errs.join(' '));
      // A list also offers its number of rows (`custom.<key>.count`).
      const kept = new Set(cmd.fields.flatMap((f) => (f.type === 'list' ? [`custom.${f.key}`, `custom.${f.key}.count`] : [`custom.${f.key}`])));
      const used = customFieldUsage(project).filter((u) => !kept.has(u.path));
      if (used.length) return reject('FIELD_IN_USE', `${used[0].path} is still used by ${used[0].where.join(', ')}. Remove those references first.`);
      const candidate = { ...project, customFields: cmd.fields };
      const bad = project.rules.map((r) => validateRule(r, candidate)).find((e) => e.length);
      if (bad) return reject('FIELD_IN_USE', `A rule no longer validates with these fields: ${bad.join(' ')}`);
      if (project.calculatedFields?.length) {
        const calcBad = validateCalculatedFields(candidate, project.calculatedFields);
        if (calcBad.length) return reject('FIELD_IN_USE', `A calculation no longer works with these fields: ${calcBad[0]}`);
      }
      return { ok: true, label: 'Edit data fields', project: bump(project, (d) => { d.customFields = cmd.fields.map((f) => ({ ...f })); }) };
    }
    case 'SET_STYLES': {
      const errs = validateStyles(cmd.styles);
      if (errs.length) return reject('INVALID_STYLES', errs.join(' '));
      const ids = new Set(cmd.styles.map((x) => x.id));
      const orphan = project.nodes.find((n) => n.styleId && !ids.has(n.styleId));
      if (orphan) return reject('STYLE_IN_USE', `Style ${orphan.styleId} is still used by ${orphan.name ?? orphan.id}.`);
      return { ok: true, label: 'Edit text styles', project: bump(project, (d) => { d.styles = cmd.styles.map((x) => ({ ...x })); }) };
    }
    case 'SET_BRAND': {
      if (cmd.brand) {
        const hex = /^#[0-9a-fA-F]{6}$/;
        if (!hex.test(cmd.brand.primary) || !hex.test(cmd.brand.accent) || (cmd.brand.text && !hex.test(cmd.brand.text))) return reject('INVALID_BRAND', 'Brand colours must be 6-digit hex values such as #4EAF60.');
        if (cmd.brand.logoDataUri && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(cmd.brand.logoDataUri)) return reject('INVALID_BRAND', 'Brand logo must be a PNG, JPEG or WebP image from the image library.');
        if (cmd.brand.logoDataUri && !cmd.brand.logoAlt?.trim()) return reject('INVALID_BRAND', 'A brand logo needs alternative text.');
      }
      return { ok: true, label: cmd.brand ? 'Edit brand kit' : 'Remove brand kit', project: bump(project, (d) => { if (cmd.brand) d.brand = { ...cmd.brand }; else delete d.brand; }) };
    }
    case 'UPSERT_TEST_CASE': {
      const t = cmd.testCase;
      if (!/^[A-Za-z0-9-]{1,40}$/.test(t.id ?? '')) return reject('INVALID_TEST', 'Test case id must be letters, digits or dashes.');
      if (!t.name?.trim()) return reject('INVALID_TEST', 'Give the test case a name.');
      if (!RECORD_ID_PATTERN.test(t.recordId ?? '')) return reject('INVALID_TEST', 'Test case needs a record ID.');
      if (t.issueDate !== undefined && !isIsoDay(t.issueDate)) return reject('INVALID_TEST', 'The test’s “as issued on” date must be a date (YYYY-MM-DD).');
      const existing = (project.testCases ?? []).some((x) => x.id === t.id);
      return { ok: true, label: `${existing ? 'Edit' : 'Add'} test “${t.name}”`, project: bump(project, (d) => {
        d.testCases = [...(d.testCases ?? []).filter((x) => x.id !== t.id), { ...t }];
      }) };
    }
    case 'DELETE_TEST_CASE': {
      const t = (project.testCases ?? []).find((x) => x.id === cmd.testCaseId);
      if (!t) return reject('NOT_FOUND', `Unknown test case ${cmd.testCaseId}.`);
      return { ok: true, label: `Delete test “${t.name}”`, project: bump(project, (d) => { d.testCases = (d.testCases ?? []).filter((x) => x.id !== cmd.testCaseId); }) };
    }
    case 'SET_TRANSLATION_DRAFT': {
      const target = translationTarget(project, cmd.partId);
      if (!target) return reject('NOT_FOUND', `Unknown text ${cmd.partId}.`);
      const bad = localeProblem(project, cmd.locale);
      if (bad) return reject('INVALID_LOCALE', bad);
      if (cmd.text !== null && cmd.text.length > 4000) return reject('TOO_LONG', 'Translations are limited to 4,000 characters.');
      return { ok: true, label: `${cmd.text === null ? 'Discard' : 'Draft'} ${cmd.locale} for “${target.title}”`, project: bump(project, (d) => { writeDraft(d, cmd.partId, cmd.locale, cmd.text, cmd.origin); }) };
    }
    case 'SET_TRANSLATION_DRAFTS': {
      const bad = localeProblem(project, cmd.locale);
      if (bad) return reject('INVALID_LOCALE', bad);
      if (!cmd.items.length) return reject('EMPTY', 'There is nothing to add.');
      for (const it of cmd.items) {
        if (!translationTarget(project, it.id)) return reject('NOT_FOUND', `Unknown text ${it.id}.`);
        if (it.text.length > 4000) return reject('TOO_LONG', 'Translations are limited to 4,000 characters.');
      }
      return { ok: true, label: `${cmd.items.length} ${languageShortName(cmd.locale)} draft${cmd.items.length === 1 ? '' : 's'}${cmd.origin === 'ai' ? ' from AI' : cmd.origin === 'sample' ? ' from the sample set' : ''}`, project: bump(project, (d) => { for (const it of cmd.items) writeDraft(d, it.id, cmd.locale, it.text, cmd.origin); }) };
    }
    case 'APPROVE_TRANSLATION': {
      const target = translationTarget(project, cmd.partId);
      if (!target) return reject('NOT_FOUND', `Unknown text ${cmd.partId}.`);
      const draft = target.draft(cmd.locale);
      if (!draft?.trim()) return reject('NO_DRAFT', `There is no ${cmd.locale} draft to approve for “${target.title}”.`);
      const tokensOf = (t: string) => tokensOfText(t).join(',');
      const source = target.source;
      if (source && tokensOf(source) !== tokensOf(draft)) return reject('TOKEN_MISMATCH', `The ${languageShortName(cmd.locale)} text must use the same data tokens as the English text (${tokensOf(source) || 'none'}).`);
      return { ok: true, label: `Approve ${cmd.locale} for “${target.title}”`, project: bump(project, (d) => { writeApproval(d, cmd.partId, cmd.locale, draft, source); }) };
    }
    case 'APPROVE_TRANSLATIONS': {
      if (!cmd.ids.length) return reject('EMPTY', 'There is nothing to approve.');
      const tokensOf = (t: string) => tokensOfText(t).join(',');
      const todo: Array<{ id: string; draft: string; source: string }> = [];
      for (const id of [...new Set(cmd.ids)]) {
        const target = translationTarget(project, id);
        if (!target) return reject('NOT_FOUND', `Unknown text ${id}.`);
        const draft = target.draft(cmd.locale);
        if (!draft?.trim()) return reject('NO_DRAFT', `There is no ${cmd.locale} draft to approve for “${target.title}”.`);
        if (target.source && tokensOf(target.source) !== tokensOf(draft)) return reject('TOKEN_MISMATCH', `“${target.title}”: the ${languageShortName(cmd.locale)} text must use the same data tokens as the English text. Nothing was approved.`);
        todo.push({ id, draft, source: target.source });
      }
      return { ok: true, label: `Approve ${todo.length} ${languageShortName(cmd.locale)} translation${todo.length === 1 ? '' : 's'}`, project: bump(project, (d) => { for (const t of todo) writeApproval(d, t.id, cmd.locale, t.draft, t.source); }) };
    }
    case 'ADD_LANGUAGE': {
      if (cmd.locale === SOURCE_LANGUAGE) return reject('INVALID_LOCALE', 'English is the source language of every project.');
      if (!isSupportedLanguage(cmd.locale)) return reject('INVALID_LOCALE', `${cmd.locale} is not in the list of supported languages.`);
      const current = projectLanguages(project);
      if (current.includes(cmd.locale)) return reject('DUPLICATE', `${languageName(cmd.locale)} is already a language of this project.`);
      return { ok: true, label: `Add language ${languageName(cmd.locale)}`, project: bump(project, (d) => { d.languages = [...current, cmd.locale]; }) };
    }
    case 'REMOVE_LANGUAGE': {
      const current = projectLanguages(project);
      if (!current.includes(cmd.locale)) return reject('NOT_FOUND', `${languageName(cmd.locale)} is not a language of this project.`);
      if (project.rules.some((r) => r.then.op === 'setApprovedLocale' && r.then.locale === cmd.locale)) return reject('IN_USE', `A rule selects ${languageName(cmd.locale)} for some customers. Remove or change that rule first.`);
      // Translations already written are kept, so adding the language back restores them.
      return { ok: true, label: `Remove language ${languageName(cmd.locale)}`, project: bump(project, (d) => { d.languages = current.filter((l) => l !== cmd.locale); }) };
    }
    case 'SET_CHANNELS': {
      const c = cmd.channels;
      if (!c?.email || !c?.sms) return reject('INVALID', 'Email and SMS settings are both required.');
      const texts: Array<[string, string, number]> = [
        ['Email subject', c.email.subject, CHANNEL_TEXT_LIMITS.subject], ['Email preview text', c.email.preheader, CHANNEL_TEXT_LIMITS.preheader], ['Email heading', c.email.title, CHANNEL_TEXT_LIMITS.title],
        ['Email opening text', c.email.intro, CHANNEL_TEXT_LIMITS.intro], ['Email closing text', c.email.closing, CHANNEL_TEXT_LIMITS.closing], ['Key figures heading', c.email.keyFactsHeading, CHANNEL_TEXT_LIMITS.keyFactsHeading], ['SMS message', c.sms.text, CHANNEL_TEXT_LIMITS.sms],
      ];
      const known = projectFieldIndex(project);
      for (const [name, text, max] of texts) {
        if (typeof text !== 'string') return reject('INVALID', `${name} must be text.`);
        if (text.length > max) return reject('TOO_LONG', `${name} is limited to ${max} characters.`);
        if (/[<>]/.test(text)) return reject('INVALID', `${name} cannot contain < or >.`);
        for (const m of text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) if (!known.has(m[1]) && !(CHANNEL_TOKENS as readonly string[]).includes(m[1])) return reject('INVALID_BINDING', `${name} uses “{{${m[1]}}}”, which is not a data field of this document.`);
      }
      if (!c.email.subject.trim()) return reject('INVALID', 'The email needs a subject line.');
      if (!c.email.title.trim()) return reject('INVALID', 'The email needs a heading.');
      if (!c.sms.text.trim()) return reject('INVALID', 'The SMS needs a message.');
      const ids = c.email.sections.map((x) => x.id);
      if (ids.length !== EMAIL_SECTION_IDS.length || EMAIL_SECTION_IDS.some((id) => !ids.includes(id))) return reject('INVALID', 'Every email section must be listed exactly once.');
      const clean: ChannelConfig = {
        email: { subject: c.email.subject, preheader: c.email.preheader, title: c.email.title, intro: c.email.intro, closing: c.email.closing, keyFactsHeading: c.email.keyFactsHeading, sections: c.email.sections.map((x) => ({ id: x.id, show: !!x.show })) },
        sms: { text: c.sms.text },
      };
      return { ok: true, label: 'Edit email and SMS wording', project: bump(project, (d) => { d.channels = clean; }) };
    }
    case 'SET_GLOSSARY': {
      const bad = localeProblem(project, cmd.locale);
      if (bad || cmd.locale === SOURCE_LANGUAGE) return reject('INVALID_LOCALE', bad ?? 'The glossary is kept per target language.');
      if (cmd.entries.length > 200) return reject('TOO_LONG', 'A glossary is limited to 200 terms per language.');
      const seen = new Set<string>();
      const clean: GlossaryEntry[] = [];
      for (const e of cmd.entries) {
        const source = (e?.source ?? '').trim(), target = (e?.target ?? '').trim();
        if (!source || !target) return reject('INVALID', 'Every glossary term needs the English term and its translation.');
        if (source.length > 80 || target.length > 80 || (e.note ?? '').length > 200) return reject('TOO_LONG', 'Glossary terms are limited to 80 characters and notes to 200.');
        if (/[<>{}]/.test(source + target)) return reject('INVALID', 'Glossary terms cannot contain <, >, { or }.');
        const key = source.toLowerCase();
        if (seen.has(key)) return reject('DUPLICATE', `“${source}” is listed twice.`);
        seen.add(key);
        clean.push({ source, target, ...(e.note?.trim() ? { note: e.note.trim() } : {}) });
      }
      return { ok: true, label: `Edit ${languageShortName(cmd.locale)} glossary`, project: bump(project, (d) => {
        const all = { ...(d.glossary ?? {}) };
        if (clean.length) all[cmd.locale] = clean; else delete all[cmd.locale];
        if (Object.keys(all).length) d.glossary = all; else delete d.glossary;
      }) };
    }
    case 'SET_DOCUMENT_DATE': {
      const src = cmd.source;
      if (src === null) {
        const use = documentDateUse(project);
        if (use.uses) return reject('DATE_IN_USE', `The document’s date is still used (${[use.periods ? `${use.periods} period${use.periods === 1 ? '' : 's'}` : '', use.calcs.length ? `${use.calcs.length} calculation${use.calcs.length === 1 ? '' : 's'}` : '', use.referenced ? 'conditions or wording' : ''].filter(Boolean).join(', ')}). Remove those first.`);
        if (!project.documentDate) return reject('NOT_FOUND', 'The document does not have a date source.');
        return { ok: true, label: 'Stop using the document’s date', project: bump(project, (d) => { delete d.documentDate; }) };
      }
      if (!src || (src.source !== 'run' && src.source !== 'field')) return reject('INVALID', 'The document’s date comes from a date field of the customer’s data, or is given for the run.');
      if (src.source === 'field') {
        const f = projectFieldIndex(project).get(src.path);
        if (!f) return reject('INVALID', `${src.path} is not a data field of this document.`);
        if (f.type !== 'date') return reject('INVALID', `“${f.label}” is not a date, so it cannot be the document’s date.`);
        if (f.derived) return reject('INVALID', `“${f.label}” is worked out by the studio; choose a date field from the customer’s data.`);
      }
      const clean: DocumentDateSource = src.source === 'field' ? { source: 'field', path: src.path } : { source: 'run' };
      return { ok: true, label: src.source === 'field' ? 'The document’s date comes from a data field' : 'The document’s date is given for each run', project: bump(project, (d) => { d.documentDate = clean; }) };
    }
    case 'UPSERT_CALCULATED_FIELD': {
      const list = project.calculatedFields ?? [];
      const field = cmd.field;
      if (!field || typeof field !== 'object') return reject('INVALID_CALCULATION', 'The calculated field cannot be read.');
      const existing = list.findIndex((c) => c.key === field.key);
      if (existing < 0 && list.length >= CALC_MAX) return reject('TOO_MANY', `A document can have at most ${CALC_MAX} calculated fields.`);
      const clean: CalculatedField = { key: field.key, label: typeof field.label === 'string' ? field.label.trim() : field.label, type: field.type, ...(typeof field.description === 'string' && field.description.trim() ? { description: field.description.trim() } : {}), expr: field.expr };
      let next = existing >= 0 ? list.map((c, i) => (i === existing ? clean : c)) : [...list, clean];
      if (existing < 0 && cmd.index !== undefined) { next = [...list]; next.splice(Math.max(0, Math.min(cmd.index, list.length)), 0, clean); }
      const errors = validateCalculatedFields(project, next);
      if (errors.length) return reject('INVALID_CALCULATION', errors.join(' '));
      const broken = referenceProblems({ ...project, calculatedFields: next });
      if (broken) return reject('CALCULATION_IN_USE', `This change would break ${broken}.`);
      return { ok: true, label: `${existing >= 0 ? 'Edit' : 'Add'} calculation “${clean.label}”`, project: bump(project, (d) => { d.calculatedFields = next; }) };
    }
    case 'DELETE_CALCULATED_FIELD': {
      const list = project.calculatedFields ?? [];
      const c = list.find((x) => x.key === cmd.key);
      if (!c) return reject('NOT_FOUND', `There is no calculated field ${cmd.key}.`);
      const used = calculationUsage(project).find((u) => u.key === cmd.key);
      if (used) return reject('CALCULATION_IN_USE', `“${c.label}” is still used by ${used.where.slice(0, 3).join(', ')}${used.where.length > 3 ? ` and ${used.where.length - 3} more` : ''}. Remove those uses first.`);
      return { ok: true, label: `Delete calculation “${c.label}”`, project: bump(project, (d) => { const rest = list.filter((x) => x.key !== cmd.key); if (rest.length) d.calculatedFields = rest; else delete d.calculatedFields; }) };
    }
    case 'MOVE_CALCULATED_FIELD': {
      const list = project.calculatedFields ?? [];
      const i = list.findIndex((x) => x.key === cmd.key);
      if (i < 0) return reject('NOT_FOUND', `There is no calculated field ${cmd.key}.`);
      if (!Number.isInteger(cmd.index)) return reject('INVALID', 'Say where to move it.');
      const next = [...list]; const [it] = next.splice(i, 1); next.splice(Math.max(0, Math.min(cmd.index, next.length)), 0, it);
      return { ok: true, label: `Move calculation “${it.label}”`, project: bump(project, (d) => { d.calculatedFields = next; }) };
    }
    case 'UPSERT_LOOKUP_TABLE': {
      const tables = project.lookupTables ?? [];
      const t = cmd.table;
      const existing = tables.findIndex((x) => x.id === t?.id);
      if (existing < 0 && tables.length >= LOOKUP_TABLES_MAX) return reject('TOO_MANY', `A document can have at most ${LOOKUP_TABLES_MAX} lookup tables.`);
      const errors = validateLookupTable(t);
      if (errors.length) return reject('INVALID_TABLE', errors.slice(0, 5).join(' ') + (errors.length > 5 ? ` (${errors.length - 5} more problems)` : ''));
      const clean: LookupTable = JSON.parse(JSON.stringify({ id: t.id, title: t.title.trim(), ...(t.description?.trim() ? { description: t.description.trim() } : {}), keys: t.keys, columns: t.columns, rows: t.rows, ...(t.defaultRow ? { defaultRow: t.defaultRow } : {}) }));
      let next = existing >= 0 ? tables.map((x, i) => (i === existing ? clean : x)) : [...tables, clean];
      if (existing < 0 && cmd.index !== undefined) { next = [...tables]; next.splice(Math.max(0, Math.min(cmd.index, tables.length)), 0, clean); }
      const calcErrors = validateCalculatedFields({ ...project, lookupTables: next }, project.calculatedFields ?? []);
      if (calcErrors.length) return reject('TABLE_IN_USE', `A calculation that reads this table would no longer work: ${calcErrors[0]}`);
      return { ok: true, label: `${existing >= 0 ? 'Edit' : 'Add'} lookup table “${clean.title}”`, project: bump(project, (d) => { d.lookupTables = next; }) };
    }
    case 'DELETE_LOOKUP_TABLE': {
      const tables = project.lookupTables ?? [];
      const t = tables.find((x) => x.id === cmd.tableId);
      if (!t) return reject('NOT_FOUND', `There is no lookup table ${cmd.tableId}.`);
      const users = (project.calculatedFields ?? []).filter((c) => exprDependencies(c.expr).tables.includes(t.id));
      if (users.length) return reject('TABLE_IN_USE', `“${t.title}” is still read by ${users.map((c) => `“${c.label}”`).join(', ')}. Remove those uses first.`);
      return { ok: true, label: `Delete lookup table “${t.title}”`, project: bump(project, (d) => { const rest = tables.filter((x) => x.id !== cmd.tableId); if (rest.length) d.lookupTables = rest; else delete d.lookupTables; }) };
    }
    case 'MOVE_LOOKUP_TABLE': {
      const tables = project.lookupTables ?? [];
      const i = tables.findIndex((x) => x.id === cmd.tableId);
      if (i < 0) return reject('NOT_FOUND', `There is no lookup table ${cmd.tableId}.`);
      if (!Number.isInteger(cmd.index)) return reject('INVALID', 'Say where to move it.');
      const next = [...tables]; const [it] = next.splice(i, 1); next.splice(Math.max(0, Math.min(cmd.index, next.length)), 0, it);
      return { ok: true, label: `Move lookup table “${it.title}”`, project: bump(project, (d) => { d.lookupTables = next; }) };
    }
    case 'SET_RULE_PERIOD': {
      const r = project.rules.find((x) => x.id === cmd.ruleId);
      if (!r) return reject('NOT_FOUND', `Unknown rule ${cmd.ruleId}.`);
      if (cmd.period) {
        if (!project.documentDate) return reject('NO_DOCUMENT_DATE', 'Choose where the document’s date comes from before giving a rule a period.');
        const bad = periodProblem(cmd.period); if (bad) return reject('INVALID_PERIOD', bad);
        if (r.mode === 'obligation') return reject('PROTECTED_OBLIGATION', `${r.id} enforces mandatory content and cannot be limited to a period.`);
      } else if (!r.effective) return reject('NOT_FOUND', `${r.id} has no period.`);
      const period = cmd.period ? cleanPeriod(cmd.period) : null;
      return { ok: true, label: period ? `Rule ${r.id} in effect ${periodLabel(period)}` : `Rule ${r.id} always in effect`, project: bump(project, (d) => {
        const t = d.rules.find((x) => x.id === cmd.ruleId)!; if (period) t.effective = period; else delete t.effective; t.version += 1;
      }) };
    }
    case 'SET_VARIANT_PERIOD': {
      const node = map.get(cmd.nodeId);
      if (!node?.variantIds?.includes(cmd.variantId)) return reject('NOT_FOUND', `Variant ${cmd.variantId} not in ${cmd.nodeId}.`);
      if (cmd.period) {
        if (!project.documentDate) return reject('NO_DOCUMENT_DATE', 'Choose where the document’s date comes from before giving an alternative a period.');
        const bad = periodProblem(cmd.period); if (bad) return reject('INVALID_PERIOD', bad);
      } else if (!node.variantPeriods?.[cmd.variantId]) return reject('NOT_FOUND', `${cmd.variantId} has no period.`);
      const period = cmd.period ? cleanPeriod(cmd.period) : null;
      return { ok: true, label: period ? `Alternative ${cmd.variantId} in effect ${periodLabel(period)}` : `Alternative ${cmd.variantId} always in effect`, project: bump(project, (d) => {
        const t = d.nodes.find((n) => n.id === cmd.nodeId)!;
        const all = { ...(t.variantPeriods ?? {}) };
        if (period) all[cmd.variantId] = period; else delete all[cmd.variantId];
        if (Object.keys(all).length) t.variantPeriods = all; else delete t.variantPeriods;
      }) };
    }
    case 'SET_SECTION_PERIOD': {
      const node = map.get(cmd.nodeId);
      if (!node) return reject('NOT_FOUND', `Unknown node ${cmd.nodeId}.`);
      if (cmd.period) {
        const shape = validateNodeShape({ ...node, effective: cmd.period }, project);
        if (shape) return reject(project.documentDate ? 'INVALID_PERIOD' : 'NO_DOCUMENT_DATE', shape, cmd.nodeId);
      } else if (!node.effective) return reject('NOT_FOUND', `${node.name ?? node.id} has no period.`);
      const period = cmd.period ? cleanPeriod(cmd.period) : null;
      return { ok: true, label: period ? `${node.name ?? node.id} in effect ${periodLabel(period)}` : `${node.name ?? node.id} always in effect`, project: bump(project, (d) => {
        const t = d.nodes.find((n) => n.id === cmd.nodeId)!; if (period) t.effective = period; else delete t.effective;
      }) };
    }
    case 'BATCH': {
      if (!cmd.commands.length) return reject('EMPTY', 'There is nothing to apply.');
      if (cmd.commands.length > 200) return reject('TOO_LONG', 'Too many changes in one step.');
      let current = project;
      for (const [i, c] of cmd.commands.entries()) {
        if (c.type === 'BATCH' || c.type === 'RESTORE_SNAPSHOT') return reject('INVALID', 'A batch cannot contain another batch or a restore.');
        const r = applyCommand(current, c);
        if (!r.ok) return reject(r.code, `Change ${i + 1} of ${cmd.commands.length} could not be applied, so nothing was changed: ${r.message}`, r.nodeId);
        current = r.project;
      }
      // one undoable step, one version bump
      return { ok: true, label: cmd.label.slice(0, 160) || `${cmd.commands.length} changes`, project: { ...current, modelVersion: project.modelVersion + 1 } };
    }
    case 'SET_PAGE_DESIGN': {
      const paged = project.presentationProfiles.filter((p) => p.kind === 'paged' || p.kind === 'afp-simulation');
      if (!paged.length) return reject('NOT_FOUND', 'This document has no paged output.');
      const next = paged.map((p) => applyPageDesignPatch(p, cmd.patch ?? {}));
      for (const p of next) { const e = pageDesignProblems(p); if (e.length) return reject('INVALID_PAGE_DESIGN', e[0]); }
      // Another paper or orientation: fixed items move with the page edges they belong to (one undoable step).
      const before = pagedProfileOf(project);
      const moved = before ? refitFixedLayouts(project, before, applyPageDesignPatch(before, cmd.patch ?? {})) : [];
      return { ok: true, label: pageDesignLabel(before, cmd.patch ?? {}), project: bump(project, (d) => {
        for (const p of next) { const i = d.presentationProfiles.findIndex((x) => x.id === p.id); d.presentationProfiles[i] = p; }
        for (const m of moved) { const n = d.nodes.find((x) => x.id === m.nodeId)!; n.layout = { ...n.layout, paged: { ...n.layout!.paged!, ...m.layout } }; }
      }) };
    }
    case 'SET_ACCESSIBLE_PDF_REQUIRED': {
      if (typeof cmd.required !== 'boolean') return reject('INVALID', 'Say whether an accessible PDF is required (true or false).');
      if (!!project.accessiblePdfRequired === cmd.required) return reject('NO_CHANGE', cmd.required ? 'An accessible PDF is already required.' : 'An accessible PDF is already not required.');
      return { ok: true, label: cmd.required ? 'Require an accessible PDF' : 'Stop requiring an accessible PDF', project: bump(project, (d) => { if (cmd.required) d.accessiblePdfRequired = true; else delete d.accessiblePdfRequired; }) };
    }
    case 'RESTORE_SNAPSHOT': {
      return { ok: true, label: cmd.label, project: { ...cmd.project, modelVersion: project.modelVersion + 1 } };
    }
  }
}

/* ------------------------------------------------------------ translations */

/** A content part or a translatable string, addressed by one id. */
function translationTarget(project: Project, id: string): { title: string; source: string; draft(locale: string): string | undefined } | null {
  if (isStringId(id)) {
    const s = translatableStrings(project).find((x) => x.id === id);
    return s ? { title: s.title, source: s.source, draft: (l) => project.strings?.[id]?.draft?.[l] } : null;
  }
  const part = project.contentParts.find((c) => c.id === id);
  return part ? { title: part.title, source: part.approvedLocales[SOURCE_LANGUAGE] ?? '', draft: (l) => part.draftLocales?.[l] } : null;
}

function localeProblem(project: Project, locale: string): string | null {
  if (locale === SOURCE_LANGUAGE) return null;
  if (!isSupportedLanguage(locale)) return `Unsupported locale ${locale}.`;
  if (!projectLanguages(project).includes(locale)) return `${languageName(locale)} is not a language of this project. Add it first.`;
  return null;
}

function clearOrigin(d: Project, locale: string, id: string) {
  const key = `${locale}|${id}`;
  if (!d.translationOrigins || !(key in d.translationOrigins)) return;
  const o = { ...d.translationOrigins }; delete o[key];
  if (Object.keys(o).length) d.translationOrigins = o; else delete d.translationOrigins;
}

/** Moves one draft to approved text (and records the English it was made from, for strings). */
function writeApproval(d: Project, id: string, locale: string, draft: string, source: string) {
  if (isStringId(id)) {
    const all = { ...(d.strings ?? {}) };
    const t = { ...(all[id] ?? {}) };
    t.approved = { ...(t.approved ?? {}), [locale]: draft };
    t.basedOn = { ...(t.basedOn ?? {}), [locale]: source };
    const drafts = { ...(t.draft ?? {}) }; delete drafts[locale];
    if (Object.keys(drafts).length) t.draft = drafts; else delete t.draft;
    all[id] = t; d.strings = all;
  } else {
    const c = d.contentParts.find((x) => x.id === id)!;
    c.approvedLocales = { ...c.approvedLocales, [locale]: draft };
    c.version += 1;
    const drafts = { ...(c.draftLocales ?? {}) }; delete drafts[locale];
    if (Object.keys(drafts).length) c.draftLocales = drafts; else delete c.draftLocales;
  }
  clearOrigin(d, locale, id);
}

/** Writes (or with null/blank, discards) one draft. A draft typed by a person carries no origin. */
function writeDraft(d: Project, id: string, locale: string, text: string | null, origin?: TranslationOrigin) {
  const blank = text === null || !text.trim();
  if (isStringId(id)) {
    const all = { ...(d.strings ?? {}) };
    const t = { ...(all[id] ?? {}) };
    const drafts = { ...(t.draft ?? {}) };
    if (blank) delete drafts[locale]; else drafts[locale] = text!;
    if (Object.keys(drafts).length) t.draft = drafts; else delete t.draft;
    if (Object.keys(t).length) all[id] = t; else delete all[id];
    if (Object.keys(all).length) d.strings = all; else delete d.strings;
  } else {
    const c = d.contentParts.find((x) => x.id === id)!;
    const drafts = { ...(c.draftLocales ?? {}) };
    if (blank) delete drafts[locale]; else drafts[locale] = text!;
    if (Object.keys(drafts).length) c.draftLocales = drafts; else delete c.draftLocales;
  }
  if (!blank && origin) d.translationOrigins = { ...(d.translationOrigins ?? {}), [`${locale}|${id}`]: origin };
  else clearOrigin(d, locale, id);
}

/** Digest of the authorable content (excludes version counters and save timestamps). */
export function projectContentDigest(project: Project): string {
  // Projects are immutable values (every command returns a new object), so the digest is cached per object.
  // Resolving one project for many customers (cube, blocker list, assistant impact checks) would otherwise re-hash it each time.
  const hit = DIGESTS.get(project);
  if (hit !== undefined) return hit;
  const { modelVersion: _v, lastSavedAt: _s, ...rest } = project;
  const digest = digestOf(rest);
  DIGESTS.set(project, digest);
  return digest;
}
const DIGESTS = new WeakMap<Project, string>();

/** Where each custom field is referenced (rule conditions, bindings, tokens) — used to block unsafe deletes. */
export function customFieldUsage(project: Project): Array<{ path: string; where: string[] }> {
  const map = new Map<string, Set<string>>();
  const add = (path: string, where: string) => { if (!path.startsWith('custom.')) return; if (!map.has(path)) map.set(path, new Set()); map.get(path)!.add(where); };
  const walk = (p: Predicate, where: string): void => {
    if ('args' in p) p.args.forEach((a) => walk(a, where));
    else if ('arg' in p) walk(p.arg, where);
    else add(p.path, where);
  };
  for (const r of project.rules) walk(r.when, `rule ${r.id}`);
  for (const n of project.nodes) {
    if (n.binding) add(n.binding, n.name ?? n.id);
    tokensIn(n.content).forEach((path) => add(path, n.name ?? n.id));
  }
  for (const c of project.contentParts) for (const t of Object.values(c.approvedLocales)) (t ?? '').replace(/\{\{\s*(custom\.[A-Za-z0-9]+)/g, (_m: string, path: string) => { add(path, c.title); return ''; });
  for (const c of project.calculatedFields ?? []) { const deps = exprDependencies(c.expr); for (const path of [...deps.fields, ...deps.lists]) add(path, `calculation “${c.label}”`); }
  if (project.documentDate?.source === 'field') add(project.documentDate.path, 'the document’s date');
  return [...map].map(([path, where]) => ({ path, where: [...where] }));
}

/* ------------------------------------------------------------ calculations, tables, periods */

const cleanPeriod = (p: EffectivePeriod): EffectivePeriod => ({ ...(p.from ? { from: p.from } : {}), ...(p.until ? { until: p.until } : {}) });
const periodLabel = (p: EffectivePeriod): string => (p.from && p.until ? `from ${p.from} until ${p.until}` : p.from ? `from ${p.from}` : `until ${p.until}`);

/** Where each calculated field is used (other calculations, rule conditions, conditions on components, bindings, wording, footers). */
export function calculationUsage(project: Project): Array<{ key: string; where: string[] }> {
  const map = new Map<string, Set<string>>();
  const add = (path: string | undefined, where: string) => { if (!path?.startsWith(CALC_PREFIX)) return; const k = path.slice(CALC_PREFIX.length); if (!map.has(k)) map.set(k, new Set()); map.get(k)!.add(where); };
  for (const c of project.calculatedFields ?? []) for (const k of exprDependencies(c.expr).calcs) add(`${CALC_PREFIX}${k}`, `calculation “${c.label}”`);
  for (const r of project.rules) predicateLeafPaths(r.when).forEach((p) => add(p, `rule ${r.id}`));
  for (const n of project.nodes) {
    const name = n.name ?? n.id;
    predicateLeafPaths(n.visibleWhen).forEach((p) => add(p, name));
    Object.values(n.variantConditions ?? {}).forEach((pr) => predicateLeafPaths(pr).forEach((p) => add(p, name)));
    add(n.binding, name);
    add(n.totalFrom, name);
    (n.chart?.series ?? []).forEach((s) => add(s.path, name));
    tokensIn(n.content).forEach((p) => add(p, name));
  }
  const text = (t: string | undefined, where: string) => { for (const m of (t ?? '').matchAll(/\{\{\s*(calc\.[A-Za-z0-9]+)\s*\}\}/g)) add(m[1], where); };
  for (const c of project.contentParts) for (const t of Object.values(c.approvedLocales)) text(t, c.title);
  for (const st of translatableStrings(project)) text(st.source, st.title);
  return [...map].map(([key, where]) => ({ key, where: [...where] }));
}

/**
 * Whether the project's rules, conditions, bindings and footers still work after a change to its calculated fields
 * (a calculation removed or giving another kind of value). Null when they do; otherwise what breaks, in plain words.
 */
function referenceProblems(candidate: Project): string | null {
  const fields = projectFieldIndex(candidate);
  for (const r of candidate.rules) { const e = validatePredicate(r.when, fields); if (e.length) return `rule ${r.id} (${e[0]})`; }
  for (const n of candidate.nodes) {
    for (const p of [n.visibleWhen, ...Object.values(n.variantConditions ?? {})]) if (p) { const e = validatePredicate(p, fields); if (e.length) return `${n.name ?? n.id} (${e[0]})`; }
    if (n.totalFrom && fields.get(n.totalFrom)?.type !== 'cents') return `the footer total of ${n.name ?? n.id} (it must be an amount)`;
  }
  return null;
}

/** Validation for named text styles. */
export function validateStyles(styles: TextStyle[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const st of styles) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(st.id ?? '')) errors.push(`Style id “${st.id}” must be lowercase letters, digits or dashes.`);
    if (seen.has(st.id)) errors.push(`Style id “${st.id}” is used twice.`);
    seen.add(st.id);
    if (!st.name?.trim()) errors.push(`Style ${st.id} needs a name.`);
    if (st.kind !== 'paragraph' && st.kind !== 'character') errors.push(`Style ${st.id} must be paragraph or character.`);
    if (st.fontSizePt !== undefined && (st.fontSizePt < 6 || st.fontSizePt > 48)) errors.push(`Style ${st.id}: font size must be 6–48 pt.`);
    if (st.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(st.color)) errors.push(`Style ${st.id}: colour must be a 6-digit hex value.`);
    if (st.lineHeight !== undefined && (st.lineHeight < 1 || st.lineHeight > 3)) errors.push(`Style ${st.id}: line height must be 1–3.`);
    for (const k of ['spaceBeforePt', 'spaceAfterPt'] as const) if (st[k] !== undefined && (st[k]! < 0 || st[k]! > 72)) errors.push(`Style ${st.id}: spacing must be 0–72 pt.`);
  }
  return errors;
}
