import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MAPPINGS_MAX, TYPE_RULES, defaultMappingName, mappingSlug, nextMappingId, type TargetMapping } from '@iss/model';
import { dataDictionary, mappingChecks, mappingCsv, mappingFile, type MappingCheck } from '@iss/scenarios';
import { useCan, useStudio } from '../state/store';
import { Dialog, Empty, ScreenHeader, Tech } from '../ui/common';
import { Icon } from '../ui/icons';
import { DictionaryView } from './mapping/DictionaryView';
import { ImportTargetList } from './mapping/ImportTargetList';
import { MappingTable, type MappingTableHandle } from './mapping/MappingTable';
import { downloadText, stampNow } from './mapping/model';
import './Mapping.css';

/**
 * Mapping (S26, under Releases): the document's data dictionary and, per production system, a mapping of each field to
 * that system's own field (wave 3, section 3; decision D100: neutral, no system built in). The dictionary is the same
 * function as the release package's data/dictionary.json; the checks are the pure `mappingChecks`. Every edit is one
 * undoable command. Deep link: `?mapping=<id>` (or `?mapping=dictionary`).
 */
export function Mapping() {
  const project = useStudio((s) => s.project)!;
  const canEdit = useCan('edit');
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<null | 'add' | 'edit' | 'remove' | 'import'>(null);
  const tableRef = useRef<MappingTableHandle>(null);
  const mappings = project.mappings ?? [];
  const dict = useMemo(() => dataDictionary(project), [project.documentType, project.customFields, project.calculatedFields, project.lookupTables, project.documentDate, project.nodes, project.rules, project.contentParts, project.journey, project.channels, project.strings]); // eslint-disable-line react-hooks/exhaustive-deps
  const checks = useMemo(() => new Map(mappings.map((m) => [m.id, mappingChecks(project, m, dict)])), [mappings, dict, project]);
  const wanted = params.get('mapping');
  const selected = wanted === 'dictionary' ? null : mappings.find((m) => m.id === wanted) ?? (wanted ? null : mappings[0] ?? null);
  const choose = (id: string) => setParams({ mapping: id }, { replace: true });
  const check = selected ? checks.get(selected.id)! : null;

  const download = (m: TargetMapping, kind: 'json' | 'csv') => {
    const c = checks.get(m.id)!;
    const name = `${project.projectId}-mapping-${mappingSlug(m.name)}`;
    if (kind === 'json') downloadText(`${name}.json`, JSON.stringify(mappingFile(project, m, dict, c), null, 2) + '\n', 'application/json');
    else downloadText(`${name}.csv`, '﻿' + mappingCsv(project, m, dict, c), 'text/csv;charset=utf-8');
  };

  return (
    <section className="screen" data-testid="map-screen">
      <ScreenHeader id="S26" title="Mapping" subtitle="The data dictionary of this document, and for each system that produces it, what that system calls each field. A mapping that is complete when a release is made goes into the release package."
        actions={<button type="button" className="btn sm primary" onClick={() => setDialog('add')} disabled={!canEdit || mappings.length >= MAPPINGS_MAX} data-testid="map-add"><Icon.plus /> Add a mapping</button>} />
      <div className={`screen-body mp-body${selected ? '' : ' mp-two'}`}>
        <aside className="panel" data-side="left" data-side-title="Mappings" aria-label="Data dictionary and mappings">
          <div className="panel-head"><h2 className="section-title">Mappings <span className="chip count">{mappings.length}</span></h2></div>
          <div className="panel-body flush">
            <div className="list-rows" data-testid="map-list">
              <button type="button" className={`mp-item${!selected ? ' selected' : ''}`} aria-current={!selected ? 'true' : undefined} onClick={() => choose('dictionary')} data-testid="map-item-dictionary">
                <span className="mp-item-name">Data dictionary</span>
                <span className="muted mp-small">{dict.fields.filter((f) => f.needed).length} fields the document reads</span>
              </button>
              {mappings.map((m) => {
                const c = checks.get(m.id)!;
                return (
                  <button key={m.id} type="button" className={`mp-item${selected?.id === m.id ? ' selected' : ''}`} aria-current={selected?.id === m.id ? 'true' : undefined} onClick={() => choose(m.id)} data-testid={`map-item-${m.id}`}>
                    <span className="mp-item-name">{m.name}</span>
                    <span className="mp-item-foot">
                      <span className={`chip ${c.complete ? 'accent' : 'warning'}`} data-testid={`map-complete-${m.id}`} data-complete={c.complete ? 'yes' : 'no'}>{c.complete ? 'Complete' : 'Not complete'}</span>
                      <span className="muted mp-small">{c.counts.mapped + c.counts.notNeeded} of {c.counts.required} decided</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {mappings.length === 0 && (
              <div className="mp-empty" data-testid="map-empty">
                <Empty title="No mappings yet" message="A mapping tells the team that produces this document what their system calls each field the document reads, its type there and how it is written. No system is built in: name the system, then fill the mapping in or import the system’s field list. A complete mapping goes into each release package, for an adapter to read.">
                  <button type="button" className="btn primary" onClick={() => setDialog('add')} disabled={!canEdit} data-testid="map-empty-add"><Icon.plus /> Add a mapping</button>
                </Empty>
              </div>
            )}
          </div>
        </aside>

        {!selected ? (
          <div className="panel mp-main" aria-label="Data dictionary"><div className="panel-body"><DictionaryView dict={dict} /></div></div>
        ) : (
          <>
            <div className="panel mp-main" aria-label={`Mapping ${selected.name}`}>
              <div className="panel-body">
                <div className="mp-head" data-testid="map-detail" data-id={selected.id}>
                  <div className="mp-title">
                    <h2 className="mp-name" data-testid="map-name">{selected.name}</h2>
                    <span className="muted">Target system: <strong data-testid="map-system">{selected.system}</strong>{selected.description ? ` · ${selected.description}` : ''}</span>
                    {selected.created && <span className="muted mp-small">Added by {selected.created.by} on {selected.created.at.slice(0, 10)}{selected.changed ? `; last changed by ${selected.changed.by} on ${selected.changed.at.slice(0, 10)}` : ''}</span>}
                    <Tech><span className="chip code">{selected.id}</span></Tech>
                  </div>
                  <div className="mp-actions">
                    <button type="button" className="btn sm" onClick={() => setDialog('import')} disabled={!canEdit} data-testid="map-import-open">Import the target’s field list…</button>
                    <button type="button" className="btn sm" onClick={() => download(selected, 'json')} data-testid="map-download-json"><Icon.download /> JSON</button>
                    <button type="button" className="btn sm" onClick={() => download(selected, 'csv')} data-testid="map-download-csv"><Icon.download /> CSV</button>
                    <button type="button" className="btn sm" onClick={() => setDialog('edit')} disabled={!canEdit} data-testid="map-rename">Rename</button>
                    <button type="button" className="btn sm danger" onClick={() => setDialog('remove')} disabled={!canEdit} data-testid="map-remove"><Icon.trash /> Remove</button>
                  </div>
                </div>
                <p className="mp-small muted" data-testid="map-target-count">{selected.targetFields?.length ? `The target’s field list has ${selected.targetFields.length} fields; pick from it or type a name.` : 'No target field list yet: type each target field’s name, or import the list.'}</p>
                <MappingTable ref={tableRef} mapping={selected} check={check!} canEdit={canEdit} />
              </div>
            </div>
            <aside className="panel mp-side" data-side="right" data-side-title="Checks" aria-label="Checks">
              <ChecksPanel check={check!} onGoTo={(p) => tableRef.current?.goTo(p)} />
            </aside>
          </>
        )}
      </div>
      {dialog === 'add' && <DetailsDialog onClose={() => setDialog(null)} onDone={(id) => { setDialog(null); choose(id); }} existing={mappings} />}
      {dialog === 'edit' && selected && <DetailsDialog mapping={selected} onClose={() => setDialog(null)} onDone={() => setDialog(null)} existing={mappings} />}
      {dialog === 'import' && selected && <ImportTargetList project={project} mapping={selected} dict={dict} onClose={() => setDialog(null)} />}
      {dialog === 'remove' && selected && (
        <Dialog title="Remove this mapping?" onClose={() => setDialog(null)} labelledBy="mp-remove-title"
          footer={<><button type="button" className="btn" onClick={() => setDialog(null)}>Keep it</button><button type="button" className="btn danger" data-testid="map-remove-confirm" onClick={() => { const r = useStudio.getState().dispatch({ type: 'REMOVE_MAPPING', mappingId: selected.id }); setDialog(null); if (r.ok) setParams({}, { replace: true }); }}>Remove</button></>}>
          <p>“{selected.name}” and every decision in it are removed from the working version. Releases already made keep their copy. Undo brings it back.</p>
        </Dialog>
      )}
    </section>
  );
}

function ChecksPanel({ check, onGoTo }: { check: MappingCheck; onGoTo: (path: string) => void }) {
  const problems = check.findings.filter((f) => f.severity === 'problem');
  const notes = check.findings.filter((f) => f.severity === 'note');
  const LABEL: Record<string, string> = { unmapped: 'Not mapped', 'mapped-twice': 'Mapped twice', 'type-clash': 'Type clash', 'stale-entry': 'No longer a field', calculated: 'Calculated', 'lookup-table': 'Lookup table', 'document-date': 'The document’s date', 'not-in-target-list': 'Not in the list', 'amount-format': 'Cents or dollars' };
  const item = (f: MappingCheck['findings'][number], i: number) => (
    <li key={i} data-testid="map-finding" data-kind={f.kind} data-severity={f.severity}>
      <span className={`chip ${f.severity === 'problem' ? 'error' : 'info'}`}>{LABEL[f.kind] ?? f.kind}</span> {f.message}{' '}
      {f.paths.length > 0 && f.kind !== 'stale-entry' && f.kind !== 'lookup-table' && f.kind !== 'document-date' && <button type="button" className="btn sm ghost mp-goto" onClick={() => onGoTo(f.paths[0])} data-testid="map-goto">Go to the row</button>}
    </li>
  );
  return (
    <div className="panel-body mp-checks" data-testid="map-checks" data-complete={check.complete ? 'yes' : 'no'}>
      <h3 className="section-title">Checks</h3>
      <p data-testid="map-summary" role="status">
        <span className={`chip ${check.complete ? 'accent' : 'warning'}`}>{check.complete ? 'Complete' : 'Not complete'}</span>{' '}
        {check.counts.mapped} mapped, {check.counts.notNeeded} not needed, {check.counts.unmapped} not mapped, of {check.counts.required} fields that need a decision.
        {check.counts.clashes > 0 && ` ${check.counts.clashes} type clash${check.counts.clashes === 1 ? '' : 'es'}.`}
        {check.counts.mappedTwice > 0 && ` ${check.counts.mappedTwice} target field${check.counts.mappedTwice === 1 ? '' : 's'} mapped twice.`}
      </p>
      <p className="mp-small muted">Complete means nothing the document reads is left undecided, no target field is mapped from two fields, and no type clashes. Only a complete mapping goes into a release package.</p>
      {problems.length > 0 && <><h4 className="mp-h4">Problems <span className="chip count">{problems.length}</span></h4><ul className="mp-findings">{problems.slice(0, 60).map(item)}{problems.length > 60 && <li className="muted">and {problems.length - 60} more (use “Not mapped” above the table)</li>}</ul></>}
      {notes.length > 0 && <><h4 className="mp-h4">For the target system to know</h4><ul className="mp-findings">{notes.map(item)}</ul></>}
      <details className="mp-rules"><summary>How types are compared</summary><ul>{TYPE_RULES.map((r) => <li key={r}>{r}</li>)}</ul></details>
    </div>
  );
}

function DetailsDialog({ mapping, existing, onClose, onDone }: { mapping?: TargetMapping; existing: TargetMapping[]; onClose: () => void; onDone: (id: string) => void }) {
  const [system, setSystem] = useState(mapping?.system ?? '');
  const [name, setName] = useState(mapping?.name ?? '');
  const [description, setDescription] = useState(mapping?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const finalName = name.trim() || (system.trim() ? defaultMappingName(system) : '');
  const submit = () => {
    const st = useStudio.getState();
    if (mapping) {
      const r = st.dispatch({ type: 'RENAME_MAPPING', mappingId: mapping.id, name: finalName, system, description, stamp: stampNow() });
      if (!r.ok) { if (r.code === 'NO_CHANGE') onDone(mapping.id); else setError(r.message); return; }
      onDone(mapping.id);
      return;
    }
    const id = nextMappingId(existing, finalName);
    const r = st.dispatch({ type: 'ADD_MAPPING', mapping: { id, name: finalName, system, ...(description.trim() ? { description } : {}) }, stamp: stampNow() });
    if (!r.ok) { setError(r.message); return; }
    onDone(id);
  };
  return (
    <Dialog title={mapping ? 'Rename the mapping' : 'Add a mapping'} onClose={onClose} labelledBy="mp-details-title"
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={submit} disabled={!system.trim()} data-testid="map-details-save">{mapping ? 'Save' : 'Add'}</button></>}>
      <form className="mp-form" onSubmit={(e) => { e.preventDefault(); if (system.trim()) submit(); }}>
        <div className="field"><label htmlFor="mp-system">Target system</label>
          <input id="mp-system" className="input" autoFocus value={system} maxLength={80} placeholder="For example, the print house’s composition system" onChange={(e) => setSystem(e.target.value)} data-testid="map-system-input" />
          <span className="hint">No target system is built into the studio: this is the name your teams use for it.</span></div>
        <div className="field"><label htmlFor="mp-name">Name</label>
          <input id="mp-name" className="input" value={name} maxLength={80} placeholder={system.trim() ? defaultMappingName(system) : 'Mapping for …'} onChange={(e) => setName(e.target.value)} data-testid="map-name-input" /></div>
        <div className="field"><label htmlFor="mp-desc">Description (optional)</label>
          <input id="mp-desc" className="input" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} data-testid="map-desc-input" /></div>
        {error && <p className="callout error" role="alert" data-testid="map-details-error">{error}</p>}
      </form>
    </Dialog>
  );
}

export default Mapping;
