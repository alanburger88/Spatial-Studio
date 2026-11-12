import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CATALOG_BY_TYPE, fieldsFor, getPath, nodeMap, requiredNodeIds, type DocNode, type Formatter, type Predicate, type Project } from '@iss/model';
import { describePredicate, indexTree, type Resolution } from '@iss/resolver';
import { useScenarioEngine, useStudio } from '../../state/store';
import { Icon } from '../../ui/icons';
import { insertToken } from './RichTextEditor';

type Tab = 'content' | 'data' | 'rules' | 'layout' | 'a11y' | 'impact';
const TABS: Array<[Tab, string]> = [['content', 'Content'], ['data', 'Data'], ['rules', 'Rules'], ['layout', 'Layout'], ['a11y', 'Accessibility'], ['impact', 'Impact']];

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <div className="field"><label>{label}{children}</label>{hint && <span className="hint">{hint}</span>}</div>;
}

/** Text input that commits one command on blur/Enter (one undo step per edit, not per keystroke). */
function CommitInput({ value, onCommit, type = 'text', ariaLabel, testId }: { value: string | number | undefined; onCommit: (v: string) => void; type?: string; ariaLabel?: string; testId?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value ?? '');
  return (
    <input className="input" type={type} value={shown} aria-label={ariaLabel} data-testid={testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== null && draft !== String(value ?? '')) onCommit(draft); setDraft(null); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur(); } }} />
  );
}

export function Inspector({ project, res, nodeId, onEditText }: { project: Project; res: Resolution; nodeId: string | null; onEditText: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('content');
  const node = nodeId ? nodeMap(project).get(nodeId) : undefined;
  const rnode = nodeId ? indexTree(res.root).get(nodeId) : undefined;
  return (
    <aside className="panel insp" aria-label="Component inspector" data-testid="component-inspector">
      <div className="panel-head">Inspector {node && <span className="sub">{CATALOG_BY_TYPE[node.type].code} · {CATALOG_BY_TYPE[node.type].label}</span>}</div>
      {!node || !rnode ? (
        <div className="panel-body"><div className="empty"><strong>No component selected</strong><span>Select a component on the page or in Layers. Use the palette to insert one.</span></div></div>
      ) : (
        <>
          <div className="insp-id">
            <div className="insp-name">{node.name ?? node.id}</div>
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="chip accent mono" data-testid="inspector-node-id">{node.id}</span>
              {rnode.required && <span className="chip">Required</span>}
              {node.locked && <span className="chip warning"><Icon.lock width={12} height={12} /> Locked</span>}
              {node.layout?.paged?.mode === 'fixed' ? <span className="chip info">Fixed anchor</span> : <span className="chip">Flow</span>}
            </div>
            {!rnode.visible && <div className="callout warning" style={{ marginTop: 8 }} data-testid="not-rendered"><strong>Not rendered in this scenario.</strong> {rnode.hiddenReason}</div>}
          </div>
          <div className="tabs" role="tablist" aria-label="Inspector sections">
            {TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} data-testid={`insp-tab-${id}`}>{label}</button>)}
          </div>
          <div className="panel-body" role="tabpanel">
            {tab === 'content' && <ContentTab node={node} project={project} res={res} onEditText={onEditText} />}
            {tab === 'data' && <DataTab node={node} project={project} res={res} />}
            {tab === 'rules' && <RulesTab node={node} project={project} res={res} />}
            {tab === 'layout' && <LayoutTab node={node} project={project} />}
            {tab === 'a11y' && <A11yTab node={node} res={res} />}
            {tab === 'impact' && <ImpactTab node={node} />}
          </div>
        </>
      )}
    </aside>
  );
}

/* ------------------------------------------------------------------ content */

