import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fieldsFor, type DocumentType, type JourneyEvent, type Scalar } from '@iss/model';
import { explainNode, resolve } from '@iss/resolver';
import { replayJourney, type JourneySnapshot } from '@iss/scenarios';
import { renderInteractiveHtml } from '@iss/renderers';
import { api } from '../api/client';
import { Biz, Dialog, Empty, ErrorState, Loading, Named, Proof, ScreenHeader, Tech } from '../ui/common';
import { fieldLabel, nodeTitle, ruleTitle } from '../ui/plain';
import { Icon } from '../ui/icons';
import { useRecord, useResolution, useStudio } from '../state/store';
import './JourneySimulator.css';

/* ------------------------------------------------------------ event templates */

type Draft = {
  eventType: string;
  day: string;
  label: string;
  issue: boolean;
  effects: Array<{ path: string; value: Scalar }>;
  payload: Array<{ key: string; value: string }>;
  pre: { enabled: boolean; path: string; op: string; value: Scalar };
};

interface Template { label: string; effects: Array<{ path: string; value: Scalar }>; pre?: { path: string; op: string; value: Scalar }; issue?: boolean; day: number; payload?: Record<string, Scalar> }

const TEMPLATES: Record<string, Record<string, Template>> = {
  'credit-statement': {
    'payment.missed': { label: 'Payment missed', day: 30, effects: [{ path: 'card.missedPayments', value: 1 }, { path: 'card.paymentStatus', value: 'overdue' }], payload: { missedAmountCents: 4500 } },
    'assistance.requested': { label: 'Assistance requested', day: 45, effects: [{ path: 'card.assistanceRequested', value: true }], pre: { path: 'card.paymentStatus', op: 'eq', value: 'overdue' }, payload: { requested: true, channel: 'phone' } },
    'arrangement.approved': { label: 'Arrangement approved', day: 60, effects: [{ path: 'card.arrangementStatus', value: 'approved' }], pre: { path: 'card.assistanceRequested', op: 'eq', value: true }, payload: { arrangementMonths: 6 } },
    'payment.received': { label: 'Payment received', day: 70, effects: [{ path: 'card.paymentStatus', value: 'current' }, { path: 'card.missedPayments', value: 0 }] },
    'statement.issued': { label: 'Statement issued', day: 1, effects: [], issue: true },
  },
  eob: {
    'claim.received': { label: 'Claim received', day: 1, effects: [{ path: 'claim.status', value: 'received' }] },
    'claim.adjudicated': { label: 'Claim adjudicated', day: 5, effects: [{ path: 'claim.status', value: 'processed-covered' }], issue: true },
    'claim.review.requested': { label: 'Review requested', day: 20, effects: [{ path: 'claim.status', value: 'denied-pending-review' }, { path: 'claim.liabilityConfirmed', value: false }] },
    'appeal.filed': { label: 'Appeal filed', day: 35, effects: [{ path: 'claim.status', value: 'appeal-filed' }] },
    'appeal.resolved': { label: 'Appeal resolved', day: 50, effects: [{ path: 'claim.status', value: 'appeal-resolved' }] },
  },
};

const fmt = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const short = (h?: string | null, n = 12) => (h ? h.slice(0, n) : '—');
const parseScalar = (s: string): Scalar => (s === 'true' ? true : s === 'false' ? false : s !== '' && !Number.isNaN(Number(s)) ? Number(s) : s);

function toDraft(e: JourneyEvent | null, type: string, docType: string): Draft {
  const t = TEMPLATES[docType]?.[type];
  if (e) {
    const pc = e.preconditions?.[0];
    return {
      eventType: e.eventType, day: String(e.day ?? ''), label: e.label ?? '', issue: e.emits === 'immutable-issued-snapshot',
      effects: e.effects.map((x) => ({ path: x.path, value: x.value })),
      payload: Object.entries(e.payload ?? {}).map(([key, value]) => ({ key, value: String(value) })),
      pre: pc ? { enabled: true, path: pc.path, op: pc.op, value: pc.value } : { enabled: false, path: t?.pre?.path ?? '', op: 'eq', value: t?.pre?.value ?? true },
    };
  }
  return {
    eventType: type, day: String(t?.day ?? ''), label: t?.label ?? type, issue: !!t?.issue,
    effects: (t?.effects ?? []).map((x) => ({ ...x })),
    payload: Object.entries(t?.payload ?? {}).map(([key, value]) => ({ key, value: String(value) })),
    pre: { enabled: !!t?.pre, path: t?.pre?.path ?? '', op: t?.pre?.op ?? 'eq', value: t?.pre?.value ?? true },
  };
}

/* ---------------------------------------------------------- O05 event editor */

