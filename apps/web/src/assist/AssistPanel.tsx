import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { OUTPUT_PROFILES, journeyStates, primaryVariantSet, explainInPlainWords, safeFixPlan } from '@iss/scenarios';
import { api, type VersionDto } from '../api/client';
import { useRecord, useResolution, useStudio } from '../state/store';
import { Loading } from '../ui/common';
import { Icon } from '../ui/icons';
import { localeLabel, nodeTitle, ruleTitle } from '../ui/plain';
import { recordSummary } from '../shell/RecordPicker';
import { Conversation } from './Conversation';
import { ChangeSummaryCard, lastApprovedVersion } from './ChangeSummaryCard';
import { useAiLive } from './common';
import { usePanel } from './panelStore';
import './panel.css';

/**
 * The assistant as a side panel on every studio screen. It knows the screen, the customer and the selection, offers the
 * few most useful actions for that spot, shows built-in (computed) explanations and change summaries, and hosts the same
 * conversation as the AI Assistant screen. The assistant proposes and explains; a person acts.
 */

const SCREEN_NAMES: Record<string, string> = {
  design: 'Design Studio', exploded: 'Exploded Document', cube: 'Document Cube', landscape: 'Scenario Landscape', 'page-stack': 'Page Composition Stack',
  'rules-data': 'Rules & Data', journey: 'Journey Simulator', validate: 'Validate & Compare', outputs: 'Preview & Export', demo: 'Guided Demo',
  content: 'Content & Translations', activity: 'Activity', channels: 'Email & SMS', assistant: 'AI Assistant',
};

/** Wait for a control (the other screens are being built in parallel) and bring it into view; never fails when it is absent. */
function jumpTo(testIds: string[]) {
  let tries = 0;
  const t = window.setInterval(() => {
    const el = testIds.map((id) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)).find(Boolean);
    if (el) {
      window.clearInterval(t);
      for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.setAttribute('open', '');
      el.scrollIntoView({ block: 'center', behavior: useStudio.getState().reducedMotion ? 'auto' : 'smooth' });
      if (!el.matches('button, input, select, textarea, a[href], [tabindex]')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
    } else if (++tries > 15) window.clearInterval(t);
  }, 100);
}

export function AssistPanel() {
  const { pathname } = useLocation();
  const open = usePanel((s) => s.open);
  const setAvailable = usePanel((s) => s.setAvailable);
  useEffect(() => { setAvailable(true); return () => setAvailable(false); }, [setAvailable]);
  // The AI Assistant screen is the full-size version of this panel; two copies of the conversation would be confusing.
  if (!open || /\/assistant\/?$/.test(pathname)) return null;
  return <PanelInner />;
}

