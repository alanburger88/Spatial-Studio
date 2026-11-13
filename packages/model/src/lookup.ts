import { isIsoDay } from './isoDate';
import type { CalcType, LookupKeyColumn, LookupRange, LookupRow, LookupTable, LookupValueColumn, Scalar } from './types';

/**
 * Lookup tables: small tables kept with the document ("fee by tier", "notice by state"), read by a calculation with
 * LOOKUP. Keys are exact text, or ranges of numbers or days (from included, until excluded, either end open). Pure.
 */

export const LOOKUP_TABLE_MAX_ROWS = 5000;
export const LOOKUP_TABLE_MAX_KEYS = 3;
export const LOOKUP_TABLE_MAX_COLUMNS = 12;
export const LOOKUP_TABLES_MAX = 50;
export const LOOKUP_TEXT_MAX = 500;
export const LOOKUP_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;

const q = (s: string) => `“${s}”`;
/** 5000 → "5,000" (fixed studio English; no Intl in the engine). */
const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const isRange = (v: unknown): v is LookupRange => !!v && typeof v === 'object' && !Array.isArray(v);
type Bound = number | string;

/** Whether a key value falls in one key cell. */
export function keyMatches(col: LookupKeyColumn, cell: string | LookupRange | undefined, value: unknown): boolean {
  if (col.match === 'text') return typeof cell === 'string' && cell === value;
  if (!isRange(cell)) return false;
  if (col.match === 'number-range' ? typeof value !== 'number' : typeof value !== 'string') return false;
  const v = value as Bound;
  if (cell.from !== undefined && cell.from !== null && v < (cell.from as Bound)) return false;
  if (cell.until !== undefined && cell.until !== null && v >= (cell.until as Bound)) return false;
  return true;
}

/** The first row whose every key matches, or null. (A table with overlapping rows is refused when it is saved.) */
export function lookupRowFor(table: LookupTable, keys: unknown[]): LookupRow | null {
  for (const row of table.rows) if (table.keys.every((k, i) => keyMatches(k, row.keys?.[k.key], keys[i]))) return row;
  return null;
}

export const valueOfType = (type: CalcType, v: Scalar): boolean => {
  if (v === null) return true;
  switch (type) {
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'money': return typeof v === 'number' && Number.isSafeInteger(v);
    case 'date': return isIsoDay(v);
    case 'text': return typeof v === 'string' && v.length <= LOOKUP_TEXT_MAX;
    case 'bool': return typeof v === 'boolean';
  }
};

const TYPE_WORDS: Record<CalcType, string> = { number: 'a number', money: 'an amount in cents', date: 'a date (YYYY-MM-DD)', text: 'text', bool: 'true or false' };

/** Describes a key cell in plain words ("from 100 until 500", "“gold”"). */
export function keyCellWords(col: LookupKeyColumn, cell: string | LookupRange | undefined): string {
  if (col.match === 'text') return typeof cell === 'string' ? q(cell) : 'nothing';
  if (!isRange(cell)) return 'nothing';
  const f = cell.from, u = cell.until;
  const show = (b: Bound) => (col.match === 'number-range' && col.unit === 'money' && typeof b === 'number' ? `${(b / 100).toFixed(2)} dollars` : String(b));
  if (f === undefined && u === undefined) return 'any value';
  if (f === undefined) return `below ${show(u!)}`;
  if (u === undefined) return `${show(f)} or more`;
  return `from ${show(f)} until ${show(u)}`;
}

/**
 * Structural problems that make a table unusable (refused when it is saved): ids, names, column types, the size limit,
 * cells of the wrong kind, ranges that end before they start, duplicate keys and overlapping ranges.
 */