function EventEditor({ docType, initial, existingIds, existingEvent, onSave, onClose }: {
  docType: DocumentType;
  initial: Draft;
  existingIds: Set<string>;
  existingEvent: JourneyEvent | null;
  onSave: (e: JourneyEvent) => void;
  onClose: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const prefix = docType === 'eob' ? 'claim.' : docType === 'custom' ? 'custom.' : 'card.';
  const fields = useMemo(() => fieldsFor(docType).filter((f) => f.path.startsWith(prefix) && !f.derived && f.type !== 'array'), [docType, prefix]);
  const fieldOf = (p: string) => fields.find((f) => f.path === p);
  const types = Object.keys(TEMPLATES[docType] ?? {});
  const patch = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  const applyType = (type: string) => {
    if (existingEvent) { patch({ eventType: type }); return; }
    setD(toDraft(null, type, docType));
  };
  const valueInput = (path: string, value: Scalar, onChange: (v: Scalar) => void, label: string) => {
    const f = fieldOf(path);
    if (f?.type === 'bool') return <select className="select" aria-label={label} value={String(value)} onChange={(e) => onChange(e.target.value === 'true')}><option value="true">true</option><option value="false">false</option></select>;
    if (f?.type === 'enum') return <select className="select" aria-label={label} value={String(value)} onChange={(e) => onChange(e.target.value)}>{f.enumValues!.map((v) => <option key={v}>{v}</option>)}</select>;
    if (f && ['int', 'cents', 'points'].includes(f.type)) return <input className="input" type="number" aria-label={label} value={typeof value === 'number' ? value : 0} onChange={(e) => onChange(Math.trunc(Number(e.target.value)))} />;
    return <input className="input" aria-label={label} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  };

  const save = () => {
    const errs: string[] = [];
    const day = Number(d.day);
    if (!Number.isInteger(day) || day < 0 || d.day === '') errs.push('Day must be a whole number, 0 or greater.');
    if (!d.eventType) errs.push('Event type is required.');
    d.effects.forEach((x, i) => { if (!x.path) errs.push(`Effect ${i + 1} needs a field.`); });
    if (d.pre.enabled && !d.pre.path) errs.push('Choose a field for the precondition.');
    d.payload.forEach((p, i) => { if (!p.key.trim()) errs.push(`Payload row ${i + 1} needs a key.`); });
    if (errs.length) { setErrors(errs); return; }
    const slug = d.eventType.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    let eventId = existingEvent?.eventId;
    if (!eventId) { let n = 1; while (existingIds.has(`evt-${slug}-${n}`)) n++; eventId = `evt-${slug}-${n}`; }
    const ev: JourneyEvent = {
      eventId, eventType: d.eventType, day, label: d.label.trim() || undefined,
      ...(existingEvent?.effectiveAt ? { effectiveAt: existingEvent.effectiveAt } : {}),
      payload: Object.fromEntries(d.payload.map((p) => [p.key.trim(), parseScalar(p.value)])),
      effects: d.effects.map((x) => ({ op: 'set' as const, path: x.path, value: x.value })),
      ...(d.pre.enabled ? { preconditions: [{ path: d.pre.path, op: d.pre.op as any, value: d.pre.value }] } : {}),
      emits: d.issue ? 'immutable-issued-snapshot' : 'new-communication-preview',
    };
    onSave(ev);
  };

  return (
    <Dialog title={existingEvent ? `Edit event · ${existingEvent.eventId}` : 'Add journey event'} onClose={onClose} labelledBy="o05-title"
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} data-testid="event-save">{existingEvent ? 'Save event' : 'Add event'}</button></>}>
      <div className="jr-editor" data-testid="event-editor">
        {errors.length > 0 && <div className="callout error" role="alert"><ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}
        <div className="jr-editor-row">
          <div className="field"><label htmlFor="ev-type">Event type</label>
            <select id="ev-type" className="select" value={d.eventType} onChange={(e) => applyType(e.target.value)}>
              {!types.includes(d.eventType) && <option>{d.eventType}</option>}
              {types.map((t) => <option key={t}>{t}</option>)}
            </select></div>
          <div className="field"><label htmlFor="ev-day">Day</label><input id="ev-day" className="input" inputMode="numeric" value={d.day} onChange={(e) => patch({ day: e.target.value })} /></div>
          <div className="field" style={{ gridColumn: 'span 2' }}><label htmlFor="ev-label">Label</label><input id="ev-label" className="input" value={d.label} onChange={(e) => patch({ label: e.target.value })} /></div>
        </div>
        <label className="jr-check"><input type="checkbox" checked={d.issue} onChange={(e) => patch({ issue: e.target.checked })} /> Issue an immutable snapshot at this event (frozen once issued)</label>

        <div className="section-title">Typed effects</div>
        {d.effects.length === 0 && <p className="muted">No effects: the event is recorded but state does not change.</p>}
        {d.effects.map((x, i) => (
          <div className="jr-effect" key={i}>
            <select className="select" aria-label={`Effect ${i + 1} field`} value={x.path} onChange={(e) => { const f = fieldOf(e.target.value); const v: Scalar = f?.type === 'bool' ? true : f?.type === 'enum' ? f.enumValues![0] : f && ['int', 'cents', 'points'].includes(f.type) ? 0 : ''; setD((s) => ({ ...s, effects: s.effects.map((y, j) => (j === i ? { path: e.target.value, value: v } : y)) })); }}>
              {!x.path && <option value="">Choose field…</option>}
              {fields.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}
            </select>
            <span aria-hidden="true">=</span>
            {valueInput(x.path, x.value, (v) => setD((s) => ({ ...s, effects: s.effects.map((y, j) => (j === i ? { ...y, value: v } : y)) })), `Effect ${i + 1} value`)}
            <button className="btn ghost icon" aria-label={`Remove effect ${i + 1}`} onClick={() => setD((s) => ({ ...s, effects: s.effects.filter((_, j) => j !== i) }))}><Icon.trash /></button>
          </div>
        ))}
        <button className="btn sm" onClick={() => setD((s) => ({ ...s, effects: [...s.effects, { path: fields[0].path, value: fields[0].type === 'enum' ? fields[0].enumValues![0] : '' }] }))}><Icon.plus /> Add effect</button>

        <div className="section-title">Precondition (optional)</div>
        <label className="jr-check"><input type="checkbox" checked={d.pre.enabled} onChange={(e) => patch({ pre: { ...d.pre, enabled: e.target.checked, path: d.pre.path || fields[0].path } })} /> Only apply when the prior state satisfies a condition; otherwise the event is skipped</label>
        {d.pre.enabled && (
          <div className="jr-effect">
            <select className="select" aria-label="Precondition field" value={d.pre.path} onChange={(e) => { const f = fieldOf(e.target.value); setD((s) => ({ ...s, pre: { ...s.pre, path: e.target.value, value: f?.type === 'bool' ? true : f?.type === 'enum' ? f.enumValues![0] : 0 } })); }}>
              {fields.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}
            </select>
            <select className="select" aria-label="Precondition operator" value={d.pre.op} onChange={(e) => patch({ pre: { ...d.pre, op: e.target.value } })}>
              {['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].map((o) => <option key={o}>{o}</option>)}
            </select>
            {valueInput(d.pre.path, d.pre.value, (v) => patch({ pre: { ...d.pre, value: v } }), 'Precondition value')}
          </div>
        )}

        <div className="section-title">Payload</div>
        {d.payload.map((p, i) => (
          <div className="jr-effect jr-payload" key={i}>
            <input className="input" aria-label={`Payload ${i + 1} key`} value={p.key} onChange={(e) => setD((s) => ({ ...s, payload: s.payload.map((y, j) => (j === i ? { ...y, key: e.target.value } : y)) }))} />
            <span aria-hidden="true">:</span>
            <input className="input" aria-label={`Payload ${i + 1} value`} value={p.value} onChange={(e) => setD((s) => ({ ...s, payload: s.payload.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)) }))} />
            <button className="btn ghost icon" aria-label={`Remove payload ${i + 1}`} onClick={() => setD((s) => ({ ...s, payload: s.payload.filter((_, j) => j !== i) }))}><Icon.trash /></button>
          </div>
        ))}
        <button className="btn sm" onClick={() => setD((s) => ({ ...s, payload: [...s.payload, { key: '', value: '' }] }))}><Icon.plus /> Add payload field</button>
        <p className="hint muted">Saving creates one undoable model edit (Edit journey events).</p>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------- preview iframe */

function ScaledPreview({ html, title }: { html: string; title: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 520, h: 600 });
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const W = 860;
  const scale = Math.max(0.2, Math.min(1, box.w / W));
  return (
    <div className="jr-frame-wrap" ref={wrap}>
      <iframe title={title} sandbox="allow-scripts" srcDoc={html} style={{ width: W, height: box.h / scale, transform: `scale(${scale})` }} />
    </div>
  );
}

