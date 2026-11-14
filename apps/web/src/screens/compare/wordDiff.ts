/**
 * A word-by-word difference between two texts, for showing which words changed. Pure.
 * Tokens are words and the white space between them; only words are marked. Texts that are too long to compare word
 * by word are reported as wholly changed rather than guessed at.
 */
export interface DiffPiece { text: string; changed: boolean }
export interface WordDiffResult { before: DiffPiece[]; after: DiffPiece[]; changedWords: number }

const MAX_CELLS = 2_500_000;
const tokens = (s: string): string[] => s.match(/\s+|[^\s]+/g) ?? [];

/** White space between two changed words belongs to the change, so a changed phrase is marked as one piece. */
function merge(pieces: DiffPiece[]): DiffPiece[] {
  pieces = pieces.map((p, i) => (!p.changed && /^\s+$/.test(p.text) && pieces[i - 1]?.changed && pieces[i + 1]?.changed ? { ...p, changed: true } : p));
  const out: DiffPiece[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && last.changed === p.changed) last.text += p.text; else out.push({ ...p });
  }
  return out;
}

export function wordDiff(before: string, after: string): WordDiffResult {
  const a = tokens(before), b = tokens(after);
  if (a.length * b.length > MAX_CELLS) {
    return { before: before ? [{ text: before, changed: true }] : [], after: after ? [{ text: after, changed: true }] : [], changedWords: Math.max(a.length, b.length) };
  }
  // Longest common subsequence over tokens.
  const n = a.length, m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const left: DiffPiece[] = [], right: DiffPiece[] = [];
  let i = 0, j = 0, changedWords = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { left.push({ text: a[i], changed: false }); right.push({ text: b[j], changed: false }); i++; j++; }
    else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) { right.push({ text: b[j], changed: !/^\s+$/.test(b[j]) }); if (!/^\s+$/.test(b[j])) changedWords++; j++; }
    else { left.push({ text: a[i], changed: !/^\s+$/.test(a[i]) }); if (!/^\s+$/.test(a[i])) changedWords++; i++; }
  }
  return { before: merge(left), after: merge(right), changedWords };
}