function ContentTab({ node, project, res, onEditText }: { node: DocNode; project: Project; res: Resolution; onEditText: (id: string) => void }) {
  const dispatch = useStudio((s) => s.dispatch);
  const fields = fieldsFor(project.documentType);
  const upd = (patch: Partial<DocNode>) => dispatch({ type: 'UPDATE_NODE', nodeId: node.id, patch: patch as any });
  const scalarFields = fields.filter((f) => f.type !== 'array');
  return (
    <div>
      <Field label="Name"><CommitInput value={node.name} onCommit={(v) => upd({ name: v })} ariaLabel="Component name" /></Field>
      {node.type === 'rich-text' && (
        <>
          <button className="btn primary" onClick={() => onEditText(node.id)} data-testid="edit-rich-text"><Icon.design /> Edit text in place</button>
          <p className="muted" style={{ fontSize: 12 }}>Double-click the text on the page to edit. Raw HTML and scripts are never stored.</p>
          <TokenPicker project={project} res={res} />
        </>
      )}
      {(node.type === 'bound-field' || node.type === 'summary-metric') && (
        <>
          <Field label="Label"><CommitInput value={node.label} onCommit={(v) => upd({ label: v })} ariaLabel="Label" testId="field-label" /></Field>
          <Field label="Bound field (allowlisted schema path)" hint={`Current value: ${JSON.stringify(getPath({ ...res.effectiveRecord, claim: (res.effectiveRecord as any).claims?.[0] }, node.binding ?? '')) ?? 'null'}`}>
            <select className="select" value={node.binding} onChange={(e) => { const f = fields.find((x) => x.path === e.target.value); upd({ binding: e.target.value, formatter: f?.type === 'cents' ? 'usd-cents' : f?.type === 'date' ? 'date' : f?.type === 'int' ? 'int' : f?.type === 'points' ? 'points' : 'text' }); }} data-testid="binding-select">
              {!fields.some((f) => f.path === node.binding) && <option value={node.binding}>{node.binding} (unknown!)</option>}
              {scalarFields.map((f) => <option key={f.path} value={f.path}>{f.path} · {f.type}</option>)}
            </select>
          </Field>
          <div className="row">
            <Field label="Formatter"><select className="select" value={node.formatter ?? 'text'} onChange={(e) => upd({ formatter: e.target.value as Formatter })}>{['text', 'usd-cents', 'date', 'int', 'points', 'percent'].map((f) => <option key={f}>{f}</option>)}</select></Field>
            <Field label="Null policy"><select className="select" value={node.nullPolicy ?? 'fallback'} onChange={(e) => upd({ nullPolicy: e.target.value as any })}>{['fallback', 'blank', 'suppress', 'error'].map((f) => <option key={f}>{f}</option>)}</select></Field>
          </div>
          {(node.nullPolicy ?? 'fallback') === 'fallback' && <Field label="Fallback text"><CommitInput value={node.fallbackText} onCommit={(v) => upd({ fallbackText: v })} /></Field>}
          {node.type === 'summary-metric' && <Field label="Importance"><select className="select" value={node.importance ?? 'secondary'} onChange={(e) => upd({ importance: e.target.value as any })}><option>primary</option><option>secondary</option></select></Field>}
        </>
      )}
      {(node.type === 'variant-set' || node.type === 'conditional-region') && <VariantsEditor node={node} project={project} res={res} />}
      {node.type === 'disclosure' && <DisclosureEditor node={node} project={project} />}
      {node.type === 'repeating-table' && <TableEditor node={node} project={project} />}
      {node.type === 'chart' && node.chart && (
        <>
          <Field label="Title"><CommitInput value={node.chart.title} onCommit={(v) => upd({ chart: { ...node.chart!, title: v } })} /></Field>
          <div className="row">
            <Field label="Kind"><select className="select" value={node.chart.kind} onChange={(e) => upd({ chart: { ...node.chart!, kind: e.target.value as any } })}><option value="bar">bar</option><option value="donut">donut</option></select></Field>
            {node.chart.groupBy && <Field label="Top N"><CommitInput type="number" value={node.chart.limit ?? 5} onCommit={(v) => upd({ chart: { ...node.chart!, limit: Math.max(1, Math.min(10, Number(v) || 5)) } })} /></Field>}
          </div>
          <p className="muted" style={{ fontSize: 12 }}>Chart style changes never alter financial values (content digest of amounts is unchanged).</p>
        </>
      )}
      {node.type === 'action-link' && node.action && (
        <>
          <Field label="Action label"><CommitInput value={node.action.label} onCommit={(v) => upd({ action: { ...node.action!, label: v } })} /></Field>
          <Field label="Safe URL (https only)"><CommitInput value={node.action.url} onCommit={(v) => upd({ action: { ...node.action!, url: v } })} /></Field>
          <Field label="Printed fallback"><CommitInput value={node.action.fallbackText} onCommit={(v) => upd({ action: { ...node.action!, fallbackText: v } })} /></Field>
        </>
      )}
      {node.type === 'qr-code' && node.qr && (
        <>
          <Field label="Destination (https only)"><CommitInput value={node.qr.url} onCommit={(v) => upd({ qr: { ...node.qr!, url: v } })} /></Field>
          <Field label="Caption"><CommitInput value={node.qr.caption} onCommit={(v) => upd({ qr: { ...node.qr!, caption: v } })} /></Field>
        </>
      )}
      {node.type === 'expandable-explanation' && node.explanation && (
        <>
          <Field label="Title"><CommitInput value={node.explanation.title} onCommit={(v) => upd({ explanation: { ...node.explanation!, title: v } })} /></Field>
          <Field label="Summary"><CommitInput value={node.explanation.summary} onCommit={(v) => upd({ explanation: { ...node.explanation!, summary: v } })} /></Field>
          <Field label="Details"><CommitInput value={node.explanation.details} onCommit={(v) => upd({ explanation: { ...node.explanation!, details: v } })} /></Field>
        </>
      )}
      {node.type === 'header-footer' && node.headerFooter && (
        <>
          <Field label="Role"><select className="select" value={node.headerFooter.role} onChange={(e) => upd({ headerFooter: { ...node.headerFooter!, role: e.target.value as any } })}><option value="document-header">document-header</option><option value="page-header">page-header (repeats)</option><option value="page-footer">page-footer (repeats)</option></select></Field>
          <Field label="Text (tokens allowed)"><CommitInput value={node.headerFooter.text} onCommit={(v) => upd({ headerFooter: { ...node.headerFooter!, text: v } })} /></Field>
        </>
      )}
      {node.type === 'image' && node.image && (
        <>
          <Field label="Image source"><select className="select" value={node.image.src.startsWith('data:') ? 'upload' : node.image.src} onChange={(e) => e.target.value !== 'upload' && upd({ image: { ...node.image!, src: e.target.value } })}><option value="asset:aster-mark">Aster Card mark (sample)</option><option value="asset:harborcare-mark">HarborCare mark (sample)</option>{node.image.src.startsWith('data:') && <option value="upload">Uploaded image</option>}</select></Field>
          <Field label="Upload PNG/JPEG (≤ 280 KB)">
            <input className="input" type="file" accept="image/png,image/jpeg" onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 280_000) { useStudio.getState().toast({ kind: 'error', title: 'Image too large', message: 'Upload limit is 280 KB.' }); return; }
              const r = new FileReader(); r.onload = () => upd({ image: { ...node.image!, src: String(r.result) } }); r.readAsDataURL(f);
            }} />
          </Field>
          <Field label="Fit"><select className="select" value={node.image.fit ?? 'contain'} onChange={(e) => upd({ image: { ...node.image!, fit: e.target.value as any } })}><option>contain</option><option>cover</option></select></Field>
        </>
      )}
      {node.type === 'shape' && node.shape && (
        <div className="row wrap">
          <Field label="Kind"><select className="select" value={node.shape.kind} onChange={(e) => upd({ shape: { ...node.shape!, kind: e.target.value as any } })}><option>line</option><option>rect</option></select></Field>
          <Field label="Stroke"><input className="input" type="color" value={node.shape.stroke ?? '#4EAF60'} onChange={(e) => upd({ shape: { ...node.shape!, stroke: e.target.value } })} style={{ width: 60, padding: 2 }} /></Field>
          <Field label="Width (pt)"><CommitInput type="number" value={node.shape.strokeWidthPt ?? 1} onCommit={(v) => upd({ shape: { ...node.shape!, strokeWidthPt: Math.max(0.25, Math.min(8, Number(v) || 1)) } })} /></Field>
        </div>
      )}
      {node.type === 'container' && <p className="muted">Section with {node.children?.length ?? 0} children. Set row/column flow in Layout. Drop components onto it to nest them.</p>}
    </div>
  );
}