/* -------------------------------------------------------------------- screen */

type ServerState = { status: 'loading' | 'ready' | 'error'; issued: any[]; error?: string };

export function JourneySimulator() {
  const project = useStudio((s) => s.project)!;
  const ctx = useStudio((s) => s.ctx);
  const dispatch = useStudio((s) => s.dispatch);
  const setJourneyCursor = useStudio((s) => s.setJourneyCursor);
  const select = useStudio((s) => s.select);
  const reduced = useStudio((s) => s.reducedMotion);
  const record = useRecord();
  const res = useResolution();
  const navigate = useNavigate();
  const events = project.journey.events;
  const eob = project.documentType === 'eob';
  const cursor = ctx.journeyCursor;
  const base = `/studio/${project.projectId}`;

  const snaps: JourneySnapshot[] = useMemo(() => (record && record.documentType === project.documentType ? replayJourney(project, record, ctx.overrides, ctx.profileId) : []), [project, record, ctx.overrides, ctx.profileId]);
  const idx = cursor === null ? 0 : Math.min(cursor + 1, snaps.length - 1);
  const sel = snaps[idx];
  const prior = idx > 0 ? snaps[idx - 1] : undefined;
  const issuedSnaps = snaps.filter((s) => s.kind === 'issued');
  const firstIssued = issuedSnaps[0];
  const primaryNodeId = useMemo(() => project.nodes.find((n) => n.type === 'variant-set')?.id ?? null, [project]);
  const nodeName = (id: string) => project.nodes.find((n) => n.id === id)?.name ?? id;
  const viewMode = useStudio((st) => st.viewMode);
  const biz = viewMode === 'business';
  const variantName = (v: unknown) => (biz && typeof v === 'string' ? nodeTitle(project, v) : fmt(v));
  const ruleName = (id: string) => { const r = project.rules.find((x) => x.id === id); return biz && r ? ruleTitle(project, r) : id; };

  /* server freeze / verify */
  const [server, setServer] = useState<ServerState>({ status: 'loading', issued: [] });
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    if (!record) return;
    let live = true;
    setServer((s) => ({ ...s, status: 'loading' }));
    const t = setTimeout(() => {
      api.replayJourney({ projectId: project.projectId, recordId: record.recordId, overrides: ctx.overrides, project })
        .then((r) => { if (live) setServer({ status: 'ready', issued: r.issued ?? [] }); })
        .catch((e) => { if (live) setServer({ status: 'error', issued: [], error: e.message }); });
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [project, record, ctx.overrides, reloadTick]);
  const issuedServer = firstIssued ? server.issued.find((i) => i.eventId === firstIssued.eventId) : undefined;

  /* trigger / replay */
  const [announce, setAnnounce] = useState('');
  const [replaying, setReplaying] = useState(false);
  const nextIndex = cursor === null ? 0 : cursor + 1;
  const canTrigger = nextIndex < events.length;
  const trigger = () => {
    if (!canTrigger) return;
    const e = events[nextIndex];
    setJourneyCursor(nextIndex);
    setAnnounce(`Triggered ${e.day ? `Day ${e.day} · ` : ''}${e.label ?? e.eventType}`);
  };
  const startReplay = () => { setJourneyCursor(null); setAnnounce('Replaying from start'); setReplaying(true); };
  useEffect(() => {
    if (!replaying) return;
    if (events.length === 0 || (cursor !== null && cursor >= events.length - 1)) { setReplaying(false); setAnnounce('Replay complete'); return; }
    const t = setTimeout(() => setJourneyCursor(cursor === null ? 0 : cursor + 1), reduced ? 0 : 750);
    return () => clearTimeout(t);
  }, [replaying, cursor, events.length, reduced, setJourneyCursor]);
  useEffect(() => () => setReplaying(false), []);

  /* event editing (undoable model edits) */
  const [editor, setEditor] = useState<{ mode: 'add'; type: string } | { mode: 'edit'; index: number } | null>(null);
  const [addType, setAddType] = useState(Object.keys(TEMPLATES[project.documentType] ?? {})[0] ?? '');
  const closeEditor = useCallback(() => setEditor(null), []);
  const commit = (next: JourneyEvent[]) => dispatch({ type: 'SET_JOURNEY', events: next });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= events.length) return;
    const next = events.slice();
    [next[i], next[j]] = [next[j], next[i]];
    if (commit(next).ok) setAnnounce(`Moved ${events[i].label ?? events[i].eventType} ${dir < 0 ? 'earlier' : 'later'}; journey replayed.`);
  };
  const remove = (i: number) => {
    const next = events.filter((_, k) => k !== i);
    if (commit(next).ok) { if (cursor !== null && cursor >= next.length) setJourneyCursor(next.length ? next.length - 1 : null); setAnnounce(`Removed ${events[i].label ?? events[i].eventType}. Undo is available in the top bar.`); }
  };
  const saveEvent = (e: JourneyEvent) => {
    if (!editor) return;
    const next = events.slice();
    if (editor.mode === 'edit') next[editor.index] = e; else next.push(e);
    if (commit(next).ok) { setEditor(null); if (editor.mode === 'add') setJourneyCursor(next.length - 1); }
  };

  /* compare */
  const [cmpA, setCmpA] = useState<string>('issued');
  const [showCompare, setShowCompare] = useState(true);
  const aSnap = cmpA === 'issued' ? (firstIssued ?? snaps[0]) : snaps[Number(cmpA)];
  const bSnap = sel;

  /* preview */
  const [previewOf, setPreviewOf] = useState<'selected' | 'issued'>('selected');
  const previewHtml = useMemo(() => {
    if (!record || !project) return '';
    try {
      if (previewOf === 'issued' && firstIssued) return renderInteractiveHtml(resolve({ project, record, overrides: ctx.overrides, journeyCursor: firstIssued.cursor, profileId: ctx.profileId }), project);
      return res ? renderInteractiveHtml(res, project) : '';
    } catch (e: any) { return `<p style="font:14px sans-serif;padding:16px">Preview could not be composed: ${String(e.message).replace(/</g, '&lt;')}</p>`; }
  }, [record, project, res, previewOf, firstIssued, ctx.overrides, ctx.profileId]);

  const explanation = useMemo(() => (res && primaryNodeId ? explainNode(res, primaryNodeId) : null), [res, primaryNodeId]);
  const guarded = res?.semanticManifest?.guardedLiabilityNodeIds ?? [];

  if (!record) return <section className="screen" data-testid="journey-view"><ScreenHeader id="S08" title="Journey Simulator" subtitle="" /><Loading label="Loading record…" /></section>;
  if (!sel) return <section className="screen" data-testid="journey-view"><ScreenHeader id="S08" title="Journey Simulator" subtitle="" /><ErrorState message="This record could not be replayed for the open project." /></section>;

  const statePaths = Array.from(new Set([...Object.keys(prior?.state ?? {}), ...Object.keys(sel.state)]));
  const KindChip = ({ s, pending }: { s: JourneySnapshot; pending?: boolean }) => {
    if (s.kind === 'issued') return <span className="chip accent jr-kind"><Icon.lock width={12} height={12} /> Issued · frozen{pending ? ' (not yet reached)' : ''}</span>;
    if (s.kind === 'skipped') return <span className="chip warning jr-kind"><Icon.warning width={12} height={12} /> Skipped</span>;
    if (s.kind === 'baseline') return <span className="chip jr-kind"><Icon.journey width={12} height={12} /> Baseline</span>;
    return <span className="chip variant jr-kind"><Icon.unlock width={12} height={12} /> Preview · recomposable</span>;
  };

  return (
    <section className="screen" data-testid="journey-view">
      <ScreenHeader id="S08" title="Journey Simulator" subtitle="Customer events change what is communicated next, never what was already issued. Replay is deterministic and every state below comes from the shared resolver."
        actions={<>
          <button className="btn" onClick={startReplay} disabled={replaying || events.length === 0} data-testid="replay-journey"><Icon.reset /> Replay from start</button>
          <button className="btn primary" onClick={trigger} disabled={!canTrigger || replaying} data-testid="trigger-event"><Icon.demo /> Trigger next event</button>
        </>} />
      <div className="screen-body jr-body">
        <div className="sr-only" role="status" aria-live="polite">{announce}</div>

        <div className="jr-banner" data-testid="issued-notice">
          <Icon.lock /> <span><strong>The issued {eob ? 'EOB' : 'statement'} is never rewritten.</strong> <span className="muted">Later events create new previews.</span></span>
          <Tech><span className="muted jr-banner-rec">Record <span className="mono">{record.recordId}</span></span></Tech>
        </div>

        {/* timeline */}
        <div className="panel jr-timeline-panel">
          <div className="panel-head"><Icon.journey /> Timeline <span className="sub">Event cards · select one to inspect</span>
            <span className="right"><span className="chip jr-legend"><Icon.lock width={12} height={12} /> Issued / frozen</span><span className="chip variant jr-legend"><Icon.unlock width={12} height={12} /> Preview</span><span className="chip warning jr-legend"><Icon.warning width={12} height={12} /> Skipped</span></span></div>
          <div className="jr-timeline-scroll">
            <ol className="jr-timeline" data-testid="journey-timeline" aria-label="Journey timeline">
              {snaps.map((s, i) => {
                const pending = cursor === null ? s.cursor !== null : s.cursor !== null && s.cursor > cursor;
                const selected = i === idx;
                return (
                  <li key={s.eventId ?? 'baseline'} className={`jr-node jr-${s.kind}${pending ? ' jr-pending' : ''}${selected ? ' jr-selected' : ''}`}>
                    <button className="jr-card" aria-current={selected ? 'step' : undefined} onClick={() => setJourneyCursor(s.cursor)} data-testid={`timeline-card-${s.eventId ?? 'baseline'}`}>
                      <span className="jr-day">{s.cursor === null ? 'Start' : s.day !== null ? `Day ${s.day}` : `Event ${s.cursor + 1}`}</span>
                      <strong className="jr-label">{s.cursor === null ? 'Baseline' : events[s.cursor]?.label ?? events[s.cursor]?.eventType}</strong>
                      {biz ? <span className="jr-type">{s.cursor === null ? 'Record as seeded' : ''}</span> : <span className="mono jr-type">{s.cursor === null ? 'record as seeded' : events[s.cursor]?.eventType}</span>}
                      <KindChip s={s} />
                      {pending && <span className="jr-sub">Not yet triggered</span>}
                      {s.kind === 'skipped' && <span className="jr-sub jr-warn">Precondition not met</span>}
                      {s.kind !== 'baseline' && <span className="jr-sub">Variant · <span className={biz ? '' : 'mono'}>{variantName(Object.values(s.selectedVariants)[0])}</span></span>}
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>

        <div className="jr-grid">
          {/* left: keyboard event list + editing */}
          <div className="panel jr-events">
            <div className="panel-head"><Icon.list /> Events <span className="sub">Keyboard list</span></div>
            <div className="panel-body">
              <ul className="jr-list" aria-label="Journey events">
                <li><button className={`jr-row${cursor === null ? ' sel' : ''}`} onClick={() => setJourneyCursor(null)}><span className="jr-row-main"><strong>Baseline</strong></span></button></li>
                {events.map((e, i) => {
                  const s = snaps[i + 1];
                  const pending = cursor === null || i > cursor;
                  return (
                    <li key={e.eventId} className="jr-row-wrap">
                      <button className={`jr-row${cursor === i ? ' sel' : ''}`} onClick={() => setJourneyCursor(i)} aria-pressed={cursor === i} data-testid={`event-row-${e.eventId}`}>
                        <span className="jr-row-main">
                          <strong>{e.day !== undefined ? `Day ${e.day} · ` : ''}{e.label ?? e.eventType}</strong>
                          <Tech><span className="mono muted">{e.eventType}</span></Tech>
                          <span className="jr-row-state">{s && <KindChip s={s} />}{pending && <span className="muted">pending</span>}</span>
                          {s?.kind === 'skipped' && <span className="jr-warn">{s.skippedReason}</span>}
                        </span>
                      </button>
                      <span className="jr-row-actions" role="group" aria-label={`Actions for ${e.label ?? e.eventType}`}>
                        <button className="btn ghost icon sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${e.label ?? e.eventType} earlier`} title="Move earlier"><Icon.chevron style={{ transform: 'rotate(-90deg)' }} /></button>
                        <button className="btn ghost icon sm" onClick={() => move(i, 1)} disabled={i === events.length - 1} aria-label={`Move ${e.label ?? e.eventType} later`} title="Move later"><Icon.chevron style={{ transform: 'rotate(90deg)' }} /></button>
                        <button className="btn ghost icon sm" onClick={() => setEditor({ mode: 'edit', index: i })} aria-label={`Edit ${e.label ?? e.eventType}`} title="Edit event" data-testid={`event-edit-${e.eventId}`}><Icon.design /></button>
                        <button className="btn ghost icon sm" onClick={() => remove(i)} aria-label={`Remove ${e.label ?? e.eventType}`} title="Remove event" data-testid={`event-remove-${e.eventId}`}><Icon.trash /></button>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {events.length === 0 && <Empty title="No events" message="Add an event to start a journey." />}
              <div className="jr-add">
                <label htmlFor="jr-add-type" className="sr-only">Event type to add</label>
                <select id="jr-add-type" className="select" value={addType} onChange={(e) => setAddType(e.target.value)} data-testid="add-event-type">
                  {Object.entries(TEMPLATES[project.documentType] ?? {}).map(([t, def]) => <option key={t} value={t}>{biz ? (def as { label?: string }).label ?? t : t}</option>)}
                </select>
                <button className="btn" onClick={() => setEditor({ mode: 'add', type: addType })} data-testid="add-event"><Icon.plus /> Add event</button>
              </div>
              
            </div>
          </div>

          {/* middle: detail */}
          <div className="panel jr-detail">
            <div className="panel-head"><Icon.target /> {sel.cursor === null ? 'Baseline' : sel.label} <span className="right"><KindChip s={sel} /></span></div>
            <div className="panel-body">
              {sel.kind === 'skipped' && <div className="callout warning" role="status"><strong>Event skipped.</strong> {sel.skippedReason}</div>}

              <div className="jr-integrity" data-testid="snapshot-integrity" role="status">
                {!firstIssued ? <span className="muted">This journey has no issued snapshot event.</span> : server.status === 'error' ? <span className="muted">Server verification unavailable.</span> : server.status === 'loading' && !issuedServer ? <span className="muted">Verifying issued snapshot…</span> : issuedServer?.verified ? <span className="chip accent"><Icon.lock width={12} height={12} /> Issued {firstIssued.day !== null && firstIssued.day !== undefined ? `Day ${firstIssued.day} ` : ''}statement is unchanged ✓ (verified)</span> : <span className="chip error">Issued snapshot verification failed</span>}
                {firstIssued && (sel.contentDigest === firstIssued.contentDigest ? <span className="chip">This preview matches what was issued</span> : <span className="chip variant">This preview differs from what was issued</span>)}
                {issuedServer?.currentModelWouldDiffer && <span className="chip warning">Current model would compose differently; issued copy unchanged</span>}
              </div>
              <Proof label="Hashes and run" testId="snapshot-proof">
              <div className="jr-hashes">
                <div className="card jr-hash issued">
                  <div className="jr-hash-h"><Icon.lock width={14} height={14} /> Issued snapshot (immutable)</div>
                  {!firstIssued ? <p className="muted">This journey has no issued snapshot event.</p> : server.status === 'error' ? <p className="muted">Server verification unavailable: {server.error}</p> : (
                    <>
                      <div className="mono jr-digest" data-testid="issued-snapshot-hash" title="SHA-256 of the canonical issued snapshot">{issuedServer ? issuedServer.sha256 : server.status === 'loading' ? 'verifying…' : 'not yet issued'}</div>
                      <div className="jr-hash-meta">
                        {issuedServer && <><span className={`chip ${issuedServer.verified ? 'accent' : 'error'}`}>{issuedServer.verified ? 'Verified: hash matches stored bytes' : 'Verification failed'}</span>
                          <span className="muted">Issued {new Date(issuedServer.issuedAt).toLocaleString()}</span>
                          {issuedServer.currentModelWouldDiffer && <span className="chip warning">Current model would compose differently; issued copy unchanged</span>}</>}
                        <span className="muted">{firstIssued.label}</span>
                      </div>
                    </>
                  )}
                </div>
                <div className="card jr-hash preview">
                  <div className="jr-hash-h"><Icon.unlock width={14} height={14} /> Selected preview (recomposable)</div>
                  <div className="mono jr-digest" data-testid="preview-snapshot-hash" title="Content digest of the selected preview run">{sel.contentDigest}</div>
                  <div className="jr-hash-meta"><span className="muted">Run <span className="mono">{sel.runId}</span></span>
                    {firstIssued && (sel.contentDigest === firstIssued.contentDigest ? <span className="chip">Same content as the issued snapshot</span> : <span className="chip variant">Differs from the issued snapshot</span>)}</div>
                </div>
              </div>
              </Proof>

              <div className="section-title">Prior state → resulting state</div>
              <table className="table jr-state" aria-label="State transition">
                <thead><tr><th>{biz ? 'Field' : 'State path'}</th><th>{idx === 0 ? 'Prior' : `Prior (${prior?.cursor === null ? 'Baseline' : `Day ${prior?.day}`})`}</th><th>Resulting</th></tr></thead>
                <tbody>
                  {statePaths.map((p) => {
                    const a = prior?.state[p]; const b = sel.state[p]; const ch = idx > 0 && a !== b;
                    return <tr key={p} className={ch ? 'selected' : ''}><td><Named name={fieldLabel(project, p)} code={p} /></td><td>{idx === 0 ? '—' : fmt(a)}</td><td><strong>{fmt(b)}</strong> {ch && <span className="chip accent">changed</span>}</td></tr>;
                  })}
                </tbody>
              </table>
              {sel.cursor !== null && events[sel.cursor] && (
                <details className="jr-payload-d"><summary>Event payload and effects</summary>
                  <pre className="code">{JSON.stringify({ eventId: events[sel.cursor].eventId, eventType: events[sel.cursor].eventType, day: events[sel.cursor].day, payload: events[sel.cursor].payload, preconditions: events[sel.cursor].preconditions, effects: events[sel.cursor].effects }, null, 2)}</pre></details>
              )}

              <div className="section-title">Selected content variants</div>
              <div className="jr-variants">
                {prior && prior.cursor !== sel.cursor && <div className="muted">Before: {Object.entries(prior.selectedVariants).map(([k, v]) => <span key={k} className="chip" style={{ marginRight: 4 }}>{nodeName(k)}: <span className={biz ? '' : 'mono'}>{variantName(v)}</span></span>)}</div>}
                <div>Now: {Object.entries(sel.selectedVariants).map(([k, v]) => <span key={k} className="chip variant" style={{ marginRight: 4 }}>{nodeName(k)}: <span className={biz ? '' : 'mono'}>{variantName(v)}</span></span>)}</div>
                <div>Matched rules: {sel.matchedRuleIds.map((r) => <span key={r} className="chip" style={{ marginRight: 4 }} title={r}>{ruleName(r)}</span>)}</div>
              </div>

              <div className="section-title">Why this variant</div>
              {explanation ? (
                <div className="card jr-explain" data-testid="journey-explanation">
                  {sel.cursor !== null && sel.kind !== 'skipped' && events[sel.cursor] && sel.changes.length > 0 && (
                    <p><strong>Event {events[sel.cursor].eventType}</strong> ({sel.label}) changed {sel.changes.map((c) => `${c.path} ${fmt(c.before)} → ${fmt(c.after)}`).join(', ')}.</p>
                  )}
                  <p>{explanation.summary}</p>
                  {explanation.evidence.length > 0 && (
                    <table className="table" aria-label="Rule evidence"><thead><tr><th>Rule</th><th>Outcome</th><th>Condition</th></tr></thead>
                      <tbody>{explanation.evidence.map((e, i) => <tr key={i}><td className="mono">{e.ruleId}</td><td>{e.outcome}</td><td>{e.condition}</td></tr>)}</tbody></table>
                  )}
                  <p className="muted jr-src">Source: deterministic resolver trace, run <span className="mono">{explanation.runId}</span></p>
                </div>
              ) : <Empty title="Nothing to explain" message="This document has no variant set." />}

              {eob && (
                <div className="callout warning jr-guard" data-testid="liability-guard"><Icon.warning /> <div><strong>Liability guard.</strong> The engine does not adjudicate coverage. While <span className="mono">claim.liabilityConfirmed</span> is <strong>{fmt(sel.state['claim.liabilityConfirmed'])}</strong>, a denied or pending claim is never shown as an amount-due demand{guarded.length ? ` (${guarded.length} guarded field${guarded.length === 1 ? '' : 's'} withheld in this run)` : ''}.</div></div>
              )}

              {/* compare */}
              <div className="section-title">Compare snapshots <button className="btn ghost sm" onClick={() => setShowCompare((v) => !v)} aria-expanded={showCompare}>{showCompare ? 'Hide' : 'Show'}</button></div>
              {showCompare && aSnap && bSnap && (
                <div className="jr-compare" data-testid="snapshot-compare">
                  <div className="jr-cmp-head">
                    <div className="field"><label htmlFor="cmp-a">Snapshot A</label>
                      <select id="cmp-a" className="select" value={cmpA} onChange={(e) => setCmpA(e.target.value)}>
                        {firstIssued && <option value="issued">Issued · {firstIssued.label}</option>}
                        {snaps.map((s, i) => <option key={i} value={String(i)}>{s.label}{s.kind === 'issued' ? ' (issued)' : s.kind === 'skipped' ? ' (skipped)' : ''}</option>)}
                      </select></div>
                    <div className="field"><label>Snapshot B (selected)</label><div className="input jr-static">{bSnap.label}</div></div>
                  </div>
                  <table className="table jr-cmp" aria-label="Snapshot comparison">
                    <thead><tr><th></th><th>A · {aSnap.label}</th><th>B · {bSnap.label}</th></tr></thead>
                    <tbody>
                      <tr><th scope="row">Selected variants</th>
                        <td>{Object.entries(aSnap.selectedVariants).map(([k, v]) => <div key={k} className="mono">{fmt(v)}</div>)}</td>
                        <td>{Object.entries(bSnap.selectedVariants).map(([k, v]) => <div key={k} className="mono">{fmt(v)} {aSnap.selectedVariants[k] !== v && <span className="chip warning">differs</span>}</div>)}</td></tr>
                      <tr><th scope="row">Matched rules</th><td className="mono">{aSnap.matchedRuleIds.join(', ')}</td><td className="mono">{bSnap.matchedRuleIds.join(', ')}</td></tr>
                      {Array.from(new Set([...Object.keys(aSnap.state), ...Object.keys(bSnap.state)])).map((p) => (
                        <tr key={p}><th scope="row" className="mono">{p}</th><td>{fmt(aSnap.state[p])}</td><td>{fmt(bSnap.state[p])} {aSnap.state[p] !== bSnap.state[p] && <span className="chip warning">differs</span>}</td></tr>
                      ))}
                      <tr><th scope="row">Content digest</th><td className="mono jr-small">{short(aSnap.contentDigest, 16)}</td><td className="mono jr-small">{short(bSnap.contentDigest, 16)} {aSnap.contentDigest !== bSnap.contentDigest ? <span className="chip warning">differs</span> : <span className="chip">identical</span>}</td></tr>
                    </tbody>
                  </table>
                  <div className="jr-cmp-links">
                    <button className="btn" onClick={() => { setJourneyCursor(bSnap.cursor); if (primaryNodeId) select(primaryNodeId); navigate(`${base}/exploded${primaryNodeId ? `/${primaryNodeId}` : ''}`); }} data-testid="compare-open-exploded"><Icon.exploded /> Open in Exploded Document</button>
                    <button className="btn" onClick={() => { setJourneyCursor(bSnap.cursor); navigate(`${base}/page-stack`); }} data-testid="compare-open-page-stack"><Icon.stack /> Open in Page Stack</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* right: preview */}
          <div className="panel jr-docpane">
            <div className="panel-head"><Icon.eye /> Document preview
              <span className="right"><span className="segmented" role="group" aria-label="Preview source">
                <button aria-pressed={previewOf === 'selected'} onClick={() => setPreviewOf('selected')}>Selected</button>
                <button aria-pressed={previewOf === 'issued'} onClick={() => setPreviewOf('issued')} disabled={!firstIssued}>Issued</button>
              </span></span></div>
            <div className="jr-preview-note">{previewOf === 'issued' && firstIssued ? <><Icon.lock width={13} height={13} /> Frozen view of {firstIssued.label}; later events do not alter it.</> : <>Composed live by the resolver for {sel.label} (real interactive HTML output).</>}</div>
            <div className="jr-preview-body"><ScaledPreview html={previewHtml} title={`Document preview for ${previewOf === 'issued' && firstIssued ? firstIssued.label : sel.label}`} /></div>
            <div className="jr-preview-foot">
              {server.status === 'error' && <span className="chip error">Server freeze unavailable</span>}
              <button className="btn sm" onClick={() => setReloadTick((t) => t + 1)} title="Re-freeze and verify issued snapshots on the server"><Icon.reset /> Verify issued snapshot</button>
            </div>
          </div>
        </div>
      </div>

      {editor && (
        <EventEditor
          key={editor.mode === 'edit' ? `e${editor.index}` : `a${editor.type}`}
          docType={project.documentType}
          existingIds={new Set(events.map((e) => e.eventId))}
          existingEvent={editor.mode === 'edit' ? events[editor.index] : null}
          initial={editor.mode === 'edit' ? toDraft(events[editor.index], events[editor.index].eventType, project.documentType) : toDraft(null, editor.type, project.documentType)}
          onSave={saveEvent}
          onClose={closeEditor}
        />
      )}
    </section>
  );
}
