import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CATALOG_BY_TYPE, WORKFLOW_LABEL, type Project, type ProjectDiff, type RuleChange, type ValueChange } from '@iss/model';
import { api, ApiFailure, type VersionDto, type VersionMeta } from '../api/client';
import { editBlockedReason, useIsDirty, useStudio } from '../state/store';
import { Proof, Tech } from '../ui/common';
import { Icon } from '../ui/icons';
import { actionSentence, nodeTitle, predicateSentence, ruleSentence } from '../ui/plain';
import { ChangeSummaryCard } from '../assist/ChangeSummaryCard';
import { fmtAbs, When } from '../ui/time';
import { useDrawers } from './drawers';
import { useModal } from './CommandPalette';
import './collab.css';

/* ------------------------------------------------------------------ drawer state + frame */

/** Right-hand modal panel with focus trap, Esc to close and focus return. */
export function Drawer({ title, sub, testId, wide, onClose, children, labelId }: { title: string; sub?: ReactNode; testId: string; wide?: boolean; onClose: () => void; children: ReactNode; labelId: string }) {
  const ref = useRef<HTMLElement>(null);
  useModal(true, onClose, ref);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus() ?? ref.current?.querySelector<HTMLElement>('button')?.focus(); }, []);
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className={`drawer${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelId} data-testid={testId} ref={ref}>
        <header>
          <h2 id={labelId}>{title}</h2>
          {sub && <span className="sub">{sub}</span>}
          <button type="button" className="btn ghost icon close" onClick={onClose} aria-label={`Close ${title}`}><Icon.close /></button>
        </header>
        {children}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ time helpers */

/* ------------------------------------------------------------------ plain-language change list */

const LOCALE_NAME: Record<string, string> = { 'en-US': 'English', 'es-US': 'Spanish' };
const FIELD_WORD: Record<string, string> = {
  effective: 'period in effect', variantPeriods: 'periods of the alternatives', totalFrom: 'table total',
  name: 'name', layout: 'position & size', text: 'text', content: 'text', binding: 'data field', formatter: 'number format', label: 'label', nullPolicy: 'empty-value handling',
  fallbackText: 'fallback text', visibleWhen: 'visibility condition', children: 'contents', variantIds: 'alternatives', fallbackVariantId: 'default alternative',
  variantConditions: 'alternative conditions', styleId: 'text style', columns: 'table columns', chart: 'chart settings', image: 'image', shape: 'shape', locked: 'lock',
  a11y: 'accessibility label', decorative: 'decorative setting', required: 'required setting', protected: 'protection', jurisdiction: 'jurisdictions', caption: 'caption',
  importance: 'importance', domainRole: 'domain role', contentPartId: 'linked wording', policy: 'selection policy', ruleDriven: 'shown-by-rule setting', repeatHeader: 'header repeat',
  flowContinuation: 'continuation', sortable: 'sorting', filterable: 'filtering', action: 'link', qr: 'QR code', explanation: 'explanation', headerFooter: 'header/footer text',
  primary: 'primary colour', accent: 'accent colour', fontFamily: 'font', logoDataUri: 'logo', logoAlt: 'logo description',
  accessiblePdfRequired: 'The “Accessible PDF is required” setting',
};
const word = (f: string) => FIELD_WORD[f] ?? f.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const short = (s: string | null, n = 140) => (s === null ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s);
const typeLabel = (t: string) => CATALOG_BY_TYPE[t as keyof typeof CATALOG_BY_TYPE]?.label ?? t;

function OldNew({ from, to, quote = true }: { from: string | null; to: string | null; quote?: boolean }) {
  const q = (s: string) => (quote ? `“${short(s)}”` : short(s));
  if (from === null && to !== null) return <>set to <span className="diff-new" title={to}>{q(to)}</span></>;
  if (to === null && from !== null) return <><span className="diff-old" title={from}>{q(from)}</span> removed</>;
  return <><span className="diff-old" title={from ?? ''}>{q(from ?? '')}</span> → <span className="diff-new" title={to ?? ''}>{q(to ?? '')}</span></>;
}

function Item({ kind, children, tech }: { kind: 'add' | 'del' | 'chg'; children: ReactNode; tech?: ReactNode }) {
  return (
    <li className={`diff-item ${kind}`}>
      <span className="mark" aria-hidden="true">{kind === 'add' ? '+' : kind === 'del' ? '−' : '~'}</span>
      <span className="what"><span className="sr-only">{kind === 'add' ? 'Added: ' : kind === 'del' ? 'Removed: ' : 'Changed: '}</span>{children}{tech && <Tech><span className="tech">{tech}</span></Tech>}</span>
    </li>
  );
}

function componentChangeLine(c: ValueChange): ReactNode {
  if (c.field === 'name') return <>renamed <OldNew from={c.from} to={c.to} /></>;
  if (c.field === 'text') return <>text <OldNew from={c.from} to={c.to} /></>;
  if (c.field === 'layout') return <>{word('layout')}: <OldNew from={c.from} to={c.to} quote={false} /></>;
  if (c.field === 'children' || c.field === 'variantIds') return <>{word(c.field)} changed</>;
  if (['label', 'fallbackText', 'caption', 'binding'].includes(c.field)) return <>{word(c.field)} <OldNew from={c.from} to={c.to} /></>;
  if (c.field === 'effective') return <>in effect <OldNew from={c.from ?? 'always'} to={c.to ?? 'always'} quote={false} /></>;
  if (c.field === 'variantPeriods') return <>periods of the alternatives <OldNew from={c.from ?? 'none'} to={c.to ?? 'none'} quote={false} /></>;
  return <>{word(c.field)} changed</>;
}

function ruleChangeParts(project: Project, c: RuleChange): ReactNode[] {
  const out: ReactNode[] = [];
  if (c.enabled) out.push(c.enabled.to ? 'turned on' : 'turned off');
  if (c.priority) out.push(<>priority {c.priority.to > c.priority.from ? 'raised' : 'lowered'} ({c.priority.from} → {c.priority.to})</>);
  if (c.condition) out.push(<>now applies when <span className="diff-new">{predicateSentence(project, c.after.when)}</span> <span className="sub">was: {predicateSentence(project, c.before.when)}</span></>);
  if (c.action) out.push(<>now will <span className="diff-new">{actionSentence(project, c.after)}</span> <span className="sub">was: {actionSentence(project, c.before)}</span></>);
  if (c.title) out.push(<>title <OldNew from={c.title.from} to={c.title.to} /></>);
  if (c.mode) out.push(<>mode {c.mode.from} → {c.mode.to}</>);
  if (c.period) out.push(<>in effect <span className="diff-new">{c.period.to}</span> <span className="sub">was: {c.period.from}</span></>);
  const rest = c.fields.filter((f) => !['enabled', 'priority', 'when', 'then', 'title', 'mode', 'version', 'effective'].includes(f));
  if (rest.length) out.push(<>{rest.map(word).join(', ')} changed</>);
  if (!out.length && c.fields.includes('version')) out.push('rule version number changed');
  return out;
}

const join = (parts: ReactNode[]) => parts.map((p, i) => <span key={i}>{i ? '; ' : ''}{p}</span>);

/** Readable change list for a structural diff. Business: plain words. Technical: adds ids, field names and expressions. */
export function DiffView({ diff, project, testId = 'history-diff' }: { diff: ProjectDiff; project: Project; testId?: string }) {
  const nTitle = (id: string, fallback: string) => (project.nodes.some((n) => n.id === id) ? nodeTitle(project, id) : fallback);
  if (diff.summary.identical) return <div className="diff-empty" data-testid={testId}>No differences — these versions have the same content.</div>;
  const groups: Array<{ key: string; title: string; items: ReactNode[] }> = [];
  const g = (key: string, title: string, items: ReactNode[]) => { if (items.length) groups.push({ key, title, items }); };
  g('title', 'Project', diff.title ? [<Item key="t" kind="chg">Project title <OldNew from={diff.title.from} to={diff.title.to} /></Item>] : []);
  g('components', 'Components', [
    ...diff.components.added.map((c) => <Item key={`a${c.id}`} kind="add" tech={`${c.id} · ${c.type}`}>Added <strong>“{c.name}”</strong> ({typeLabel(c.type)})</Item>),
    ...diff.components.removed.map((c) => <Item key={`r${c.id}`} kind="del" tech={`${c.id} · ${c.type}`}>Removed <strong>“{c.name}”</strong> ({typeLabel(c.type)})</Item>),
    ...diff.components.changed.map((c) => (
      <Item key={`c${c.id}`} kind="chg" tech={<>{c.id} · fields: {c.fields.join(', ')}{c.changes.map((x) => <span key={x.field} className="tech">{x.field}: {x.from ?? '∅'} → {x.to ?? '∅'}</span>)}</>}>
        <strong>“{nTitle(c.id, c.name)}”</strong>: {join(c.changes.map(componentChangeLine))}
      </Item>
    )),
  ]);
  g('rules', 'Rules', [
    ...diff.rules.added.map((r) => <Item key={`a${r.id}`} kind="add" tech={`${r.id} · P${r.priority} · ${r.condition} ⇒ ${r.action}`}>New rule: {ruleSentence(project, r.rule)}{!r.enabled && ' (turned off)'}</Item>),
    ...diff.rules.removed.map((r) => <Item key={`r${r.id}`} kind="del" tech={`${r.id} · P${r.priority} · ${r.condition} ⇒ ${r.action}`}>Removed rule: {ruleSentence(project, r.rule)}</Item>),
    ...diff.rules.changed.map((c) => (
      <Item key={`c${c.id}`} kind="chg" tech={<>{c.id} · fields: {c.fields.join(', ')}{c.condition && <span className="tech">when: {c.condition.from} → {c.condition.to}</span>}{c.action && <span className="tech">then: {c.action.from} → {c.action.to}</span>}</>}>
        Rule <strong>“{c.after.title?.trim() || ruleSentence(project, c.after)}”</strong> <span className="chip" style={{ fontSize: 10.5, padding: '0 6px' }}>{c.id}</span>: {join(ruleChangeParts(project, c))}
      </Item>
    )),
  ]);
  g('content', 'Wording', [
    ...diff.content.added.map((c) => <Item key={`a${c.id}`} kind="add" tech={c.id}>New wording <strong>“{c.name}”</strong></Item>),
    ...diff.content.removed.map((c) => <Item key={`r${c.id}`} kind="del" tech={c.id}>Removed wording <strong>“{c.name}”</strong></Item>),
    ...diff.content.renamed.map((c) => <Item key={`n${c.partId}`} kind="chg" tech={c.partId}>Wording renamed <OldNew from={c.from} to={c.to} /></Item>),
    ...diff.content.changed.map((c) => (
      <Item key={`c${c.partId}${c.locale}${c.kind}`} kind={c.from === null ? 'add' : c.to === null ? 'del' : 'chg'} tech={`${c.partId} · ${c.locale} · ${c.kind}`}>
        <strong>“{c.title}”</strong> — {LOCALE_NAME[c.locale] ?? c.locale} {c.kind === 'approved' ? 'approved wording' : 'draft translation'}: <OldNew from={c.from} to={c.to} />
      </Item>
    )),
  ]);
  const named = (key: keyof Pick<ProjectDiff, 'customFields' | 'styles' | 'testCases' | 'journey'>, title: string, noun: string) => g(key, title, [
    ...diff[key].added.map((x) => <Item key={`a${x.id}`} kind="add" tech={x.id}>Added {noun} <strong>“{x.name}”</strong></Item>),
    ...diff[key].removed.map((x) => <Item key={`r${x.id}`} kind="del" tech={x.id}>Removed {noun} <strong>“{x.name}”</strong></Item>),
    ...diff[key].changed.map((x) => <Item key={`c${x.id}`} kind="chg" tech={`${x.id} · ${x.fields.join(', ')}`}>Changed {noun} <strong>“{x.name}”</strong> ({x.fields.map(word).join(', ')})</Item>),
  ]);
  named('customFields', 'Data fields', 'data field');
  named('styles', 'Text styles', 'text style');
  g('brand', 'Brand', diff.brand.changed.map((c) => <Item key={c.field} kind="chg" tech={c.field}>Brand {word(c.field)}: <OldNew from={c.from} to={c.to} quote={false} /></Item>));
  named('testCases', 'Tests', 'test');
  named('journey', 'Journey', 'journey event');
  // Calculations, lookup tables and the document's date (absent on documents that do not use them).
  g('calculations', 'Calculations', [
    ...(diff.calculations?.added ?? []).map((x) => <Item key={`a${x.id}`} kind="add" tech={x.id}>New calculation <strong>“{x.name}”</strong></Item>),
    ...(diff.calculations?.removed ?? []).map((x) => <Item key={`r${x.id}`} kind="del" tech={x.id}>Removed calculation <strong>“{x.name}”</strong></Item>),
    ...(diff.calculations?.changed ?? []).map((x) => <Item key={`c${x.id}`} kind="chg" tech={<>{x.id} · {x.fields.join(', ')}{x.formula && <span className="tech">{x.formula.from} → {x.formula.to}</span>}</>}>Calculation <strong>“{x.name}”</strong> changed ({x.formula ? 'how it is worked out' : x.fields.map(word).join(', ')})</Item>),
  ]);
  g('lookupTables', 'Lookup tables', [
    ...(diff.lookupTables?.added ?? []).map((x) => <Item key={`a${x.id}`} kind="add" tech={x.id}>New lookup table <strong>“{x.name}”</strong></Item>),
    ...(diff.lookupTables?.removed ?? []).map((x) => <Item key={`r${x.id}`} kind="del" tech={x.id}>Removed lookup table <strong>“{x.name}”</strong></Item>),
    ...(diff.lookupTables?.changed ?? []).map((x) => <Item key={`c${x.id}`} kind="chg" tech={`${x.id} · ${x.fields.join(', ')}`}>Lookup table <strong>“{x.name}”</strong> changed{x.rows.from !== x.rows.to ? ` (${x.rows.from} → ${x.rows.to} rows)` : ` (${x.fields.map(word).join(', ')})`}</Item>),
  ]);
  g('documentDate', 'The document’s date', diff.documentDate ? [<Item key="d" kind={diff.documentDate.from === null ? 'add' : diff.documentDate.to === null ? 'del' : 'chg'}>{diff.documentDate.to === null ? 'The document no longer uses its date' : 'Where the document’s date comes from'} <OldNew from={diff.documentDate.from} to={diff.documentDate.to} quote={false} /></Item>] : []);
  g('profiles', 'Output profiles', diff.profiles.changed.map((p) => <Item key={p.id} kind="chg" tech={`${p.id} · ${p.fields.join(', ')}`}>Output settings for <strong>{p.id === 'paged-pdf' ? 'PDF' : p.id === 'html-responsive' ? 'Interactive HTML' : p.id === 'paged-afp-sim' ? 'AFP (simulated)' : p.id}</strong> changed ({p.fields.map(word).join(', ')})</Item>));
  g('other', 'Other', diff.other.map((k) => <Item key={k} kind="chg" tech={k}>{word(k)} changed</Item>));
  return (
    <div data-testid={testId}>
      {groups.map((gr) => (
        <section className="diff-group" key={gr.key} aria-label={gr.title}>
          <h4>{gr.title} <span className="chip">{gr.items.length}</span></h4>
          <ul className="diff">{gr.items}</ul>
        </section>
      ))}
    </div>
  );
}

/** Small summary chips: "2 components · 1 rule". */
export function DiffSummary({ diff }: { diff: ProjectDiff }) {
  const c = diff.summary.counts;
  const parts: Array<[number, string, string]> = [[c.title, 'title', 'title'], [c.components, 'component', 'components'], [c.rules, 'rule', 'rules'], [c.content, 'wording change', 'wording changes'], [c.customFields, 'data field', 'data fields'], [c.styles, 'style', 'styles'], [c.brand, 'brand setting', 'brand settings'], [c.testCases, 'test', 'tests'], [c.journey, 'journey event', 'journey events'], [c.profiles, 'output profile', 'output profiles'], [c.calculations ?? 0, 'calculation', 'calculations'], [c.lookupTables ?? 0, 'lookup table', 'lookup tables'], [c.documentDate ?? 0, 'change to the document’s date', 'changes to the document’s date'], [c.other, 'other change', 'other changes']];
  return <div className="hist-summary">{parts.filter(([n]) => n > 0).map(([n, one, many]) => <span key={one} className="chip info">{n} {n === 1 ? one : many}</span>)}{diff.summary.identical && <span className="chip">No changes</span>}</div>;
}

/* ------------------------------------------------------------------ history panel */

const STEP_WORD: Record<string, string> = { submit: 'Submitted', request_changes: 'Changes requested', approve: 'Approved', publish: 'Published', reopen: 'Back to draft', auto_reopen: 'Back to draft (edited)' };

export function HistoryPanel() {
  const open = useDrawers((s) => s.open === 'history');
  return open ? <HistoryPanelInner /> : null;
}

function HistoryPanelInner() {
  const close = useDrawers((s) => s.close);
  const project = useStudio((s) => s.project)!;
  const serverVersion = useStudio((s) => s.serverVersion);
  const session = useStudio((s) => s.session);
  const dirty = useIsDirty();
  const [versions, setVersions] = useState<VersionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [compareTo, setCompareTo] = useState<number | null>(null);
  const [diff, setDiff] = useState<{ from: VersionMeta; to: VersionMeta; diff: ProjectDiff } | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const pid = project.projectId;
  const readOnly = editBlockedReason(session);

  useEffect(() => {
    let live = true;
    api.versions(pid).then((r) => {
      if (!live) return;
      setVersions(r.versions);
      setSelected((s) => (s !== null && r.versions.some((v) => v.modelVersion === s) ? s : r.versions[1]?.modelVersion ?? r.versions[0]?.modelVersion ?? null));
    }).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [pid, serverVersion]);

  const current = versions?.find((v) => v.current) ?? versions?.[0] ?? null;
  const sel = versions?.find((v) => v.modelVersion === selected) ?? null;
  const prevOf = (v: number) => versions?.find((x) => x.modelVersion < v)?.modelVersion ?? null;
  // Default comparison: the selected version against the current one (or, for the current version, against its predecessor).
  const pair = useMemo<[number, number] | null>(() => {
    if (!sel || !current) return null;
    if (compareTo !== null && compareTo !== sel.modelVersion) return [Math.min(sel.modelVersion, compareTo), Math.max(sel.modelVersion, compareTo)];
    if (sel.modelVersion !== current.modelVersion) return [sel.modelVersion, current.modelVersion];
    const p = prevOf(sel.modelVersion);
    return p === null ? null : [p, sel.modelVersion];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, current, compareTo, versions]);

  useEffect(() => {
    setDiff(null); setDiffErr(null); setConfirming(false);
    if (!pair) return;
    let live = true;
    api.versionDiff(pid, pair[0], pair[1]).then((d) => live && setDiff(d)).catch((e) => live && setDiffErr(e.message));
    return () => { live = false; };
  }, [pid, pair?.[0], pair?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  const restore = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      const r = await api.restoreVersion(pid, sel.modelVersion, useStudio.getState().serverVersion);
      useStudio.getState().replaceProject(r.project);
      useStudio.getState().toast({ kind: 'success', title: `Restored v${r.restoredVersion}`, message: `Saved as v${r.project.modelVersion}. Nothing was deleted — v${current?.modelVersion} stays in the history.` });
      setCompareTo(null);
      setSelected(r.project.modelVersion);
    } catch (e: any) {
      useStudio.getState().toast({ kind: 'error', title: e instanceof ApiFailure && e.code === 'VERSION_CONFLICT' ? 'Restore conflict' : 'Restore failed', message: e.message });
    } finally { setBusy(false); setConfirming(false); }
  };

  const onKeyList = (e: React.KeyboardEvent) => {
    if (!versions || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const i = versions.findIndex((v) => v.modelVersion === selected);
    const next = versions[Math.max(0, Math.min(versions.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { setSelected(next.modelVersion); setCompareTo(null); (document.querySelector(`[data-version="${next.modelVersion}"]`) as HTMLElement | null)?.focus(); }
  };

  const isCurrent = sel && current && sel.modelVersion === current.modelVersion;
  return (
    <Drawer title="Version history" sub={<>{project.title} · {versions ? `${versions.length} saved version${versions.length === 1 ? '' : 's'}` : 'loading…'}</>} testId="history-panel" wide onClose={close} labelId="history-title">
      {error ? <div className="drawer-body"><div className="callout error" role="alert">Could not load the history: {error}</div></div> : !versions ? <div className="drawer-body"><span className="spinner" /> Loading versions…</div> : (
        <div className="hist-body">
          <ol className="hist-list" aria-label="Saved versions, newest first" onKeyDown={onKeyList}>
            {versions.map((v) => (
              <li key={v.modelVersion}>
                <button type="button" className="hist-item" data-testid="history-version" data-version={v.modelVersion} aria-current={v.modelVersion === selected ? 'true' : undefined} onClick={() => { setSelected(v.modelVersion); setCompareTo(null); }} {...(v.modelVersion === selected ? { 'data-autofocus': true } : {})}>
                  <span className="top"><span className="ver">v{v.modelVersion}</span>{v.current && <span className="chip accent">Current</span>}<span className="when"><When iso={v.savedAt} /></span></span>
                  <span className="label">{v.label ?? 'Saved'}</span>
                  <span className="who">{v.savedBy ?? 'Unknown (saved before history tracked users)'}</span>
                  {v.workflow.length > 0 && <span className="wf">{[...v.workflow].reverse().map((w, i) => <span key={i} className={`chip ${w.to === 'approved' || w.to === 'published' ? 'accent' : w.to === 'changes_requested' ? 'warning' : 'info'}`} title={`${WORKFLOW_LABEL[w.from]} → ${WORKFLOW_LABEL[w.to]}${w.user ? ` by ${w.user}` : ''} · ${fmtAbs(w.at)}`}>{STEP_WORD[w.action] ?? WORKFLOW_LABEL[w.to]}</span>)}</span>}
                  <Tech><span className="who mono" title={v.contentDigest}>{v.contentDigest.slice(0, 12)}…</span></Tech>
                </button>
              </li>
            ))}
          </ol>
          <section className="hist-detail" aria-live="polite">
            {!sel ? <div className="diff-empty">Select a version.</div> : (
              <>
                <h3 className="vtitle">v{sel.modelVersion}{isCurrent ? ' · current version' : ''}</h3>
                <p className="hist-meta">{sel.label ?? 'Saved'} · {sel.savedBy ?? 'unknown'} · {fmtAbs(sel.savedAt)}</p>
                <div className="hist-restore">
                  {isCurrent ? <p className="muted" style={{ margin: 0 }}>This is the current version. Pick an older version to restore it.</p> : (
                    <>
                      {dirty && (
                        <div className="callout warning" role="status">
                          You have unsaved changes. Restoring replaces the current model, so save or discard them first.
                          <div className="row" style={{ marginTop: 8 }}>
                            <button type="button" className="btn sm" onClick={() => void useStudio.getState().save()} disabled={!!readOnly}>Save changes</button>
                            <button type="button" className="btn sm danger" onClick={() => void useStudio.getState().discardChanges()} data-testid="history-discard">Discard unsaved changes</button>
                          </div>
                        </div>
                      )}
                      {confirming ? (
                        <div className="callout accent" role="alertdialog" aria-label="Confirm restore">
                          <strong>Restore v{sel.modelVersion}?</strong> This saves a new version v{(current?.modelVersion ?? 0) + 1} with the content of v{sel.modelVersion}. Nothing is deleted — v{current?.modelVersion} stays in the history.
                          <div className="muted" style={{ marginTop: 4 }}>If the document was approved or published, it goes back to draft and needs review again.</div>
                          <div className="row" style={{ marginTop: 8 }}>
                            <button type="button" className="btn primary sm" onClick={restore} disabled={busy} data-testid="history-restore-confirm" data-autofocus>{busy ? 'Restoring…' : `Restore v${sel.modelVersion}`}</button>
                            <button type="button" className="btn sm" onClick={() => setConfirming(false)}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="row">
                          <button type="button" className="btn" onClick={() => setConfirming(true)} disabled={dirty || busy || !!readOnly} title={readOnly ?? (dirty ? 'Save or discard your unsaved changes first' : `Make v${sel.modelVersion} the current version again`)} data-testid="history-restore">
                            <Icon.reset /> Restore this version
                          </button>
                          {readOnly && <span className="muted">{readOnly}.</span>}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div className="hist-compare">
                  {pair ? <span>Changes from <strong>v{pair[0]}</strong> to <strong>v{pair[1]}</strong>{current && pair[1] === current.modelVersion ? ' (current)' : ''}</span> : <span>This is the first saved version.</span>}
                  <label className="row" style={{ gap: 6, marginLeft: 'auto' }}>
                    <span className="muted">Compare with…</span>
                    <select className="select" value={compareTo ?? ''} onChange={(e) => setCompareTo(e.target.value ? Number(e.target.value) : null)} data-testid="history-compare">
                      <option value="">{isCurrent ? 'previous version' : 'current version'}</option>
                      {versions.filter((v) => v.modelVersion !== sel.modelVersion).map((v) => <option key={v.modelVersion} value={v.modelVersion}>v{v.modelVersion}{v.current ? ' (current)' : ''}{v.label ? ` — ${v.label}` : ''}</option>)}
                    </select>
                  </label>
                </div>
                {pair && (
                  <div className="hist-sumbar">
                    <button type="button" className="btn sm" onClick={() => setShowSummary((x) => !x)} aria-expanded={showSummary} aria-controls="hist-summary" data-testid="summary-open"><Icon.ai width={14} height={14} /> {showSummary ? 'Hide summary' : 'Summarise changes'}</button>
                    <span className="muted" style={{ fontSize: 12 }}>A plain-language summary of this comparison, worked out by the studio.</span>
                  </div>
                )}
                {pair && showSummary && (
                  <div id="hist-summary" style={{ marginBottom: 12 }}>
                    <ChangeSummaryCard pid={pid} from={pair[0]} to={pair[1]}
                      fromLabel={`v${pair[0]}${versions.find((v) => v.modelVersion === pair[0])?.workflow.some((w) => w.to === 'approved' || w.to === 'published') ? ' (approved)' : ''}`}
                      toLabel={`v${pair[1]}${current && pair[1] === current.modelVersion ? ' (current)' : ''}`}
                      note={dirty && current && pair[1] === current.modelVersion ? 'Your unsaved changes are not included.' : undefined} />
                  </div>
                )}
                {diffErr && <div className="callout error" role="alert" style={{ marginTop: 10 }}>{diffErr}</div>}
                {pair && !diff && !diffErr && <p className="muted"><span className="spinner" /> Comparing…</p>}
                {diff && (
                  <>
                    <DiffSummary diff={diff.diff} />
                    <DiffView diff={diff.diff} project={project} />
                    <div style={{ marginTop: 12 }}>
                      <Proof label="Version proof">
                        <dl className="kv" style={{ maxWidth: 560 }}>
                          <dt>v{diff.from.modelVersion} content digest</dt><dd className="mono" title={diff.from.contentDigest}>{diff.from.contentDigest.slice(0, 24)}…</dd>
                          <dt>v{diff.to.modelVersion} content digest</dt><dd className="mono" title={diff.to.contentDigest}>{diff.to.contentDigest.slice(0, 24)}…</dd>
                        </dl>
                      </Proof>
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}
