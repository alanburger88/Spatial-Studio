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
import type { LibraryKind, LibraryLink, LibraryTarget, WordingRule } from './types';
import type { MappingEntry, MappingStamp, TargetField, TargetMapping } from './types';
import { MAPPINGS_MAX, cleanEntry, cleanTargetFields, entryProblem, mappablePaths, mappingProblems, stampProblem, targetFieldsProblems } from './mapping';
import {
  LIBRARY_ID_PATTERN, LIBRARY_LINK_ID_PATTERN, LIBRARY_LINKS_MAX, LIBRARY_TITLE_MAX, blockId, blockMembers, blockPrefixFor, changedLink, checkLibraryContent,
  isLibraryKind, libraryContentFingerprint, linkedContentMessage, linkFor, linkNodeId, linkOfPart, mapBlock, nextLinkId,
  WORDING_RULE_KIND_LABEL, checkWordingRule, ownWordingRuleProblem,
  type LibraryContentByKind, type LibraryWordingContent,
} from './library';

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
  | { type: 'RESTORE_SNAPSHOT'; project: Project; label: string }
  // Shared library (wave 2, phase 4). `content` is the approved version's content as the library holds it (validated here again).
  /** Links the document to an approved library version and places its content (inserting it, or replacing what `placement` names). */
  | { type: 'LINK_LIBRARY_ITEM'; item: { id: string; kind: LibraryKind; title: string }; version: number; content: unknown; placement?: LibraryPlacement; linkId?: string }
  /** Replaces a link's content in place with another approved version (position and what the document adds around it are kept). */
  | { type: 'UPDATE_LIBRARY_LINK'; linkId: string; version: number; content: unknown; title?: string }
  /** Removes the link; the content stays and becomes the document's own. */
  | { type: 'UNLINK_LIBRARY_ITEM'; linkId: string }
  // The document's own wording rules (wave 2, section 4): each change is one undoable step, checked by `ownWordingRuleProblem`.
  | { type: 'ADD_WORDING_RULE'; rule: WordingRule; index?: number }
  | { type: 'UPDATE_WORDING_RULE'; ruleId: string; rule: WordingRule }
  | { type: 'REMOVE_WORDING_RULE'; ruleId: string }
  | { type: 'MOVE_WORDING_RULE'; ruleId: string; index: number }
  // Mappings to the system that produces the document (wave 3, section 3): each change is one undoable step. `stamp` says
  // who made it and when (supplied by the caller, so the commands stay pure). The engine never reads a mapping.
  | { type: 'ADD_MAPPING'; mapping: { id: string; name: string; system: string; description?: string }; stamp?: MappingStamp }
  /** Changes a mapping's name, target system or description (an empty description removes it). */
  | { type: 'RENAME_MAPPING'; mappingId: string; name?: string; system?: string; description?: string; stamp?: MappingStamp }
  | { type: 'REMOVE_MAPPING'; mappingId: string }
  /** Replaces the target's field list (as typed or imported). Entries are kept: a target name no longer in the list is reported by the checks. */
  | { type: 'IMPORT_TARGET_FIELDS'; mappingId: string; fields: TargetField[]; stamp?: MappingStamp }
  /** Sets what the target does with one document field (replacing what was there). */
  | { type: 'SET_MAPPING_ENTRY'; mappingId: string; entry: MappingEntry; stamp?: MappingStamp }
  | { type: 'CLEAR_MAPPING_ENTRY'; mappingId: string; path: string; stamp?: MappingStamp }
  /** Sets several entries at once (accepted suggestions, a pasted list): each replaces the entry for its field. */
  | { type: 'SET_MAPPING_ENTRIES'; mappingId: string; entries: MappingEntry[]; stamp?: MappingStamp };

/**
 * Where a linked item's content goes. A block is inserted into `parentId` (at `index`) or replaces the component
 * `replaceNodeId` (keeping its ids: the block was made from it); wording replaces the message `partId`; a lookup table
 * replaces `tableId`. Without a placement: a block is refused, wording and tables are added, the rest replace the document's own.
 */
export type LibraryPlacement = { parentId: string; index?: number } | { replaceNodeId: string } | { partId: string } | { tableId: string };

const LIBRARY_COMMANDS = new Set<Command['type']>(['LINK_LIBRARY_ITEM', 'UPDATE_LIBRARY_LINK', 'UNLINK_LIBRARY_ITEM', 'BATCH', 'RESTORE_SNAPSHOT']);

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


/**
 * Applies one command. Content linked from the shared library is read-only: when a document has library links, any
 * command other than the library commands themselves (and a batch, whose steps are each checked, or an undo) that would
 * change linked content is refused here, once, whatever the command. A document without links is not affected.
 */