export function validateLookupTable(t: LookupTable): string[] {
  const e: string[] = [];
  if (!t || typeof t !== 'object') return ['The table cannot be read.'];
  const name = typeof t.title === 'string' && t.title.trim() ? t.title.trim() : String(t.id);
  if (!LOOKUP_ID_PATTERN.test(t.id ?? '')) e.push(`The table id ${q(String(t.id))} must start with a letter and use only letters and digits (max 40).`);
  if (typeof t.title !== 'string' || !t.title.trim() || t.title.length > 80) e.push(`Table ${q(name)} needs a name (max 80 characters).`);
  if (t.description !== undefined && (typeof t.description !== 'string' || t.description.length > 300)) e.push(`The description of ${q(name)} is limited to 300 characters.`);
  const keys: LookupKeyColumn[] = Array.isArray(t.keys) ? t.keys : [];
  const cols: LookupValueColumn[] = Array.isArray(t.columns) ? t.columns : [];
  if (!keys.length || keys.length > LOOKUP_TABLE_MAX_KEYS) e.push(`Table ${q(name)} needs 1 to ${LOOKUP_TABLE_MAX_KEYS} key columns (what it is looked up by).`);
  if (!cols.length || cols.length > LOOKUP_TABLE_MAX_COLUMNS) e.push(`Table ${q(name)} needs 1 to ${LOOKUP_TABLE_MAX_COLUMNS} value columns.`);
  const seen = new Set<string>();
  for (const c of [...keys, ...cols]) {
    if (!c || !LOOKUP_ID_PATTERN.test(c.key ?? '')) { e.push(`Table ${q(name)}: the column key ${q(String(c?.key))} must start with a letter and use only letters and digits.`); continue; }
    if (seen.has(c.key)) e.push(`Table ${q(name)} uses the column key ${q(c.key)} twice.`);
    seen.add(c.key);
    if (typeof c.label !== 'string' || !c.label.trim() || c.label.length > 60) e.push(`Table ${q(name)}: column ${q(c.key)} needs a name (max 60 characters).`);
  }
  for (const k of keys) {
    if (!['text', 'number-range', 'date-range'].includes(k?.match)) e.push(`Table ${q(name)}: key ${q(k?.label ?? k?.key)} must be exact text, a range of numbers or a range of dates.`);
    if (k?.unit !== undefined && (k.match !== 'number-range' || !['number', 'money'].includes(k.unit))) e.push(`Table ${q(name)}: only a range of numbers can be in amounts.`);
  }
  for (const c of cols) if (!['number', 'money', 'date', 'text', 'bool'].includes(c?.type)) e.push(`Table ${q(name)}: column ${q(c?.label ?? c?.key)} must hold numbers, amounts, dates, text or yes or no.`);
  if (e.length) return e;
  const rows: LookupRow[] = Array.isArray(t.rows) ? t.rows : [];
  if (!Array.isArray(t.rows)) e.push(`Table ${q(name)} has no list of rows.`);
  if (rows.length > LOOKUP_TABLE_MAX_ROWS) return [...e, `Table ${q(name)} has ${rows.length} rows; the most is ${grouped(LOOKUP_TABLE_MAX_ROWS)}.`];
  const cellProblem = (where: string, k: LookupKeyColumn, cell: unknown): string | null => {
    if (k.match === 'text') return typeof cell === 'string' && cell.length <= LOOKUP_TEXT_MAX ? null : `${where}: ${q(k.label)} must be text.`;
    if (!isRange(cell)) return `${where}: ${q(k.label)} must be a range (from and until).`;
    const extra = Object.keys(cell).filter((x) => x !== 'from' && x !== 'until');
    if (extra.length) return `${where}: ${q(k.label)} has unexpected parts (${extra.join(', ')}).`;
    const ok = (b: unknown) => b === undefined || (k.match === 'number-range' ? typeof b === 'number' && Number.isFinite(b) && (k.unit !== 'money' || Number.isSafeInteger(b)) : isIsoDay(b));
    if (!ok(cell.from) || !ok(cell.until)) return `${where}: ${q(k.label)} must be ${k.match === 'number-range' ? (k.unit === 'money' ? 'amounts in whole cents' : 'numbers') : 'dates (YYYY-MM-DD)'}.`;
    if (cell.from !== undefined && cell.until !== undefined && !((cell.from as Bound) < (cell.until as Bound))) return `${where}: ${q(k.label)} must end after it starts (“until” is the first value it no longer covers).`;
    return null;
  };
  rows.forEach((row, i) => {
    const where = `Table ${q(name)}, row ${i + 1}`;
    if (!row || typeof row !== 'object' || !row.keys || typeof row.keys !== 'object' || !row.values || typeof row.values !== 'object') { e.push(`${where} cannot be read.`); return; }
    for (const k of keys) { const p = cellProblem(where, k, row.keys[k.key]); if (p) e.push(p); }
    for (const c of cols) if (!valueOfType(c.type, (row.values[c.key] ?? null) as Scalar)) e.push(`${where}: ${q(c.label)} must be ${TYPE_WORDS[c.type]}.`);
    const unknown = [...Object.keys(row.keys).filter((x) => !keys.some((k) => k.key === x)), ...Object.keys(row.values).filter((x) => !cols.some((c) => c.key === x))];
    if (unknown.length) e.push(`${where} has cells for columns the table does not have (${unknown.slice(0, 3).join(', ')}).`);
  });
  if (t.defaultRow !== undefined) {
    if (!t.defaultRow || typeof t.defaultRow !== 'object' || Array.isArray(t.defaultRow)) e.push(`The default row of ${q(name)} cannot be read.`);
    else for (const c of cols) if (!valueOfType(c.type, (t.defaultRow[c.key] ?? null) as Scalar)) e.push(`The default row of ${q(name)}: ${q(c.label)} must be ${TYPE_WORDS[c.type]}.`);
  }
  if (e.length) return e.slice(0, 20);
  for (const p of lookupTableProblems(t)) if (p.severity === 'error') e.push(p.message);
  return e.slice(0, 20);
}

