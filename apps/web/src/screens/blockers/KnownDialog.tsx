import { useState } from 'react';
import { KNOWN_REASON_MAX } from '@iss/scenarios';
import { ApiFailure } from '../../api/client';
import { useCan, useStudio } from '../../state/store';
import { Dialog } from '../../ui/common';
import { useKnownData } from './knownData';

/** Why this person cannot set a data problem aside, or null when they can (approvers and admins). */
export function useKnownBlockedReason(): string | null {
  return useCan('approve') ? null : 'Only an approver can set a customer’s data problem aside';
}

/**
 * "Mark as a known data problem": one customer, one problem in that customer's own data, an approver and a reason.
 * The server refuses anything else; this dialog only says so first.
 */
export function KnownDialog({ blockerId, blockerTitle, recordId, customerName, onClose, onDone }: {
  blockerId: string; blockerTitle: string; recordId: string; customerName: string; onClose: () => void; onDone?: () => void;
}) {
  const projectId = useStudio((s) => s.project!.projectId);
  const blocked = useKnownBlockedReason();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = reason.trim();
  const tooLong = trimmed.length > KNOWN_REASON_MAX;
  const submit = async () => {
    if (!trimmed || tooLong || blocked) return;
    setBusy(true); setError(null);
    try {
      await useKnownData.getState().add(projectId, { blockerId, recordId, reason: trimmed });
      useStudio.getState().toast({ kind: 'success', title: 'Set aside as a known data problem', message: `${customerName}: ${blockerTitle}. It is listed on the approval screen and in the next release.` });
      onDone?.();
      onClose();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <Dialog title="Mark as a known data problem" onClose={onClose} labelledBy="bl-known-title"
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || !trimmed || tooLong || !!blocked} title={blocked ?? (!trimmed ? 'Write the reason first' : undefined)} data-testid="bl-known-save">{busy ? 'Saving…' : 'Set aside for this customer'}</button>
      </>}>
      <div className="bl-known-dialog" data-testid="bl-known-dialog">
        <p><strong>{blockerTitle}</strong> for <strong>{customerName}</strong>.</p>
        <ul className="bl-known-rules">
          <li>It applies to this customer and this problem only. Other customers it stops stay stopped.</li>
          <li>The customer is no longer counted as stopped, and the problem no longer blocks approval.</li>
          <li>It is listed, with your reason, on the approval screen and in every release from now on.</li>
          <li>It is undone automatically when the customer’s data or the document changes so that the problem no longer exists.</li>
        </ul>
        {blocked && <p className="bl-note warn" role="status" data-testid="bl-known-blocked">{blocked}.</p>}
        <label className="field">
          <span className="label">Reason (required)</span>
          <textarea className="textarea" value={reason} maxLength={KNOWN_REASON_MAX + 50} onChange={(e) => setReason(e.target.value)} disabled={!!blocked} data-testid="bl-known-reason"
            placeholder="For example: the source system corrects this account in the next cycle" aria-describedby="bl-known-count" />
        </label>
        <p id="bl-known-count" className={`hint${tooLong ? ' bl-warn' : ''}`}>{trimmed.length} of {KNOWN_REASON_MAX} characters</p>
        {error && <p className="bl-note warn" role="alert" data-testid="bl-known-error">{error}</p>}
      </div>
    </Dialog>
  );
}
