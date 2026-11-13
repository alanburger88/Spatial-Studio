import type { ReleaseInfo } from '@iss/model';
import { When } from '../../shell/History';
import { Tech } from '../../ui/common';
import { PACKAGE_CHIP, STANDING_CHIP, personName } from './format';

export function ReleaseList({ releases, selected, onSelect }: { releases: ReleaseInfo[]; selected: number | null; onSelect: (n: number) => void }) {
  return (
    <ul className="list-rows rel-list" data-testid="rel-list" aria-label="Releases, newest first">
      {releases.map((r) => {
        const st = STANDING_CHIP[r.standing];
        const pk = PACKAGE_CHIP[r.package.status];
        return (
          <li key={r.id} className="rel-row-li">
            <button type="button" className="rel-row" data-testid={`rel-row-${r.number}`} data-standing={r.standing} aria-current={selected === r.number ? 'true' : undefined} onClick={() => onSelect(r.number)}>
              <span className="rel-row-main">
                <strong className="rel-row-num">Release {r.number}</strong>
                <span className={`chip ${st.cls}`} data-testid="rel-standing">{st.label}</span>
                <span className="muted rel-row-ver">v{r.modelVersion}</span>
                {r.stages.production?.status === 'withdrawn' && r.standing !== 'withdrawn' && <span className="chip warning" data-testid="rel-prod-withdrawn">Withdrawn from Production</span>}
                {r.documentRemoved && <span className="chip">Document deleted</span>}
              </span>
              <span className="rel-row-sub muted">Approved by {personName(r.approvedBy)} · <When iso={r.approvedAt} /></span>
              <span className="rel-row-marks">
                <span className={`chip ${pk.cls}`} data-testid="rel-pkg-chip">{pk.label}</span>
                {r.handover.received && <span className="chip accent" data-testid="rel-mark-received">✓ Received</span>}
                {r.handover.live && <span className="chip accent" data-testid="rel-mark-live">✓ Live</span>}
                {!r.handover.received && !r.handover.live && <span className="muted rel-row-nohand">Not handed over</span>}
                <Tech><span className="chip code">{r.id}</span></Tech>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
