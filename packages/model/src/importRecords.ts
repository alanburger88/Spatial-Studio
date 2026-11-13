import { fieldsFor, type FieldDef, type FieldType } from './fields';

/** Standard contract for the document type plus any extra (custom) fields of the target project. */
const contract = (documentType: DocumentType, extra: FieldDef[] = []) => [...fieldsFor(documentType), ...extra];
import { buildContext, getPath } from './data';
import { isSupportedLanguage } from './languages';
import type { DocumentType, SyntheticRecord } from './types';

/**
 * Validation for user-imported scenario records (JSON or CSV). Imported data is checked against the same typed
 * data contract (fields.ts) the rules and bindings use; nothing is accepted that the engine could not evaluate.
 * Records are re-identified (CARD-5xxx / EOB-5xxx) so they can never collide with or masquerade as the seeded fixtures.
 */

export const IMPORT_LIMIT = 500;
export const IMPORT_ID_BASE = 5001;
/** Most rows one list field of a record may carry. */
export const LIST_ROW_LIMIT = 500;
/** Record id prefix per kind of document (CARD-0001, EOB-5003, REC-60012). */
export const RECORD_ID_PREFIX: Record<DocumentType, string> = { 'credit-statement': 'CARD', eob: 'EOB', custom: 'REC' };

export interface ImportRowResult { row: number; sourceId: string | null; errors: string[]; record?: SyntheticRecord }

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkType(f: Pick<FieldDef, 'type' | 'enumValues' | 'label'>, v: unknown, where: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  const t: FieldType = f.type;
  if ((t === 'cents' || t === 'int' || t === 'points') && !Number.isInteger(v)) return `${where}: expected a whole number${t === 'cents' ? ' of cents' : ''}, got ${JSON.stringify(v)}.`;
  if (t === 'bool' && typeof v !== 'boolean') return `${where}: expected true/false, got ${JSON.stringify(v)}.`;
  if (t === 'date' && (typeof v !== 'string' || !DATE.test(v))) return `${where}: expected a date YYYY-MM-DD, got ${JSON.stringify(v)}.`;
  if (t === 'string' && typeof v !== 'string') return `${where}: expected text, got ${JSON.stringify(v)}.`;
  if (t === 'enum' && f.enumValues && !f.enumValues.includes(String(v))) return `${where}: “${String(v)}” is not one of ${f.enumValues.join(', ')}.`;
  return null;
}

/** Validate one record object against the data contract. Returns human-readable errors (empty = valid). */
export function validateRecordShape(raw: unknown, documentType: DocumentType, extra: FieldDef[] = []): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['Record must be an object.'];
  const r = raw as Record<string, any>;
  if (!r.customer || typeof r.customer !== 'object') errors.push('Missing customer object (customer.givenName, customer.familyName, customer.locale).');
  if (documentType === 'credit-statement' && (!r.card || typeof r.card !== 'object')) errors.push('Missing card object.');
  if (documentType === 'eob' && (!Array.isArray(r.claims) || !r.claims.length)) errors.push('Missing claims array (at least one claim).');
  if (errors.length) return errors;
  const rec = { ...r, documentType, recordId: 'IMPORT-CHECK' } as SyntheticRecord;
  if (documentType === 'credit-statement' && !Array.isArray(rec.card!.transactions)) rec.card!.transactions = [];
  const ctx = buildContext(rec);
  for (const f of contract(documentType, extra)) {
    if (f.derived || f.path === 'recordId' || f.path === 'documentType') continue;
    const v = getPath(ctx, f.path);
    if (f.type === 'array') {
      if (v === null) { if (f.required && f.path.startsWith('custom.')) errors.push(`Missing required list ${f.label} (${f.path}).`); continue; }
      if (!Array.isArray(v)) { errors.push(`${f.label} (${f.path}) must be a list.`); continue; }
      // A project's own list holds plain rows of its columns; the built-in lists keep their looser historical check.
      const own = f.path.startsWith('custom.');
      if (own && v.length > LIST_ROW_LIMIT) { errors.push(`${f.label} (${f.path}) has ${v.length} rows; a list can have at most ${LIST_ROW_LIMIT}.`); continue; }
      v.forEach((item: any, i: number) => {
        if (own && (!item || typeof item !== 'object' || Array.isArray(item))) { errors.push(`${f.label} (${f.path}): row ${i + 1} must be an object with the list's columns.`); return; }
        for (const it of f.itemFields ?? []) { const e = checkType({ ...it, enumValues: undefined }, item?.[it.key], `${f.path}[${i}].${it.key}`); if (e) errors.push(e); }
      });
      continue;
    }
    if (f.required && (v === null || v === '')) { errors.push(`Missing required field ${f.label} (${f.path}).`); continue; }
    // A customer may prefer any language the studio supports, not only the two the samples use.
    const asText = f.path === 'customer.locale' && typeof v === 'string' && isSupportedLanguage(v);
    const e = checkType(asText ? { ...f, type: 'string', enumValues: undefined } : f, v, `${f.label} (${f.path})`);
    if (e) errors.push(e);
  }
  return errors;
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

