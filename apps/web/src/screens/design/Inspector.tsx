import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CATALOG_BY_TYPE, projectFields, getPath, nodeMap, requiredNodeIds, applyCommand, type Command, type FieldDef, type DocNode, type Formatter, type Predicate, type Project } from '@iss/model';
import { describePredicate, indexTree, type Resolution } from '@iss/resolver';
import { useScenarioEngine, useStudio } from '../../state/store';
import { Icon } from '../../ui/icons';
import { Tech, Biz, Named } from '../../ui/common';
import { fieldLabel, predicateSentence, nodeTitle, localeLabel } from '../../ui/plain';
import { insertToken } from './RichTextEditor';
import { ImpactPreview, ReachLine } from '../../ui/ImpactPreview';
import { AssetLibraryDialog, type PickedAsset } from './AssetLibrary';
import { StylesBrandDialog } from './StylesBrand';
import { CommentsTab, useOpenCommentCount } from './Comments';
import { suggestAltText } from '@iss/scenarios';
import { api } from '../../api/client';
import { NeedsAi, useBusy } from '../../assist/common';
import { GuardedSuggestion, WritingHelp, recordAssist, useReadOnlyReason } from '../../assist/WritingHelp';

/** Single-condition editor with a live before-you-save impact preview. */
function ConditionEditor({ project, initial, command, onDone, label }: { project: Project; initial: Predicate | null | undefined; command: (when: Predicate | null) => Command; onDone: () => void; label: string }) {
  const dispatch = useStudio((s) => s.dispatch);
  const fields = projectFields(project).filter((f) => f.type !== 'array' && f.type !== 'string' && f.type !== 'date');
  const leaf = initial && 'path' in initial && 'value' in initial && !Array.isArray((initial as any).value) ? (initial as any) : null;
  const [path, setPath] = useState<string>(leaf?.path ?? fields[0]?.path ?? '');
  const [op, setOp] = useState<string>(leaf?.op && ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(leaf.op) ? leaf.op : 'eq');
  const [value, setValue] = useState<string>(leaf ? String(leaf.value) : '');
  const [none, setNone] = useState(!initial);
  const f: FieldDef | undefined = fields.find((x) => x.path === path);
  const parsed: Predicate | null = useMemo(() => {
    if (none || value === '' || !f) return null;
    const v = f.type === 'bool' ? value === 'true' : ['int', 'cents', 'points'].includes(f.type) ? Number(value) : value;
    if (typeof v === 'number' && Number.isNaN(v)) return null;
    return { op: op as any, path, value: v as any };
  }, [none, value, f, op, path]);
  const valid = none || !!parsed;
  const next = useMemo(() => {
    if (!valid) return null;
    const r = applyCommand(project, command(none ? null : parsed));
    return r.ok ? r.project : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, valid, none, parsed]);
  return (
    <div className="card" style={{ marginTop: 6 }} data-testid="condition-editor" aria-label={label}>
      <label className="row" style={{ gap: 6, fontSize: 12.5 }}><input type="checkbox" checked={none} onChange={(e) => setNone(e.target.checked)} /> No condition (always applies)</label>
      {!none && (
        <div className="row wrap" style={{ alignItems: 'flex-end', marginTop: 6 }}>
          <Field label="Field"><select className="select" value={path} onChange={(e) => { setPath(e.target.value); setValue(''); }} data-testid="cond-path">{fields.map((x) => <option key={x.path} value={x.path}>{x.label} ({x.path})</option>)}</select></Field>
          <Field label="Is"><select className="select" value={op} onChange={(e) => setOp(e.target.value)} data-testid="cond-op">{[['eq', 'equal to'], ['ne', 'not equal to'], ['gt', 'more than'], ['gte', 'at least'], ['lt', 'less than'], ['lte', 'at most']].map(([o, l]) => <option key={o} value={o}>{l}</option>)}</select></Field>
          <Field label="Value">
            {f?.type === 'enum' ? <select className="select" value={value} onChange={(e) => setValue(e.target.value)} data-testid="cond-value"><option value="">Choose…</option>{f.enumValues!.map((v) => <option key={v}>{v}</option>)}</select>
              : f?.type === 'bool' ? <select className="select" value={value} onChange={(e) => setValue(e.target.value)} data-testid="cond-value"><option value="">Choose…</option><option value="true">yes</option><option value="false">no</option></select>
              : <input className="input" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 90 }} inputMode="numeric" data-testid="cond-value" />}
          </Field>
        </div>
      )}
      {next && <div style={{ marginTop: 8 }}><ImpactPreview before={project} after={next} /></div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm primary" disabled={!next} onClick={() => { if (dispatch(command(none ? null : parsed)).ok) onDone(); }} data-testid="cond-save">Save condition</button>
        <button className="btn sm ghost" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}