export function applyCommand(project: Project, cmd: Command): CommandResult {
  const res = applyOne(project, cmd);
  if (!res.ok || !project.libraryLinks?.length || LIBRARY_COMMANDS.has(cmd.type)) return res;
  const hit = changedLink(project, res.project);
  return hit ? reject('LIBRARY_READ_ONLY', linkedContentMessage(hit), linkNodeId(hit)) : res;
}

function applyOne(project: Project, cmd: Command): CommandResult {
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
      return { ok: true, label: `${cmd.items.length} ${languageShortName(cmd.locale)} draft${cmd.items.length === 1 ? '' : 's'}${cmd.origin === 'ai' ? ' from AI' : cmd.origin === 'sample' ? ' from the sample set' : cmd.origin === 'imported' ? ' imported from a file' : ''}`, project: bump(project, (d) => { for (const it of cmd.items) writeDraft(d, it.id, cmd.locale, it.text, cmd.origin); }) };
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
    case 'LINK_LIBRARY_ITEM':
    case 'UPDATE_LIBRARY_LINK':
    case 'UNLINK_LIBRARY_ITEM':
      return applyLibraryCommand(project, cmd);
    case 'ADD_WORDING_RULE':
    case 'UPDATE_WORDING_RULE':
    case 'REMOVE_WORDING_RULE':
    case 'MOVE_WORDING_RULE':
      return applyWordingRuleCommand(project, cmd);
    case 'ADD_MAPPING':
    case 'RENAME_MAPPING':
    case 'REMOVE_MAPPING':
    case 'IMPORT_TARGET_FIELDS':
    case 'SET_MAPPING_ENTRY':
    case 'CLEAR_MAPPING_ENTRY':
    case 'SET_MAPPING_ENTRIES':
      return applyMappingCommand(project, cmd);
  }
}

/* ------------------------------------------------------------ mappings to a production system (wave 3) */

type MappingCommand = Extract<Command, { type: 'ADD_MAPPING' | 'RENAME_MAPPING' | 'REMOVE_MAPPING' | 'IMPORT_TARGET_FIELDS' | 'SET_MAPPING_ENTRY' | 'CLEAR_MAPPING_ENTRY' | 'SET_MAPPING_ENTRIES' }>;

