import { customFieldDefs, isIsoDay, validateRecordShape, type DocumentType, type FieldDef, type Project, type SyntheticRecord } from '@iss/model';

/**
 * The data contract of a runnable package: what one input line must look like, and the check every line goes through
 * before the engine sees it. The check is the studio's own (`validateRecordShape`, the same one that guards imported
 * customers), so a line the package accepts is a line the studio would accept.
 *
 * Messages never carry a customer's values: only field paths and what was expected.
 */

/** Most bytes one input line may have (a customer with a long list of transactions is well under this). */
export const MAX_LINE_BYTES = 2 * 1024 * 1024;
/** Most characters of a customer reference. */
export const MAX_REF_LENGTH = 200;

/** One field of `data/dictionary.json` in the release package, as far as the contract needs it. */
export interface DictionaryField {
  path: string; label: string; type: FieldDef['type']; required: boolean; calculated: boolean;
  allowedValues?: string[]; columns?: Array<{ key: string; label: string; type: FieldDef['type'] }>; example?: unknown;
}
export interface Dictionary { documentKind: DocumentType; fields: DictionaryField[] }

const SCALAR_SCHEMA: Record<string, Record<string, unknown>> = {
  string: { type: 'string' },
  cents: { type: 'integer', description: 'Whole number of cents (never a decimal amount).' },
  int: { type: 'integer' },
  points: { type: 'integer' },
  bool: { type: 'boolean' },
  date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'ISO 8601 date, YYYY-MM-DD.' },
  enum: { type: 'string' },
  number: { type: 'number' },
};

type Schema = Record<string, any>;
const objectSchema = (): Schema => ({ type: 'object', properties: {}, required: [] as string[], additionalProperties: true });

/**
 * `contract/input.schema.json`: a JSON Schema (draft 2020-12) of one customer record, generated from the release's data
 * dictionary. Calculated fields are left out (the engine works them out). For a document about one claim of a list
 * (`claim.*`), the claim's fields are columns of `claims`.
 */
