import { useMemo, useRef, useState } from 'react';
import { planFieldsImport } from '@iss/scenarios';
import { api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Dialog } from '../../ui/common';

const TYPE_LABEL: Record<string, string> = { string: 'Text', int: 'Whole number', cents: 'Amount', bool: 'Yes / no', date: 'Date', enum: 'Choice', group: 'Group of fields', list: 'List' };

/**
 * "Import fields…" in the data fields editor (wave 3, section 4): a data dictionary file (CSV: name, type, description,
 * example) becomes the document's own data fields. Types are checked and an unrecognised type says what it was read as;
 * clashes with existing fields are skipped with the reason; nothing changes until "Add". Adding is one undoable step.
 * The examples can make one synthetic customer, added through the studio's customer route after the document is saved.
 */
export function ImportFields({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const project = useStudio((s) => s.project)!;
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [withCustomer, setWithCustomer] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const plan = useMemo(() => (text.trim() ? planFieldsImport(project, text) : null), [project, text]);
  const adding = plan?.proposals.filter((p) => !p.skip) ?? [];

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { setError('The file is larger than 2 MB.'); return; }
    setError(null); setFileName(f.name); setText(await f.text());
    if (fileRef.current) fileRef.current.value = '';
  };
  const apply = async () => {
    if (!plan?.command) return;
    const st = useStudio.getState();
    const r = st.dispatch(plan.command);
    if (!r.ok) { setError(r.message); return; }
    onApplied();
    if (!(withCustomer && plan.exampleCustomer)) {
      st.toast({ kind: 'success', title: 'Data fields added', message: `${plan.label}. Undo with Ctrl+Z; Save in the top bar keeps them.` });
      onClose();
      return;
    }
    // The customer is checked against the saved document, so the new fields are saved first.
    setBusy(true);
    try {
      if (!(await st.save())) { setError('The fields were added, but the document could not be saved, so no customer was made. Save, then add a customer in Customers.'); return; }
      const added = await api.addRecord(project.projectId, { record: plan.exampleCustomer.record });
      await st.refreshRecords();
      st.setRecord(added.record.recordId);
      st.toast({ kind: 'success', title: 'Data fields and a customer added', message: `${plan.label}, saved, and the synthetic customer “Example Customer” (${added.record.recordId}) made from the examples.` });
      onClose();
    } catch (e: any) {
      setError(`The fields were added and saved, but the customer could not be made: ${e?.message ?? 'unknown error'}.`);
    } finally { setBusy(false); }
  };

  return (
    <Dialog title="Import data fields" onClose={onClose} labelledBy="if-title"
      footer={<>
        <button type="button" className="btn" onClick={onClose} data-testid="if-cancel">Cancel</button>
        <button type="button" className="btn primary" onClick={apply} disabled={!plan?.command || busy} aria-busy={busy} data-testid="if-apply">{adding.length ? `Add ${adding.length} field${adding.length === 1 ? '' : 's'}${withCustomer && plan?.exampleCustomer ? ', save and add the customer' : ''}` : 'Add'}</button>
      </>}>
      <div className="if" data-testid="if-dialog">
        <p className="muted">A data dictionary as a CSV file: one row per field with its name, and if you have them its type, a description and an example. Headings such as “Field name”, “Data type” and “Sample value” are recognised. For a group of fields or a list, write dotted names: “address.city”, “accounts[].number”, “accounts[].transactions[].amount”. Nothing changes until you add the fields.</p>
        <div className="row">
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} data-testid="if-choose">Choose a CSV file…</button>
          <input ref={fileRef} type="file" hidden accept=".csv,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0])} data-testid="if-file" aria-label="Choose a data dictionary file" />
          {fileName && <span className="muted">{fileName}</span>}
        </div>
        <details>
          <summary>Or paste the list</summary>
          <textarea className="textarea if-text" rows={4} value={text} onChange={(e) => { setText(e.target.value); setFileName(null); }} aria-label="Data dictionary as CSV" data-testid="if-text" placeholder={'name,type,description,example\nmonthly_fee,amount,Monthly fee,49.00'} />
        </details>
        {error && <p className="callout error" role="alert" data-testid="if-error">{error}</p>}
        {plan && (
          <>
            <p data-testid="if-columns">
              {plan.columns.name || plan.columns.label ? <>Names from “{plan.columns.name ?? plan.columns.label}”{plan.columns.type ? <>, types from “{plan.columns.type}”</> : ''}{plan.columns.example ? <>, examples from “{plan.columns.example}”</> : ''}{plan.columns.description ? <>, descriptions from “{plan.columns.description}”</> : ''}.</> : null}
              {plan.ignored.length > 0 && <> Not used: {plan.ignored.map((h) => `“${h}”`).join(', ')}.</>}
              {' '}The studio’s data fields have no description of their own: descriptions are shown here only.
            </p>
            {plan.problems.length > 0 && <ul className="callout warning if-problems" data-testid="if-problems">{plan.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
            <div className="if-rows">
              <table className="table if-table" data-testid="if-table">
                <thead><tr><th scope="col">Line</th><th scope="col">Field</th><th scope="col">Read as</th><th scope="col">Example</th><th scope="col">What happens</th></tr></thead>
                <tbody>
                  {plan.proposals.map((p) => (
                    <tr key={p.line} data-testid="if-row" data-key={p.field.key} data-type={p.type} data-skip={p.skip ? 'yes' : 'no'}>
                      <td className="mono">{p.line}</td>
                      <td><strong>{p.field.label || p.name}</strong>{p.inside?.length ? <div className="muted if-small" data-testid="if-inside">In {p.inside.map((x) => `“${x}”`).join(', in ')}</div> : null}{p.description && <div className="muted if-small">{p.description}</div>}</td>
                      <td>{TYPE_LABEL[p.type]}{p.field.enumValues ? `: ${p.field.enumValues.join(', ')}` : ''}{p.typeNote && <div className="if-small if-note" data-testid="if-type-note">{p.typeNote}</div>}</td>
                      <td>{p.example === null ? '—' : String(p.example)}{p.exampleProblem && <div className="if-small if-note" data-testid="if-example-note">{p.exampleProblem}</div>}</td>
                      <td>{p.skip ? <span className="if-small" data-testid="if-skip"><span className="chip warning">Not added</span> {p.skip}</span> : <span className="chip accent">Added</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label className="if-cust"><input type="checkbox" checked={withCustomer && !!plan.exampleCustomer} disabled={!plan.exampleCustomer} onChange={(e) => setWithCustomer(e.target.checked)} data-testid="if-customer" /> Also make one synthetic customer from the examples (this saves the document first). <span className="muted" data-testid="if-customer-note">{plan.exampleCustomerNote}</span></label>
          </>
        )}
      </div>
    </Dialog>
  );
}