type Tab = 'content' | 'data' | 'layout' | 'review';
/** Old per-tab test IDs are kept: insp-tab-data now opens "Data & rules"; the old Comments tab ID opens "Review". */
const TABS: Array<[Tab, string, string]> = [['content', 'Content', 'insp-tab-content'], ['data', 'Data & rules', 'insp-tab-data'], ['layout', 'Layout', 'insp-tab-layout'], ['review', 'Review', 'inspector-tab-comments']];
/** Last-used tab survives selection changes and leaving/re-entering the screen (session only). */
let lastTab: Tab = 'content';

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <div className="field"><label>{label}{children}</label>{hint && <span className="hint">{hint}</span>}</div>;
}

/** Text input that commits one command on blur/Enter (one undo step per edit, not per keystroke). */
function CommitInput({ value, onCommit, type = 'text', ariaLabel, testId, inject }: { value: string | number | undefined; onCommit: (v: string) => void; type?: string; ariaLabel?: string; testId?: string; /** Text a person accepted from a suggestion: it goes into the field as an edit, committed on blur or Enter like typing. */ inject?: { text: string; n: number } }) {
  const [draft, setDraft] = useState<string | null>(null);
  const el = useRef<HTMLInputElement>(null);
  useEffect(() => { if (inject && inject.n > 0) { setDraft(inject.text); el.current?.focus(); } }, [inject?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = draft ?? String(value ?? '');
  return (
    <input ref={el} className="input" type={type} value={shown} aria-label={ariaLabel} data-testid={testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== null && draft !== String(value ?? '')) onCommit(draft); setDraft(null); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur(); } }} />
  );
}