function PanelInner() {
  const close = usePanel((s) => s.close);
  const tab = usePanel((s) => s.tab);
  const setTab = usePanel((s) => s.setTab);
  const focus = usePanel((s) => s.focus);
  const live = useAiLive();
  const ref = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return; // a dialog or drawer owns Escape
      const a = document.activeElement;
      if (a && a !== document.body && !ref.current?.contains(a)) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <aside className="assist-panel" id="assist-panel" role="complementary" aria-label="Assistant" data-testid="assist-panel" ref={ref}>
      <header className="assist-head">
        <h2 tabIndex={-1} ref={titleRef}><Icon.ai width={16} height={16} /> Assistant</h2>
        <button type="button" className="btn ghost icon" onClick={() => close()} aria-label="Close assistant" data-testid="assist-close"><Icon.close /></button>
      </header>
      <p className={`assist-status${live ? ' live' : ''}`} data-testid="assist-status" data-live={live === null ? 'unknown' : live ? 'yes' : 'no'}>
        <span className="assist-dot" aria-hidden="true" />
        {live === null ? 'Checking assistant…' : live ? 'Live AI on' : 'Built-in assistant · no AI key'}
      </p>
      <ForThisScreen />
      <div className="assist-tabs" role="tablist" aria-label="Assistant sections">
        <button type="button" role="tab" id="assist-tab-help" aria-selected={tab === 'help'} aria-controls="assist-tabpanel" tabIndex={tab === 'help' ? 0 : -1} onClick={() => setTab('help')} data-testid="assist-tab-help">Explain &amp; summary</button>
        <button type="button" role="tab" id="assist-tab-chat" aria-selected={tab === 'chat'} aria-controls="assist-tabpanel" tabIndex={tab === 'chat' ? 0 : -1} onClick={() => setTab('chat')} data-testid="assist-tab-chat">Ask</button>
      </div>
      <div className="assist-body" id="assist-tabpanel" role="tabpanel" aria-labelledby={`assist-tab-${tab}`}>
        {tab === 'chat' ? <Conversation compact /> : (
          <div className="assist-help">
            {focus?.kind === 'explain' ? <ExplainCard nodeId={focus.nodeId} />
              : focus?.kind === 'summary' ? <SinceApproved />
                : <p className="assist-empty muted" data-testid="assist-empty">Pick an action above to see a plain-words explanation or a summary of changes here. Both are worked out by the studio itself, so they work without an AI key.</p>}
          </div>
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ for this screen */

type QuickAction = { id: string; label: string; hint?: string; run: () => void };

function ForThisScreen() {
  const project = useStudio((s) => s.project)!;
  const ctx = useStudio((s) => s.ctx);
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  const record = useRecord();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { setFocus, setTab, close } = usePanel.getState();
  const pid = project.projectId;
  const seg = pathname.split('/')[3] ?? '';
  const screen = SCREEN_NAMES[seg] ?? 'This screen';
  const here = (path: string) => pathname.startsWith(`/studio/${pid}/${path}`);
  const goThen = (path: string, ids: string[]) => { close(false); if (!here(path)) navigate(`/studio/${pid}/${path}`); jumpTo(ids); };

  const customer = record ? recordSummary(record, personas).name : ctx.recordId;
  const node = ctx.selectedNodeId ? project.nodes.find((n) => n.id === ctx.selectedNodeId) ?? null : null;
  const selectedName = node ? nodeTitle(project, node.id) : null;
  const variantName = node && ctx.selectedVariantId && project.contentParts.some((c) => c.id === ctx.selectedVariantId) ? nodeTitle(project, ctx.selectedVariantId) : null;

  // What "explain" would explain: the selected rule-driven component, else the document's main variant set.
  const ruleDriven = !!node && (node.type === 'variant-set' || node.type === 'conditional-region' || node.ruleDriven === true);
  const explainId = ruleDriven ? node!.id : primaryVariantSet(project);

  const fixCount = useMemo(() => {
    if (seg !== 'validate') return null;
    try { return safeFixPlan(project, records).items.length; } catch { return null; }
  }, [seg, project, records]);

  const actions: QuickAction[] = [];
  if (explainId && seg !== 'rules-data') {
    actions.push({ id: 'explain', label: 'Explain why this customer gets this', hint: `About “${nodeTitle(project, explainId)}”, for ${customer}`, run: () => { setFocus({ kind: 'explain', nodeId: explainId }); setTab('help'); } });
  }
  if (seg === 'validate') {
    actions.push({ id: 'fixes', label: 'Suggest fixes for the issues', hint: fixCount ? `${fixCount} low-risk fix${fixCount === 1 ? '' : 'es'} available` : 'Opens the fix suggestions', run: () => goThen('validate', ['fix-panel', 'fix-recommended', 'fix-all-safe', 'issue-suggestion']) });
  }
  if (seg === 'rules-data') {
    actions.push({ id: 'describe', label: 'Describe a rule in plain words', run: () => goThen('rules-data', ['rule-describe-input']) });
    actions.push({ id: 'coverage', label: 'Find coverage gaps', run: () => goThen('rules-data', ['coverage-open']) });
    // Opens the generator itself (not just a jump): wait for the button, then press it.
    actions.push({ id: 'testdata', label: 'Generate test customers', hint: 'One customer for every outcome and edge value', run: () => { goThen('rules-data', ['testdata-open']); let n = 0; const t = window.setInterval(() => { const b = document.querySelector<HTMLButtonElement>('[data-testid="testdata-open"]'); if (b) { window.clearInterval(t); b.click(); } else if (++n > 20) window.clearInterval(t); }, 100); } });
  }
  if (seg === 'content') {
    actions.push({ id: 'draft', label: 'Draft missing translations', run: () => goThen('content', ['tr-ai-draft-all']) });
    actions.push({ id: 'check', label: 'Check drafts', run: () => goThen('content', ['tr-check']) });
  }
  if (seg === 'channels') actions.push({ id: 'sms-fit', label: 'Fit the SMS in one message', run: () => goThen('channels', ['sms-fit']) });
  if (seg === 'design' && node) actions.push({ id: 'writing', label: 'Writing help for the selected message', hint: selectedName ?? undefined, run: () => goThen('design', ['writing-help']) });
  const summary: QuickAction = { id: 'summary', label: 'Summarise changes since the last approved version', run: () => { setFocus({ kind: 'summary' }); setTab('help'); } };
  const ask: QuickAction = { id: 'ask', label: 'Ask a question about this document', run: () => setTab('chat') };
  const list = [...actions.slice(0, 3), summary];
  if (list.length < 3) list.splice(list.length - 1, 0, ask);

  return (
    <section className="assist-context" data-testid="assist-context" aria-label="For this screen">
      <h3>For this screen</h3>
      <p className="assist-sees" data-testid="assist-sees">
        <span>Screen: <strong>{screen}</strong></span>
        <span aria-hidden="true"> · </span>
        <span>Customer: <strong>{customer}</strong></span>
        <span aria-hidden="true"> · </span>
        <span>Selected: <strong>{selectedName ? `${selectedName}${variantName ? ` › ${variantName}` : ''}` : 'nothing'}</strong></span>
      </p>
      <ul className="assist-actions">
        {list.map((a) => (
          <li key={a.id}>
            <button type="button" className="assist-action" data-testid="assist-action" data-action={a.id} onClick={a.run}>
              <span className="assist-action-label">{a.label}</span>
              {a.hint && <span className="assist-action-hint muted">{a.hint}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ explain */

/** Why this customer gets this content, from the engine's own trace. Follows the customer, journey step, language and output in the top bar. */
export function ExplainCard({ nodeId }: { nodeId: string }) {
  const project = useStudio((s) => s.project)!;
  const ctx = useStudio((s) => s.ctx);
  const personas = useStudio((s) => s.personas);
  const res = useResolution();
  const record = useRecord();
  const navigate = useNavigate();
  const ex = useMemo(() => (res ? explainInPlainWords(project, res, nodeId) : null), [project, res, nodeId]);
  if (!res || !ex) return <div className="assist-explanation" data-testid="assist-explanation"><p className="muted">No matching fixture: pick a customer in the top bar to see why they get this content.</p></div>;

  const customer = record ? recordSummary(record, personas).name : ctx.recordId;
  const output = OUTPUT_PROFILES.find((o) => o.id === ctx.profileId)?.label ?? ctx.profileId;
  const step = ctx.journeyCursor === null ? 'baseline' : journeyStates(project).find((j) => j.cursor === ctx.journeyCursor)?.label ?? `event ${ctx.journeyCursor + 1}`;
  const rules = ex.ruleIds.map((id) => project.rules.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r);
  const openRule = (id: string) => { usePanel.getState().close(false); navigate(`/studio/${project.projectId}/rules-data?rule=${encodeURIComponent(id)}`); };

  return (
    <article className="assist-explanation" data-testid="assist-explanation" data-node-id={ex.nodeId} data-variant-id={ex.variantId ?? ''} aria-label={`Why: ${nodeTitle(project, ex.nodeId)}`}>
      <div className="assist-ex-for muted" data-testid="assist-explanation-for">
        {nodeTitle(project, ex.nodeId)} · {customer} · {localeLabel(res.locale)} · {output} · {step}
      </div>
      <p className="assist-ex-headline" data-testid="assist-explanation-headline">{ex.headline}</p>
      {ex.steps.length > 0 && <ol className="assist-ex-steps" data-testid="assist-explanation-steps">{ex.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
      {rules.length > 0 && (
        <div className="assist-ex-rules">
          <div className="assist-sub">Rules involved</div>
          <ul>
            {rules.map((r) => (
              <li key={r.id} data-testid="assist-explanation-rule" data-rule-id={r.id}>
                <span className="assist-ex-rule-title">{ruleTitle(project, r)}</span>
                <span className="chip code" title="Rule number">{r.id}</span>
                <button type="button" className="linkbtn" onClick={() => openRule(r.id)} data-testid="assist-open-rule" aria-label={`Open rule ${ruleTitle(project, r)} in Rules & Data`}>Open rule</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="assist-ex-src">
        <span className="chip as-source" data-testid="assist-source" data-source="builtin" title="Computed by the studio from the rules and the engine's own trace of this run. No AI model was used, so it cannot invent a reason.">Built-in · from the engine&rsquo;s trace</span>
      </p>
    </article>
  );
}

/* ------------------------------------------------------------------ summary since the last approved version */

function SinceApproved() {
  const project = useStudio((s) => s.project)!;
  const serverVersion = useStudio((s) => s.serverVersion);
  const pid = project.projectId;
  const [versions, setVersions] = useState<VersionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setVersions(null); setError(null);
    api.versions(pid).then((r) => live && setVersions(r.versions)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [pid, serverVersion]);
  if (error) return <div className="callout error" role="alert">The version history could not be loaded: {error}</div>;
  if (!versions) return <Loading label="Looking up the last approved version…" />;
  const approved = lastApprovedVersion(versions);
  const saved = versions.find((v) => v.current) ?? versions[0] ?? null;
  const base = approved ?? saved;
  if (!base) return <p className="muted">No saved version exists yet, so there is nothing to compare with.</p>;
  return (
    <div className="assist-summary" data-testid="assist-summary">
      <ChangeSummaryCard
        pid={pid} from={base.modelVersion} to="working"
        fromLabel={`v${base.modelVersion}${approved ? ' (last approved)' : ' (last saved)'}`} toLabel="your working copy"
        note={approved ? undefined : 'No version has been approved yet, so this compares with the last saved version.'} />
    </div>
  );
}