function TokenPicker({ project, res }: { project: Project; res: Resolution }) {
  const [q, setQ] = useState('');
  const ctx = { ...res.effectiveRecord, claim: (res.effectiveRecord as any).claims?.[0] };
  const fields = fieldsFor(project.documentType).filter((f) => f.type !== 'array' && (!q || f.path.toLowerCase().includes(q.toLowerCase()) || f.label.toLowerCase().includes(q.toLowerCase())));
  return (
    <div data-testid="token-picker">
      <div className="section-title">Field token picker</div>
      <input className="input" placeholder="Search fields…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search fields" style={{ width: '100%', marginBottom: 6 }} />
      <div className="token-list">
        {fields.map((f) => (
          <button key={f.path} className="token-item" onMouseDown={(e) => e.preventDefault()} onClick={() => { if (!insertToken(f.path)) useStudio.getState().toast({ kind: 'warning', title: 'Open the text editor first', message: 'Double-click the rich text on the page, then pick a field.' }); }} data-testid={`token-${f.path}`}>
            <span className="mono">{`{{${f.path}}}`}</span>
            <span className="muted">{f.type}{f.derived ? ' · derived' : ''} · e.g. {JSON.stringify(getPath(ctx, f.path))?.slice(0, 24)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function VariantsEditor({ node, project, res }: { node: DocNode; project: Project; res: Resolution }) {
  const dispatch = useStudio((s) => s.dispatch);
  const rnode = indexTree(res.root).get(node.id);
  const parts = new Map(project.contentParts.map((c) => [c.id, c]));
  const [newTitle, setNewTitle] = useState('');
  const [newText, setNewText] = useState('');
  const [cond, setCond] = useState<{ path: string; op: string; value: string }>({ path: project.documentType === 'eob' ? 'claim.status' : 'card.missedPayments', op: 'eq', value: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const fields = fieldsFor(project.documentType).filter((f) => f.type !== 'array' && f.type !== 'string' && f.type !== 'date');
  const parseVal = (path: string, v: string) => { const f = fields.find((x) => x.path === path); if (!f) return v; if (f.type === 'bool') return v === 'true'; if (['int', 'cents', 'points'].includes(f.type)) return Number(v); return v; };
  const add = () => {
    const id = (node.id + '-' + newTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).slice(0, 60);
    let when: Predicate | undefined;
    if (node.type === 'conditional-region' && cond.value !== '') when = { op: cond.op as any, path: cond.path, value: parseVal(cond.path, cond.value) as any };
    const r = dispatch({ type: 'ADD_VARIANT', nodeId: node.id, variantId: id, title: newTitle, text: newText, when });
    if (r.ok) { setNewTitle(''); setNewText(''); setCond({ ...cond, value: '' }); }
  };
  return (
    <div data-testid="variants-editor">
      <div className="section-title">{node.type === 'variant-set' ? 'Named variants (exclusive)' : `Branches (${node.policy ?? 'exclusive'})`}</div>
      {node.type === 'conditional-region' && (
        <Field label="Policy"><select className="select" value={node.policy ?? 'exclusive'} onChange={(e) => dispatch({ type: 'UPDATE_NODE', nodeId: node.id, patch: { policy: e.target.value as any } })}><option value="exclusive">exclusive (first match)</option><option value="additive">additive (all matches)</option></select></Field>
      )}
      <ul className="variant-list">
        {(node.variantIds ?? []).map((vid) => {
          const p = parts.get(vid);
          const rv = rnode?.variants?.items.find((v) => v.id === vid);
          return (
            <li key={vid} className={rv?.selected ? 'active' : ''} data-testid={`variant-${vid}`}>
              <div className="row"><strong className="grow">{p?.title ?? vid}</strong>{rv?.selected && <span className="chip accent">Selected</span>}{node.fallbackVariantId === vid && <span className="chip">Fallback</span>}</div>
              <div className="mono muted">{vid} · v{p?.version ?? '?'} · rules: {rv?.candidateRuleIds.join(', ') || (node.variantConditions?.[vid] ? describePredicate(node.variantConditions[vid]) : node.ruleDriven ? 'shown by additive rule' : '—')}</div>
              {editing === vid ? (
                <div style={{ marginTop: 6 }}>
                  <textarea className="textarea" value={editText} onChange={(e) => setEditText(e.target.value)} aria-label={`Text for ${vid}`} />
                  <div className="row" style={{ marginTop: 6 }}>
                    <button className="btn sm primary" onClick={() => { if (p) { const r = dispatch({ type: 'UPSERT_CONTENT_PART', part: { ...p, approvedLocales: { ...p.approvedLocales, 'en-US': editText } } }); if (r.ok) setEditing(null); } }}>Save text (new version)</button>
                    <button className="btn sm ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="variant-text">{p?.approvedLocales['en-US']}</div>
              )}
              <div className="row" style={{ gap: 4, marginTop: 4 }}>
                {editing !== vid && <button className="btn sm ghost" onClick={() => { setEditing(vid); setEditText(p?.approvedLocales['en-US'] ?? ''); }}>Edit text</button>}
                {node.fallbackVariantId !== vid && <button className="btn sm ghost" onClick={() => dispatch({ type: 'UPDATE_NODE', nodeId: node.id, patch: { fallbackVariantId: vid } })}>Make fallback</button>}
                {(node.variantIds?.length ?? 0) > 1 && <button className="btn sm ghost" onClick={() => dispatch({ type: 'REMOVE_VARIANT', nodeId: node.id, variantId: vid })} aria-label={`Remove variant ${vid}`}><Icon.trash width={14} height={14} /></button>}
              </div>
            </li>
          );
        })}
      </ul>
      {!node.fallbackVariantId && node.type === 'variant-set' && <div className="callout warning">No fallback variant: if no rule matches, the resolver raises a blocking NO_VARIANT_MATCH.</div>}
      <div className="section-title">Add variant</div>
      <Field label="Title"><input className="input" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} data-testid="new-variant-title" /></Field>
      <Field label="Approved text (tokens like {{customer.givenName}} allowed)"><textarea className="textarea" value={newText} onChange={(e) => setNewText(e.target.value)} data-testid="new-variant-text" /></Field>
      {node.type === 'conditional-region' && (
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="Condition field"><select className="select" value={cond.path} onChange={(e) => setCond({ ...cond, path: e.target.value })} data-testid="new-variant-cond-path">{fields.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}</select></Field>
          <Field label="Op"><select className="select" value={cond.op} onChange={(e) => setCond({ ...cond, op: e.target.value })} data-testid="new-variant-cond-op">{['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].map((o) => <option key={o}>{o}</option>)}</select></Field>
          <Field label="Value"><input className="input" value={cond.value} onChange={(e) => setCond({ ...cond, value: e.target.value })} style={{ width: 110 }} data-testid="new-variant-cond-value" /></Field>
        </div>
      )}
      <button className="btn primary" disabled={!newTitle.trim() || !newText.trim()} onClick={add} data-testid="add-variant"><Icon.plus /> Add variant</button>
    </div>
  );
}

function DisclosureEditor({ node, project }: { node: DocNode; project: Project }) {
  const dispatch = useStudio((s) => s.dispatch);
  const part = project.contentParts.find((c) => c.id === node.contentPartId);
  const [advanced, setAdvanced] = useState(false);
  const [text, setText] = useState(part?.approvedLocales['en-US'] ?? '');
  const [reason, setReason] = useState('');
  return (
    <div>
      <div className="callout accent"><strong>Protected disclosure.</strong> Approved text v{part?.version} · {node.required ? 'mandatory (obligation rule)' : 'optional'} · jurisdiction {node.jurisdiction?.join(', ') || '—'}. It can be repositioned but not deleted or made optional.</div>
      <div className="section-title">Approved text</div>
      {Object.entries(part?.approvedLocales ?? {}).map(([loc, t]) => <div key={loc} className="card" style={{ marginBottom: 6 }}><span className="chip">{loc}</span> <span style={{ fontSize: 12.5 }}>{t}</span></div>)}
      {!advanced ? <button className="btn sm" onClick={() => setAdvanced(true)}>Advanced: new approved version…</button> : (
        <div className="card">
          <Field label="New approved en-US text"><textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} /></Field>
          <Field label="Reason (required for audit)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <button className="btn sm primary" disabled={!reason.trim() || !part} onClick={() => { const r = dispatch({ type: 'UPSERT_CONTENT_PART', part: { ...part!, approvedLocales: { ...part!.approvedLocales, 'en-US': text } }, advanced: true, reason }); if (r.ok) setAdvanced(false); }}>Create version v{(part?.version ?? 0) + 1}</button>
        </div>
      )}
    </div>
  );
}

function TableEditor({ node, project }: { node: DocNode; project: Project }) {
  const dispatch = useStudio((s) => s.dispatch);
  const upd = (patch: Partial<DocNode>) => dispatch({ type: 'UPDATE_NODE', nodeId: node.id, patch: patch as any });
  const arrays = fieldsFor(project.documentType).filter((f) => f.type === 'array');
  const items = arrays.find((a) => a.path === node.binding)?.itemFields ?? [];
  return (
    <div>
      <Field label="Caption"><CommitInput value={node.caption} onCommit={(v) => upd({ caption: v })} /></Field>
      <Field label="Bound collection"><select className="select" value={node.binding} onChange={(e) => upd({ binding: e.target.value })}>{arrays.map((a) => <option key={a.path}>{a.path}</option>)}</select></Field>
      <div className="row wrap">
        <label className="row" style={{ gap: 6, fontSize: 12.5 }}><input type="checkbox" checked={node.flowContinuation !== false} onChange={(e) => upd({ flowContinuation: e.target.checked })} data-testid="toggle-continuation" /> Continue across pages</label>
        <Field label="Repeat heading"><select className="select" value={node.repeatHeader ?? 'always'} onChange={(e) => upd({ repeatHeader: e.target.value as any })}><option value="always">always</option><option value="when-hinted">when rule R10 hints</option><option value="never">never</option></select></Field>
      </div>
      {node.flowContinuation === false && <div className="callout warning">Continuation disabled: rows that do not fit the flow region produce a real composer overflow diagnostic.</div>}
      <div className="section-title">Columns</div>
      {(node.columns ?? []).map((c, i) => (
        <div key={c.key + i} className="row" style={{ marginBottom: 4 }}>
          <span className="mono" style={{ width: 90 }}>{c.key}</span>
          <CommitInput value={c.label} onCommit={(v) => upd({ columns: node.columns!.map((x, j) => (j === i ? { ...x, label: v } : x)) })} ariaLabel={`Label for column ${c.key}`} />
          <button className="btn sm ghost icon" aria-label={`Remove column ${c.key}`} onClick={() => upd({ columns: node.columns!.filter((_, j) => j !== i) })}><Icon.trash width={14} height={14} /></button>
        </div>
      ))}
      <select className="select" value="" onChange={(e) => { const f = items.find((x) => x.key === e.target.value); if (f) upd({ columns: [...(node.columns ?? []), { key: f.key, label: f.label, format: f.type === 'cents' ? 'usd-cents' : f.type === 'date' ? 'date' : 'text', align: f.type === 'cents' ? 'right' : 'left' }] }); }} aria-label="Add column">
        <option value="">+ Add column…</option>
        {items.filter((f) => !(node.columns ?? []).some((c) => c.key === f.key)).map((f) => <option key={f.key} value={f.key}>{f.label} ({f.key})</option>)}
      </select>
    </div>
  );
}

/* --------------------------------------------------------------------- data */

function DataTab({ node, project, res }: { node: DocNode; project: Project; res: Resolution }) {
  const rnode = indexTree(res.root).get(node.id)!;
  const ctx = { ...res.effectiveRecord, claim: (res.effectiveRecord as any).claims?.[0] };
  const known = new Set(fieldsFor(project.documentType).map((f) => f.path));
  const findings = res.findings.filter((f) => f.nodeId === node.id);
  return (
    <div>
      <div className="section-title">Data lineage</div>
      {rnode.dataLineage.length ? (
        <table className="table"><thead><tr><th>Field path</th><th className="num">Value ({res.recordId})</th></tr></thead><tbody>
          {rnode.dataLineage.map((p) => <tr key={p}><td className="mono">{p}{!known.has(p) && <span className="chip error" style={{ marginLeft: 6 }}>unknown</span>}</td><td className="num mono">{JSON.stringify(getPath(ctx, p))?.slice(0, 40) ?? 'null'}</td></tr>)}
        </tbody></table>
      ) : <p className="muted">No data bindings.</p>}
      {rnode.field && <div className="kv" style={{ marginTop: 10 }}><dt>Resolved display</dt><dd>{rnode.field.display || '(blank)'}</dd><dt>Raw</dt><dd className="mono">{JSON.stringify(rnode.field.raw)}</dd>{rnode.field.guarded && <><dt>Domain guard</dt><dd>Liability unconfirmed — not shown as owed</dd></>}</div>}
      {rnode.table && <div className="kv" style={{ marginTop: 10 }}><dt>Rows</dt><dd>{rnode.table.rows.length}</dd><dt>Total</dt><dd>{rnode.table.totalCents !== undefined ? `${rnode.table.totalCents} cents` : '—'}</dd><dt>Repeat heading</dt><dd>{rnode.table.repeatHeader ? 'yes' : 'no'}</dd><dt>Continuation</dt><dd>{rnode.table.continuation ? 'enabled' : 'disabled'}</dd></div>}
      {findings.length > 0 && <><div className="section-title">Findings</div>{findings.map((f, i) => <div key={i} className={`callout ${f.severity === 'blocking' || f.severity === 'error' ? 'error' : 'warning'}`} style={{ marginBottom: 6 }} data-testid="node-finding"><strong>{f.code}</strong> {f.message}</div>)}</>}
    </div>
  );
}

/* -------------------------------------------------------------------- rules */

function RulesTab({ node, project, res }: { node: DocNode; project: Project; res: Resolution }) {
  const rnode = indexTree(res.root).get(node.id)!;
  const related = project.rules.filter((r) => ('targetNodeId' in r.then && r.then.targetNodeId === node.id) || (r.then.op === 'requireNodes' && r.then.nodeIds.includes(node.id)));
  const traceBy = new Map(res.trace.map((t) => [t.ruleId, t]));
  return (
    <div>
      <div className="section-title">Why it appears</div>
      <ul className="reasons">{rnode.visibleBecause.map((r, i) => <li key={i}>{r}</li>)}{!rnode.visible && <li>Not rendered: {rnode.hiddenReason}</li>}</ul>
      <div className="section-title">Rules targeting this component</div>
      {!related.length && <p className="muted">No rules target this component.</p>}
      {related.map((r) => {
        const t = traceBy.get(r.id);
        return (
          <div key={r.id} className="card" style={{ marginBottom: 6 }}>
            <div className="row"><strong>{r.id}</strong><span className="chip">{r.mode} · p{r.priority}</span>{t && <span className={`chip ${t.outcome === 'selected' || t.outcome === 'applied' || t.outcome === 'required' ? 'accent' : t.outcome === 'tie' ? 'error' : ''}`}>{t.outcome}</span>}<Link className="btn sm ghost" style={{ marginLeft: 'auto' }} to={`/studio/${project.projectId}/rules-data?rule=${r.id}`}>Open</Link></div>
            <div className="mono muted" style={{ marginTop: 4 }}>IF {describePredicate(r.when)}</div>
            {t && <div className="mono" style={{ fontSize: 11 }}>inputs: {JSON.stringify(t.predicateInputs)}</div>}
          </div>
        );
      })}
      {node.variantConditions && Object.keys(node.variantConditions).length > 0 && <>
        <div className="section-title">Inline conditions</div>
        {Object.entries(node.variantConditions).map(([v, p]) => <div key={v} className="mono" style={{ fontSize: 12 }}>{v}: {describePredicate(p)}</div>)}
      </>}
    </div>
  );
}

/* ------------------------------------------------------------------- layout */

function LayoutTab({ node, project }: { node: DocNode; project: Project }) {
  const dispatch = useStudio((s) => s.dispatch);
  const profileId = useStudio((s) => s.ctx.profileId);
  const [profile, setProfile] = useState<'paged' | 'html'>(profileId === 'html-responsive' ? 'html' : 'paged');
  const pl = node.layout?.paged ?? { mode: 'flow' as const };
  const hl = node.layout?.html ?? {};
  const set = (layout: any) => dispatch({ type: 'SET_LAYOUT', nodeId: node.id, profile, layout });
  const isRoot = project.nodes.find((n) => n.id === project.rootNodeId)?.children?.includes(node.id);
  const required = requiredNodeIds(project).has(node.id);
  const parent = project.nodes.find((n) => n.children?.includes(node.id));
  const idx = parent?.children?.indexOf(node.id) ?? 0;
  const num = (v: string) => Number(v);
  return (
    <div>
      <div className="segmented" role="group" aria-label="Layout profile" style={{ marginBottom: 10 }}>
        <button aria-pressed={profile === 'paged'} onClick={() => setProfile('paged')}>Paged (PDF / AFP sim)</button>
        <button aria-pressed={profile === 'html'} onClick={() => setProfile('html')}>Interactive HTML</button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Profiles keep separate geometry; switching never overwrites the other profile.</p>
      {profile === 'paged' ? (
        <>
          {isRoot && <Field label="Placement"><select className="select" value={pl.mode} onChange={(e) => set(e.target.value === 'fixed' ? { mode: 'fixed', xPt: pl.xPt ?? 40, yPt: pl.yPt ?? 60, wPt: pl.wPt ?? 200, hPt: pl.hPt ?? 40, pages: pl.pages ?? 'first' } : { mode: 'flow', widthPct: pl.widthPct ?? 100 })} data-testid="layout-mode"><option value="flow">Flow region (paginates)</option><option value="fixed">Fixed anchor (pt)</option></select></Field>}
          {pl.mode === 'fixed' ? (
            <>
              <div className="layout-grid">
                {(['xPt', 'yPt', 'wPt', 'hPt'] as const).map((k) => <Field key={k} label={k.replace('Pt', ' (pt)')}><CommitInput type="number" value={Math.round((pl as any)[k] ?? 0)} onCommit={(v) => set({ [k]: num(v) })} testId={`layout-${k}`} /></Field>)}
              </div>
              <Field label="Pages"><select className="select" value={pl.pages ?? 'first'} onChange={(e) => set({ pages: e.target.value })}><option value="first">First page</option><option value="all">All pages</option><option value="following">Following pages</option></select></Field>
              <div className="row"><span className="muted" style={{ fontSize: 12 }}>Align on page</span>
                <button className="btn sm icon" aria-label="Align left margin" onClick={() => set({ xPt: 40 })}><Icon.alignL /></button>
                <button className="btn sm icon" aria-label="Align page centre" onClick={() => set({ xPt: Math.round((612 - (pl.wPt ?? 100)) / 2) })}><Icon.alignC /></button>
                <button className="btn sm icon" aria-label="Align right margin" onClick={() => set({ xPt: Math.round(572 - (pl.wPt ?? 100)) })}><Icon.alignR /></button>
              </div>
              <p className="muted" style={{ fontSize: 12 }}>Keyboard: arrows nudge 1 pt, Shift+arrows 10 pt.</p>
            </>
          ) : (
            <>
              <Field label={`Width ${pl.widthPct ?? 100}% of region`}><input type="range" min={10} max={100} step={5} value={pl.widthPct ?? 100} onChange={(e) => set({ widthPct: num(e.target.value) })} aria-label="Flow width percent" data-testid="layout-width" /></Field>
              <div className="row"><span className="muted" style={{ fontSize: 12 }}>Align</span>
                {(['left', 'center', 'right'] as const).map((a) => <button key={a} className="btn sm icon" aria-pressed={(pl.align ?? 'left') === a} aria-label={`Align ${a}`} onClick={() => set({ align: a })} data-testid={`align-${a}`}>{a === 'left' ? <Icon.alignL /> : a === 'center' ? <Icon.alignC /> : <Icon.alignR />}</button>)}
              </div>
              <Field label="Space before (pt)"><CommitInput type="number" value={pl.spaceBeforePt ?? 8} onCommit={(v) => set({ spaceBeforePt: Math.max(0, Math.min(72, num(v))) })} /></Field>
              <label className="row" style={{ gap: 6, fontSize: 12.5 }}><input type="checkbox" checked={!!pl.keepWithNext} onChange={(e) => set({ keepWithNext: e.target.checked })} /> Keep with next</label>
              {node.type === 'container' && <Field label="Child direction"><select className="select" value={pl.direction ?? 'column'} onChange={(e) => set({ direction: e.target.value })}><option value="column">column</option><option value="row">row</option></select></Field>}
              <p className="muted" style={{ fontSize: 12 }}>Keyboard: Alt+↑/↓ reorders · Shift+←/→ width ±5%.</p>
            </>
          )}
        </>
      ) : (
        <>
          <Field label="Area"><select className="select" value={hl.area ?? 'main'} onChange={(e) => set({ area: e.target.value })}><option>header</option><option>main</option><option>aside</option><option>footer</option></select></Field>
          <Field label={`Column span ${hl.span ?? 12}/12`}><input type="range" min={1} max={12} value={hl.span ?? 12} onChange={(e) => set({ span: num(e.target.value) })} aria-label="Column span" /></Field>
          <Field label="Order"><CommitInput type="number" value={hl.order ?? 0} onCommit={(v) => set({ order: num(v) })} /></Field>
          <label className="row" style={{ gap: 6, fontSize: 12.5 }}><input type="checkbox" checked={!!hl.hidden} onChange={(e) => set({ hidden: e.target.checked })} /> Hide in HTML (presentation only)</label>
          {hl.hidden && (required || node.type === 'summary-metric' || node.type === 'disclosure') && <div className="callout warning" style={{ marginTop: 6 }}>Hiding a semantic or mandatory node in HTML will fail semantic parity validation.</div>}
        </>
      )}
      <div className="section-title">Arrange</div>
      <div className="row wrap">
        <button className="btn sm" disabled={!parent || idx === 0} onClick={() => parent && dispatch({ type: 'MOVE_NODE', nodeId: node.id, parentId: parent.id, index: idx - 1 })}>Move up</button>
        <button className="btn sm" disabled={!parent || idx >= (parent.children?.length ?? 1) - 1} onClick={() => parent && dispatch({ type: 'MOVE_NODE', nodeId: node.id, parentId: parent.id, index: idx + 1 })}>Move down</button>
        <button className="btn sm" onClick={() => dispatch({ type: 'DUPLICATE_NODE', nodeId: node.id, newId: `${node.id.slice(0, 40)}-copy-${Date.now().toString(36).slice(-4)}` })}><Icon.copy width={14} height={14} /> Duplicate</button>
        <button className="btn sm" onClick={() => dispatch({ type: 'UPDATE_NODE', nodeId: node.id, patch: { locked: !node.locked } })} aria-pressed={!!node.locked}>{node.locked ? <Icon.unlock width={14} height={14} /> : <Icon.lock width={14} height={14} />} {node.locked ? 'Unlock' : 'Lock'}</button>
        <button className="btn sm danger" onClick={() => dispatch({ type: 'DELETE_NODE', nodeId: node.id })} data-testid="delete-node"><Icon.trash width={14} height={14} /> Delete</button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- a11y and impact */

function A11yTab({ node, res }: { node: DocNode; res: Resolution }) {
  const dispatch = useStudio((s) => s.dispatch);
  const findings = res.findings.filter((f) => f.nodeId === node.id && f.source === 'accessibility');
  return (
    <div>
      {node.type === 'image' && node.image && <Field label="Alternative text"><CommitInput value={node.image.alt} onCommit={(v) => dispatch({ type: 'UPDATE_NODE', nodeId: node.id, patch: { image: { ...node.image!, alt: v } } })} /></Field>}
      <Field label="Accessible label override"><CommitInput value={node.a11y?.label} onCommit={(v) => dispatch({ type: 'UPDATE_NODE', nodeId: node.id, patch: { a11y: { ...(node.a11y ?? {}), label: v } } })} /></Field>
      <label className="row" style={{ gap: 6, fontSize: 12.5 }}><input type="checkbox" checked={!!node.decorative} onChange={(e) => dispatch({ type: 'UPDATE_NODE', nodeId: node.id, patch: { decorative: e.target.checked } })} /> Decorative (excluded from semantic parity and screen readers)</label>
      {findings.map((f, i) => <div key={i} className="callout warning" style={{ marginTop: 8 }}>{f.message}</div>)}
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Run Validate &amp; Compare for automated axe-core checks of the exported HTML. Automated checks are not WCAG certification.</p>
    </div>
  );
}

function ImpactTab({ node }: { node: DocNode }) {
  const engine = useScenarioEngine();
  const data = useMemo(() => {
    if (!engine) return null;
    const sc = engine.universe();
    let visible = 0;
    const variants: Record<string, number> = {};
    for (const s of sc) {
      const r = engine.resolveScenario(s);
      const n = indexTree(r.root).get(node.id);
      if (n?.visible) visible++;
      for (const v of n?.variants?.selected ?? []) variants[v] = (variants[v] ?? 0) + 1;
      if (n?.variants?.unresolved) variants['(unresolved)'] = (variants['(unresolved)'] ?? 0) + 1;
    }
    return { total: sc.length, visible, variants };
  }, [engine, node.id]);
  if (!data) return null;
  return (
    <div data-testid="impact-tab">
      <div className="kv"><dt>Seeded records evaluated</dt><dd>{data.total}</dd><dt>Rendered in</dt><dd>{data.visible} ({Math.round((100 * data.visible) / Math.max(1, data.total))}%)</dd></div>
      {Object.keys(data.variants).length > 0 && <>
        <div className="section-title">Variant reach (synthetic count)</div>
        {Object.entries(data.variants).sort((a, b) => b[1] - a[1]).map(([v, c]) => (
          <div key={v} className="reach-row"><span className="mono">{v}</span><span className="reach-bar"><span style={{ width: `${(100 * c) / data.total}%` }} /></span><span className="num">{c}</span></div>
        ))}
      </>}
      <p className="muted" style={{ fontSize: 12 }}>Counts are synthetic seeded records — not customer analytics.</p>
    </div>
  );
}