function applyMappingCommand(project: Project, cmd: MappingCommand): CommandResult {
  const all = project.mappings ?? [];
  const stampBad = 'stamp' in cmd ? stampProblem(cmd.stamp) : null;
  if (stampBad) return reject('INVALID_MAPPING', stampBad);
  const stamp = 'stamp' in cmd && cmd.stamp ? { by: cmd.stamp.by.trim(), at: cmd.stamp.at } : undefined;
  if (cmd.type === 'ADD_MAPPING') {
    if (all.length >= MAPPINGS_MAX) return reject('TOO_MANY', `A document can have at most ${MAPPINGS_MAX} mappings.`);
    const m: TargetMapping = { id: cmd.mapping?.id, name: cmd.mapping?.name?.trim(), system: cmd.mapping?.system?.trim(), ...(cmd.mapping?.description?.trim() ? { description: cmd.mapping.description.trim() } : {}), ...(stamp ? { created: stamp } : {}), entries: [] };
    const bad = mappingProblems(m);
    if (bad.length) return reject('INVALID_MAPPING', bad[0]);
    if (all.some((x) => x.id === m.id)) return reject('DUPLICATE_ID', `A mapping with the id “${m.id}” already exists.`);
    if (all.some((x) => x.name.toLowerCase() === m.name.toLowerCase())) return reject('DUPLICATE', `This document already has a mapping called “${m.name}”.`);
    return { ok: true, label: `Add the mapping “${m.name}”`, project: bump(project, (d) => { d.mappings = [...all, m]; }) };
  }
  const i = all.findIndex((x) => x.id === cmd.mappingId);
  if (i < 0) return reject('NOT_FOUND', 'This document has no such mapping.');
  const before = all[i];
  const put = (next: TargetMapping) => (d: Project) => { d.mappings = all.map((x, j) => (j === i ? { ...next, ...(stamp ? { changed: stamp } : {}) } : x)); };
  switch (cmd.type) {
    case 'REMOVE_MAPPING':
      return { ok: true, label: `Remove the mapping “${before.name}”`, project: bump(project, (d) => { const rest = all.filter((_, j) => j !== i); if (rest.length) d.mappings = rest; else delete d.mappings; }) };
    case 'RENAME_MAPPING': {
      const next: TargetMapping = { ...before };
      if (cmd.name !== undefined) next.name = String(cmd.name).trim();
      if (cmd.system !== undefined) next.system = String(cmd.system).trim();
      if (cmd.description !== undefined) { if (String(cmd.description).trim()) next.description = String(cmd.description).trim(); else delete next.description; }
      const bad = mappingProblems(next);
      if (bad.length) return reject('INVALID_MAPPING', bad[0]);
      if (all.some((x, j) => j !== i && x.name.toLowerCase() === next.name.toLowerCase())) return reject('DUPLICATE', `This document already has a mapping called “${next.name}”.`);
      if (next.name === before.name && next.system === before.system && next.description === before.description) return reject('NO_CHANGE', 'Nothing changed.');
      return { ok: true, label: next.name !== before.name ? `Rename the mapping “${before.name}” to “${next.name}”` : `Change the details of the mapping “${next.name}”`, project: bump(project, put(next)) };
    }
    case 'IMPORT_TARGET_FIELDS': {
      const bad = targetFieldsProblems(cmd.fields);
      if (bad.length) return reject('INVALID_TARGET_FIELDS', bad[0]);
      const fields = cleanTargetFields(cmd.fields);
      const next: TargetMapping = { ...before };
      if (fields.length) next.targetFields = fields; else delete next.targetFields;
      return { ok: true, label: `${fields.length ? `${fields.length} target field${fields.length === 1 ? '' : 's'} for` : 'Clear the target field list of'} “${before.name}”`, project: bump(project, put(next)) };
    }
    case 'SET_MAPPING_ENTRY':
    case 'SET_MAPPING_ENTRIES': {
      const list = cmd.type === 'SET_MAPPING_ENTRY' ? [cmd.entry] : cmd.entries;
      if (!Array.isArray(list) || !list.length) return reject('EMPTY', 'There is nothing to set.');
      if (list.length > 5000) return reject('TOO_LONG', 'Too many entries in one step.');
      const paths = mappablePaths(project);
      const byPath = new Map(before.entries.map((e) => [e.path, e]));
      const seen = new Set<string>();
      for (const e of list) {
        const bad = entryProblem(e, paths);
        if (bad) return reject('INVALID_MAPPING_ENTRY', bad);
        if (seen.has(e.path)) return reject('INVALID_MAPPING_ENTRY', `“${paths.get(e.path)!.label}” is set twice in one step.`);
        seen.add(e.path);
        const c = cleanEntry(e);
        if (c) byPath.set(e.path, c); else byPath.delete(e.path);
      }
      const entries = [...byPath.values()];
      if (digestOf(entries) === digestOf(before.entries)) return reject('NO_CHANGE', 'Nothing changed.');
      const one = list.length === 1 ? paths.get(list[0].path)!.label : null;
      return { ok: true, label: one ? `Map “${one}” in “${before.name}”` : `Map ${list.length} fields in “${before.name}”`, project: bump(project, put({ ...before, entries })) };
    }
    case 'CLEAR_MAPPING_ENTRY': {
      if (!before.entries.some((e) => e.path === cmd.path)) return reject('NOT_FOUND', 'That field has nothing to clear in this mapping.');
      const label = mappablePaths(project).get(cmd.path)?.label ?? cmd.path;
      return { ok: true, label: `Clear “${label}” in “${before.name}”`, project: bump(project, put({ ...before, entries: before.entries.filter((e) => e.path !== cmd.path) })) };
    }
  }
}

/* ------------------------------------------------------------ the document's own wording rules */

type WordingRuleCommand = Extract<Command, { type: 'ADD_WORDING_RULE' | 'UPDATE_WORDING_RULE' | 'REMOVE_WORDING_RULE' | 'MOVE_WORDING_RULE' }>;
const ruleWords = (r: WordingRule): string => (r.phrase ? `“${r.phrase}”` : WORDING_RULE_KIND_LABEL[r.kind].toLowerCase());