export interface LookupTableProblem {
  kind: 'duplicate' | 'overlap' | 'gap';
  severity: 'error' | 'warning';
  /** 1-based rows involved. */
  rows: number[];
  message: string;
}

/**
 * Duplicate keys and overlapping ranges (errors: a customer could match two rows) and gaps between ranges (warnings:
 * a customer could match no row) of one table, in plain words. Ranges are compared among rows whose other keys are the
 * same. Rows are compared in sorted order, so this stays fast at 5,000 rows.
 */
export function lookupTableProblems(t: LookupTable): LookupTableProblem[] {
  const out: LookupTableProblem[] = [];
  const keys = t.keys ?? [];
  const rows = t.rows ?? [];
  const name = q(t.title || t.id);
  const ranged = keys.filter((k) => k.match !== 'text');
  // Group by every key except one range key; within the group compare that range key.
  const textKeyOf = (row: LookupRow, skip: string | null) => keys.filter((k) => k.key !== skip).map((k) => JSON.stringify(row.keys?.[k.key] ?? null)).join('|');
  if (!ranged.length) {
    const first = new Map<string, number>();
    rows.forEach((row, i) => {
      const id = textKeyOf(row, null);
      const was = first.get(id);
      if (was === undefined) first.set(id, i);
      else out.push({ kind: 'duplicate', severity: 'error', rows: [was + 1, i + 1], message: `Rows ${was + 1} and ${i + 1} of ${name} have the same key (${keys.map((k) => keyCellWords(k, row.keys?.[k.key])).join(', ')}), so a customer would match both.` });
    });
    return out.slice(0, 50);
  }
  for (const rk of ranged) {
    const groups = new Map<string, number[]>();
    rows.forEach((row, i) => { const id = textKeyOf(row, rk.key); groups.set(id, [...(groups.get(id) ?? []), i]); });
    for (const idx of groups.values()) {
      const lo = (i: number): Bound | null => (rows[i].keys?.[rk.key] as LookupRange | undefined)?.from ?? null;
      const hi = (i: number): Bound | null => (rows[i].keys?.[rk.key] as LookupRange | undefined)?.until ?? null;
      const sorted = [...idx].sort((a, b) => { const x = lo(a), y = lo(b); if (x === y) return a - b; if (x === null) return -1; if (y === null) return 1; return x < y ? -1 : 1; });
      // Walk in order of where each range starts, keeping how far the rows so far reach (null = no end).
      let reach: Bound | null = sorted.length ? hi(sorted[0]) : null;
      let reachRow = sorted[0];
      for (let j = 1; j < sorted.length; j++) {
        const cur = sorted[j];
        const curStart = lo(cur);
        const show = (b: Bound) => keyCellWords(rk, { from: b }).replace(/ or more$/, '');
        const [a, b] = [Math.min(reachRow, cur) + 1, Math.max(reachRow, cur) + 1];
        if (reach === null || curStart === null || curStart < reach) {
          const same = hi(reachRow) === hi(cur) && lo(reachRow) === curStart;
          out.push({ kind: same ? 'duplicate' : 'overlap', severity: 'error', rows: [a, b], message: same ? `Rows ${a} and ${b} of ${name} have the same ${q(rk.label)} (${keyCellWords(rk, rows[cur].keys?.[rk.key])}), so a customer would match both.` : `Rows ${a} and ${b} of ${name} overlap in ${q(rk.label)} (${keyCellWords(rk, rows[reachRow].keys?.[rk.key])} and ${keyCellWords(rk, rows[cur].keys?.[rk.key])}), so a customer could match both.` });
        } else if (curStart > reach) {
          out.push({ kind: 'gap', severity: 'warning', rows: [a, b], message: `${q(rk.label)} of ${name} has a gap from ${show(reach)} until ${show(curStart)} (between rows ${a} and ${b}): a customer there matches no row${t.defaultRow ? ' and gets the default row' : ''}.` });
        }
        const end = hi(cur);
        if (reach !== null && (end === null || end > reach)) { reach = end; reachRow = cur; }
        if (out.length >= 50) return out;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ pasting from a spreadsheet */

export interface PasteProblem { row: number; column: number | null; message: string }
export interface PasteResult { rows: LookupRow[]; problems: PasteProblem[]; headerSkipped: boolean }

/** Splits pasted text into cells: tab-separated when it has tabs, otherwise comma-separated with "quoted" cells. */
export function splitDelimited(text: string): string[][] {
  const t = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!t) return [];
  const delim = t.includes('\t') ? '\t' : ',';
  const out: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; i++; continue; }
    if (ch === delim) { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = ''; i++; continue; }
    cell += ch; i++;
  }
  row.push(cell);
  out.push(row);
  return out;
}

const parseNumber = (s: string): number | null => (/^-?\d+(\.\d+)?$/.test(s.replace(/,/g, '')) ? Number(s.replace(/,/g, '')) : null);
const parseMoney = (s: string): number | null => {
  const m = /^(-)?\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  const cents = Number(m[2].replace(/,/g, '')) * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0);
  return Number.isSafeInteger(cents) ? (m[1] ? -cents : cents) : null;
};

