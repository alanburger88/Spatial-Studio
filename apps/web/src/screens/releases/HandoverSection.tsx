import { useState } from 'react';
import { HANDOVER_LABEL, RELEASE_NOTE_MAX, cleanReleaseNote, releaseRoleProblem, type HandoverEntry, type HandoverKind, type ReleaseInfo, type Role } from '@iss/model';
import { ApiFailure, api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Tech } from '../../ui/common';
import { When } from '../../ui/time';

/** The handover log: when the receiving team said they got the package and when it went live. A record only: it moves nothing. */
export function HandoverSection({ release, entries, role, onChanged }: { release: ReleaseInfo; entries: HandoverEntry[]; role: Role | null; onChanged: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<HandoverKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const why = releaseRoleProblem(role, 'handover');
  const add = async (kind: HandoverKind) => {
    setBusy(kind); setError(null);
    try {
      await api.addHandover(release.id, { kind, ...(cleanReleaseNote(note) ? { note: cleanReleaseNote(note) } : {}) });
      useStudio.getState().toast({ kind: 'success', title: `Release ${release.number} marked as ${HANDOVER_LABEL[kind].toLowerCase()}` });
      setNote('');
      onChanged();
    } catch (e) { setError(e instanceof ApiFailure ? e.message : 'That did not work.'); } finally { setBusy(null); }
  };
  return (
    <section className="rel-section" aria-labelledby="rel-handover-h" data-testid="rel-handover">
      <h3 className="section-title" id="rel-handover-h">Handover</h3>
      <p className="muted rel-hint">A record of what the receiving team told you. It does not move the release.</p>
      {entries.length === 0
        ? <p className="muted" data-testid="rel-handover-empty">Nothing has been recorded yet.</p>
        : (
          <ol className="rel-timeline" data-testid="rel-handover-log">
            {entries.map((e) => (
              <li key={e.id} data-testid="rel-handover-entry" data-kind={e.kind}>
                <span className="rel-dot" aria-hidden="true" />
                <span className="rel-ev-text">
                  <strong>{HANDOVER_LABEL[e.kind]}</strong>{e.stage ? <span className="muted"> in {e.stage === 'production' ? 'Production' : 'Test'}</span> : null}
                  <span className="muted"> · {e.by?.name ?? 'an unknown person'} · <When iso={e.at} /></span>
                  {e.note && <span className="rel-ev-note" data-testid="rel-handover-note">{e.note}</span>}
                  <Tech><span className="rel-ev-note mono">{e.packageSha256 ? `package ${e.packageSha256}` : 'package not built yet'}</span></Tech>
                </span>
              </li>
            ))}
          </ol>
        )}
      <div className="rel-handover-add" data-testid="rel-handover-add">
        <label className="field"><span className="label">Note (optional)</span>
          <input className="input" type="text" maxLength={RELEASE_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} disabled={!!why} data-testid="rel-handover-note-input" placeholder="For example: loaded into the test environment" />
        </label>
        <div className="rel-action-row">
          <button type="button" className="btn" data-testid="rel-handover-received" disabled={!!why || !!busy} title={why ?? undefined} onClick={() => add('received')}>{busy === 'received' ? 'Saving…' : 'Mark as received'}</button>
          <button type="button" className="btn" data-testid="rel-handover-live" disabled={!!why || !!busy} title={why ?? undefined} onClick={() => add('live')}>{busy === 'live' ? 'Saving…' : 'Mark as live'}</button>
        </div>
        {why && <p className="muted rel-why" data-testid="rel-handover-why">{why}</p>}
        {error && <p className="callout error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