function applyWordingRuleCommand(project: Project, cmd: WordingRuleCommand): CommandResult {
  const own = project.wordingRules ?? [];
  const set = (rules: WordingRule[]) => (d: Project) => { if (rules.length) d.wordingRules = rules; else delete d.wordingRules; };
  switch (cmd.type) {
    case 'ADD_WORDING_RULE': {
      const why = ownWordingRuleProblem(project, cmd.rule);
      if (why) return reject('INVALID_WORDING_RULE', why);
      const rule = checkWordingRule(cmd.rule).rule!;
      const at = cmd.index === undefined ? own.length : Math.max(0, Math.min(own.length, Math.floor(cmd.index)));
      return { ok: true, label: `Add the wording rule ${ruleWords(rule)}`, project: bump(project, set([...own.slice(0, at), rule, ...own.slice(at)])) };
    }
    case 'UPDATE_WORDING_RULE': {
      const i = own.findIndex((r) => r.id === cmd.ruleId);
      if (i < 0) return reject('NOT_FOUND', (project.houseWordingRules ?? []).some((r) => r.id === cmd.ruleId) ? 'That is a house rule: it comes from the library and is changed there.' : 'This document has no such wording rule.');
      const why = ownWordingRuleProblem(project, cmd.rule, cmd.ruleId);
      if (why) return reject('INVALID_WORDING_RULE', why);
      const rule = checkWordingRule(cmd.rule).rule!;
      if (digestOf(rule) === digestOf(own[i])) return reject('NO_CHANGE', 'The rule is unchanged.');
      return { ok: true, label: `Change the wording rule ${ruleWords(rule)}`, project: bump(project, set(own.map((r, j) => (j === i ? rule : r)))) };
    }
    case 'REMOVE_WORDING_RULE': {
      const r = own.find((x) => x.id === cmd.ruleId);
      if (!r) return reject('NOT_FOUND', (project.houseWordingRules ?? []).some((x) => x.id === cmd.ruleId) ? 'That is a house rule: it comes from the library. Unlink the house rules to make them this document’s own.' : 'This document has no such wording rule.');
      return { ok: true, label: `Remove the wording rule ${ruleWords(r)}`, project: bump(project, set(own.filter((x) => x.id !== cmd.ruleId))) };
    }
    case 'MOVE_WORDING_RULE': {
      const i = own.findIndex((r) => r.id === cmd.ruleId);
      if (i < 0) return reject('NOT_FOUND', 'This document has no such wording rule.');
      if (!Number.isInteger(cmd.index)) return reject('INVALID', 'Say where the rule goes.');
      const to = Math.max(0, Math.min(own.length - 1, cmd.index));
      if (to === i) return reject('NO_CHANGE', 'The rule is already there.');
      const next = own.filter((_, j) => j !== i);
      next.splice(to, 0, own[i]);
      return { ok: true, label: `Move the wording rule ${ruleWords(own[i])}`, project: bump(project, set(next)) };
    }
  }
}

/**
 * The house rules arriving in a document (a link or an update): an own rule that is the same as a house rule is dropped
 * (it is now a house rule), and an own rule that has a house rule's id gets a free id. The order of the rest is kept.
 */
function ownRulesBeside(house: readonly WordingRule[], own: readonly WordingRule[] | undefined): WordingRule[] | undefined {
  if (!own?.length) return undefined;
  const same = new Set(house.map((r) => digestOf(r)));
  const ids = new Set(house.map((r) => r.id));
  const kept: WordingRule[] = [];
  for (const r of own) {
    if (same.has(digestOf(r))) continue;
    let id = r.id;
    for (let n = 2; ids.has(id); n++) id = `${r.id.slice(0, 36)}-${n}`;
    ids.add(id);
    kept.push(id === r.id ? r : { ...r, id });
  }
  return kept.length ? kept : undefined;
}

/* ------------------------------------------------------------ shared library */

type LibraryCommand = Extract<Command, { type: 'LINK_LIBRARY_ITEM' | 'UPDATE_LIBRARY_LINK' | 'UNLINK_LIBRARY_ITEM' }>;

