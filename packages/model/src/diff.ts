import { canonicalJson } from './digest';
import { richToPlain } from './rich';
import type { BrandKit, ContentPart, CustomField, DocNode, JourneyEvent, NodeLayout, Predicate, PresentationProfile, Project, Rule, RuleAction, TestCase, TextStyle } from './types';

/**
 * Pure, deterministic structural diff between two saved project versions. It reports *what* changed in the
 * canonical model (never a rendering); the UI words it for Business view and shows ids/digests in Technical view.
 */

export interface ValueChange { field: string; from: string | null; to: string | null }

export interface ComponentRef { id: string; type: string; name: string }
export interface ComponentChange extends ComponentRef {
  /** Top-level DocNode keys that differ (e.g. `name`, `layout`, `content`). */
  fields: string[];
  /** Readable old → new values where they make sense (name, text, layout, label, binding…). */
  changes: ValueChange[];
}

export interface RuleRef { id: string; title: string | null; priority: number; enabled: boolean; condition: string; action: string; rule: Rule }
export interface RuleChange {
  id: string;
  fields: string[];
  title?: { from: string | null; to: string | null };
  priority?: { from: number; to: number };
  enabled?: { from: boolean; to: boolean };
  condition?: { from: string; to: string };
  action?: { from: string; to: string };
  mode?: { from: string; to: string };
  before: Rule;
  after: Rule;
}

export interface TextChange { partId: string; title: string; locale: string; kind: 'approved' | 'draft'; from: string | null; to: string | null }
export interface NamedRef { id: string; name: string }
export interface NamedChange extends NamedRef { fields: string[] }

export interface ProjectDiff {
  title?: { from: string; to: string };
  components: { added: ComponentRef[]; removed: ComponentRef[]; changed: ComponentChange[] };
  rules: { added: RuleRef[]; removed: RuleRef[]; changed: RuleChange[] };
  content: { added: NamedRef[]; removed: NamedRef[]; changed: TextChange[]; renamed: Array<{ partId: string; from: string; to: string }> };
  customFields: { added: NamedRef[]; removed: NamedRef[]; changed: NamedChange[] };
  styles: { added: NamedRef[]; removed: NamedRef[]; changed: NamedChange[] };
  brand: { changed: ValueChange[] };
  testCases: { added: NamedRef[]; removed: NamedRef[]; changed: NamedChange[] };
  journey: { added: NamedRef[]; removed: NamedRef[]; changed: NamedChange[] };
  profiles: { changed: NamedChange[] };
  /** Other top-level keys (issuer, rootNodeId, documentType…) that differ. */
  other: string[];
  summary: { counts: Record<'title' | 'components' | 'rules' | 'content' | 'customFields' | 'styles' | 'brand' | 'testCases' | 'journey' | 'profiles' | 'other', number>; total: number; identical: boolean };
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const clip = (s: string, n = 240) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Technical one-line form of a predicate (field paths and operators), mirroring the resolver trace wording. */
export function predicateText(p: Predicate | undefined): string {
  if (!p) return 'always';
  switch (p.op) {
    case 'and': return p.args.map(predicateText).join(' AND ');
    case 'or': return `(${p.args.map(predicateText).join(' OR ')})`;
    case 'not': return `NOT (${predicateText(p.arg)})`;
    case 'isNull': return `${p.path} is empty`;
    case 'notNull': return `${p.path} is present`;
    case 'in': return `${p.path} in [${p.value.map((v) => JSON.stringify(v)).join(', ')}]`;
    default: {
      const sym: Record<string, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };
      return `${p.path} ${sym[p.op]} ${JSON.stringify(p.value)}`;
    }
  }
}

export function actionText(a: RuleAction): string {
  switch (a.op) {
    case 'selectVariant': return `selectVariant ${a.targetNodeId} → ${a.variantId}`;
    case 'showSection': return `showSection ${a.targetNodeId}`;
    case 'requireNodes': return `requireNodes ${a.nodeIds.join(', ')}`;
    case 'setApprovedLocale': return `setApprovedLocale ${a.locale}`;
    case 'setPresentationHint': return `setPresentationHint ${a.hint}`;
  }
}

