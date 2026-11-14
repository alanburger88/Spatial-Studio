import { blockText, type ReadBlock } from './fileReading';
import { marksAt, replaceMarks, type DetailMark } from './personalDetails';

/**
 * Several samples of the same document (two or three files, each one customer's copy): which blocks correspond, and
 * how they differ.
 *
 *  - `same`: the wording is identical in every sample: fixed wording.
 *  - `values`: the wording is the same apart from a few values: those values are data fields (`slots`).
 *  - `different`: the block is there in every sample but its wording differs: candidate alternative wording.
 *  - `partial`: the block is missing from at least one sample: a candidate conditional section.
 *
 * Pure and deterministic. Blocks are matched in order (a block never jumps over another), by kind and by how many words
 * they share once digits and the marked personal details are set aside.
 */
export type AlignKind = 'same' | 'values' | 'different' | 'partial';

export const ALIGN_KIND_LABEL: Record<AlignKind, string> = { same: 'Same wording', values: 'Only values differ', different: 'Wording differs', partial: 'Not in every sample' };

export interface AlignSlot {
  /** A suggested data field name. */
  name: string;
  /** The value in each sample, in sample order ("" when that sample has nothing there). */
  values: string[];
}

export interface AlignedRow {
  kind: AlignKind;
  /** The block id in each sample, or null when that sample has no such block. */
  blocks: Array<string | null>;
  /** The kind of block (heading, paragraph, list, table). */
  blockKind: ReadBlock['kind'];
  /** `values`: the wording with each differing value as `{{name}}`. */
  template?: string;
  slots?: AlignSlot[];
}

export interface SampleAlignment {
  samples: number;
  rows: AlignedRow[];
  counts: Record<AlignKind, number>;
}

export interface AlignInput { blocks: ReadBlock[]; marks?: DetailMark[] }

/* ------------------------------------------------------------------ comparing text */

