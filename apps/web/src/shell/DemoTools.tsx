import { useEffect, useRef, type ReactNode } from 'react';
import { create } from 'zustand';
import { useResolution, useStudio } from '../state/store';
import { useDemo } from '../demo/demo';
import { injectD01, makeTransactions, removeFallback, restoreFallback, restoreR03 } from '../demo/defects';
import { Icon } from '../ui/icons';
import { Tech, formatMoney } from '../ui/common';

/**
 * Demo tools: every deliberate-defect control in one place, out of the working screens.
 * Closed by default and opened only from the status bar, so it never covers a screen unasked.
 * Model edits go through the command bus (undoable); scenario changes are overrides (never model edits).
 */
export const useDemoTools = create<{ open: boolean; setOpen(v: boolean): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** Which seeded defects are currently applied (derived from the live model + scenario; nothing is stored). */
export function useDefectState() {
  const project = useStudio((s) => s.project);
  const res = useResolution();
  const overrides = useStudio((s) => s.ctx.overrides);
  if (!project) return null;
  const eff = res?.effectiveRecord;
  const isCard = project.documentType === 'credit-statement';
  const r3 = project.rules.find((r) => r.id === 'R03');
  const table = project.nodes.find((n) => n.id === 'transaction-table');
  const guidance = project.nodes.find((n) => n.id === 'payment-guidance');
  const claim0 = eff?.claims?.[0] as Record<string, unknown> | undefined;
  const txCount = (eff?.card?.transactions ?? []).length;
  const active = {
    d01: isCard && r3?.priority === 400,
    d02: eff?.customer.locale === 'es-US' && (overrides as { customer?: { locale?: string } }).customer?.locale === 'es-US',
    d03: isCard && table?.flowContinuation === false && txCount >= 250,
    d04: !isCard && claim0?.patientResponsibilityCents === 30000 && claim0?.liabilityConfirmed === false,
    d05: isCard && !!guidance && guidance.fallbackVariantId === undefined,
  };
  return { project, eff, isCard, table, claim0, active, overrideCount: Object.keys(overrides).length, count: Object.values(active).filter(Boolean).length };
}

function Tool({ id, title, text, on, children }: { id: string; title: string; text: string; on: boolean; children: ReactNode }) {
  return (
    <li className={`dt-tool${on ? ' on' : ''}`} data-testid={`defect-${id}`}>
      <div className="dt-tool-head"><strong>{title}</strong><Tech><span className="chip code">{id.toUpperCase()}</span></Tech>{on && <span className="chip warning">Applied</span>}</div>
      <p className="dt-tool-text">{text}</p>
      <div className="row wrap dt-tool-actions">{children}</div>
    </li>
  );
}

export function DemoToolsPanel() {
  const open = useDemoTools((s) => s.open);
  const bannerShown = useDemo((s) => s.active && !s.bannerHidden && s.index >= 0);
  const st = useDefectState();
  const ref = useRef<HTMLElement>(null);
  const dispatch = useStudio((s) => s.dispatch);
  const patchOverrides = useStudio((s) => s.patchOverrides);
  const clearOverrides = useStudio((s) => s.clearOverrides);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && ref.current?.contains(document.activeElement)) { useDemoTools.getState().setOpen(false); document.querySelector<HTMLElement>('[data-testid=open-demo-tools]')?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open || !st) return null;
  const { isCard, eff, table, claim0, active, overrideCount } = st;
  const cardOnly = 'Credit-card statement project only.';
  const d03 = () => {
    const purchases = typeof eff?.card?.purchasesCents === 'number' ? (eff.card.purchasesCents as number) : 0;
    patchOverrides({ card: { transactions: makeTransactions(250, purchases) } });
    dispatch({ type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { flowContinuation: false } });
  };
  const d04 = () => {
    if (!claim0 || !eff?.claims) return;
    patchOverrides({ claims: [{ ...claim0, patientResponsibilityCents: 30000, liabilityConfirmed: false, status: 'denied-pending-review' }, ...eff.claims.slice(1)] });
  };
  return (
    <aside className={`demo-tools${bannerShown ? ' with-banner' : ''}`} role="complementary" aria-label="Demo tools" data-testid="demo-tools" ref={ref}>
      <header>
        <Icon.warning /><h2>Demo tools</h2>
        <button type="button" className="btn ghost sm icon" style={{ marginLeft: 'auto' }} onClick={() => useDemoTools.getState().setOpen(false)} aria-label="Close demo tools" data-autofocus><Icon.close /></button>
      </header>
      <p className="dt-intro">Break the sample on purpose to show the checks catching it. Changes to the document can be undone from the top bar; changes to the customer are temporary.</p>
      <ul className="dt-list">
        <Tool id="d01" title="Two rules tie" on={active.d01} text={isCard ? 'Gives two “choose one” rules the same priority and loads a customer who matches both.' : cardOnly}>
          <button className="btn danger sm" onClick={() => { if (injectD01()) useStudio.getState().setRecord('CARD-0002'); }} disabled={!isCard || active.d01} data-testid="seed-d01">Apply</button>
          <button className="btn sm" onClick={() => restoreR03()} disabled={!isCard || !active.d01} data-testid="restore-r03">Put back</button>
        </Tool>
        <Tool id="d02" title="Spanish wording missing" on={!!active.d02} text="Switches this customer to Spanish, which has no approved translation yet.">
          <button className="btn danger sm" onClick={() => patchOverrides({ customer: { locale: 'es-US' } })} disabled={!!active.d02} data-testid="seed-d02">Apply</button>
        </Tool>
        <Tool id="d03" title="Table too long for the page" on={active.d03} text={isCard ? 'Loads 250 transactions and stops the table continuing onto the next page.' : cardOnly}>
          <button className="btn danger sm" onClick={d03} disabled={!isCard || active.d03} data-testid="seed-d03">Apply</button>
          <button className="btn sm" disabled={!isCard || table?.flowContinuation !== false} onClick={() => dispatch({ type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { flowContinuation: true } })} data-testid="restore-continuation">Put back</button>
        </Tool>
        <Tool id="d04" title="Unconfirmed amount shown as owed" on={!!active.d04} text={isCard ? 'Healthcare EOB project only.' : `Sets ${formatMoney(30000)} member liability on a claim that is not confirmed.`}>
          <button className="btn danger sm" onClick={d04} disabled={isCard || !claim0 || !!active.d04} data-testid="seed-d04">Apply</button>
        </Tool>
        <Tool id="d05" title="No message matches" on={active.d05} text={isCard ? 'Removes the fallback message, then loads a customer no rule matches.' : cardOnly}>
          <button className="btn danger sm" disabled={!isCard || active.d05} onClick={() => removeFallback()} data-testid="remove-fallback">Remove fallback</button>
          <button className="btn sm" disabled={!isCard} onClick={() => patchOverrides({ card: { paymentStatus: 'overdue', missedPayments: 0 } })} data-testid="no-match-scenario">Load customer</button>
          <button className="btn sm" disabled={!isCard || !active.d05} onClick={() => restoreFallback()} data-testid="restore-fallback">Put back</button>
        </Tool>
      </ul>
      <footer>
        <button className="btn sm" onClick={() => clearOverrides()} disabled={!overrideCount} data-testid="clear-overrides"><Icon.reset /> Reset this customer{overrideCount ? ` (${overrideCount})` : ''}</button>
      </footer>
    </aside>
  );
}

/** Status-bar button that opens the panel; shows how many seeded defects are applied. */
export function DemoToolsButton() {
  const open = useDemoTools((s) => s.open);
  const st = useDefectState();
  if (!st) return null;
  return (
    <button type="button" className={`dock-btn${st.count ? ' warn' : ''}`} aria-expanded={open} aria-controls="demo-tools" onClick={() => useDemoTools.getState().setOpen(!open)} data-testid="open-demo-tools" title="Deliberate defects for demonstrations">
      <Icon.warning width={13} height={13} /> Demo tools{st.count ? ` · ${st.count} applied` : ''}
    </button>
  );
}