function applyLibraryCommand(project: Project, cmd: LibraryCommand): CommandResult {
  const links = project.libraryLinks ?? [];
  if (cmd.type === 'UNLINK_LIBRARY_ITEM') {
    const link = linkFor(project, cmd.linkId);
    if (!link) return reject('NOT_FOUND', 'That library link is not in this document.');
    return { ok: true, label: `Unlink “${link.title}” from the library`, project: bump(project, (d) => {
      const rest = (d.libraryLinks ?? []).filter((l) => l.linkId !== cmd.linkId);
      if (rest.length) d.libraryLinks = rest; else delete d.libraryLinks;
      // Unlinked house wording rules become the document's own (first, in their order), so they can be edited here.
      if (link.kind === 'wording-rules' && d.houseWordingRules) {
        const all = [...d.houseWordingRules, ...(d.wordingRules ?? [])];
        delete d.houseWordingRules;
        if (all.length) d.wordingRules = JSON.parse(JSON.stringify(all)); else delete d.wordingRules;
      }
    }) };
  }
  if (!Number.isInteger(cmd.version) || cmd.version < 1) return reject('INVALID_LIBRARY_LINK', 'Say which approved version of the library item to use.');
  let link: LibraryLink;
  if (cmd.type === 'LINK_LIBRARY_ITEM') {
    const it = cmd.item;
    if (!it || !LIBRARY_ID_PATTERN.test(it.id ?? '') || !isLibraryKind(it.kind)) return reject('INVALID_LIBRARY_LINK', 'The library item cannot be read.');
    if (typeof it.title !== 'string' || !it.title.trim() || it.title.length > LIBRARY_TITLE_MAX) return reject('INVALID_LIBRARY_LINK', `The library item needs a title (max ${LIBRARY_TITLE_MAX} characters).`);
    if (links.length >= LIBRARY_LINKS_MAX) return reject('TOO_MANY', `A document can link to at most ${LIBRARY_LINKS_MAX} library items.`);
    if (cmd.linkId !== undefined && (!LIBRARY_LINK_ID_PATTERN.test(cmd.linkId) || links.some((l) => l.linkId === cmd.linkId))) return reject('INVALID_LIBRARY_LINK', 'The link id is not valid or is already used.');
    const linkId = cmd.linkId ?? nextLinkId(project, it.id);
    const target = initialTarget(project, it.kind, linkId, cmd.content, cmd.placement);
    if ('error' in target) return reject('INVALID_LIBRARY_LINK', target.error);
    link = { linkId, itemId: it.id, kind: it.kind, title: it.title.trim(), version: cmd.version, fingerprint: '', target: target.target };
  } else {
    const found = linkFor(project, cmd.linkId);
    if (!found) return reject('NOT_FOUND', 'That library link is not in this document.');
    if (found.version === cmd.version) return reject('UNCHANGED', `This document already holds version ${cmd.version} of “${found.title}”.`);
    link = { ...found, version: cmd.version, ...(typeof cmd.title === 'string' && cmd.title.trim() && cmd.title.length <= LIBRARY_TITLE_MAX ? { title: cmd.title.trim() } : {}) };
  }
  const checked = checkLibraryContent(link.kind, cmd.content);
  if (!checked.ok) return reject('INVALID_LIBRARY_CONTENT', `The library content cannot be used: ${checked.problems[0]}`);
  const content = checked.content;
  link.fingerprint = libraryContentFingerprint(content);
  const updating = cmd.type === 'UPDATE_LIBRARY_LINK';
  const verb = updating ? `Update “${link.title}” to library version ${link.version}` : `Link “${link.title}” from the library (version ${link.version})`;
  const others = links.filter((l) => l.linkId !== link.linkId);
  const taken = (pred: (l: LibraryLink) => boolean) => others.find(pred);
  const withLink = (d: Project) => { d.libraryLinks = updating ? (d.libraryLinks ?? []).map((l) => (l.linkId === link.linkId ? link : l)) : [...(d.libraryLinks ?? []), link]; };
  const t = link.target;

  switch (t.kind) {
    case 'brand': {
      const other = taken((l) => l.target.kind === 'brand');
      if (other) return reject('ALREADY_LINKED', `The brand already comes from the library (“${other.title}”). Update or unlink it first.`);
      const brand = content as BrandKit;
      return { ok: true, label: verb, project: bump(project, (d) => { d.brand = { ...brand }; withLink(d); }) };
    }
    case 'glossary': {
      const other = taken((l) => l.target.kind === 'glossary');
      if (other) return reject('ALREADY_LINKED', `The glossary already comes from the library (“${other.title}”). Update or unlink it first.`);
      const entries = (content as LibraryContentByKind['glossary']).entries;
      return { ok: true, label: verb, project: bump(project, (d) => { d.glossary = JSON.parse(JSON.stringify(entries)); withLink(d); }) };
    }
    case 'wording-rules': {
      const other = taken((l) => l.target.kind === 'wording-rules');
      if (other) return reject('ALREADY_LINKED', `The house wording rules already come from the library (“${other.title}”). Update or unlink them first.`);
      const rules = (content as LibraryContentByKind['wording-rules']).rules;
      const own = ownRulesBeside(rules, project.wordingRules);
      return { ok: true, label: verb, project: bump(project, (d) => { d.houseWordingRules = JSON.parse(JSON.stringify(rules)); if (own) d.wordingRules = own; else delete d.wordingRules; withLink(d); }) };
    }
    case 'lookup-table': {
      const other = taken((l) => l.target.kind === 'lookup-table' && l.target.tableId === t.tableId);
      if (other) return reject('ALREADY_LINKED', `That lookup table already comes from the library (“${other.title}”).`);
      const table: LookupTable = { ...(JSON.parse(JSON.stringify(content)) as LookupTable), id: t.tableId };
      const tables = project.lookupTables ?? [];
      const at = tables.findIndex((x) => x.id === t.tableId);
      if (at < 0 && tables.length >= LOOKUP_TABLES_MAX) return reject('TOO_MANY', `A document can have at most ${LOOKUP_TABLES_MAX} lookup tables.`);
      const next = at >= 0 ? tables.map((x, i) => (i === at ? table : x)) : [...tables, table];
      const calcErrors = validateCalculatedFields({ ...project, lookupTables: next }, project.calculatedFields ?? []);
      if (calcErrors.length) return reject('TABLE_IN_USE', `A calculation that reads this table would no longer work: ${calcErrors[0]}`);
      return { ok: true, label: verb, project: bump(project, (d) => { d.lookupTables = next; withLink(d); }) };
    }
    case 'wording': {
      const other = taken((l) => linkOfPart(project, t.partId)?.linkId === l.linkId);
      if (other) return reject('ALREADY_LINKED', `That wording already comes from the library (“${other.title}”).`);
      const w = content as LibraryContentByKind['wording'];
      const existing = project.contentParts.find((c) => c.id === t.partId);
      const part: ContentPart = { id: t.partId, version: existing ? existing.version + 1 : 1, title: w.part.title, approvedLocales: { ...w.part.approvedLocales }, syntheticDemoOnly: existing?.syntheticDemoOnly ?? true, type: w.part.type };
      return { ok: true, label: verb, project: bump(project, (d) => {
        const i = d.contentParts.findIndex((c) => c.id === t.partId);
        if (i >= 0) d.contentParts[i] = part; else d.contentParts.push(part);
        const strings = { ...(d.strings ?? {}) };
        if (w.titleTranslations) strings[`@title/${t.partId}`] = { approved: { ...w.titleTranslations } }; else delete strings[`@title/${t.partId}`];
        if (Object.keys(strings).length) d.strings = strings; else delete d.strings;
        if (d.translationOrigins) for (const k of Object.keys(d.translationOrigins)) if (k.endsWith(`|${t.partId}`)) clearOrigin(d, k.split('|')[0], t.partId);
        withLink(d);
      }) };
    }
    case 'block': {
      const block = content as LibraryContentByKind['block'];
      const mapped = mapBlock(block, t.idPrefix, project);
      // What is replaced: the linked block itself (an update), the component the block was made from, or nothing (an insert).
      const replaceId = updating ? t.rootNodeId : cmd.type === 'LINK_LIBRARY_ITEM' && cmd.placement && 'replaceNodeId' in cmd.placement ? cmd.placement.replaceNodeId : null;
      const insertAt = cmd.type === 'LINK_LIBRARY_ITEM' && cmd.placement && 'parentId' in cmd.placement ? cmd.placement : null;
      const placed = placeBlock(project, mapped, replaceId, insertAt, others);
      if ('error' in placed) return reject(placed.code, placed.error, placed.nodeId);
      const next: LibraryLink = { ...link, target: { ...t, rootNodeId: mapped.nodes[0].id } };
      const finalProject = { ...placed.project, libraryLinks: updating ? (project.libraryLinks ?? []).map((l) => (l.linkId === link.linkId ? next : l)) : [...links, next] };
      return { ok: true, label: verb, project: { ...finalProject, modelVersion: project.modelVersion + 1 } };
    }
  }
}