/** Compact readable layout: "flow · 100% wide" / "fixed · x 36 y 72 · 540×40 pt · first page". */
export function layoutText(l: NodeLayout | undefined): string {
  if (!l) return 'default';
  const parts: string[] = [];
  const p = l.paged;
  if (p) {
    if (p.mode === 'fixed') {
      parts.push(`fixed at x ${p.xPt ?? 0} y ${p.yPt ?? 0}`);
      if (p.wPt !== undefined || p.hPt !== undefined) parts.push(`${p.wPt ?? 'auto'}×${p.hPt ?? 'auto'} pt`);
      if (p.pages) parts.push(p.pages === 'first' ? 'first page' : p.pages === 'all' ? 'every page' : 'following pages');
    } else {
      parts.push('in the flow');
      if (p.widthPct !== undefined) parts.push(`${p.widthPct}% wide`);
      if (p.align) parts.push(`${p.align}-aligned`);
      if (p.spaceBeforePt) parts.push(`${p.spaceBeforePt} pt space before`);
      if (p.keepWithNext) parts.push('kept with next');
      if (p.direction === 'row') parts.push('children in a row');
    }
  }
  const h = l.html;
  if (h) {
    const hp: string[] = [];
    if (h.area) hp.push(h.area);
    if (h.span) hp.push(`${h.span}/12 columns`);
    if (h.order !== undefined) hp.push(`order ${h.order}`);
    if (h.hidden) hp.push('hidden');
    if (hp.length) parts.push(`web: ${hp.join(', ')}`);
  }
  return parts.join(' · ') || 'default';
}

function nodeText(n: DocNode): string | null {
  if (n.content) return richToPlain(n.content);
  if (n.headerFooter) return n.headerFooter.text;
  if (n.explanation) return `${n.explanation.title}: ${n.explanation.summary}`;
  if (n.action) return n.action.label;
  if (n.qr) return n.qr.caption;
  return null;
}

const nodeName = (n: DocNode) => n.name ?? n.label ?? n.id;
const nodeRef = (n: DocNode): ComponentRef => ({ id: n.id, type: n.type, name: nodeName(n) });
const scalarText = (v: unknown): string | null => (v === undefined || v === null ? null : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : clip(canonicalJson(v), 160));