export function inputSchemaFromDictionary(dict: Dictionary, about: { releaseId: string; title: string; languages: string[] }): Schema {
  const root = objectSchema();
  const at = (parent: Schema, key: string): Schema => {
    parent.properties[key] ??= objectSchema();
    return parent.properties[key];
  };
  const setLeaf = (path: string[], leaf: Schema, required: boolean) => {
    let node = root;
    for (let i = 0; i < path.length - 1; i++) {
      if (required && !node.required.includes(path[i])) node.required.push(path[i]);
      node = at(node, path[i]);
    }
    const key = path[path.length - 1];
    node.properties[key] = leaf;
    if (required && !node.required.includes(key)) node.required.push(key);
  };
  const scalar = (f: { type: string; label: string; allowedValues?: string[] }): Schema => ({
    ...SCALAR_SCHEMA[f.type] ?? {}, title: f.label, ...(f.allowedValues?.length ? { enum: f.allowedValues } : {}),
  });
  const claimColumns: Record<string, Schema> = {};
  for (const f of dict.fields) {
    if (f.calculated) continue;
    if (f.path === 'recordId') { setLeaf(['recordId'], { type: 'string', minLength: 1, maxLength: MAX_REF_LENGTH, title: f.label, description: 'Your identifier for this record. It is part of the run ID, and the default customer reference.' }, true); continue; }
    if (f.path === 'documentType') { setLeaf(['documentType'], { const: dict.documentKind, title: f.label, description: 'Optional: the engine sets it.' }, false); continue; }
    if (f.path === 'customer.locale') {
      setLeaf(['customer', 'locale'], { type: 'string', title: f.label, description: `A language code such as en-US. This release has approved wording in: ${about.languages.join(', ')}. Other languages are shown in English, or stopped when a required text has no approved translation.` }, true);
      continue;
    }
    if (dict.documentKind === 'eob' && f.path.startsWith('claim.')) { claimColumns[f.path.slice(6)] = scalar(f); continue; }
    if (f.type === 'array') {
      const items = objectSchema();
      for (const c of f.columns ?? []) items.properties[c.key] = scalar(c);
      setLeaf(f.path.split('.'), { type: 'array', title: f.label, items }, f.required);
      continue;
    }
    setLeaf(f.path.split('.'), scalar(f), f.required);
  }
  if (Object.keys(claimColumns).length) {
    const claims = root.properties.claims ?? { type: 'array', title: 'Claims', items: objectSchema() };
    claims.minItems = 1;
    claims.description = 'The first claim is the one the document is about.';
    Object.assign(claims.items.properties, claimColumns);
    root.properties.claims = claims;
    if (!root.required.includes('claims')) root.required.push('claims');
  }
  const prune = (s: Schema) => { if (s.type === 'object') { if (!s.required.length) delete s.required; (Object.values(s.properties) as Schema[]).forEach(prune); } if (s.items) prune(s.items); };
  prune(root);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:iss:runtime:${about.releaseId}:input`,
    title: `One customer for ${about.title}`,
    description: 'One line of the input file (JSON Lines) is either this record, or { "customerRef": "<your reference>", "data": <this record> }. Generated from data/dictionary.json of the release. The engine checks every line with the same rules the studio uses for imported customers; this schema describes those rules for your own tools.',
    ...root,
  };
}

/** Plain-words problems of one record, without its values. */
export function recordProblems(raw: unknown, project: Pick<Project, 'documentType' | 'customFields'>): string[] {
  const extra: FieldDef[] = customFieldDefs(project.customFields);
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['The line is not a JSON object.'];
  const r = raw as Record<string, unknown>;
  if (typeof r.recordId !== 'string' || !r.recordId.trim()) problems.push('recordId is missing: every record needs an identifier.');
  else if (r.recordId.length > MAX_REF_LENGTH) problems.push(`recordId is longer than ${MAX_REF_LENGTH} characters.`);
  if (r.documentType !== undefined && r.documentType !== project.documentType) problems.push(`documentType does not match this release (it must be ${project.documentType} or left out).`);
  for (const e of validateRecordShape(raw, project.documentType, extra)) problems.push(withoutValues(e));
  return [...new Set(problems)];
}

/** Takes the customer's value out of one of the studio's validation messages (they quote it to help a person editing one record). */
export function withoutValues(message: string): string {
  return message
    .replace(/, got .*$/s, '.')
    .replace(/: “[^”]*” is not one of .*$/s, ': not one of the allowed values.')
    .replace(/\.\.$/, '.');
}

export interface ParsedLine {
  ok: true; customerRef: string; record: SyntheticRecord;
  /** The document's date given with this customer (`"issueDate"` next to `"data"`), or null. */
  issueDate: string | null;
}
export interface RejectedLine { ok: false; customerRef: string | null; problems: string[] }

/**
 * One input line: a record, or `{ "customerRef": "...", "data": <record> }`. The reference defaults to the record id.
 * Returns the record exactly as supplied, with `documentType` set to the release's kind.
 */
export function parseInput(value: unknown, project: Pick<Project, 'documentType' | 'customFields'>): ParsedLine | RejectedLine {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, customerRef: null, problems: ['The line is not a JSON object.'] };
  const v = value as Record<string, unknown>;
  const enveloped = 'data' in v && !('customer' in v);
  const data = enveloped ? v.data : v;
  let customerRef: string | null = null;
  let issueDate: string | null = null;
  const problems: string[] = [];
  if (enveloped) {
    const extraKeys = Object.keys(v).filter((k) => k !== 'data' && k !== 'customerRef' && k !== 'issueDate');
    if (extraKeys.length) problems.push(`Unknown keys next to "data": ${extraKeys.slice(0, 5).join(', ')}. Only "customerRef", "issueDate" and "data" are allowed.`);
    if (v.issueDate !== undefined && v.issueDate !== null) {
      if (!isIsoDay(v.issueDate)) problems.push('issueDate must be a date written as YYYY-MM-DD.');
      else issueDate = v.issueDate;
    }
    if (v.customerRef !== undefined) {
      if (typeof v.customerRef !== 'string' || !v.customerRef.trim()) problems.push('customerRef must be non-empty text.');
      else if (v.customerRef.length > MAX_REF_LENGTH) problems.push(`customerRef is longer than ${MAX_REF_LENGTH} characters.`);
      else customerRef = v.customerRef;
    }
  }
  const rec = data as Record<string, unknown> | null;
  if (customerRef === null && rec && typeof rec === 'object' && typeof rec.recordId === 'string' && rec.recordId.trim() && rec.recordId.length <= MAX_REF_LENGTH) customerRef = rec.recordId;
  problems.push(...recordProblems(data, project));
  if (problems.length) return { ok: false, customerRef, problems };
  const record = { ...(data as Record<string, unknown>), documentType: project.documentType } as unknown as SyntheticRecord;
  if (project.documentType === 'credit-statement' && record.card && !Array.isArray(record.card.transactions)) record.card = { ...record.card, transactions: [] };
  return { ok: true, customerRef: customerRef!, record, issueDate };
}

/** Parses one text line of a JSON Lines file. Never echoes the text. */
export function parseInputLine(text: string, project: Pick<Project, 'documentType' | 'customFields'>): ParsedLine | RejectedLine {
  if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) return { ok: false, customerRef: null, problems: [`The line is longer than ${MAX_LINE_BYTES} bytes.`] };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, customerRef: null, problems: ['The line is not valid JSON.'] }; }
  return parseInput(value, project);
}
