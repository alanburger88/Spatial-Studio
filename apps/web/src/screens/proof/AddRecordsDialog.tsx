import { useState } from 'react';
import { ApiFailure } from '../../api/client';
import { useStudio } from '../../state/store';
import { Dialog } from '../../ui/common';
import { proofApi, type ImportResultDto } from './api';
import { plural } from './format';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * "Add proof records": choose the proof.jsonl a runnable package wrote, see what a dry run finds (new, already known,
 * refused and why), then add. The file is untrusted: the server checks every line and keeps nothing beyond the record.
 */
export function AddRecordsDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [dry, setDry] = useState<ImportResultDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (f: File | undefined) => {
    setDry(null); setError(null); setFile(null);
    if (!f) return;
    if (f.size > MAX_BYTES) { setError(`The file is larger than ${MAX_BYTES / 1024 / 1024} MB. Split it and add the parts one by one.`); return; }
    const text = await f.text();
    setFile({ name: f.name, text });
    setBusy(true);
    try { setDry(await proofApi.importFile(text, true)); } catch (e) { setError(e instanceof ApiFailure ? e.message : 'The file could not be checked.'); } finally { setBusy(false); }
  };
  const add = async () => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const r = await proofApi.importFile(file.text, false);
      useStudio.getState().toast({ kind: 'success', title: `${plural(r.added, 'proof record')} added`, message: r.unknownRelease ? `${plural(r.unknownRelease, 'record')} name a release not known here; they are kept and marked.` : 'They can be looked up now.' });
      onAdded();
    } catch (e) { setError(e instanceof ApiFailure ? e.message : 'The records could not be added.'); setBusy(false); }
  };
  const refused = dry?.details.filter((d) => d.outcome === 'refused' || d.outcome === 'conflict') ?? [];
  return (
    <Dialog title="Add proof records" onClose={onClose} labelledBy="prf-add-title"
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || !dry || dry.new === 0} onClick={add} data-testid="proof-add-confirm">{busy && dry ? 'Adding…' : dry ? `Add ${plural(dry.new, 'record')}` : 'Add'}</button>
      </>}>
      <div className="prf-add" data-testid="proof-add-dialog">
        <p>Choose the <code>proof.jsonl</code> file a runnable package wrote: one proof record per line. Each line is checked; a record with anything beyond the proof record’s fields is refused, and nothing in the file is run. First you see what would happen; nothing is added until you confirm.</p>
        <label className="field"><span className="label">Proof file (.jsonl, at most 5 MB and 10,000 records)</span>
          <input type="file" accept=".jsonl,.json,.txt,application/json,text/plain" onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} data-testid="proof-add-file" />
        </label>
        {busy && !dry && <p role="status"><span className="spinner" aria-hidden="true" /> Checking {file?.name}…</p>}
        {error && <p className="callout error" role="alert" data-testid="proof-add-error">{error}</p>}
        {dry && (
          <div data-testid="proof-add-summary" role="status">
            <p><strong>{file?.name}</strong>: {plural(dry.lines, 'record')} read.</p>
            <ul className="prf-add-counts">
              <li data-testid="proof-add-new"><strong>{dry.new}</strong> new{dry.unknownRelease ? ` (${dry.unknownRelease} for a release not known here: kept and marked)` : ''}</li>
              <li data-testid="proof-add-known"><strong>{dry.known}</strong> already known (nothing new is stored)</li>
              {dry.conflict > 0 && <li><strong>{dry.conflict}</strong> already known with different content (the record already kept is not changed)</li>}
              <li data-testid="proof-add-refused"><strong>{dry.refused}</strong> refused</li>
            </ul>
            {dry.new > 0 && <p className="muted">From the runnable package: {dry.producers.runtime}; from a studio: {dry.producers.studio}.</p>}
            {refused.length > 0 && (
              <details open={refused.length <= 5}>
                <summary>Why {refused.length === 1 ? 'one line was' : `${refused.length} lines were`} not added</summary>
                <ul className="prf-add-why" data-testid="proof-add-why">
                  {refused.map((d) => <li key={d.line}>Line {d.line}{d.proofId ? ` (${d.proofId})` : ''}: {d.problems.join(' ')}</li>)}
                </ul>
                {dry.detailsCut && <p className="muted">Only the first 500 lines are listed.</p>}
              </details>
            )}
            {dry.new === 0 && <p className="muted">There is nothing new to add.</p>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
