import {
  isIsoDay, keyCellWords, type CalcType, type LookupKeyColumn, type LookupRange, type LookupRow, type LookupTable, type LookupValueColumn, type Scalar,
} from '@iss/model';
import { formatCents } from '@iss/resolver';

/** Pure helpers behind the Lookup tables screen: the grid's columns, reading and writing one cell, new tables and rows. */

export type CellKind = 'text' | 'number' | 'money' | 'date' | 'bool';

/** One column of the grid: a key column (a range takes two: from and until) or a value column. */
export interface GridCol {
  id: string;
  head: string;
  sub: string;
  role: 'key-text' | 'key-from' | 'key-until' | 'value';
  /** The key or value column's key. */
  key: string;
  kind: CellKind;
}

export const KIND_OF_TYPE: Record<CalcType, CellKind> = { number: 'number', money: 'money', date: 'date', text: 'text', bool: 'bool' };
export const TYPE_NAME: Record<CalcType, string> = { number: 'Number', money: 'Amount', date: 'Date', text: 'Text', bool: 'Yes or no' };
export const MATCH_NAME: Record<LookupKeyColumn['match'], string> = { text: 'Exact text', 'number-range': 'A range of numbers', 'date-range': 'A range of dates' };

export function gridColumns(t: Pick<LookupTable, 'keys' | 'columns'>): GridCol[] {
  const out: GridCol[] = [];
  for (const k of t.keys) {
    if (k.match === 'text') out.push({ id: `k:${k.key}`, head: k.label, sub: 'key', role: 'key-text', key: k.key, kind: 'text' });
    else {
      const kind: CellKind = k.match === 'date-range' ? 'date' : k.unit === 'money' ? 'money' : 'number';
      out.push({ id: `k:${k.key}:from`, head: `${k.label}`, sub: 'from (included)', role: 'key-from', key: k.key, kind });
      out.push({ id: `k:${k.key}:until`, head: `${k.label}`, sub: 'until (not included)', role: 'key-until', key: k.key, kind });
    }
  }
  for (const c of t.columns) out.push({ id: `v:${c.key}`, head: c.label, sub: TYPE_NAME[c.type].toLowerCase(), role: 'value', key: c.key, kind: KIND_OF_TYPE[c.type] });
  return out;
}

/** A cell's raw value. */
export function cellValue(row: LookupRow, c: GridCol): Scalar | undefined {
  if (c.role === 'value') return row.values?.[c.key];
  const cell = row.keys?.[c.key];
  if (c.role === 'key-text') return typeof cell === 'string' ? cell : undefined;
  const r = cell && typeof cell === 'object' ? (cell as LookupRange) : undefined;
  const v = c.role === 'key-from' ? r?.from : r?.until;
  return v === undefined ? undefined : v;
}

/** A value as text, in the way a person would type it back (amounts in dollars with the cents). */
export function valueText(kind: CellKind, v: Scalar | undefined, locale = 'en-US'): string {
  if (v === undefined || v === null) return '';
  switch (kind) {
    case 'money': return typeof v === 'number' ? formatCents(v, locale) : String(v);
    case 'bool': return v === true ? 'Yes' : v === false ? 'No' : String(v);
    default: return String(v);
  }
}

const MONEY_RE = /^(-)?\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/;
export function parseMoney(s: string): number | null {
  const m = MONEY_RE.exec(s.trim());
  if (!m) return null;
  const cents = Number(m[2].replace(/,/g, '')) * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0);
  return Number.isSafeInteger(cents) ? (m[1] ? -cents : cents) : null;
}

export type Parsed = { ok: true; value: Scalar | undefined } | { ok: false; message: string };

/** Reads what was typed into a cell. An empty cell is an open end of a range, an empty value or an empty text. */
export function parseCell(c: GridCol, text: string): Parsed {
  const s = text.trim();
  const open = c.role === 'key-from' || c.role === 'key-until';
  if (!s) return { ok: true, value: c.role === 'value' ? null : open ? undefined : '' };
  switch (c.kind) {
    case 'text': return { ok: true, value: text };
    case 'number': return /^-?\d+(\.\d+)?$/.test(s.replace(/,/g, '')) ? { ok: true, value: Number(s.replace(/,/g, '')) } : { ok: false, message: 'Type a number, for example 12.5.' };
    case 'money': { const v = parseMoney(s); return v === null ? { ok: false, message: 'Type an amount in dollars, for example 12.50.' } : { ok: true, value: v }; }
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(s) && isIsoDay(s) ? { ok: true, value: s } : { ok: false, message: 'Write the date as YYYY-MM-DD, for example 2027-01-31.' };
    case 'bool': {
      if (/^(yes|true|y)$/i.test(s)) return { ok: true, value: true };
      if (/^(no|false|n)$/i.test(s)) return { ok: true, value: false };
      return { ok: false, message: 'Type yes or no.' };
    }
  }
}

/** The row with one cell changed. */
export function withCell(row: LookupRow, c: GridCol, v: Scalar | undefined): LookupRow {
  if (c.role === 'value') return { ...row, values: { ...row.values, [c.key]: (v === undefined ? null : v) as Scalar } };
  if (c.role === 'key-text') return { ...row, keys: { ...row.keys, [c.key]: typeof v === 'string' ? v : '' } };
  const cur = row.keys?.[c.key];
  const range: LookupRange = { ...(cur && typeof cur === 'object' ? (cur as LookupRange) : {}) };
  const end = c.role === 'key-from' ? 'from' : 'until';
  if (v === undefined || v === null) delete range[end]; else range[end] = v as number | string;
  return { ...row, keys: { ...row.keys, [c.key]: range } };
}

/** A new row: empty values, and (for a range key) starting where the last row ends. */
export function blankRow(t: LookupTable): LookupRow {
  const last = t.rows[t.rows.length - 1];
  const keys: LookupRow['keys'] = {};
  for (const k of t.keys) {
    if (k.match === 'text') keys[k.key] = '';
    else {
      const prev = last?.keys?.[k.key];
      const from = prev && typeof prev === 'object' ? (prev as LookupRange).until : undefined;
      keys[k.key] = from !== undefined ? { from } : {};
    }
  }
  return { keys, values: Object.fromEntries(t.columns.map((c) => [c.key, null])) };
}

/** Whether a key cell is wrong by itself (an empty text key, a range that ends before it starts). */
export function cellInvalid(row: LookupRow, c: GridCol): boolean {
  if (c.role === 'key-text') return !(typeof row.keys?.[c.key] === 'string' && (row.keys[c.key] as string).length > 0);
  if (c.role === 'value') return false;
  const r = row.keys?.[c.key];
  if (!r || typeof r !== 'object') return true;
  const { from, until } = r as LookupRange;
  return from !== undefined && until !== undefined && !(from < until);
}

export function defaultKeyColumn(match: LookupKeyColumn['match'], label = 'Key', key = 'key'): LookupKeyColumn {
  return match === 'number-range' ? { key, label, match, unit: 'number' } : { key, label, match };
}

/** What a table's row says about its keys, in words ("Basic", "from 100 until 500"). */
export function rowKeyWords(t: LookupTable, row: LookupRow): string {
  return t.keys.map((k) => keyCellWords(k, row.keys?.[k.key])).join(', ');
}

/** Keys of a value column (default row, try it) as text and back. */
export function valueColumnKind(c: LookupValueColumn): CellKind { return KIND_OF_TYPE[c.type]; }
