import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { VARIANT_LABEL_MAX, VARIANT_PURPOSE_LABEL, type VariantPurpose } from '@iss/model';
import { ApiFailure, variantApi } from '../../api/client';
import { useStudio } from '../../state/store';
import { Dialog } from '../../ui/common';
import './variants.css';

/**
 * "New variant" (wave 5, design rule 1): a name and what it is for. The variant starts as an exact copy of the base's
 * latest saved version and follows it. Opens the new variant's Overview.
 */
export function NewVariantDialog({ base, onClose }: { base: { projectId: string; title: string }; onClose: () => void }) {
  const [title, setTitle] = useState(`${base.title} — `);
  const [purpose, setPurpose] = useState<VariantPurpose>('region');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();
  const ok = title.trim().length >= 2 && label.trim().length > 0;
  const create = async () => {
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      const r = await variantApi.create(base.projectId, { title: title.trim(), purpose, label: label.trim() });
      await useStudio.getState().loadProjects();
      useStudio.getState().toast({ kind: 'success', title: 'Variant made', message: `“${r.project.title}” follows version ${r.project.variantOf!.modelVersion} of “${base.title}”.${r.customers ? ` It has copies of the ${r.customers} customers of the base.` : ''}` });
      onClose();
      navigate(`/studio/${r.project.projectId}/overview`);
    } catch (e) { setErr(e instanceof ApiFailure ? e.message : String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };
  const what = purpose === 'brand' ? 'Which brand' : purpose === 'region' ? 'Which region' : 'What it is for';
  return (
    <Dialog title={`New variant of “${base.title}”`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={create} disabled={busy || !ok} data-testid="new-variant-create">Make the variant</button></>}>
      <form className="vr-new" onSubmit={(e) => { e.preventDefault(); void create(); }} data-testid="new-variant-dialog">
        <p className="muted">A variant is its own, complete document: it can have its own brand, wording, sections, lookup-table values and rules. The data fields, calculations, page design and the place of the base’s components stay the base’s. It starts as an exact copy of the latest saved version of “{base.title}” and follows it.</p>
        <div className="field">
          <label htmlFor="nv-title">Name of the variant</label>
          <input id="nv-title" className="input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} data-testid="new-variant-title" />
        </div>
        <fieldset className="field vr-purpose">
          <legend>It is for</legend>
          {(Object.keys(VARIANT_PURPOSE_LABEL) as VariantPurpose[]).map((p) => (
            <label key={p} className="row"><input type="radio" name="nv-purpose" value={p} checked={purpose === p} onChange={() => setPurpose(p)} data-testid={`new-variant-purpose-${p}`} /> {VARIANT_PURPOSE_LABEL[p]}</label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="nv-label">{what}</label>
          <input id="nv-label" className="input" value={label} maxLength={VARIANT_LABEL_MAX} placeholder={purpose === 'brand' ? 'For example: Bright Saver' : purpose === 'region' ? 'For example: Lakeshore region' : ''} onChange={(e) => setLabel(e.target.value)} data-testid="new-variant-label" />
        </div>
      </form>
      {err && <p className="callout error" role="alert">{err}</p>}
    </Dialog>
  );
}
