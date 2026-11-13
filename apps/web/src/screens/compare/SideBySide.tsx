import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, SyntheticRecord } from '@iss/model';
import { resolve } from '@iss/resolver';
import type { CustomerComparison, VisibleChange } from '@iss/scenarios';
import { ApiFailure, api, type ScenarioRequest } from '../../api/client';
import { Loading, Named, Tech } from '../../ui/common';
import { localeLabel } from '../../ui/plain';
import { CHANGE_LABEL, OUTPUTS, OUTPUT_LABEL, isPartChange, outputOfChannelChange, sidesOutlined, type Output, type SideId } from './model';
import { HtmlPane, PagesPane, SmsPane, WordMarked, type PaneControl } from './Panes';
import { wordDiff } from './wordDiff';

/** What one side of the comparison is: a frozen release, or the working version. */
export interface SideData { id: SideId; label: string; short: string; project: Project; working: boolean }

const failText = (e: unknown) => (e instanceof ApiFailure ? e.message : e instanceof Error ? e.message : 'That did not work.');

interface Async<T> { data: T | null; error: string | null; loading: boolean; retry: () => void }
/** Runs `run` whenever `deps` change. What it returns is only ever the result for the current `deps` (never a stale one from the previous output). */
function useAsync<T>(run: (() => Promise<T>) | null, deps: unknown[]): Async<T> {
  const [state, setState] = useState<{ run: unknown; data: T | null; error: string | null; loading: boolean }>({ run: null, data: null, error: null, loading: !!run });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!run) { setState({ run, data: null, error: null, loading: false }); return; }
    const my = ++seq.current;
    setState({ run, data: null, error: null, loading: true });
    run().then(
      (data) => { if (seq.current === my) setState({ run, data, error: null, loading: false }); },
      (e) => { if (seq.current === my) setState({ run, data: null, error: failText(e), loading: false }); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const retry = useCallback(() => setTick((t) => t + 1), []);
  if (state.run !== run) return { data: null, error: null, loading: !!run, retry };
  return { data: state.data, error: state.error, loading: state.loading, retry };
}

/** The request for one side. A release side sends its frozen project and shows approved wording only; the working side follows the studio and shows drafts. Blocked customers are composed as marked drafts, so there is always something to look at. */
function requestFor(side: SideData, recordId: string, profileId?: 'paged-pdf' | 'html-responsive'): ScenarioRequest {
  return {
    projectId: side.project.projectId, recordId, project: side.project, overrides: {}, journeyCursor: null, allowDraft: true,
    ...(side.working ? { includeDrafts: true } : {}), ...(profileId ? { outputContext: { profileId } } : {}),
  };
}

function useOutput(output: Output, side: SideData, recordId: string) {
  const run = useMemo(() => {
    switch (output) {
      case 'pdf': return () => api.composePages(requestFor(side, recordId, 'paged-pdf'));
      case 'web': return async () => { const b = await api.composeHtml(requestFor(side, recordId, 'html-responsive')); URL.revokeObjectURL(b.url); return { html: await b.blob.text() }; };
      case 'email': return () => api.composeEmail(requestFor(side, recordId));
      case 'sms': return () => api.composeSms(requestFor(side, recordId));
    }
  }, [output, side, recordId]);
  return useAsync<any>(run, [run]);
}

const sameSet = (a: Set<string> | null, b: Set<string> | null) => a === b || (!!a && !!b && a.size === b.size && [...a].every((x) => b.has(x)));

/* ------------------------------------------------------------ the differences, in words */

function Quoted({ text }: { text: string }) { return <em className="cmp-q">{text ? `“${text.length > 140 ? `${text.slice(0, 139)}…` : text}”` : 'nothing'}</em>; }

function ChangeWords({ c }: { c: VisibleChange }) {
  const d = useMemo(() => (c.kind === 'wording' || c.kind === 'email-sms' ? wordDiff(c.before, c.after) : null), [c]);
  switch (c.kind) {
    case 'message': return <>showed <Quoted text={c.before} />, now shows <Quoted text={c.after} />.</>;
    case 'appears': return <>was not shown, now shows <Quoted text={c.after} />.</>;
    case 'disappears': return <>is no longer shown; it showed <Quoted text={c.before} />.</>;
    case 'layout': return <>is placed or sized differently. The words are the same.</>;
    case 'stopped': return <>a blocker now stops this document{c.after ? `: ${c.after}` : ''}.</>;
    case 'unstopped': return <>no blocker stops this document any more{c.before ? ` (it was stopped: ${c.before})` : ''}.</>;
    case 'language': return <>was <strong>{localeLabel(c.before)}</strong>, now <strong>{localeLabel(c.after)}</strong>.</>;
    default:
      return d ? (
        <>wording changes{d.changedWords ? ` (${d.changedWords} changed ${d.changedWords === 1 ? 'word' : 'words'})` : ''}.
          <span className="cmp-diff-lines">
            <span className="cmp-diff-line"><span className="cmp-diff-tag">Before</span><span><WordMarked pieces={d.before} kind="before" /></span></span>
            <span className="cmp-diff-line"><span className="cmp-diff-tag">After</span><span><WordMarked pieces={d.after} kind="after" /></span></span>
          </span>
        </>
      ) : null;
  }
}

function DiffList({ changes, sel, onSelect, outlinable, output }: { changes: VisibleChange[]; sel: number | null; onSelect: (i: number) => void; outlinable: (c: VisibleChange) => boolean | null; output: Output }) {
  if (!changes.length) return <p className="muted cmp-nodiff" data-testid="cmp-no-diffs">Nothing the customer sees is different for this customer.</p>;
  return (
    <ol className="cmp-diffs" data-testid="cmp-diffs" aria-label="What is different for this customer">
      {changes.map((c, i) => {
        const part = isPartChange(c);
        const found = part && (output === 'pdf' || output === 'web') ? outlinable(c) : null;
        return (
          <li key={`${c.kind}-${c.nodeId}-${i}`}>
            <button type="button" className="cmp-diff" data-testid="cmp-diff" data-kind={c.kind} data-node={c.nodeId} aria-pressed={sel === i} onClick={() => onSelect(i)}>
              <span className="chip">{CHANGE_LABEL[c.kind]}</span>
              <span className="cmp-diff-text">
                <strong>{part ? <Named name={c.name} code={c.nodeId} /> : c.name}</strong>{' '}<ChangeWords c={c} />
                {found === false && <span className="muted cmp-notshown"> {OUTPUT_LABEL[output]} does not show this part.</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------ the pane for one side */

function PaneBox({ side, title, async: a, children }: { side: SideData; title: 'Before' | 'After'; async: Async<any>; children: React.ReactNode }) {
  return (
    <section className="cmp-pane" data-testid={`cmp-pane-${title.toLowerCase()}`} data-side-id={side.id} aria-label={`${title}: ${side.label}`}>
      <h3 className="cmp-pane-head"><span className="cmp-pane-title">{title}</span><span className="muted" title={side.label}>{side.label}</span></h3>
      {a.loading ? <div className="cmp-pane-state"><Loading label="Composing…" /></div>
        : a.error ? <div className="cmp-pane-state"><div className="callout error" role="alert">{a.error} <button type="button" className="btn sm" onClick={a.retry}>Try again</button></div></div>
        : children}
    </section>
  );
}

/* ------------------------------------------------------------ side by side */

export function SideBySide({ before, after, record, comparison, output, onOutput, styleChanged }: {
  before: SideData; after: SideData; record: SyntheticRecord; comparison: CustomerComparison;
  output: Output; onOutput: (o: Output) => void; styleChanged: boolean;
}) {
  const changes = comparison.changes;
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => { setSel(null); }, [record.recordId, before.id, after.id]);

  const b = useOutput(output, before, record.recordId);
  const a = useOutput(output, after, record.recordId);

  const [ctlB, setCtlB] = useState<PaneControl | null>(null);
  const [ctlA, setCtlA] = useState<PaneControl | null>(null);
  const [foundB, setFoundB] = useState<Set<string> | null>(null);
  const [foundA, setFoundA] = useState<Set<string> | null>(null);
  const regB = useCallback((c: PaneControl | null) => setCtlB(c), []);
  const regA = useCallback((c: PaneControl | null) => setCtlA(c), []);
  const onFoundB = useCallback((f: Set<string> | null) => setFoundB((p) => (sameSet(p, f) ? p : f)), []);
  const onFoundA = useCallback((f: Set<string> | null) => setFoundA((p) => (sameSet(p, f) ? p : f)), []);

  /* The two panes scroll together (by how far down each is), except while a jump to a part is under way. */
  const paused = useRef(false);
  const mirror = (from: HTMLElement, to: HTMLElement) => {
    const r = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
    to.scrollTop = r * Math.max(0, to.scrollHeight - to.clientHeight);
  };
  useEffect(() => {
    if (!ctlB || !ctlA) return;
    let swallow: HTMLElement | null = null;
    const link = (src: HTMLElement, dst: HTMLElement) => () => {
      if (swallow === src) { swallow = null; return; }
      if (paused.current) return;
      const before = dst.scrollTop;
      mirror(src, dst);
      if (Math.abs(dst.scrollTop - before) >= 1) swallow = dst;
    };
    const f1 = link(ctlB.scroller, ctlA.scroller), f2 = link(ctlA.scroller, ctlB.scroller);
    ctlB.scroller.addEventListener('scroll', f1, { passive: true });
    ctlA.scroller.addEventListener('scroll', f2, { passive: true });
    return () => { ctlB.scroller.removeEventListener('scroll', f1); ctlA.scroller.removeEventListener('scroll', f2); };
  }, [ctlB, ctlA]);

  const chosen = sel !== null ? changes[sel] ?? null : null;
  const outlined = chosen ? sidesOutlined(chosen) : { before: false, after: false };
  const marks = useMemo(() => {
    const ids = (side: 'before' | 'after') => [...new Set(changes.filter((c) => sidesOutlined(c)[side]).map((c) => c.nodeId))];
    return { before: ids('before'), after: ids('after') };
  }, [changes]);
  const focusB = chosen && outlined.before ? chosen.nodeId : null;
  const focusA = chosen && outlined.after ? chosen.nodeId : null;

  // Choosing a difference: both sides go to that part (a side that does not have it follows the other).
  useEffect(() => {
    if (!chosen || !ctlB || !ctlA || !isPartChange(chosen) || (output !== 'pdf' && output !== 'web')) return;
    paused.current = true;
    const okB = outlined.before && ctlB.scrollToNode(chosen.nodeId);
    const okA = outlined.after && ctlA.scrollToNode(chosen.nodeId);
    if (okB && !okA) mirror(ctlB.scroller, ctlA.scroller);
    if (okA && !okB) mirror(ctlA.scroller, ctlB.scroller);
    const t = window.requestAnimationFrame(() => window.requestAnimationFrame(() => { paused.current = false; }));
    return () => window.cancelAnimationFrame(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, ctlB, ctlA, foundB, foundA, output]);

  const select = (i: number) => {
    const c = changes[i];
    const ch = outputOfChannelChange(c);
    if (ch && ch !== output) onOutput(ch);
    setSel(i);
  };
  const outlinable = (c: VisibleChange): boolean | null => {
    const s = sidesOutlined(c);
    if ((s.before && !foundB) || (s.after && !foundA)) return null;
    return (s.before && foundB!.has(c.nodeId)) || (s.after && foundA!.has(c.nodeId));
  };

  // Notes that change how to read the pages.
  const draftsShown = useMemo(() => {
    const n = (s: SideData) => (s.working ? resolve({ project: s.project, record, overrides: {}, journeyCursor: null, includeDrafts: true }).translation.draftsShown.length : 0);
    return { before: n(before), after: n(after) };
  }, [before, after, record]);
  const pdfPages = output === 'pdf' && b.data && a.data ? { before: b.data.pageCount as number, after: a.data.pageCount as number } : null;
  const noMarkers = (output === 'pdf' || output === 'web') && ((b.data && foundB && foundB.size === 0) || (a.data && foundA && foundA.size === 0));

  return (
    <div className="cmp-sbs" data-testid="cmp-sbs" data-output={output} data-record={record.recordId}>
      <div className="cmp-toolbar">
        <div className="segmented" role="group" aria-label="Which output to compare">
          {OUTPUTS.map((o) => <button key={o} type="button" data-testid={`cmp-output-${o}`} aria-pressed={output === o} className={output === o ? 'active' : ''} onClick={() => onOutput(o)}>{OUTPUT_LABEL[o]}</button>)}
        </div>
        <span className="muted cmp-customer">Showing <strong>{comparison.name}</strong><Tech> <span className="chip code">{record.recordId}</span></Tech></span>
      </div>

      {styleChanged && (
        <div className="callout cmp-note" role="note" data-testid="cmp-style-changed">
          The brand, text styles or page settings are different between these two versions, so <strong>the look of every page may differ</strong>. This screen compares what each customer is told, not pixels: look at the pages to judge the look.
        </div>
      )}
      {(draftsShown.before > 0 || draftsShown.after > 0) && (
        <div className="callout warning cmp-note" role="note" data-testid="cmp-drafts-note">
          The working version shows {draftsShown.after || draftsShown.before} unapproved translation {(draftsShown.after || draftsShown.before) === 1 ? 'draft' : 'drafts'} for this customer. A release shows approved wording only, so some differences below are drafts waiting for approval.
        </div>
      )}
      {(comparison.stoppedBefore || comparison.stoppedAfter) && (
        <div className="callout warning cmp-note" role="note" data-testid="cmp-stopped-note">
          {comparison.stoppedBefore && comparison.stoppedAfter ? 'A blocker stops this customer’s document on both sides.' : comparison.stoppedAfter ? 'A blocker stops this customer’s document in the After version.' : 'A blocker stopped this customer’s document in the Before version.'} A stopped document is shown here as a marked draft so it can still be looked at; it would not be produced.
        </div>
      )}
      {pdfPages && (
        <p className={`cmp-pages-count${pdfPages.before !== pdfPages.after ? ' changed' : ''}`} data-testid="cmp-page-count" data-before={pdfPages.before} data-after={pdfPages.after}>
          {pdfPages.before === pdfPages.after
            ? <>The PDF has {pdfPages.before} {pdfPages.before === 1 ? 'page' : 'pages'} on both sides.</>
            : <><strong>The number of PDF pages changes:</strong> {pdfPages.before} {pdfPages.before === 1 ? 'page' : 'pages'} before, {pdfPages.after} now.</>}
        </p>
      )}
      {noMarkers && <div className="callout cmp-note" role="note" data-testid="cmp-no-outlines">This output does not mark which part is which, so it is shown without outlines.</div>}
      {(output === 'email' || output === 'sms') && (
        <p className="muted cmp-nooutline" data-testid="cmp-email-note">
          {output === 'email' ? 'The email is shown side by side without outlines: its parts are not marked in a way that can be matched reliably. The differences are listed in words.' : 'A text message is plain text, so the changed words are marked instead of outlined.'}
        </p>
      )}

      <div className="cmp-diffbox">
        <h3 className="section-title">What is different for this customer <span className="chip count" data-testid="cmp-diff-count">{changes.length}</span></h3>
        <DiffList changes={changes} sel={sel} onSelect={select} outlinable={outlinable} output={output} />
        {changes.length > 0 && (output === 'pdf' || output === 'web') && <p className="muted cmp-hint">Choose a difference to scroll both sides to it. Dashed outlines mark every part that differs; the heavy outline is the one chosen.</p>}
      </div>

      <div className="cmp-panes" data-testid="cmp-panes">
        <PaneBox side={before} title="Before" async={b}>
          {output === 'pdf' && b.data && <PagesPane data={b.data} marks={marks.before} focusId={focusB} register={regB} onFound={onFoundB} />}
          {output === 'web' && b.data && <HtmlPane html={b.data.html} title="Web page, before" outlines marks={marks.before} focusId={focusB} register={regB} onFound={onFoundB} />}
          {output === 'email' && b.data && <HtmlPane html={b.data.html} title="Email, before" outlines={false} marks={[]} focusId={null} register={regB} onFound={onFoundB} />}
          {output === 'sms' && b.data && <SmsPane text={b.data.text} other={a.data?.text ?? ''} kind="before" detail={`${b.data.length} characters · ${b.data.segments} ${b.data.segments === 1 ? 'message' : 'messages'}`} />}
        </PaneBox>
        <PaneBox side={after} title="After" async={a}>
          {output === 'pdf' && a.data && <PagesPane data={a.data} marks={marks.after} focusId={focusA} register={regA} onFound={onFoundA} />}
          {output === 'web' && a.data && <HtmlPane html={a.data.html} title="Web page, after" outlines marks={marks.after} focusId={focusA} register={regA} onFound={onFoundA} />}
          {output === 'email' && a.data && <HtmlPane html={a.data.html} title="Email, after" outlines={false} marks={[]} focusId={null} register={regA} onFound={onFoundA} />}
          {output === 'sms' && a.data && <SmsPane text={a.data.text} other={b.data?.text ?? ''} kind="after" detail={`${a.data.length} characters · ${a.data.segments} ${a.data.segments === 1 ? 'message' : 'messages'}`} />}
        </PaneBox>
      </div>
    </div>
  );
}
