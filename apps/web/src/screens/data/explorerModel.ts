import { customFieldDefs, projectFieldIndex, projectFields, validateRecordShape, type FieldDef, type FieldType, type Project, type SyntheticRecord } from '@iss/model';

/* Pure helpers for the Data Explorer: where a customer comes from, the tree of fields, typed values, problems. */

/** Fields the studio owns; they are never edited here and never sent on save (the server ignores them too). */
export const BOOKKEEPING = ['recordId', 'documentType', 'projectId', 'generated', 'imported', 'sourceId', 'personaId', 'demonstrationOnly'] as const;

export type Origin = 'yours' | 'generated' | 'imported' | 'sample';
export const ORIGIN_LABEL: Record<Origin, string> = { yours: 'Yours', generated: 'Generated', imported: 'Imported', sample: 'Sample' };
export const ORIGIN_GROUP: Record<Origin, string> = { yours: 'Yours', generated: 'Generated for this document', imported: 'Imported', sample: 'Samples' };
export const ORIGINS: Origin[] = ['yours', 'generated', 'imported', 'sample'];

export function originOf(r: SyntheticRecord): Origin {
  if (r.generated) return 'generated';
  if (r.imported) return 'imported';
  if (r.projectId) return 'yours';
  return 'sample';
}
/** Only the document's own customers (yours and generated) can be changed or removed. */
export const isOwn = (o: Origin) => o === 'yours' || o === 'generated';

export const recordName = (r: { customer?: Record<string, unknown> } | null | undefined) => {
  const c = r?.customer ?? {};
  return `${String(c.givenName ?? '').trim()} ${String(c.familyName ?? '').trim()}`.trim() || 'Unnamed customer';
};

/* ------------------------------------------------------------------ values and paths */

export type Seg = string | number;
export type Rec = Record<string, any>;

export function getIn(obj: unknown, segs: Seg[]): any {
  let v: any = obj;
  for (const s of segs) { if (v === null || v === undefined || typeof v !== 'object') return undefined; v = v[s as any]; }
  return v;
}

/** Immutable update along a path. `undefined` removes the key. */
export function setIn<T>(obj: T, segs: Seg[], value: unknown): T {
  if (!segs.length) return value as T;
  const [head, ...rest] = segs;
  const base: any = obj !== null && typeof obj === 'object' ? obj : typeof head === 'number' ? [] : {};
  if (Array.isArray(base)) {
    const copy = base.slice();
    copy[head as number] = rest.length ? setIn(copy[head as number], rest, value) : value;
    return copy as unknown as T;
  }
  const copy: any = { ...base };
  if (!rest.length && value === undefined) delete copy[head];
  else copy[head] = rest.length ? setIn(copy[head], rest, value) : value;
  return copy;
}

export const segsOf = (path: string): string[] => path.split('.');

export function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1))) : val));
}

/** The editable part of a customer: everything except the studio's bookkeeping. */
export function editablePart(r: SyntheticRecord | Rec): Rec {
  const out: Rec = { ...r };
  for (const k of BOOKKEEPING) delete out[k];
  return out;
}
export const bookkeepingOf = (r: SyntheticRecord | Rec): Rec => Object.fromEntries(BOOKKEEPING.filter((k) => (r as Rec)[k] !== undefined).map((k) => [k, (r as Rec)[k]]));