/**
 * Reads rows pasted from a spreadsheet (TSV or CSV) for a table's columns, in order: each key column (a range takes two
 * cells, from and until; an empty cell leaves that end open), then each value column. Amounts are written as dollars
 * ("12.50" or "$1,200"); dates as YYYY-MM-DD; yes or no as yes/no or true/false. A first row that does not read as data
 * but names the columns is skipped. Every problem names its row and column (both 1-based).
 */
export function parseLookupPaste(table: Pick<LookupTable, 'keys' | 'columns'>, text: string): PasteResult {
  const lines = splitDelimited(text);
  const problems: PasteProblem[] = [];
  const rows: LookupRow[] = [];
  const width = table.keys.reduce((n, k) => n + (k.match === 'text' ? 1 : 2), 0) + table.columns.length;
  const headings = [...table.keys.flatMap((k) => (k.match === 'text' ? [k.label] : [`${k.label} from`, `${k.label} until`])), ...table.columns.map((c) => c.label)];
  let headerSkipped = false;
  if (lines.length > LOOKUP_TABLE_MAX_ROWS + 1) return { rows: [], problems: [{ row: LOOKUP_TABLE_MAX_ROWS + 1, column: null, message: `There are ${lines.length} rows; a table holds at most ${grouped(LOOKUP_TABLE_MAX_ROWS)}.` }], headerSkipped };
  lines.forEach((cells, li) => {
    const rowNo = li + 1;
    if (cells.every((c) => !c.trim())) return;
    const rowProblems: PasteProblem[] = [];
    if (cells.length !== width) rowProblems.push({ row: rowNo, column: null, message: `Row ${rowNo} has ${cells.length} cell${cells.length === 1 ? '' : 's'}; ${width} are expected (${headings.join(', ')}).` });
    const keys: LookupRow['keys'] = {};
    const values: LookupRow['values'] = {};
    let col = 0;
    const cellAt = () => (cells[col] ?? '').trim();
    const fail = (message: string) => rowProblems.push({ row: rowNo, column: col + 1, message: `Row ${rowNo}, column ${col + 1} (${headings[col]}): ${message}` });
    if (!rowProblems.length) {
      for (const k of table.keys) {
        if (k.match === 'text') { const s = cellAt(); if (!s) fail('a key cannot be empty.'); keys[k.key] = s; col++; continue; }
        const range: LookupRange = {};
        for (const end of ['from', 'until'] as const) {
          const s = cellAt();
          if (s) {
            const v = k.match === 'date-range' ? (/^\d{4}-\d{2}-\d{2}$/.test(s) && isIsoDay(s) ? s : null) : k.unit === 'money' ? parseMoney(s) : parseNumber(s);
            if (v === null) fail(k.match === 'date-range' ? `${JSON.stringify(s)} is not a date; write it as YYYY-MM-DD.` : `${JSON.stringify(s)} is not ${k.unit === 'money' ? 'an amount' : 'a number'}.`);
            else range[end] = v;
          }
          col++;
        }
        keys[k.key] = range;
      }
      for (const c of table.columns) {
        const s = cellAt();
        if (!s) values[c.key] = null;
        else if (c.type === 'text') values[c.key] = s;
        else if (c.type === 'number') { const v = parseNumber(s); if (v === null) fail(`${JSON.stringify(s)} is not a number.`); values[c.key] = v; }
        else if (c.type === 'money') { const v = parseMoney(s); if (v === null) fail(`${JSON.stringify(s)} is not an amount (for example 12.50).`); values[c.key] = v; }
        else if (c.type === 'date') { if (!isIsoDay(s)) fail(`${JSON.stringify(s)} is not a date; write it as YYYY-MM-DD.`); values[c.key] = s; }
        else { const v = /^(yes|true|y)$/i.test(s) ? true : /^(no|false|n)$/i.test(s) ? false : null; if (v === null) fail(`${JSON.stringify(s)} is not yes or no.`); values[c.key] = v; }
        col++;
      }
    }
    // A first row that names the columns rather than holding data is a heading.
    if (li === 0 && rowProblems.length && cells.length === width && cells.some((c, i) => c.trim().toLowerCase() === headings[i].toLowerCase())) { headerSkipped = true; return; }
    if (rowProblems.length) { problems.push(...rowProblems); return; }
    rows.push({ keys, values });
  });
  return { rows, problems: problems.slice(0, 100), headerSkipped };
}