const tokens = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const loose = (s: string): string => s.toLowerCase().replace(/\d+/g, '#').replace(/[^\p{L}#{}]+/gu, '');
const normText = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The wording of a block with its marked values as placeholders (a table: its column headings). */
function maskedText(b: ReadBlock, marks: DetailMark[]): string {
  if (b.kind === 'table') return (b.rows?.[0] ?? []).join(' | ');
  return b.lines.map((l, i) => replaceMarks(l, marksAt(marks, b.id, i))).join('\n');
}

function lcsTable(a: string[], b: string[]): number[][] {
  const t: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  return t;
}
/** Pairs of indexes (i in a, j in b) of one longest common subsequence. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const t = lcsTable(a, b);
  const out: Array<[number, number]> = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/** Words in common (ignoring case, punctuation and digits) over the words of the longer text: 0 to 1. */
export function textSimilarity(a: string, b: string): number {
  const ta = tokens(a).map(loose).filter(Boolean), tb = tokens(b).map(loose).filter(Boolean);
  if (!ta.length && !tb.length) return 1;
  return lcsTable(ta, tb)[0][0] / Math.max(ta.length, tb.length);
}

interface Item { block: ReadBlock; masked: string }
function itemSimilarity(a: Item, b: Item): number {
  if (a.block.kind !== b.block.kind) return 0;
  if (a.block.kind === 'table') {
    const sameCols = (a.block.rows?.[0]?.length ?? 0) === (b.block.rows?.[0]?.length ?? 0);
    return loose(a.masked) === loose(b.masked) && sameCols ? 1 : sameCols ? 0.6 : 0.3;
  }
  return textSimilarity(a.masked, b.masked);
}

/** Below this, two blocks are not the same block of the document. */
const MATCH = 0.5;
/** At or above this share of words in common, the differences are values rather than other wording. */
const VALUES = 0.5;

/** Matches the items of `b` to rows (represented by an item each), in order, maximising the total similarity. */
function alignSequences(rows: Item[], b: Item[]): Array<[number | null, number | null]> {
  const n = rows.length, m = b.length;
  const sims: number[][] = rows.map((r) => b.map((x) => { const s = itemSimilarity(r, x); return s >= MATCH ? s : -1; }));
  const score: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    const take = sims[i][j] >= 0 ? score[i + 1][j + 1] + sims[i][j] : -Infinity;
    score[i][j] = Math.max(take, score[i + 1][j], score[i][j + 1]);
  }
  const raw: Array<[number | null, number | null]> = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && sims[i][j] >= 0 && score[i][j] === score[i + 1][j + 1] + sims[i][j]) { raw.push([i, j]); i++; j++; }
    else if (i < n && (j >= m || score[i][j] === score[i + 1][j])) { raw.push([i, null]); i++; }
    else { raw.push([null, j]); j++; }
  }
  // Between two matched blocks, blocks of the same kind left over on both sides are the same place in the document
  // with other wording: pair them, in order.
  const out: Array<[number | null, number | null]> = [];
  for (let k = 0; k < raw.length;) {
    if (raw[k][0] !== null && raw[k][1] !== null) { out.push(raw[k]); k++; continue; }
    const gap: Array<[number | null, number | null]> = [];
    while (k < raw.length && (raw[k][0] === null || raw[k][1] === null)) gap.push(raw[k++]);
    const left = gap.filter((g) => g[0] !== null).map((g) => g[0]!);
    const right = gap.filter((g) => g[1] !== null).map((g) => g[1]!);
    const usedRight = new Set<number>();
    for (const a of left) {
      const bi = right.find((x) => !usedRight.has(x) && rows[a].block.kind === b[x].block.kind && (rows[a].block.kind !== 'table' || itemSimilarity(rows[a], b[x]) > 0));
      // Keep the order of the right-hand side: unpaired blocks before the partner come first.
      if (bi !== undefined) {
        for (const x of right) if (x < bi && !usedRight.has(x)) { out.push([null, x]); usedRight.add(x); }
        out.push([a, bi]); usedRight.add(bi);
      } else out.push([a, null]);
    }
    for (const x of right) if (!usedRight.has(x)) out.push([null, x]);
  }
  return out;
}

/* ------------------------------------------------------------------ slots */

const uniqueName = (name: string, used: Set<string>): string => {
  let out = name;
  for (let k = 2; used.has(out.toLowerCase()); k++) out = `${name} ${k}`;
  used.add(out.toLowerCase());
  return out;
};

/** The common wording of the texts with each differing run of words as a slot, or null when too little is common. */
function valueSlots(texts: string[], used: Set<string>, counter: { n: number }): { template: string; slots: AlignSlot[] } | null {
  const words = texts.map(tokens);
  const base = words[0];
  const maps = words.slice(1).map((w) => new Map(lcsPairs(base, w)));
  // Indexes of the first sample's words found in every other sample.
  const common = base.map((_, i) => maps.every((m) => m.has(i)));
  if (common.filter(Boolean).length / Math.max(...words.map((w) => w.length), 1) < VALUES) return null;
  const parts: string[] = [];
  const slots: AlignSlot[] = [];
  let prev = -1; // the last common index of the first sample
  const flush = (next: number) => {
    // The words of each sample between the common words `prev` and `next` (-1: the end).
    const values = words.map((w, k) => {
      if (k === 0) return base.slice(prev + 1, next === -1 ? base.length : next).join(' ');
      const m = maps[k - 1];
      return w.slice(prev >= 0 ? m.get(prev)! + 1 : 0, next === -1 ? w.length : m.get(next)!).join(' ');
    });
    if (values.every((v) => v === values[0])) { if (values[0]) parts.push(values[0]); return; }
    counter.n += 1;
    // The words just before the slot name it when they end with a colon ("Plan: Flex").
    const before = base.slice(Math.max(0, prev - 3), prev + 1).join(' ');
    const lm = /([\p{L}][\p{L} ]{0,40}):$/u.exec(before);
    const label = lm ? lm[1].trim().split(' ').slice(-4).join(' ') : '';
    const name = uniqueName(label ? label.charAt(0).toUpperCase() + label.slice(1).toLowerCase() : `Value ${counter.n}`, used);
    slots.push({ name, values });
    parts.push(`{{${name}}}`);
  };
  base.forEach((w, i) => {
    if (!common[i]) return;
    flush(i);
    parts.push(w);
    prev = i;
  });
  flush(-1);
  return slots.length ? { template: parts.join(' '), slots } : null;
}

