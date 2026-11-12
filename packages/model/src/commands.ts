import { produce } from 'immer';
import { CATALOG_BY_TYPE } from './catalog';
import { digestOf } from './digest';
import { isSafeUrl, sanitizeRichDoc, tokensIn } from './rich';
import { projectFieldIndex, validateCustomFields } from './fields';
import type { BrandKit, ContentPart, CustomField, DocNode, Locale, TestCase, TextStyle, JourneyEvent, NodeLayout, PagedLayout, Predicate, PresentationProfile, Project, ResponsiveLayout, Rule } from './types';
import { validatePredicate, validateRule } from './validate';

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
  | { type: 'SET_TRANSLATION_DRAFT'; partId: string; locale: Locale; text: string | null }
  | { type: 'APPROVE_TRANSLATION'; partId: string; locale: Locale }
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
      return { ok: true, label: `Insert ${CATALOG_BY_TYPE[node.type].label}`, project: bump(project, (d) => {
        d.nodes.push(node);
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
          if ((next.xPt ?? 0) < 0 || (next.yPt ?? 0) < 0 || (next.xPt ?? 0) + (next.wPt ?? 0) > 612 || (next.yPt ?? 0) + (next.hPt ?? 0) > 792) return reject('INVALID_LAYOUT', 'Fixed element must stay within the US-Letter page (612×792 pt).', cmd.nodeId);
        }
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
      return { ok: true, label: `Edit profile ${cmd.profileId}`, project: bump(project, (d) => {
        const i = d.presentationProfiles.findIndex((p) => p.id === cmd.profileId);
        d.presentationProfiles[i] = { ...d.presentationProfiles[i], ...cmd.patch, id: d.presentationProfiles[i].id };
      }) };
    }
    case 'SET_CUSTOM_FIELDS': {
      const errs = validateCustomFields(project.documentType, cmd.fields);
      if (errs.length) return reject('INVALID_FIELDS', errs.join(' '));
      const kept = new Set(cmd.fields.map((f) => `custom.${f.key}`));
      const used = customFieldUsage(project).filter((u) => !kept.has(u.path));
      if (used.length) return reject('FIELD_IN_USE', `${used[0].path} is still used by ${used[0].where.join(', ')}. Remove those references first.`);
      const candidate = { ...project, customFields: cmd.fields };
      const bad = project.rules.map((r) => validateRule(r, candidate)).find((e) => e.length);
      if (bad) return reject('FIELD_IN_USE', `A rule no longer validates with these fields: ${bad.join(' ')}`);
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
      if (!/^(CARD|EOB)-\d{4}$/.test(t.recordId ?? '')) return reject('INVALID_TEST', 'Test case needs a record ID.');
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
      const part = project.contentParts.find((c) => c.id === cmd.partId);
      if (!part) return reject('NOT_FOUND', `Unknown content part ${cmd.partId}.`);
      if (!['en-US', 'es-US'].includes(cmd.locale)) return reject('INVALID_LOCALE', `Unsupported locale ${cmd.locale}.`);
      if (cmd.text !== null && cmd.text.length > 4000) return reject('TOO_LONG', 'Translations are limited to 4,000 characters.');
      return { ok: true, label: `${cmd.text === null ? 'Discard' : 'Draft'} ${cmd.locale} for “${part.title}”`, project: bump(project, (d) => {
        const c = d.contentParts.find((x) => x.id === cmd.partId)!;
        const drafts = { ...(c.draftLocales ?? {}) };
        if (cmd.text === null || !cmd.text.trim()) delete drafts[cmd.locale]; else drafts[cmd.locale] = cmd.text;
        if (Object.keys(drafts).length) c.draftLocales = drafts; else delete c.draftLocales;
      }) };
    }
    case 'APPROVE_TRANSLATION': {
      const part = project.contentParts.find((c) => c.id === cmd.partId);
      const draft = part?.draftLocales?.[cmd.locale];
      if (!part) return reject('NOT_FOUND', `Unknown content part ${cmd.partId}.`);
      if (!draft?.trim()) return reject('NO_DRAFT', `There is no ${cmd.locale} draft to approve for “${part.title}”.`);
      const tokensOf = (t: string) => [...t.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');
      const source = part.approvedLocales['en-US'];
      if (source && tokensOf(source) !== tokensOf(draft)) return reject('TOKEN_MISMATCH', `The ${cmd.locale} text must use the same data tokens as the English text (${tokensOf(source) || 'none'}).`);
      return { ok: true, label: `Approve ${cmd.locale} for “${part.title}”`, project: bump(project, (d) => {
        const c = d.contentParts.find((x) => x.id === cmd.partId)!;
        c.approvedLocales = { ...c.approvedLocales, [cmd.locale]: draft };
        c.version += 1;
        const drafts = { ...(c.draftLocales ?? {}) }; delete drafts[cmd.locale];
        if (Object.keys(drafts).length) c.draftLocales = drafts; else delete c.draftLocales;
      }) };
    }
    case 'RESTORE_SNAPSHOT': {
      return { ok: true, label: cmd.label, project: { ...cmd.project, modelVersion: project.modelVersion + 1 } };
    }
  }
}

/** Digest of the authorable content (excludes version counters and save timestamps). */
export function projectContentDigest(project: Project): string {
  const { modelVersion: _v, lastSavedAt: _s, ...rest } = project;
  return digestOf(rest);
}

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
  return [...map].map(([path, where]) => ({ path, where: [...where] }));
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