export function Inspector({ project, res, nodeId, onEditText }: { project: Project; res: Resolution; nodeId: string | null; onEditText: (id: string) => void }) {
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (t: Tab) => { lastTab = t; setTabState(t); };
  const node = nodeId ? nodeMap(project).get(nodeId) : undefined;
  const rnode = nodeId ? indexTree(res.root).get(nodeId) : undefined;
  const openComments = useOpenCommentCount(node?.id);
  const a11yIssues = node ? res.findings.filter((f) => f.nodeId === node.id && f.source === 'accessibility').length : 0;
  const reviewCount = openComments + a11yIssues;
  return (
    <aside className="panel insp" aria-label="Component inspector" data-testid="component-inspector" data-side="right" data-side-title="Inspector">
      <div className="panel-head">Inspector {node && <span className="sub">{CATALOG_BY_TYPE[node.type].label}</span>}</div>
      {!node || !rnode ? (
        <div className="panel-body"><div className="empty"><strong>No component selected</strong><span>Select a component on the page or in Layers. Use the palette to insert one.</span></div></div>
      ) : (
        <>
          <div className="insp-id">
            <div className="insp-name" title={node.id}>{node.name ?? nodeTitle(project, node.id)}</div>
            <div className="row wrap" style={{ gap: 6 }}>
              <Tech><span className="chip code" data-testid="inspector-node-id" title={node.id}>{node.id}</span><span className="chip code" title="Component code">{CATALOG_BY_TYPE[node.type].code}</span></Tech>
              {rnode.required && <span className="chip">Required</span>}
              {node.locked && <span className="chip warning"><Icon.lock width={12} height={12} /> Locked</span>}
              {node.layout?.paged?.mode === 'fixed' ? <span className="chip info">Fixed anchor</span> : <span className="chip">Flow</span>}
            </div>
            {!rnode.visible && <div className="callout warning" style={{ marginTop: 8 }} data-testid="not-rendered"><strong>Not rendered in this scenario.</strong> {rnode.hiddenReason}</div>}
          </div>
          <div className="tabs insp-tabs" role="tablist" aria-label="Inspector sections">
            {TABS.map(([id, label, tid]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} data-testid={tid}>
                {label}{id === 'review' && reviewCount > 0 && <span className="chip count insp-badge" aria-label={`${reviewCount} open ${reviewCount === 1 ? 'item' : 'items'}`}>{reviewCount}</span>}
              </button>
            ))}
          </div>
          <div className="panel-body" role="tabpanel">
            {tab === 'content' && <ContentTab node={node} project={project} res={res} onEditText={onEditText} />}
            {tab === 'data' && (
              <>
                <section className="insp-sec"><h3 className="insp-h">Data</h3><DataTab node={node} project={project} res={res} /></section>
                <section className="insp-sec"><h3 className="insp-h">Rules</h3><RulesTab node={node} project={project} res={res} /></section>
              </>
            )}
            {tab === 'layout' && <LayoutTab node={node} project={project} />}
            {tab === 'review' && (
              <>
                <section className="insp-sec"><h3 className="insp-h">Comments</h3><CommentsTab nodeId={node.id} /></section>
                <section className="insp-sec"><h3 className="insp-h">Impact</h3><ImpactTab node={node} /></section>
                <section className="insp-sec"><h3 className="insp-h">Accessibility</h3><A11yTab node={node} res={res} /></section>
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

/* ------------------------------------------------------------------ content */

const TEXT_STYLE_TYPES: DocNode['type'][] = ['rich-text', 'bound-field', 'summary-metric', 'disclosure', 'expandable-explanation'];

/** Applies a named text style (A4) to the component; the command validates that the style exists. */
function TextStyleSelect({ node, project }: { node: DocNode; project: Project }) {
  const dispatch = useStudio((s) => s.dispatch);
  const [open, setOpen] = useState(false);
  const styles = project.styles ?? [];
  return (
    <div className="field">
      <label>Text style
        <select className="select" value={node.styleId ?? ''} onChange={(e) => dispatch({ type: 'UPDATE_NODE', nodeId: node.id, patch: { styleId: e.target.value || undefined } as any })} data-testid="text-style-select">
          <option value="">None</option>
          {styles.map((st) => <option key={st.id} value={st.id}>{st.name} ({st.kind})</option>)}
          {node.styleId && !styles.some((st) => st.id === node.styleId) && <option value={node.styleId}>{node.styleId} (missing)</option>}
        </select>
      </label>
      <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)} data-testid="inspector-open-styles">Manage styles & brand…</button>
      {open && <StylesBrandDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function ContentTab({ node, project, res, onEditText }: { node: DocNode; project: Project; res: Resolution; onEditText: (id: string) => void }) {
  const dispatch = useStudio((s) => s.dispatch);
  const fields = projectFields(project);
  const upd = (patch: Partial<DocNode>) => dispatch({ type: 'UPDATE_NODE', nodeId: node.id, patch: patch as any });
  const scalarFields = fields.filter((f) => f.type !== 'array');
  const [library, setLibrary] = useState(false);
  const [altPrompt, setAltPrompt] = useState<string | null>(null);
  const pick = (a: PickedAsset) => {
    if (!node.image) return;
    const r = upd({ image: { ...node.image, src: a.dataUri } });
    setLibrary(false);
    if (r.ok && !node.image.alt.trim() && !node.decorative) setAltPrompt('');
  };
  return (
    <div>
      <Field label="Name"><CommitInput value={node.name} onCommit={(v) => upd({ name: v })} ariaLabel="Component name" /></Field>
      {TEXT_STYLE_TYPES.includes(node.type) && <TextStyleSelect node={node} project={project} />}
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
          <button className="btn" onClick={() => setLibrary(true)} data-testid="choose-image"><Icon.design /> Choose from library…</button>
          {library && <AssetLibraryDialog onClose={() => setLibrary(false)} onPick={pick} />}
          {altPrompt !== null && !node.image.alt.trim() && !node.decorative && (
            <div className="callout warning" style={{ marginTop: 8 }} data-testid="alt-prompt">
              <strong>Describe this image.</strong> Alternative text is required unless the image is purely decorative.
              <input className="input" value={altPrompt} onChange={(e) => setAltPrompt(e.target.value)} aria-label="Alternative text" placeholder="e.g. Aster Card logo" style={{ marginTop: 6 }} data-testid="alt-prompt-input" />
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn sm primary" disabled={!altPrompt.trim()} onClick={() => { if (upd({ image: { ...node.image!, alt: altPrompt.trim() } }).ok) setAltPrompt(null); }}>Save description</button>
                <button className="btn sm ghost" onClick={() => { if (upd({ decorative: true }).ok) setAltPrompt(null); }}>Mark decorative</button>
              </div>
            </div>
          )}
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
  const fields = projectFields(project).filter((f) => f.type !== 'array' && (!q || f.path.toLowerCase().includes(q.toLowerCase()) || f.label.toLowerCase().includes(q.toLowerCase())));
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

/** Plain-language reason a variant appears (Business view). */
function variantWhen(project: Project, node: DocNode, vid: string, ruleIds: string[]): string {
  const rules = ruleIds.map((id) => project.rules.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r);
  if (rules.length) return rules.map((r) => `When ${predicateSentence(project, r.when)}.`).join(' ');
  const cond = node.variantConditions?.[vid];
  if (cond) return `When ${predicateSentence(project, cond)}.`;
  if (node.fallbackVariantId === vid) return 'Used when no other option applies.';
  return node.ruleDriven ? 'Shown by a rule when its conditions match.' : 'No condition set.';
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
  const [editCond, setEditCond] = useState<string | null>(null);
  const [addedAi, setAddedAi] = useState<string | null>(null);
  const fields = projectFields(project).filter((f) => f.type !== 'array' && f.type !== 'string' && f.type !== 'date');
  const parseVal = (path: string, v: string) => { const f = fields.find((x) => x.path === path); if (!f) return v; if (f.type === 'bool') return v === 'true'; if (['int', 'cents', 'points'].includes(f.type)) return Number(v); return v; };
  const slugId = (title: string) => (node.id + '-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).slice(0, 60);
  /** The suggested version of the assistant goes through the same ADD_VARIANT command as "Add variant", with an id that is free. */
  const addSuggested = (title: string, text: string): boolean => {
    const base = slugId(title);
    const taken = (x: string) => !!node.variantIds?.includes(x) || project.contentParts.some((c) => c.id === x);
    let id = base; for (let n = 2; taken(id); n++) id = `${base.slice(0, 56)}-${n}`;
    const r = dispatch({ type: 'ADD_VARIANT', nodeId: node.id, variantId: id, title, text });
    if (!r.ok) return false;
    setEditing(id); setEditText(text); setAddedAi(title);
    return true;
  };
  const add = () => {
    const id = slugId(newTitle);
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
      <ul className="variant-list list-rows">
        {(node.variantIds ?? []).map((vid) => {
          const p = parts.get(vid);
          const rv = rnode?.variants?.items.find((v) => v.id === vid);
          return (
            <li key={vid} className={rv?.selected ? 'selected' : ''} data-testid={`variant-${vid}`}>
              <div className="row"><strong className="grow">{p?.title ?? vid}</strong>{rv?.selected && <span className="chip accent">Selected</span>}{node.fallbackVariantId === vid && <span className="chip">Fallback</span>}</div>
              <Tech><div className="code-line">{vid} · v{p?.version ?? '?'} · rules: {rv?.candidateRuleIds.join(', ') || (node.variantConditions?.[vid] ? describePredicate(node.variantConditions[vid]) : node.ruleDriven ? 'shown by additive rule' : '—')}</div></Tech>
              <Biz><div className="variant-when muted">{variantWhen(project, node, vid, rv?.candidateRuleIds ?? [])}</div></Biz>
              {editing === vid ? (
                <div style={{ marginTop: 6 }}>
                  <textarea className="textarea" value={editText} onChange={(e) => setEditText(e.target.value)} aria-label={`Text for ${vid}`} data-testid="variant-edit-text" />
                  <WritingHelp text={editText} kind="message" locale="en-US" onUse={setEditText} />
                  <ReachLine nodeId={node.id} variantId={vid} />
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
                {node.type === 'conditional-region' && editCond !== vid && <button className="btn sm ghost" onClick={() => setEditCond(vid)} data-testid={`edit-condition-${vid}`}>Edit condition</button>}
                {node.fallbackVariantId !== vid && <button className="btn sm ghost" onClick={() => dispatch({ type: 'UPDATE_NODE', nodeId: node.id, patch: { fallbackVariantId: vid } })}>Make fallback</button>}
                {(node.variantIds?.length ?? 0) > 1 && <button className="btn sm ghost" onClick={() => dispatch({ type: 'REMOVE_VARIANT', nodeId: node.id, variantId: vid })} aria-label={`Remove variant ${vid}`}><Icon.trash width={14} height={14} /></button>}
              </div>
              {editCond === vid && <ConditionEditor project={project} label={`Condition for ${p?.title ?? vid}`} initial={node.variantConditions?.[vid]} command={(when) => ({ type: 'SET_VARIANT_CONDITION', nodeId: node.id, variantId: vid, when })} onDone={() => setEditCond(null)} />}
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
      <div className="wh-row">
        <button className="btn primary" disabled={!newTitle.trim() || !newText.trim()} onClick={add} data-testid="add-variant"><Icon.plus /> Add variant</button>
        <NewVersionAi node={node} project={project} onAdd={addSuggested} />
      </div>
      {addedAi && (
        <div className="callout warning" role="status" data-testid="new-version-reminder">
          <strong>“{addedAi}” was added and is open for editing above.</strong> Nobody receives it yet: {node.type === 'variant-set' ? 'a rule must say who gets it' : 'set its condition (or a rule) to say who gets it'}. Use the Data &amp; rules tab.
          <button type="button" className="btn sm ghost" onClick={() => setAddedAi(null)} aria-label="Dismiss reminder">Dismiss</button>
        </div>
      )}
    </div>
  );
}

/** "Draft a new version with AI": a one-line brief; the model answers in the style of the existing versions. Needs a live model. */
function NewVersionAi({ node, project, onAdd }: { node: DocNode; project: Project; onAdd: (title: string, text: string) => boolean }) {
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState('');
  const [res, setRes] = useState<{ mode: 'ai' | 'unavailable'; message: string; title?: string; text?: string } | null>(null);
  const [busy, run] = useBusy();
  const btn = useRef<HTMLButtonElement>(null);
  const ro = useReadOnlyReason();
  const close = () => { setOpen(false); setRes(null); btn.current?.focus(); };
  const ask = async () => {
    if (!brief.trim()) return;
    setRes(null);
    const r = await run(() => api.assistNewVersion(project.projectId, { nodeId: node.id, brief: brief.trim(), project }));
    if (r) setRes(r);
  };
  const usable = res?.mode === 'ai' && !!res.text?.trim();
  return (
    <>
      <button type="button" className="btn" ref={btn} aria-expanded={open} onClick={() => (open ? close() : setOpen(true))} data-testid="new-version-ai"><Icon.ai width={14} height={14} /> Draft a new version with AI</button>
      {open && (
        <div className="wh-form wh-block" style={{ flexBasis: '100%' }} role="group" aria-label="Draft a new version with AI" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
          <label>What should this version say? (one line)
            <input className="input" value={brief} maxLength={300} onChange={(e) => setBrief(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void ask(); } }} placeholder="e.g. For customers who have just made a late payment" data-testid="new-version-brief" autoFocus />
          </label>
          <span className="wh-count">{brief.length} / 300</span>
          <div className="row wrap" style={{ gap: 6 }}>
            <button type="button" className="btn sm primary" onClick={ask} disabled={busy || !brief.trim()} aria-busy={busy} data-testid="new-version-draft">{busy ? <><span className="spinner" aria-hidden="true" /> Drafting…</> : 'Draft it'}</button>
            <button type="button" className="btn sm ghost" onClick={close}>Close</button>
          </div>
          <div aria-live="polite">
            {res?.mode === 'unavailable' && <NeedsAi message={res.message} />}
            {res?.mode === 'ai' && !usable && <p className="muted" data-testid="new-version-empty">{res.message || 'The assistant did not return a usable version.'}</p>}
            {usable && (
              <div className="as-compare" data-testid="new-version-suggestion" style={{ gridTemplateColumns: '1fr' }}>
                <div className="as-compare-col new">
                  <span className="as-compare-lbl">Suggested version <span className="chip info as-source" data-source="ai" title="Suggested by an AI model. Read it before accepting.">AI suggestion</span></span>
                  <p><strong data-testid="new-version-title">{res!.title?.trim() || 'New version'}</strong></p>
                  <p data-testid="new-version-text">{res!.text}</p>
                </div>
                <div className="as-compare-note">It is added as a new version and opened for editing. It reaches nobody until a rule or condition says who gets it.{ro && <span className="wh-reason">{ro}</span>}</div>
                <div className="row wrap as-card-actions">
                  <button type="button" className="btn primary sm" disabled={!!ro} title={ro ?? undefined} data-testid="new-version-accept" onClick={() => {
                    if (onAdd(res!.title?.trim() || 'New version', res!.text!.trim())) { recordAssist('new-version', `Added an AI-drafted version “${res!.title?.trim() || 'New version'}”`, 'ai'); setRes(null); setBrief(''); setOpen(false); }
                  }}>Add as a new version</button>
                  <button type="button" className="btn ghost sm" onClick={() => setRes(null)} data-testid="new-version-discard">Discard</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** "Suggest a description" for an image with the text-alternative field: built-in first, from the picture with a model on request. */
function AltSuggest({ node, project, onUse }: { node: DocNode; project: Project; onUse: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [ai, setAi] = useState<{ mode: 'ai' | 'unavailable'; message: string; text?: string } | null>(null);
  const [dismissed, setDismissed] = useState({ builtin: false, ai: false });
  const [busy, run] = useBusy();
  const btn = useRef<HTMLButtonElement>(null);
  const built = useMemo(() => suggestAltText(project, node.id), [project, node.id]);
  const now = node.image?.alt ?? '';
  const close = () => { setOpen(false); setAi(null); setDismissed({ builtin: false, ai: false }); btn.current?.focus(); };
  const use = (feature: 'builtin' | 'ai', text: string) => { onUse(text); recordAssist('alt-text', 'Used a suggested image description', feature); close(); };
  return (
    <div className="wh-block">
      <div>
        <button type="button" className="btn sm" ref={btn} aria-expanded={open} onClick={() => (open ? close() : setOpen(true))} data-testid="alt-suggest"><Icon.ai width={12} height={12} /> Suggest a description</button>
      </div>
      {open && (
        <div className="wh-block" role="group" aria-label="Suggested image descriptions" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
          {built && !dismissed.builtin && (
            <GuardedSuggestion original={now} suggestion={built.text} source="builtin" note={<span data-testid="alt-suggest-basis">Based on: {built.basis}.</span>}
              onAccept={() => use('builtin', built.text)} onDiscard={() => setDismissed((d) => ({ ...d, builtin: true }))} />
          )}
          {!built && <p className="muted" data-testid="alt-suggest-none">No built-in suggestion: {node.decorative ? 'the image is marked decorative, so it needs no description.' : 'the component has no name or label to describe it from.'}</p>}
          <div className="row wrap" style={{ gap: 6 }}>
            <button type="button" className="btn sm" disabled={busy} aria-busy={busy} onClick={async () => { setDismissed((d) => ({ ...d, ai: false })); setAi(null); const r = await run(() => api.assistImageDescription(project.projectId, { nodeId: node.id, project })); if (r) setAi(r); }} data-testid="alt-suggest-ai">
              {busy ? <><span className="spinner" aria-hidden="true" /> Looking…</> : 'Describe from the picture (AI)'}
            </button>
          </div>
          <div aria-live="polite">
            {ai?.mode === 'unavailable' && <NeedsAi message={ai.message} />}
            {ai?.mode === 'ai' && !ai.text?.trim() && <p className="muted">{ai.message || 'The assistant did not return a description.'}</p>}
            {ai?.mode === 'ai' && ai.text?.trim() && !dismissed.ai && (
              <GuardedSuggestion original={now} suggestion={ai.text.trim()} source="ai" note="Written by a model from the picture itself. Check it matches what the picture shows."
                onAccept={() => use('ai', ai.text!.trim())} onDiscard={() => setDismissed((d) => ({ ...d, ai: true }))} />
            )}
          </div>
        </div>
      )}
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
      {Object.entries(part?.approvedLocales ?? {}).map(([loc, t]) => <div key={loc} className="insp-locale"><span className="chip" title={loc}>{localeLabel(loc)}</span> <span style={{ fontSize: 12.5 }}>{t}</span></div>)}
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
  const arrays = projectFields(project).filter((f) => f.type === 'array');
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
  const known = new Set(projectFields(project).map((f) => f.path));
  const findings = res.findings.filter((f) => f.nodeId === node.id);
  return (
    <div>
      <div className="section-title"><Biz>Data used</Biz><Tech>Data lineage</Tech></div>
      {rnode.dataLineage.length ? (
        <table className="table"><thead><tr><th><Biz>Field</Biz><Tech>Field path</Tech></th><th className="num"><Biz>Value for this customer</Biz><Tech>Value ({res.recordId})</Tech></th></tr></thead><tbody>
          {rnode.dataLineage.map((p) => <tr key={p} data-path={p} data-testid="lineage-row"><td><Named name={fieldLabel(project, p)} code={p} />{!known.has(p) && <span className="chip error" style={{ marginLeft: 6 }}>unknown</span>}</td><td className="num mono">{JSON.stringify(getPath(ctx, p))?.slice(0, 40) ?? 'null'}</td></tr>)}
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
  const [editVis, setEditVis] = useState(false);
  const rnode = indexTree(res.root).get(node.id)!;
  const related = project.rules.filter((r) => ('targetNodeId' in r.then && r.then.targetNodeId === node.id) || (r.then.op === 'requireNodes' && r.then.nodeIds.includes(node.id)));
  const traceBy = new Map(res.trace.map((t) => [t.ruleId, t]));
  return (
    <div>
      <div className="section-title">Why it appears</div>
      <ul className="reasons">{rnode.visibleBecause.map((r, i) => <li key={i}>{r}</li>)}{!rnode.visible && <li>Not rendered: {rnode.hiddenReason}</li>}</ul>
      <div className="section-title">Show this component only when</div>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="grow" data-testid="visible-when">{node.visibleWhen ? <><Biz>{predicateSentence(project, node.visibleWhen)}</Biz><Tech><span className="mono">{describePredicate(node.visibleWhen)}</span></Tech></> : <span className="muted">Always (no condition)</span>}</span>
        {!editVis && !node.locked && <button className="btn sm ghost" onClick={() => setEditVis(true)} data-testid="edit-visible-when">Edit condition</button>}
      </div>
      {editVis && <ConditionEditor project={project} label="Visibility condition" initial={node.visibleWhen} command={(when) => ({ type: 'UPDATE_NODE', nodeId: node.id, patch: { visibleWhen: when ?? undefined } })} onDone={() => setEditVis(false)} />}
      <div className="section-title">Rules targeting this component</div>
      {!related.length && <p className="muted">No rules target this component.</p>}
      <div className="list-rows insp-rows">
      {related.map((r) => {
        const t = traceBy.get(r.id);
        return (
          <div key={r.id}>
            <div className="row"><strong>{r.id}</strong><span className="chip">{r.mode} · p{r.priority}</span>{t && <span className={`chip ${t.outcome === 'selected' || t.outcome === 'applied' || t.outcome === 'required' ? 'accent' : t.outcome === 'tie' ? 'error' : ''}`}>{t.outcome}</span>}<Link className="btn sm ghost" style={{ marginLeft: 'auto' }} to={`/studio/${project.projectId}/rules-data?rule=${r.id}`}>Open</Link></div>
            <div className="mono muted" style={{ marginTop: 4 }}>IF {describePredicate(r.when)}</div>
            {t && <div className="mono" style={{ fontSize: 11 }}>inputs: {JSON.stringify(t.predicateInputs)}</div>}
          </div>
        );
      })}
      </div>
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
  const project = useStudio((s) => s.project);
  const [inject, setInject] = useState({ text: '', n: 0 });
  return (
    <div>
      {node.type === 'image' && node.image && <Field label="Alternative text"><CommitInput value={node.image.alt} inject={inject} testId="alt-text-input" onCommit={(v) => dispatch({ type: 'UPDATE_NODE', nodeId: node.id, patch: { image: { ...node.image!, alt: v } } })} /></Field>}
      {node.type === 'image' && node.image && project && <AltSuggest node={node} project={project} onUse={(text) => setInject((i) => ({ text, n: i.n + 1 }))} />}
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
