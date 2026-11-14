import { useRef } from 'react';
import type { Blocker, BlockerKind, BlockerWithStatus, FixImpact } from '@iss/scenarios';
import { Tech } from '../../ui/common';
import { CountChips } from './BlockerDetail';
import { KINDS, KIND_LABEL, KIND_NEXT, plural } from './labels';
import type { BlockerWorkItem } from '../../api/work';
import { WorkChips } from './WorkParts';
import { statusOf } from './work';

/** What a fix would do, in a few words, for the list. */
export function shortEffect(impact: FixImpact | null): string | null {
  if (!impact) return null;
  if (impact.newlyBlocked.length) return `would block ${plural(impact.newlyBlocked.length, 'other customer')}`;
  if (impact.resolves) return impact.unblocked.length ? `unblocks ${impact.unblocked.length} of ${impact.totalCustomers} synthetic customers` : 'resolves it and nobody else is affected';
  return 'does not fully resolve it';
}

/** The best fix of a blocker as one line, with its effect when it has been worked out. */
function bestFixLine(b: Blocker, impact: FixImpact | null): { text: string; effect: string | null } {
  const best = b.fixes[0];
  if (!best) return { text: 'No automatic fix. Open where it is fixed.', effect: null };
  if (best.kind === 'scenario') return { text: 'The document is fine: the customer’s data has to be corrected.', effect: null };
  if (best.kind === 'link') return { text: `${best.title} (a person does this)`, effect: null };
  return { text: best.title, effect: shortEffect(impact) };
}

export function BlockerList({ blockers, selectedId, onSelect, impactFor, totalChecked, workFor, after }: {
  blockers: BlockerWithStatus[]; selectedId: string | null; onSelect: (id: string) => void; impactFor: (blockerId: string, fixId: string) => FixImpact | null; totalChecked: number;
  /** Phase 4: the owner, status and notes of a cause, when someone works on it. */
  workFor?: (blockerId: string) => BlockerWorkItem | undefined;
  /** Shown after the kinds, before the footnote (the "Fixed" group). */
  after?: React.ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const btns = [...(root.current?.querySelectorAll<HTMLButtonElement>('button[data-blocker]') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : Math.max(0, Math.min(btns.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    btns[n].focus();
    onSelect(btns[n].dataset.blocker!);
  };
  // The kind that stops the most customers comes first; ties keep the usual order of kinds.
  const top = (k: BlockerKind): number => Math.max(...blockers.filter((b) => b.kind === k).map((b) => b.openRecordIds.length));
  const kinds = KINDS.filter((k) => blockers.some((b) => b.kind === k)).sort((a, b) => top(b) - top(a) || KINDS.indexOf(a) - KINDS.indexOf(b));
  return (
    <div className="bl-list" data-testid="bl-list" ref={root} onKeyDown={onKey}>
      {kinds.map((k: BlockerKind) => {
        const rows = blockers.filter((b) => b.kind === k);
        return (
          <section key={k} className="bl-group" data-testid={`bl-kind-${k}`} aria-labelledby={`bl-kind-h-${k}`}>
            <header className="bl-group-head">
              <h2 id={`bl-kind-h-${k}`}>{KIND_LABEL[k]}</h2>
              <span className="chip count">{rows.length}</span>
              <span className="muted bl-group-next">{KIND_NEXT[k]}</span>
            </header>
            <ul className="list-rows bl-rows" aria-labelledby={`bl-kind-h-${k}`}>
              {rows.map((b) => {
                const sel = selectedId === b.id;
                const best = bestFixLine(b, b.fixes[0]?.kind === 'change' ? impactFor(b.id, b.fixes[0].id) : null);
                const work = workFor?.(b.id);
                return (
                  <li key={b.id} className={`bl-row-item${sel ? ' selected' : ''}`}>
                    <button type="button" className="bl-row" data-testid={`bl-row-${b.id}`} data-blocker={b.id} data-kind={b.kind} data-speed={b.speed} data-count={b.customerCount} data-status={b.status} data-work-status={statusOf(b, work)} data-owner={work?.owner?.id ?? ''} aria-current={sel ? 'true' : undefined} onClick={() => onSelect(b.id)}>
                      <span className="bl-row-top">
                        <strong className="bl-row-title">{b.title}</strong>
                        <CountChips blocker={b} />
                        {b.status === 'known-data-problem' && <span className="chip warning" data-testid="bl-status">Known data problem</span>}
                        {workFor && <WorkChips status={statusOf(b, work)} item={work} compact />}
                        {b.speed === 'full-check' && <span className="chip info" data-testid="bl-from-full" title="Found by the last full check, which composes the pages. It can be out of date until the check is run again.">from the full check</span>}
                        <Tech><span className="chip code">{b.code}</span></Tech>
                      </span>
                      <span className="bl-row-fix"><span className="muted">Best fix:</span> {best.text}{best.effect && <span className="bl-effect"> · {best.effect}</span>}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {after}
      <p className="hint bl-foot">Checked against {plural(totalChecked, 'synthetic customer')}. A cause that none of them reaches is not listed; generate more test customers to widen the net.</p>
    </div>
  );
}