function coerce(type: FieldType | undefined, s: string): unknown {
  const v = s.trim();
  if (v === '') return undefined;
  if (type === 'cents' || type === 'int' || type === 'points') return /^-?\d+$/.test(v) ? Number(v) : v;
  if (type === 'bool') return /^(true|yes|y|1)$/i.test(v) ? true : /^(false|no|n|0)$/i.test(v) ? false : v;
  return v;
}

/**
 * CSV → record objects. Headers are data-contract paths (e.g. customer.givenName, card.paymentStatus,
 * claim.status). For EOB, claim.* columns describe the record's single claim. An optional "recordId" column
 * is kept as the source ID. Card transactions can be supplied as a JSON array in a card.transactions column.
 */
export function csvToRecords(text: string, documentType: DocumentType, extra: FieldDef[] = []): { records: Array<Record<string, any>>; headerErrors: string[] } {
  const rows = parseCsv(text);
  if (rows.length < 2) return { records: [], headerErrors: ['CSV needs a header row and at least one data row.'] };
  const header = rows[0].map((h) => h.trim().replace(/^﻿/, ''));
  const fields = new Map(contract(documentType, extra).map((f) => [f.path, f]));
  const example = documentType === 'eob' ? 'claim.status' : documentType === 'custom' ? (extra.find((f) => !f.derived && f.type !== 'array')?.path ?? 'customer.givenName') : 'card.paymentStatus';
  const headerErrors = header.filter((h) => h && h !== 'recordId' && h !== 'personaId' && !fields.has(h)).map((h) => `Unknown column “${h}” — use a data-contract path such as ${example}.`);
  const derived = header.filter((h) => fields.get(h)?.derived);
  derived.forEach((h) => headerErrors.push(`Column “${h}” is calculated by the engine and cannot be imported.`));
  // A project's own list has one row per item, which a CSV line cannot hold: such records come as JSON.
  header.filter((h) => h.startsWith('custom.') && fields.get(h)?.type === 'array').forEach((h) => headerErrors.push(`Column “${h}” is a list (${fields.get(h)!.label}), and a CSV row cannot hold a list. Leave the column out, or supply these customers as a JSON file, where each record carries the list as an array of rows.`));
  if (headerErrors.length) return { records: [], headerErrors };
  const records = rows.slice(1).map((cells) => {
    const o: Record<string, any> = {};
    header.forEach((h, i) => {
      const raw = cells[i] ?? '';
      if (h === 'recordId' || h === 'personaId') { if (raw.trim()) o[h] = raw.trim(); return; }
      const f = fields.get(h)!;
      let v: unknown;
      if (f.type === 'array') { try { v = raw.trim() ? JSON.parse(raw) : undefined; } catch { v = raw; } }
      else v = coerce(f.type, raw);
      if (v === undefined) return;
      const path = documentType === 'eob' && h.startsWith('claim.') ? `claims.0.${h.slice(6)}` : h;
      const parts = path.split('.');
      let cur: any = o;
      parts.forEach((p, idx) => {
        const last = idx === parts.length - 1;
        const nextIsIndex = /^\d+$/.test(parts[idx + 1] ?? '');
        if (last) cur[p] = v;
        else { cur[p] = cur[p] ?? (nextIsIndex ? [] : {}); cur = cur[p]; }
      });
    });
    return o;
  });
  return { records, headerErrors: [] };
}

/** Validate and re-identify a batch. `nextId` is the first free numeric suffix (≥ IMPORT_ID_BASE). */
export function prepareImport(items: unknown[], documentType: DocumentType, nextId: number, extra: FieldDef[] = []): ImportRowResult[] {
  const prefix = RECORD_ID_PREFIX[documentType];
  let n = Math.max(nextId, IMPORT_ID_BASE);
  return items.slice(0, IMPORT_LIMIT).map((raw, i) => {
    const r = (raw ?? {}) as Record<string, any>;
    const sourceId = typeof r.recordId === 'string' ? r.recordId : null;
    const errors = validateRecordShape(r, documentType, extra);
    if (errors.length) return { row: i + 1, sourceId, errors };
    if (n > 9999) return { row: i + 1, sourceId, errors: ['Import capacity reached (IDs up to 9999).'] };
    const { recordId: _drop, documentType: _dt, demonstrationOnly: _d, ...rest } = r;
    const record = { ...rest, recordId: `${prefix}-${String(n++).padStart(4, '0')}`, documentType, imported: true, sourceId } as unknown as SyntheticRecord;
    if (documentType === 'credit-statement' && !Array.isArray((record.card as any)?.transactions)) (record.card as any).transactions = [];
    return { row: i + 1, sourceId, errors: [], record };
  });
}
