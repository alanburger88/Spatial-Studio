import type { ReactNode } from 'react';
import type { ReleaseInfo } from '@iss/model';
import { Tech } from '../../ui/common';
import { fmtAbs, When } from '../../shell/History';
import { personName } from './format';

/** What is live: the current Production and Test release of this document. */
export function LiveCards({ production, test, latest, savedVersion, onSelect, selected, changedHint }: {
  production: ReleaseInfo | null; test: ReleaseInfo | null; latest: ReleaseInfo | null; savedVersion: number;
  selected: number | null; onSelect: (n: number) => void; changedHint: ReactNode;
}) {
  return (
    <section className="rel-live" data-testid="rel-live" aria-label="What is live">
      <div className="rel-live-cards">
        <LiveCard stage="Production" r={production} none="Nothing in Production yet" selected={selected} onSelect={onSelect} />
        <LiveCard stage="Test" r={test} none="Nothing in Test" selected={selected} onSelect={onSelect} />
      </div>
      {latest && savedVersion > latest.modelVersion && (
        <div className="callout warning rel-changed" data-testid="rel-changed" role="status">
          <strong>The document has changed since release {latest.number}: v{savedVersion} is not released.</strong>
          <span> {changedHint}</span>
        </div>
      )}
    </section>
  );
}

function LiveCard({ stage, r, none, selected, onSelect }: { stage: 'Production' | 'Test'; r: ReleaseInfo | null; none: string; selected: number | null; onSelect: (n: number) => void }) {
  const id = stage.toLowerCase();
  return (
    <div className={`rel-live-card${r ? '' : ' empty-card'}`} data-testid={`rel-live-${id}`} data-release={r?.number ?? ''}>
      <h2 className="section-title">{stage}</h2>
      {r ? (
        <>
          <button type="button" className="rel-live-num" onClick={() => onSelect(r.number)} aria-current={selected === r.number ? 'true' : undefined} data-testid={`rel-live-${id}-open`}>Release {r.number}</button>
          <p className="rel-live-meta">Approved by <strong>{personName(r.approvedBy)}</strong></p>
          <p className="rel-live-meta"><time dateTime={r.approvedAt} className="nowrap">{fmtAbs(r.approvedAt)}</time> <span className="muted">(<When iso={r.approvedAt} />)</span></p>
          <p className="muted rel-live-meta">In {stage} since <When iso={r.stages[id as 'test' | 'production']?.since ?? r.approvedAt} /> · saved version v{r.modelVersion}<Tech> · <span className="mono">{r.contentDigest.slice(0, 12)}</span></Tech></p>
        </>
      ) : <p className="muted rel-live-none">{none}</p>}
    </div>
  );
}
