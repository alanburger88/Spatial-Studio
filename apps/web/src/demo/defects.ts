import { useStudio } from '../state/store';

/**
 * Deliberate defects for demonstrations (used by the status-bar Demo tools panel) and the synthetic
 * transaction generator shared with the Rules & Data scenario editor. Kept out of the screens so the
 * shell does not pull a whole screen into the first download.
 */

/** N synthetic rows whose integer-cent amounts sum EXACTLY to totalCents. */
export function makeTransactions(n: number, totalCents: number) {
  const merchants = ['Maple Groceries', 'Harbor Fuel', 'South Bay Pharmacy', 'Riverside Books', 'Aster Coffee', 'Seaside Market', 'Transit Pass'];
  const base = Math.trunc(totalCents / n);
  const extra = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => ({
    id: `GEN-${String(i + 1).padStart(4, '0')}`,
    date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
    merchant: merchants[i % merchants.length],
    amountCents: base + (i < extra ? 1 : 0),
  }));
}

export function injectD01() {
  const st = useStudio.getState();
  const r3 = st.project?.rules.find((r) => r.id === 'R03');
  if (!r3 || st.project?.documentType !== 'credit-statement') { st.toast({ kind: 'warning', title: 'D01 needs the credit-statement project', message: 'R03/R04 exist only in the Aster Card sample.' }); return false; }
  return st.dispatch({ type: 'UPSERT_RULE', rule: { ...r3, when: { op: 'gte', path: 'card.missedPayments', value: 2 }, priority: 400 } }).ok;
}
export function restoreR03() {
  const st = useStudio.getState();
  const r3 = st.project?.rules.find((r) => r.id === 'R03');
  if (!r3) return false;
  return st.dispatch({ type: 'UPSERT_RULE', rule: { ...r3, when: { op: 'and', args: [{ op: 'gte', path: 'card.missedPayments', value: 2 }, { op: 'eq', path: 'card.assistanceRequested', value: false }] }, priority: 300 } }).ok;
}
export function removeFallback() {
  const st = useStudio.getState();
  return st.dispatch({ type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: undefined } }).ok;
}
export function restoreFallback() {
  return useStudio.getState().dispatch({ type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: 'payment-standard' } }).ok;
}
