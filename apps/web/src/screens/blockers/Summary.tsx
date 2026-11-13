import type { ReactNode } from 'react';
import type { BlockerKind } from '@iss/scenarios';
import { Icon } from '../../ui/icons';
import { Tech } from '../../ui/common';
import type { BlockerData } from './useBlockers';
import { clockTime, type FullCheckResult } from './fullCheck';
import { KINDS, KIND_LABEL, KIND_SHORT, plural } from './labels';

/** The bar above the list: who can be issued the document, how many blockers of each kind, and how fresh each kind of check is. */
export function Summary({ data, current, full, modelChanged, kind, onKind, onRunFull, onCancelFull, fixAll, children }: {
  data: BlockerData; current: boolean; full: FullCheckResult; modelChanged: boolean;
  kind: BlockerKind | null; onKind: (k: BlockerKind | null) => void;
  onRunFull: () => void; onCancelFull: () => void; fixAll: ReactNode; children?: ReactNode;
}) {
  const { result } = data;
  const perKind = (k: BlockerKind) => result.blockers.filter((b) => b.kind === k).length;
  const running = full.status === 'running';
  const lastRun = full.ranAtMs !== null;
  const fromFull = result.blockers.filter((b) => b.speed === 'full-check').length;
  return (
    <section className="panel bl-summary" data-testid="bl-summary" aria-label="Summary of blockers" aria-busy={!current}>
      <div className="bl-tiles">
        <div className="bl-tile"><strong data-testid="bl-checked">{result.checked}</strong><span>synthetic customers checked</span></div>
        <div className={`bl-tile${result.stopped === 0 ? ' good' : ''}`}><strong data-testid="bl-issuable">{result.issuable}</strong><span>can be issued the document</span></div>
        <div className={`bl-tile${result.stopped ? ' bad' : ''}`}><strong data-testid="bl-stopped">{result.stopped}</strong><span>{result.stopped === 1 ? 'is stopped' : 'are stopped'}</span></div>
        <div className="bl-tile" title="Each blocker is one cause, however many customers it stops"><strong data-testid="bl-blockers">{result.blockers.length}</strong><span>{result.blockers.length === 1 ? 'blocker' : 'blockers'}</span></div>
      </div>

      <div className="bl-kinds" role="group" aria-label="Show blockers of one kind">
        {KINDS.map((k) => {
          const n = perKind(k);
          return (
            <button key={k} type="button" className={`bl-kindbtn${kind === k ? ' on' : ''}${n ? '' : ' none'}`} aria-pressed={kind === k} disabled={!n && kind !== k} onClick={() => onKind(kind === k ? null : k)} data-testid={`bl-kindcount-${k}`} data-count={n} title={KIND_LABEL[k]}>
              {KIND_SHORT[k]} <span className="chip count">{n}</span>
            </button>
          );
        })}
        {kind && <button type="button" className="btn ghost sm" onClick={() => onKind(null)} data-testid="bl-kind-clear">Show all kinds</button>}
      </div>

      <ul className="bl-speeds" aria-label="How current each kind of check is">
        <li data-testid="bl-speed-fast">
          <span className={`bl-dot ${current ? 'now' : 'wait'}`} aria-hidden="true" />
          <span><strong>Rules, wording and data:</strong> {current ? <>checked just now for all {data.result.checked} synthetic customers</> : <>updating after your change…</>}
            <Tech><span className="muted"> · {data.ms} ms</span></Tech></span>
        </li>
        <li data-testid="bl-speed-full">
          <span className={`bl-dot ${running ? 'wait' : lastRun ? (modelChanged ? 'old' : 'full') : 'none'}`} aria-hidden="true" />
          <span>
            <strong>Pages and PDF/web differences:</strong>{' '}
            {running ? <span data-testid="bl-full-progress" role="status">checking customer {Math.min(full.done + 1, full.total)} of {full.total}…</span>
              : lastRun ? <span data-testid="bl-full-time">from the full check at {clockTime(full.ranAtMs!)} <span className="muted">({plural(full.total, 'customer')}{full.elapsedMs !== null ? `, ${(full.elapsedMs / 1000).toFixed(1)} s` : ''})</span></span>
              : <span data-testid="bl-full-time">not run yet</span>}
            {fromFull > 0 && !running && <span className="chip count" title="Blockers that came from the full check">{fromFull}</span>}
          </span>
        </li>
      </ul>

      {lastRun && modelChanged && !running && (
        <p className="bl-note warn" role="status" data-testid="bl-full-stale">The document has changed since the full check at {clockTime(full.ranAtMs!)}, so the page and PDF/web findings may be out of date. Run the full check again to confirm.</p>
      )}
      {full.error && !running && <p className="bl-note warn" role="alert" data-testid="bl-full-error">{full.error}</p>}

      <div className="bl-actions">
        {running
          ? <button type="button" className="btn" onClick={onCancelFull} data-testid="bl-cancel-full">Stop the full check</button>
          : <button type="button" className="btn primary" onClick={onRunFull} data-testid="bl-run-full" title="Composes the pages of every customer, so it takes a while. Accessibility findings never stop a document, so they are not part of it."><Icon.validate /> {lastRun ? 'Run full check again' : 'Run full check'}</button>}
        {fixAll}
        {children}
      </div>
    </section>
  );
}