function sameRows(a: ReadBlock, b: ReadBlock): boolean {
  return JSON.stringify((a.rows ?? []).map((r) => r.map(normText))) === JSON.stringify((b.rows ?? []).map((r) => r.map(normText)));
}

/* ------------------------------------------------------------------ aligning */

/**
 * Aligns two or three samples. Each row says which block of each sample it is and how the samples differ there.
 * With one sample every row is `same` (there is nothing to compare).
 */
export function alignSamples(samples: AlignInput[]): SampleAlignment {
  const counts: Record<AlignKind, number> = { same: 0, values: 0, different: 0, partial: 0 };
  if (!samples.length) return { samples: 0, rows: [], counts };
  const items = samples.map((s) => s.blocks.map((block): Item => ({ block, masked: maskedText(block, s.marks ?? []) })));
  // Progressive alignment: the rows so far (each represented by its first block) against the next sample.
  let rows: Array<Array<Item | null>> = items[0].map((b) => [b]);
  for (let s = 1; s < samples.length; s++) {
    const reps = rows.map((r) => r.find((x): x is Item => !!x)!);
    const pairs = alignSequences(reps, items[s]);
    rows = pairs.map(([i, j]) => [...(i === null ? new Array<Item | null>(s).fill(null) : rows[i]), j === null ? null : items[s][j]]);
  }

  const used = new Set<string>();
  const counter = { n: 0 };
  const out: AlignedRow[] = rows.map((r) => {
    const present = r.filter((x): x is Item => !!x);
    const blockKind = present[0].block.kind;
    const ids = r.map((x) => x?.block.id ?? null);
    if (samples.length === 1) return { kind: 'same', blocks: ids, blockKind };
    if (present.length < r.length) return { kind: 'partial', blocks: ids, blockKind };
    if (blockKind === 'table') {
      if (present.some((x) => normText(x.masked) !== normText(present[0].masked))) return { kind: 'different', blocks: ids, blockKind };
      // A table whose columns are the same holds each customer's rows: its body is data when the rows differ.
      return { kind: present.every((x) => sameRows(x.block, present[0].block)) ? 'same' : 'values', blocks: ids, blockKind };
    }
    const raw = present.map((x) => blockText(x.block));
    if (raw.every((t) => normText(t) === normText(raw[0]))) return { kind: 'same', blocks: ids, blockKind };
    if (present.every((x) => normText(x.masked) === normText(present[0].masked))) {
      // Only the marked values differ: each placeholder is a slot, with each sample's value for it.
      const names = [...new Set([...present[0].masked.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]))];
      const slots = names.map((name): AlignSlot => ({
        name,
        values: present.map((x, k) => (samples[k].marks ?? []).filter((m) => m.blockId === x.block.id && m.cell === undefined && m.placeholder.includes(`{{${name}}}`)).map((m) => m.text).join(' ')),
      })).filter((sl) => sl.values.some((v) => v !== sl.values[0]));
      for (const sl of slots) used.add(sl.name.toLowerCase());
      return { kind: 'values', blocks: ids, blockKind, template: normText(present[0].masked), slots };
    }
    const v = valueSlots(present.map((x) => x.masked), used, counter);
    return v ? { kind: 'values', blocks: ids, blockKind, template: v.template, slots: v.slots } : { kind: 'different', blocks: ids, blockKind };
  });
  for (const r of out) counts[r.kind] += 1;
  return { samples: samples.length, rows: out, counts };
}
