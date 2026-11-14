import { digestOf, type Project, type SyntheticRecord } from '@iss/model';
import { resolve, type RNode, type Resolution } from '@iss/resolver';

/**
 * Impact of a model change: resolves every record with the current ("before") and proposed ("after") model
 * (default profile, no overrides, baseline journey) and reports exactly what differs. Pure and deterministic.
 */

export type ImpactChangeKind = 'variant' | 'section' | 'locale' | 'blocking';

export interface ImpactChange {
  kind: ImpactChangeKind;
  /** Node the change happens on ('' for locale or node-less findings). */
  nodeId: string;
  /** Variant id(s) / 'shown' | 'hidden' / locale / finding code ('' = none). */
  before: string;
  after: string;
}

export interface ImpactRecord { recordId: string; name: string; changes: ImpactChange[] }

export interface Impact {
  evaluated: number;
  changed: ImpactRecord[];
  /** Blocking findings present after the change but not before (counted across all records). */
  newBlocking: number;
  /** Blocking findings present before the change and gone after it. */
  resolvedBlocking: number;
}

interface Summary {
  variants: Map<string, string>;
  visible: Map<string, boolean>;
  locale: string;
  blocking: Map<string, string>; // key code@nodeId -> code
}

function summarise(res: Resolution): Summary {
  const variants = new Map<string, string>();
  const visible = new Map<string, boolean>();
  const walk = (n: RNode) => {
    if (n.variants) variants.set(n.id, n.variants.unresolved && !n.variants.selected.length ? '' : [...n.variants.selected].sort().join(', '));
    else visible.set(n.id, n.visible);
    for (const c of n.children) walk(c);
  };
  walk(res.root);
  const blocking = new Map<string, string>();
  for (const f of res.findings) if (f.severity === 'blocking') blocking.set(`${f.code}@${f.nodeId ?? ''}`, f.code);
  return { variants, visible, locale: res.locale, blocking };
}

function summariseAll(project: Project, records: SyntheticRecord[], issueDate: string | null): Summary[] {
  return records.map((record) => summarise(resolve({ project, record, overrides: {}, journeyCursor: null, ...(issueDate ? { issueDate } : {}) })));
}

const recordsIds = new WeakMap<SyntheticRecord[], number>();
let nextRecordsId = 1;
const recordsKey = (r: SyntheticRecord[]) => {
  let id = recordsIds.get(r);
  if (!id) { id = nextRecordsId++; recordsIds.set(r, id); }
  return `${id}:${r.length}`;
};

const filtered = new WeakMap<SyntheticRecord[], Map<string, SyntheticRecord[]>>();
/** Records of the project's document type (stable identity per input array so caches hit). */
function filterRecords(p: Project, all: SyntheticRecord[]): SyntheticRecord[] {
  let m = filtered.get(all);
  if (!m) { m = new Map(); filtered.set(all, m); }
  let r = m.get(p.documentType);
  if (!r) { r = all.filter((x) => x.documentType === p.documentType); m.set(p.documentType, r); }
  return r;
}

const beforeCache = new Map<string, Summary[]>();
const impactCache = new Map<string, Impact>();
const LIMIT = 12;
const remember = <V,>(m: Map<string, V>, k: string, v: V) => { m.set(k, v); if (m.size > LIMIT) m.delete(m.keys().next().value as string); return v; };

/** `issueDate`: both versions "as issued on" that day (ignored by documents without a date source). */
export function impactOf(before: Project, after: Project, allRecords: SyntheticRecord[], issueDate: string | null = null): Impact {
  const records = filterRecords(after, allRecords);
  const rk = issueDate ? `${recordsKey(records)}@${issueDate}` : recordsKey(records);
  const bd = digestOf(before);
  const ad = digestOf(after);
  const key = `${bd}|${ad}|${rk}`;
  const hit = impactCache.get(key);
  if (hit) return hit;
  if (bd === ad) return remember(impactCache, key, { evaluated: records.length, changed: [], newBlocking: 0, resolvedBlocking: 0 });

  const bKey = `${bd}|${rk}`;
  const bs = beforeCache.get(bKey) ?? remember(beforeCache, bKey, summariseAll(before, records, issueDate));
  const as = summariseAll(after, records, issueDate);

  const changed: ImpactRecord[] = [];
  let newBlocking = 0, resolvedBlocking = 0;
  records.forEach((rec, i) => {
    const b = bs[i], a = as[i];
    const changes: ImpactChange[] = [];
    for (const id of new Set([...b.variants.keys(), ...a.variants.keys()])) {
      const x = b.variants.get(id) ?? '', y = a.variants.get(id) ?? '';
      if (x !== y) changes.push({ kind: 'variant', nodeId: id, before: x, after: y });
    }
    for (const id of new Set([...b.visible.keys(), ...a.visible.keys()])) {
      const x = b.visible.get(id), y = a.visible.get(id);
      if (x !== y) changes.push({ kind: 'section', nodeId: id, before: x ? 'shown' : 'hidden', after: y ? 'shown' : 'hidden' });
    }
    if (b.locale !== a.locale) changes.push({ kind: 'locale', nodeId: '', before: b.locale, after: a.locale });
    for (const [k, code] of a.blocking) if (!b.blocking.has(k)) { newBlocking++; changes.push({ kind: 'blocking', nodeId: k.slice(code.length + 1), before: '', after: code }); }
    for (const [k, code] of b.blocking) if (!a.blocking.has(k)) { resolvedBlocking++; changes.push({ kind: 'blocking', nodeId: k.slice(code.length + 1), before: code, after: '' }); }
    if (changes.length) changed.push({ recordId: rec.recordId, name: `${rec.customer.givenName} ${rec.customer.familyName}`.trim(), changes });
  });
  return remember(impactCache, key, { evaluated: records.length, changed, newBlocking, resolvedBlocking });
}