export const humanise = (s: string) => { const t = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim().toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
export const enumLabel = (v: string) => (/^[a-z]{2,3}-[A-Z]{2}$/.test(v) || /^[A-Z0-9 ]+$/.test(v) ? v : humanise(v));

/** Whole cents <-> the text a person types (dollars with two decimals). Integer arithmetic only. */
export function centsToText(c: number): string {
  const neg = c < 0; const a = Math.abs(c);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
export const MONEY_TEXT = /^-?\d*(\.\d{0,2})?$/;
export function textToCents(t: string): number | undefined {
  const m = /^(-?)(\d*)(?:\.(\d{0,2}))?$/.exec(t.trim());
  if (!m || (m[2] === '' && !m[3])) return undefined;
  const whole = Number(m[2] || '0'); const frac = Number((m[3] ?? '').padEnd(2, '0') || '0');
  const c = whole * 100 + frac;
  return m[1] ? -c : c;
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ the tree of fields */

export interface RowField { key: string; type: FieldType; label: string; /** Longer name used when the field is shown on its own. */ fullLabel?: string; enumValues?: string[]; required?: boolean }
export interface FieldNode { kind: 'field'; def: FieldDef; segs: string[] }
export interface ListNode { kind: 'list'; def: FieldDef; segs: string[]; columns: RowField[]; rowFields: RowField[] }
export interface GroupNode { kind: 'group'; key: string; path: string; label: string; children: TreeNode[] }
export type TreeNode = FieldNode | ListNode | GroupNode;

const SECTION_LABEL: Record<string, string> = { customer: 'Customer', card: 'Card', member: 'Member', claims: 'Claims', custom: 'Your own data' };
const TABLE_COLUMNS = 4;

/** Fields of a list's rows. A claim's full set of fields is the project's `claim.*` definitions. */
function rowFieldsOf(def: FieldDef, all: FieldDef[]): RowField[] {
  const own = (def.itemFields ?? []).map((c) => ({ ...c } as RowField));
  if (def.path !== 'claims') return own;
  const claim = all.filter((f) => f.path.startsWith('claim.') && !f.derived);
  const rest = claim.map((f) => ({ key: f.path.slice(6), type: f.type, label: f.label, fullLabel: f.label, enumValues: f.enumValues, required: f.required }));
  // Table columns keep their own order; the claim's other fields follow.
  const byKey = new Map(rest.map((f) => [f.key, f]));
  return [...own.map((c) => ({ ...c, ...(byKey.get(c.key) ?? {}), label: c.label, fullLabel: byKey.get(c.key)?.label ?? c.label })), ...rest.filter((f) => !own.some((c) => c.key === f.key))];
}

export function buildSections(project: Pick<Project, 'documentType' | 'customFields'>): GroupNode[] {
  const all = projectFields(project);
  const index = new Map(all.map((f) => [f.path, f]));
  const sections: GroupNode[] = [];
  for (const def of all) {
    if (def.path === 'documentType' || def.path === 'recordId' || def.path.startsWith('claim.')) continue;
    if (def.derived && def.path.endsWith('.count') && index.get(def.path.slice(0, -6))?.type === 'array') continue;
    const segs = segsOf(def.path);
    let level = sections; let prefix = '';
    const top = segs[0];
    for (let i = 0; i < segs.length - 1; i++) {
      prefix = prefix ? `${prefix}.${segs[i]}` : segs[i];
      let g = level.find((x) => x.key === segs[i]) as GroupNode | undefined;
      if (!g) { g = { kind: 'group', key: segs[i], path: prefix, label: i === 0 ? SECTION_LABEL[segs[i]] ?? humanise(segs[i]) : humanise(segs[i]), children: [] }; level.push(g); }
      level = g.children as GroupNode[];
    }
    const leaf: TreeNode = def.type === 'array'
      ? { kind: 'list', def, segs, rowFields: rowFieldsOf(def, all), columns: [] }
      : { kind: 'field', def, segs };
    if (leaf.kind === 'list') leaf.columns = leaf.rowFields.slice(0, def.itemFields?.length ? Math.min(TABLE_COLUMNS, def.itemFields.length) : TABLE_COLUMNS);
    if (segs.length === 1) {
      // A list that is itself a top-level key (the claims of an explanation of benefits) gets a section of its own.
      sections.push({ kind: 'group', key: top, path: top, label: def.label, children: [leaf] });
    } else (level as TreeNode[]).push(leaf);
  }
  return sections;
}

export const underPath = (p: string, prefix: string) => p === prefix || p.startsWith(`${prefix}.`) || p.startsWith(`${prefix}[`);

export function countFields(n: TreeNode): number { return n.kind === 'group' ? n.children.reduce((s, c) => s + countFields(c), 0) : 1; }

/* ------------------------------------------------------------------ problems */

export interface Problem { path: string | null; message: string }

/** Each problem with the field it is about, in plain words (the same wording the server gives). */
export function problemsFor(record: unknown, project: Project): Problem[] {
  const fields = projectFieldIndex(project);
  let messages: string[];
  try { messages = validateRecordShape(JSON.parse(JSON.stringify(record)), project.documentType, customFieldDefs(project.customFields)); } catch { return [{ path: null, message: 'This customer cannot be read.' }]; }
  const seen = new Set<string>();
  const out: Problem[] = [];
  for (const message of messages) {
    const row = /^([A-Za-z0-9_.]+)\[(\d+)\]\.([A-Za-z0-9_]+): (.*)$/.exec(message);
    let p: Problem;
    if (row) {
      const list = fields.get(row[1]); const col = list?.itemFields?.find((c) => c.key === row[3]);
      p = { path: `${row[1]}[${row[2]}].${row[3]}`, message: `${list?.label ?? row[1]}, row ${Number(row[2]) + 1}, ${col?.label ?? row[3]}: ${row[4]}` };
    } else {
      let path = /\(([A-Za-z0-9_.[\]]+)\)/.exec(message)?.[1] ?? null;
      // The validator checks a claim's own fields on the first claim only.
      if (path?.startsWith('claim.')) path = `claims[0].${path.slice(6)}`;
      p = { path, message };
    }
    const key = p.path ?? p.message;
    if (seen.has(key)) continue;
    seen.add(key); out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ blank records and rows */

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

function emptyValue(f: { path?: string; key?: string; type: FieldType; enumValues?: string[]; required?: boolean; label: string; example?: string }, name: string): unknown {
  const required = !!f.required;
  switch (f.type) {
    case 'string':
      if (name === 'customer.givenName') return 'New';
      if (name === 'customer.familyName') return 'Customer';
      return required ? f.example ?? 'To be filled in' : undefined;
    case 'cents': case 'int': case 'points': return 0;
    case 'bool': return false;
    case 'enum': return f.enumValues?.[0];
    case 'date': {
      if (!required) return undefined;
      if (/statementStart$/.test(name)) return addDays(-30);
      if (/dueDate$/.test(name)) return addDays(25);
      return addDays(0);
    }
    default: return undefined;
  }
}

/** A new customer built from the field definitions: valid, with sensible empty values. */
export function blankRecord(project: Pick<Project, 'documentType' | 'customFields'>): Rec {
  const all = projectFields(project);
  let rec: Rec = {};
  for (const f of all) {
    if (f.derived || f.path === 'documentType' || f.path === 'recordId' || f.path.startsWith('claim.')) continue;
    if (f.type === 'array') { if (f.path !== 'claims') rec = setIn(rec, segsOf(f.path), []); continue; }
    const v = emptyValue(f, f.path);
    if (v !== undefined) rec = setIn(rec, segsOf(f.path), v);
  }
  if (project.documentType === 'eob') {
    let claim: Rec = {};
    for (const f of all.filter((x) => x.path.startsWith('claim.') && !x.derived)) { const v = emptyValue({ ...f, required: f.required }, f.path); if (v !== undefined) claim = { ...claim, [f.path.slice(6)]: v }; }
    rec.claims = [claim];
  }
  return rec;
}

/** A new, empty row for a list. Text stays empty, amounts and numbers start at zero; dates and choices are left unset. */
export function blankRow(fields: RowField[]): Rec {
  const row: Rec = {};
  for (const f of fields) {
    if (f.type === 'string') row[f.key] = '';
    else if (f.type === 'cents' || f.type === 'int' || f.type === 'points') row[f.key] = 0;
    else if (f.type === 'bool') row[f.key] = false;
  }
  return row;
}

/* ------------------------------------------------------------------ values the contract does not know */

export interface OtherValue { path: string; value: unknown }

export function otherValues(record: Rec, project: Pick<Project, 'documentType' | 'customFields'>): OtherValue[] {
  const all = projectFields(project);
  const known = new Set(all.filter((f) => !f.path.startsWith('claim.') && f.path !== 'documentType' && f.path !== 'recordId').map((f) => f.path));
  const isPrefix = (p: string) => [...known].some((k) => k.startsWith(`${p}.`));
  const out: OtherValue[] = [];
  const walk = (obj: Rec, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!prefix && (BOOKKEEPING as readonly string[]).includes(k)) continue;
      if (known.has(p)) continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && isPrefix(p)) { walk(v, p); continue; }
      out.push({ path: p, value: v });
    }
  };
  walk(record, '');
  // A list row may carry values its columns do not describe.
  for (const f of all.filter((x) => x.type === 'array')) {
    const rows = getIn(record, segsOf(f.path));
    if (!Array.isArray(rows)) continue;
    const keys = new Set(rowFieldsOf(f, all).map((c) => c.key));
    rows.forEach((row, i) => { if (row && typeof row === 'object') for (const [k, v] of Object.entries(row)) if (!keys.has(k)) out.push({ path: `${f.path}[${i}].${k}`, value: v }); });
  }
  return out;
}

/** In Business view the field's path is left out of a problem ("Payment due date (card.dueDate): …" becomes "Payment due date: …"). */
export const plainProblem = (message: string, technical: boolean) => (technical ? message : message.replace(/ \([A-Za-z0-9_.[\]]+\)(?=:)/, ''));