/** Where a new link's content goes, from the command's placement (validated against the document). */
function initialTarget(project: Project, kind: LibraryKind, linkId: string, content: unknown, placement: LibraryPlacement | undefined): { target: LibraryTarget } | { error: string } {
  const pl = (placement ?? {}) as Record<string, unknown>;
  switch (kind) {
    case 'brand': case 'glossary': case 'wording-rules': return { target: { kind } };
    case 'lookup-table': {
      if (typeof pl.tableId === 'string') {
        if (!(project.lookupTables ?? []).some((x) => x.id === pl.tableId)) return { error: `There is no lookup table ${pl.tableId} to replace.` };
        return { target: { kind, tableId: pl.tableId } };
      }
      const id = (content as LookupTable | null)?.id;
      if (typeof id !== 'string') return { error: 'The lookup table cannot be read.' };
      if ((project.lookupTables ?? []).some((x) => x.id === id)) return { error: `This document already has a lookup table with the id ${id}. Choose it to replace it, or rename one of them.` };
      return { target: { kind, tableId: id } };
    }
    case 'wording': {
      if (typeof pl.partId === 'string') {
        if (!project.contentParts.some((c) => c.id === pl.partId)) return { error: `There is no message ${pl.partId} to replace.` };
        return { target: { kind, partId: pl.partId } };
      }
      const id = (content as LibraryWordingContent | null)?.part?.id;
      if (typeof id !== 'string') return { error: 'The wording cannot be read.' };
      const partId = blockId(blockPrefixFor(linkId), id);
      if (project.contentParts.some((c) => c.id === partId)) return { error: `This document already has a message with the id ${partId}.` };
      return { target: { kind, partId } };
    }
    case 'block': {
      if (typeof pl.replaceNodeId === 'string') return { target: { kind, rootNodeId: pl.replaceNodeId, idPrefix: '' } };
      if (typeof pl.parentId === 'string') return { target: { kind, rootNodeId: '', idPrefix: blockPrefixFor(linkId) } };
      return { error: 'Say where in the document the building block goes.' };
    }
  }
}

/**
 * Puts a block's (mapped) nodes, messages and translations in the document: in place of `replaceId` (keeping its place
 * in its parent and its own layout, which belong to the document) or at `insertAt`. Checks everything a document needs.
 */