function diffNode(a: DocNode, b: DocNode): ComponentChange | null {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'id').sort();
  const fields = keys.filter((k) => !same((a as any)[k], (b as any)[k]));
  if (!fields.length) return null;
  const changes: ValueChange[] = [];
  for (const f of fields) {
    if (f === 'layout') changes.push({ field: 'layout', from: layoutText(a.layout), to: layoutText(b.layout) });
    else if (f === 'content' || f === 'headerFooter' || f === 'explanation' || f === 'action' || f === 'qr') {
      const from = nodeText(a), to = nodeText(b);
      if (from !== to) changes.push({ field: 'text', from: from === null ? null : clip(from), to: to === null ? null : clip(to) });
      else changes.push({ field: f, from: scalarText((a as any)[f]), to: scalarText((b as any)[f]) });
    } else if (f === 'visibleWhen') changes.push({ field: f, from: a.visibleWhen ? predicateText(a.visibleWhen) : null, to: b.visibleWhen ? predicateText(b.visibleWhen) : null });
    else if (f === 'children' || f === 'variantIds') {
      const ai = (a as any)[f] as string[] | undefined ?? [], bi = (b as any)[f] as string[] | undefined ?? [];
      const added = bi.filter((x) => !ai.includes(x)), removed = ai.filter((x) => !bi.includes(x));
      const note = [added.length ? `added ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : '', !added.length && !removed.length ? 'order changed' : ''].filter(Boolean).join('; ');
      changes.push({ field: f, from: ai.join(', ') || null, to: note ? `${bi.join(', ') || '(none)'} (${note})` : bi.join(', ') });
    } else changes.push({ field: f, from: scalarText((a as any)[f]), to: scalarText((b as any)[f]) });
  }
  return { ...nodeRef(b), fields, changes };
}

const ruleRef = (r: Rule): RuleRef => ({ id: r.id, title: r.title ?? null, priority: r.priority, enabled: r.enabled !== false, condition: predicateText(r.when), action: actionText(r.then), rule: r });

function diffRule(a: Rule, b: Rule): RuleChange | null {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'id').sort();
  const fields = keys.filter((k) => !same((a as any)[k], (b as any)[k]) && !(k === 'enabled' && (a.enabled !== false) === (b.enabled !== false)));
  if (!fields.length) return null;
  const c: RuleChange = { id: b.id, fields, before: a, after: b };
  if (fields.includes('title')) c.title = { from: a.title ?? null, to: b.title ?? null };
  if (fields.includes('priority')) c.priority = { from: a.priority, to: b.priority };
  if (fields.includes('enabled')) c.enabled = { from: a.enabled !== false, to: b.enabled !== false };
  if (fields.includes('when')) c.condition = { from: predicateText(a.when), to: predicateText(b.when) };
  if (fields.includes('then')) c.action = { from: actionText(a.then), to: actionText(b.then) };
  if (fields.includes('mode')) c.mode = { from: a.mode, to: b.mode };
  return c;
}

function byId<T>(list: T[] | undefined, key: (t: T) => string): Map<string, T> {
  return new Map((list ?? []).map((t) => [key(t), t]));
}

function diffNamed<T>(a: T[] | undefined, b: T[] | undefined, key: (t: T) => string, name: (t: T) => string) {
  const A = byId(a, key), B = byId(b, key);
  const added: NamedRef[] = [], removed: NamedRef[] = [], changed: NamedChange[] = [];
  for (const [id, t] of B) if (!A.has(id)) added.push({ id, name: name(t) });
  for (const [id, t] of A) if (!B.has(id)) removed.push({ id, name: name(t) });
  for (const [id, tb] of B) {
    const ta = A.get(id);
    if (!ta || same(ta, tb)) continue;
    const fields = [...new Set([...Object.keys(ta as object), ...Object.keys(tb as object)])].filter((k) => !same((ta as any)[k], (tb as any)[k])).sort();
    changed.push({ id, name: name(tb), fields });
  }
  return { added, removed, changed };
}

function diffContent(a: ContentPart[], b: ContentPart[]): ProjectDiff['content'] {
  const A = byId(a, (c) => c.id), B = byId(b, (c) => c.id);
  const out: ProjectDiff['content'] = { added: [], removed: [], changed: [], renamed: [] };
  for (const [id, c] of B) if (!A.has(id)) out.added.push({ id, name: c.title });
  for (const [id, c] of A) if (!B.has(id)) out.removed.push({ id, name: c.title });
  for (const [id, cb] of B) {
    const ca = A.get(id);
    if (!ca) continue;
    if (ca.title !== cb.title) out.renamed.push({ partId: id, from: ca.title, to: cb.title });
    for (const kind of ['approved', 'draft'] as const) {
      const la = (kind === 'approved' ? ca.approvedLocales : ca.draftLocales) ?? {};
      const lb = (kind === 'approved' ? cb.approvedLocales : cb.draftLocales) ?? {};
      for (const loc of [...new Set([...Object.keys(la), ...Object.keys(lb)])].sort()) {
        const from = (la as Record<string, string | undefined>)[loc] ?? null, to = (lb as Record<string, string | undefined>)[loc] ?? null;
        if (from !== to) out.changed.push({ partId: id, title: cb.title, locale: loc, kind, from: from === null ? null : clip(from), to: to === null ? null : clip(to) });
      }
    }
  }
  return out;
}

function diffBrand(a: BrandKit | undefined, b: BrandKit | undefined): ValueChange[] {
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort();
  return keys.filter((k) => !same((a as any)?.[k], (b as any)?.[k])).map((k) => k === 'logoDataUri'
    ? { field: k, from: (a as any)?.[k] ? 'logo image' : null, to: (b as any)?.[k] ? ((a as any)?.[k] ? 'a different logo image' : 'logo image') : null }
    : { field: k, from: scalarText((a as any)?.[k]), to: scalarText((b as any)?.[k]) });
}

const KNOWN = new Set(['schemaVersion', 'projectId', 'title', 'modelVersion', 'lastSavedAt', 'nodes', 'rules', 'contentParts', 'customFields', 'styles', 'brand', 'testCases', 'journey', 'presentationProfiles', 'derivedFrom', 'fromTemplate', 'importedFrom']);

/** Structural diff from `a` (older) to `b` (newer). Ignores modelVersion and save timestamps. */
export function diffProjects(a: Project, b: Project): ProjectDiff {
  const NA = byId(a.nodes, (n) => n.id), NB = byId(b.nodes, (n) => n.id);
  const components: ProjectDiff['components'] = { added: [], removed: [], changed: [] };
  for (const n of b.nodes) if (!NA.has(n.id)) components.added.push(nodeRef(n));
  for (const n of a.nodes) if (!NB.has(n.id)) components.removed.push(nodeRef(n));
  for (const n of b.nodes) { const o = NA.get(n.id); if (o) { const c = diffNode(o, n); if (c) components.changed.push(c); } }

  const RA = byId(a.rules, (r) => r.id), RB = byId(b.rules, (r) => r.id);
  const rules: ProjectDiff['rules'] = { added: [], removed: [], changed: [] };
  for (const r of b.rules) if (!RA.has(r.id)) rules.added.push(ruleRef(r));
  for (const r of a.rules) if (!RB.has(r.id)) rules.removed.push(ruleRef(r));
  for (const r of b.rules) { const o = RA.get(r.id); if (o) { const c = diffRule(o, r); if (c) rules.changed.push(c); } }

  const content = diffContent(a.contentParts, b.contentParts);
  const customFields = diffNamed<CustomField>(a.customFields, b.customFields, (f) => f.key, (f) => f.label);
  const styles = diffNamed<TextStyle>(a.styles, b.styles, (s) => s.id, (s) => s.name);
  const testCases = diffNamed<TestCase>(a.testCases, b.testCases, (t) => t.id, (t) => t.name);
  const journey = diffNamed<JourneyEvent>(a.journey?.events, b.journey?.events, (e) => e.eventId, (e) => e.label ?? e.eventType);
  if (a.journey?.snapshotPolicy !== b.journey?.snapshotPolicy) journey.changed.push({ id: 'snapshotPolicy', name: 'Snapshot policy', fields: ['snapshotPolicy'] });
  const profiles = { changed: diffNamed<PresentationProfile>(a.presentationProfiles, b.presentationProfiles, (p) => p.id, (p) => p.id).changed };
  const brand = { changed: diffBrand(a.brand, b.brand) };
  const other = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !KNOWN.has(k) && !same((a as any)[k], (b as any)[k])).sort();
  if (a.schemaVersion !== b.schemaVersion) other.unshift('schemaVersion');

  const n3 = (x: { added: unknown[]; removed: unknown[]; changed: unknown[] }) => x.added.length + x.removed.length + x.changed.length;
  const counts = {
    title: a.title !== b.title ? 1 : 0,
    components: n3(components),
    rules: n3(rules),
    content: content.added.length + content.removed.length + content.changed.length + content.renamed.length,
    customFields: n3(customFields),
    styles: n3(styles),
    brand: brand.changed.length,
    testCases: n3(testCases),
    journey: n3(journey),
    profiles: profiles.changed.length,
    other: other.length,
  };
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return {
    ...(a.title !== b.title ? { title: { from: a.title, to: b.title } } : {}),
    components, rules, content, customFields, styles, brand, testCases, journey, profiles, other,
    summary: { counts, total, identical: total === 0 },
  };
}
