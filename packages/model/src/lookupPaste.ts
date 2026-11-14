import { isIsoDay } from './isoDate';
import { LOOKUP_TABLE_MAX_ROWS } from './lookup';
import type { LookupRange, LookupRow, LookupTable } from './types';

/**
 * Pasting rows of a lookup table from a spreadsheet. Its own module: only the Lookup tables screen uses it, so the
 * browser's first download (the engine every screen needs, in lookup.ts) does not carry it.
 */

const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

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
