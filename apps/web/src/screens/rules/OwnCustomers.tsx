import { useState } from 'react';
import type { Project } from '@iss/model';
import { api, ApiFailure } from '../../api/client';
import { editBlockedReason, useStudio } from '../../state/store';
import { Icon } from '../../ui/icons';
import { ImportDialog } from '../gallery/ImportRecords';

/**
 * Where a document with its own data gets its customers from: generated for it (the "Generate test customers" button
 * in the rule list), or supplied by the person (a JSON or CSV import), and removed again. The customers belong to this
 * document alone, and it always keeps at least one.
 */
export function OwnCustomers({ project }: { project: Project }) {
  const blocked = useStudio((s) => editBlockedReason(s.session));
  const records = useStudio((s) => s.records);
  const supplied = records.filter((r) => r.projectId === project.projectId && !r.generated).length;
  const [importing, setImporting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await api.deleteSuppliedRecords(project.projectId);
      await useStudio.getState().refreshRecords();
      const msg = r.removed ? `${r.removed} supplied customer${r.removed === 1 ? '' : 's'} removed.` : 'There were no supplied customers to remove.';
      setNote(r.note ? `${msg} ${r.note}` : msg);
      useStudio.getState().toast({ kind: 'success', title: 'Supplied customers removed', message: r.note ?? msg });
      setConfirm(false);
    } catch (e) { setNote(e instanceof ApiFailure ? e.message : String((e as Error).message ?? e)); }
    setBusy(false);
  };
  return (
    <div className="rd-owncust" data-testid="own-customers">
      <span className="rd-owncust-lbl">Customers</span>
      <button type="button" className="btn sm" onClick={() => setImporting(true)} disabled={!!blocked} title={blocked ?? 'Add your own customers from a JSON or CSV file'} data-testid="import-customers"><Icon.plus /> Import customers…</button>
      {confirm ? (
        <span className="rd-owncust-confirm" role="group" aria-label="Confirm removing the supplied customers">
          <span>Remove the {supplied} supplied customer{supplied === 1 ? '' : 's'}? Generated ones stay.</span>
          <button type="button" className="btn sm danger" onClick={remove} disabled={busy} data-testid="remove-supplied-confirm">Yes, remove</button>
          <button type="button" className="btn sm ghost" onClick={() => setConfirm(false)}>Keep them</button>
        </span>
      ) : (
        <button type="button" className="btn sm" onClick={() => setConfirm(true)} disabled={!!blocked || !supplied} title={blocked ?? (supplied ? 'Remove the customers you supplied for this document' : 'You have not supplied any customers')} data-testid="remove-supplied">Remove supplied customers</button>
      )}
      {note && <span className="muted rd-owncust-note" role="status" data-testid="remove-supplied-note">{note}</span>}
      {importing && <ImportDialog projectId={project.projectId} onClose={() => setImporting(false)} onDone={async () => { setImporting(false); await useStudio.getState().refreshRecords(); }} />}
    </div>
  );
}