function placeBlock(project: Project, mapped: ReturnType<typeof mapBlock>, replaceId: string | null, insertAt: { parentId: string; index?: number } | null, otherLinks: LibraryLink[]): { project: Project } | { code: string; error: string; nodeId?: string } {
  const map = nodeMap(project);
  const root = mapped.nodes[0];
  const inOtherBlock = (id: string) => otherLinks.find((l) => l.target.kind === 'block' && blockMembers(project, l.target.rootNodeId).nodeIds.includes(id));
  let parentId: string, index: number;
  let removed = { nodeIds: [] as string[], partIds: [] as string[], stringIds: [] as string[] };
  let keptLayout: DocNode['layout'];
  if (replaceId !== null) {
    const old = map.get(replaceId);
    if (!old) return { code: 'NOT_FOUND', error: `There is no component ${replaceId} to replace.` };
    if (replaceId === project.rootNodeId) return { code: 'PROTECTED', error: 'The document itself cannot be replaced by a building block.' };
    const inside = inOtherBlock(replaceId);
    if (inside) return { code: 'ALREADY_LINKED', error: `That component already comes from the library (“${inside.title}”).`, nodeId: replaceId };
    removed = blockMembers(project, replaceId);
    const nested = otherLinks.find((l) => l.target.kind === 'block' && removed.nodeIds.includes(l.target.rootNodeId));
    if (nested) return { code: 'ALREADY_LINKED', error: `That component contains “${nested.title}”, which comes from the library. Unlink it first.`, nodeId: replaceId };
    const parent = parentOf(project, replaceId);
    if (!parent) return { code: 'NOT_FOUND', error: 'The component has no place in the document.' };
    parentId = parent.id; index = parent.children!.indexOf(replaceId);
    keptLayout = old.layout;
  } else if (insertAt) {
    const why = dropRejection(project, insertAt.parentId, root.type);
    if (why) return { code: 'INVALID_DROP_TARGET', error: why, nodeId: insertAt.parentId };
    const inside = inOtherBlock(insertAt.parentId);
    if (inside) return { code: 'LIBRARY_READ_ONLY', error: `“${inside.title}” comes from the library and is read-only, so nothing can be put inside it.`, nodeId: insertAt.parentId };
    parentId = insertAt.parentId;
    index = insertAt.index ?? map.get(parentId)!.children?.length ?? 0;
  } else return { code: 'INVALID_LIBRARY_LINK', error: 'Say where in the document the building block goes.' };

  const goneNodes = new Set(removed.nodeIds), goneParts = new Set(removed.partIds);
  const clash = mapped.nodes.find((n) => map.has(n.id) && !goneNodes.has(n.id));
  if (clash) return { code: 'DUPLICATE_ID', error: `The document already has a component with the id ${clash.id}, so the building block cannot be placed.`, nodeId: clash.id };
  const partClash = mapped.parts.find((p) => !goneParts.has(p.id) && project.contentParts.some((c) => c.id === p.id) && replaceId === null);
  if (partClash) return { code: 'DUPLICATE_ID', error: `The document already has a message with the id ${partClash.id}, so the building block cannot be placed.` };
  const keptIds = new Set(mapped.nodes.map((n) => n.id));
  const req = requiredNodeIds(project);
  const lost = removed.nodeIds.find((id) => req.has(id) && !keptIds.has(id));
  if (lost) return { code: 'PROTECTED_OBLIGATION', error: `This would remove “${map.get(lost)?.name ?? lost}”, which a rule of this document requires.`, nodeId: lost };

  const placedRoot: DocNode = keptLayout ? { ...root, layout: keptLayout } : root;
  const fields = projectFieldIndex(project);
  for (const n of [placedRoot, ...mapped.nodes.slice(1)]) {
    const shape = validateNodeShape(n, project);
    if (shape) return { code: 'INVALID_NODE', error: `“${n.name ?? n.id}” cannot be placed in this document: ${shape}`, nodeId: n.id };
    if (n.binding && !fields.has(n.binding)) return { code: 'INVALID_BINDING', error: `“${n.name ?? n.id}” shows the data field ${n.binding}, which this document does not have.`, nodeId: n.id };
  }
  const nodes = project.nodes.filter((n) => !goneNodes.has(n.id)).map((n) => (n.id === parentId ? { ...n, children: (n.children ?? []).filter((c) => c !== replaceId) } : n));
  const parent = nodes.find((n) => n.id === parentId)!;
  const children = [...(parent.children ?? [])];
  children.splice(Math.max(0, Math.min(index, children.length)), 0, placedRoot.id);
  parent.children = children;
  nodes.push(placedRoot, ...mapped.nodes.slice(1));
  const oldParts = new Map(project.contentParts.map((c) => [c.id, c]));
  const newPartIds = new Set(mapped.parts.map((p) => p.id));
  const contentParts = project.contentParts.filter((c) => !(goneParts.has(c.id) && !newPartIds.has(c.id))).map((c) => {
    const np = mapped.parts.find((p) => p.id === c.id);
    return np ? { ...np, version: c.version + 1, syntheticDemoOnly: c.syntheticDemoOnly } : c;
  });
  for (const p of mapped.parts) if (!oldParts.has(p.id)) contentParts.push(p);
  const strings = { ...(project.strings ?? {}) };
  for (const id of removed.stringIds) delete strings[id];
  Object.assign(strings, mapped.strings);
  const origins = Object.fromEntries(Object.entries(project.translationOrigins ?? {}).filter(([k]) => !removed.stringIds.includes(k.slice(k.indexOf('|') + 1)) && !goneParts.has(k.slice(k.indexOf('|') + 1))));
  const candidate: Project = { ...project, nodes, contentParts };
  if (Object.keys(strings).length) candidate.strings = strings; else delete candidate.strings;
  if (Object.keys(origins).length) candidate.translationOrigins = origins; else delete candidate.translationOrigins;
  const badRule = candidate.rules.map((r) => ({ r, e: validateRule(r, candidate) })).find((x) => x.e.length);
  if (badRule) return { code: 'RULE_IN_USE', error: `Rule ${badRule.r.id} would no longer work: ${badRule.e[0]}` };
  return { project: candidate };
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

/**
 * One place a calculated field is used, for a screen to link to: another calculation (`id` = its key), a rule (`id` =
 * the rule id), a component of the document (`id` = `nodeId`), wording kept with the document (`id` = the content part
 * or string id, `nodeId` when a component shows it) or the email or SMS (`id` = the string id). `label` is the same
 * words as in `where`.
 */
export interface CalculationUse { kind: 'calculation' | 'rule' | 'component' | 'wording' | 'channel'; id: string; nodeId?: string; label: string }

/**
 * Where each calculated field is used (other calculations, rule conditions, conditions on components, bindings, wording,
 * footers): `where` in words (for messages), `uses` as structured places (for links; two calculations or parts with the
 * same name stay apart).
 */
export function calculationUsage(project: Project): Array<{ key: string; where: string[]; uses: CalculationUse[] }> {
  const map = new Map<string, { where: Set<string>; uses: Map<string, CalculationUse> }>();
  const add = (path: string | undefined, use: CalculationUse) => {
    if (!path?.startsWith(CALC_PREFIX)) return;
    const k = path.slice(CALC_PREFIX.length);
    let m = map.get(k);
    if (!m) { m = { where: new Set(), uses: new Map() }; map.set(k, m); }
    m.where.add(use.label);
    const id = `${use.kind}|${use.id}|${use.label}`;
    if (!m.uses.has(id)) m.uses.set(id, use);
  };
  for (const c of project.calculatedFields ?? []) for (const k of exprDependencies(c.expr).calcs) add(`${CALC_PREFIX}${k}`, { kind: 'calculation', id: c.key, label: `calculation “${c.label}”` });
  for (const r of project.rules) predicateLeafPaths(r.when).forEach((p) => add(p, { kind: 'rule', id: r.id, label: `rule ${r.id}` }));
  for (const n of project.nodes) {
    const use: CalculationUse = { kind: 'component', id: n.id, nodeId: n.id, label: n.name ?? n.id };
    predicateLeafPaths(n.visibleWhen).forEach((p) => add(p, use));
    Object.values(n.variantConditions ?? {}).forEach((pr) => predicateLeafPaths(pr).forEach((p) => add(p, use)));
    add(n.binding, use);
    add(n.totalFrom, use);
    (n.chart?.series ?? []).forEach((s) => add(s.path, use));
    tokensIn(n.content).forEach((p) => add(p, use));
  }
  const text = (t: string | undefined, use: CalculationUse) => { for (const m of (t ?? '').matchAll(/\{\{\s*(calc\.[A-Za-z0-9]+)\s*\}\}/g)) add(m[1], use); };
  const shownBy = (partId: string): string | undefined => project.nodes.find((n) => n.id === partId || n.contentPartId === partId || (n.variantIds ?? []).includes(partId))?.id;
  for (const c of project.contentParts) {
    const nodeId = shownBy(c.id);
    for (const t of Object.values(c.approvedLocales)) text(t, { kind: 'wording', id: c.id, ...(nodeId ? { nodeId } : {}), label: c.title });
  }
  for (const st of translatableStrings(project)) {
    text(st.source, st.kind === 'channel' ? { kind: 'channel', id: st.id, label: st.title } : st.nodeId ? { kind: 'component', id: st.nodeId, nodeId: st.nodeId, label: st.title } : { kind: 'wording', id: st.id, label: st.title });
  }
  return [...map].map(([key, m]) => ({ key, where: [...m.where], uses: [...m.uses.values()] }));
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
