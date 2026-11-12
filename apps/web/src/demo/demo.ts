import { create } from 'zustand';
import { defaultNode, projectContentDigest, type DocNode } from '@iss/model';
import { indexTree } from '@iss/resolver';
import { buildCube, ScenarioEngine } from '@iss/scenarios';
import { resolve } from '@iss/resolver';
import { api } from '../api/client';
import { useStudio } from '../state/store';

/**
 * Guided stakeholder demo. Every step performs the SAME typed commands, scenario changes and API calls
 * a user would make in the UI, then verifies a checkpoint against live state. Nothing is pre-recorded.
 */

export interface Checkpoint { ok: boolean; detail: string; digest?: string }
export interface DemoStep {
  id: string;
  time: string;
  chapter: string;
  title: string;
  narration: string;
  proof: string;
  run: (nav: (to: string) => void) => Promise<Checkpoint>;
}

const S = () => useStudio.getState();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureProject(id: string) {
  if (S().project?.projectId !== id || S().projectStatus !== 'ready') await S().openProject(id);
  for (let i = 0; i < 40 && (S().projectStatus !== 'ready' || S().project?.projectId !== id); i++) await wait(50);
}

function current() {
  const s = S();
  const record = s.records.find((r) => r.recordId === s.ctx.recordId)!;
  return resolve({ project: s.project!, record, overrides: s.ctx.overrides, journeyCursor: s.ctx.journeyCursor, profileId: s.ctx.profileId });
}

const stress = (purchasesCents: number) => Array.from({ length: 250 }, (_, i) => ({ id: `STRESS-${String(i + 1).padStart(4, '0')}`, date: '2026-10-15', merchant: `Synthetic transaction ${String(i + 1).padStart(3, '0')}`, amountCents: Math.floor(purchasesCents / 250) + (i < purchasesCents % 250 ? 1 : 0) }));

export const DEMO_STEPS: DemoStep[] = [
  {
    id: 'familiar-page', time: '0:00', chapter: 'Familiar page', title: 'A familiar statement, built in an unfamiliar way',
    narration: 'Aster Card’s October statement for Jordan Mercer. Every block on this page is a component in one canonical model, with stable IDs, typed data bindings and rules.',
    proof: 'Resolver selects payment-standard via R01; new balance $1,248.00.',
    run: async (nav) => {
      await ensureProject('aster-card-demo');
      S().setCtx({ recordId: 'CARD-0001', overrides: {}, journeyCursor: null, profileId: 'paged-pdf', selectedNodeId: 'payment-guidance', selectedVariantId: null });
      nav('/studio/aster-card-demo/design');
      const r = current();
      const ok = r.result.selectedVariants['payment-guidance'] === 'payment-standard' && r.result.documentFacts.newBalanceCents === 124800;
      return { ok, detail: `payment-guidance = ${r.result.selectedVariants['payment-guidance']} · rules ${r.result.matchedRuleIds.join(', ')}`, digest: r.contentDigest };
    },
  },
  {
    id: 'author', time: '0:40', chapter: 'Author', title: 'It is an editor, not a viewer',
    narration: 'Insert a bound field for the cardholder’s first name and save. The model version increments; the change flows into every view and output.',
    proof: 'INSERT_NODE command, one undo step, explicit Save to the API.',
    run: async (nav) => {
      nav('/studio/aster-card-demo/design');
      const p = S().project!;
      if (!p.nodes.some((n) => n.id === 'demo-first-name')) {
        const node: DocNode = { ...defaultNode('bound-field', 'demo-first-name', 'credit-statement'), name: 'Cardholder first name', label: 'Prepared for', binding: 'customer.givenName' };
        const idx = p.nodes.find((n) => n.id === p.rootNodeId)!.children!.indexOf('greeting') + 1;
        const r = S().dispatch({ type: 'INSERT_NODE', node, parentId: p.rootNodeId, index: idx });
        if (!r.ok) return { ok: false, detail: r.message };
      }
      S().select('demo-first-name');
      const saved = await S().save();
      const res = current();
      const n = indexTree(res.root).get('demo-first-name');
      return { ok: saved && n?.field?.display === 'Jordan', detail: `Saved model v${S().project!.modelVersion}; field renders “${n?.field?.display}” from customer.givenName`, digest: projectContentDigest(S().project!) };
    },
  },
  {
    id: 'explode', time: '1:30', chapter: 'Explode', title: 'Pull the document apart',
    narration: 'Payment Guidance unfolds into its five real, named variants. Depth means one thing only: alternative outcomes of this component. Each panel shows its rules and how many sample customers receive it.',
    proof: 'Panels derive from variantIds + rules of the canonical node.',
    run: async (nav) => {
      S().select('payment-guidance');
      nav('/studio/aster-card-demo/exploded/payment-guidance');
      const v = S().project!.nodes.find((n) => n.id === 'payment-guidance')!.variantIds!;
      return { ok: v.length === 5, detail: `${v.length} variants: ${v.join(', ')}` };
    },
  },
  {
    id: 'persona', time: '2:25', chapter: 'Persona', title: 'Personalisation is explainable, not magic',
    narration: 'Switch to Taylor Rivers (CARD-0002): two missed payments and an assistance request. The active marker moves to “Assistance requested”, and the trace cites R04 with its exact inputs.',
    proof: 'R04 selected; R03 not applicable because assistanceRequested=true.',
    run: async () => {
      S().setRecord('CARD-0002');
      S().setCtx({ selectedNodeId: 'payment-guidance', selectedVariantId: null });
      const r = current();
      const t = r.trace.find((x) => x.ruleId === 'R04');
      return { ok: r.result.selectedVariants['payment-guidance'] === 'payment-assistance-requested' && t?.outcome === 'selected', detail: `R04 ${t?.outcome} with ${JSON.stringify(t?.predicateInputs)}`, digest: r.contentDigest };
    },
  },
  {
    id: 'rule', time: '2:50', chapter: 'Rule change', title: 'Change a rule, see cause and effect — then undo',
    narration: 'Disable R04 in the editor: the same customer now falls back to the standard payment message. Undo restores the approved rule — every edit is a versioned, reversible command.',
    proof: 'SET_RULE_ENABLED → different resolution → undo → original resolution.',
    run: async (nav) => {
      nav('/studio/aster-card-demo/rules-data?rule=R04');
      const before = current().result.selectedVariants['payment-guidance'];
      S().dispatch({ type: 'SET_RULE_ENABLED', ruleId: 'R04', enabled: false });
      const during = current().result.selectedVariants['payment-guidance'];
      await wait(400);
      S().undo();
      const after = current().result.selectedVariants['payment-guidance'];
      return { ok: before === 'payment-assistance-requested' && during !== before && after === before, detail: `${before} → (R04 off) ${during} → (undo) ${after}` };
    },
  },
  {
    id: 'cube', time: '3:15', chapter: 'Cube & Landscape', title: 'See the whole possibility space',
    narration: 'The Cube intersects persona × language × journey state across all 70 sample card records. Empty intersections say “No matching fixture” instead of inventing output.',
    proof: 'Cells come from resolving every seeded record.',
    run: async (nav) => {
      S().setCtx({ cubeAxes: ['persona', 'language', 'journey'] });
      nav('/studio/aster-card-demo/cube');
      const cube = buildCube(new ScenarioEngine(S().project!, S().records), ['persona', 'language', 'journey']);
      const filled = cube.cells.filter((c) => c.count > 0).length;
      return { ok: cube.universeSize > 0 && !cube.errors.length, detail: `${cube.universeSize} scenarios evaluated · ${filled} populated / ${cube.cells.length} shown intersections` };
    },
  },
  {
    id: 'landscape', time: '3:40', chapter: 'Cube & Landscape', title: 'Outcome clusters and risk',
    narration: 'The Landscape groups every evaluated scenario by its resolved outcome. Bubble size is the number of sample records, and the cluster sizes reconcile exactly to the evaluated universe.',
    proof: 'Σ cluster sizes = evaluated scenarios.',
    run: async (nav) => {
      nav('/studio/aster-card-demo/landscape');
      const { buildLandscape } = await import('@iss/scenarios');
      const l = buildLandscape(new ScenarioEngine(S().project!, S().records));
      return { ok: l.reconciles, detail: `${l.clusters.length} clusters · Σ ${l.universeSize} = ${l.evaluated} evaluated` };
    },
  },
  {
    id: 'journey', time: '4:00', chapter: 'Journey', title: 'Communication evolves over time',
    narration: 'Jordan misses a payment on day 30 and asks for help on day 45. Each event produces a new preview — the issued day-1 statement is frozen and its hash never changes.',
    proof: 'Issued snapshot sha256 identical before and after later events.',
    run: async (nav) => {
      S().setCtx({ recordId: 'CARD-0001', overrides: {}, journeyCursor: 0 });
      const req = { projectId: 'aster-card-demo', recordId: 'CARD-0001', project: S().project! };
      const a = await api.replayJourney({ ...req, journeyCursor: 0 });
      S().setJourneyCursor(1);
      const day30 = current().result.selectedVariants['payment-guidance'];
      S().setJourneyCursor(2);
      const day45 = current().result.selectedVariants['payment-guidance'];
      const b = await api.replayJourney({ ...req, journeyCursor: 2 });
      nav('/studio/aster-card-demo/journey');
      const same = a.issued[0]?.sha256 && a.issued[0].sha256 === b.issued[0]?.sha256;
      return { ok: !!same && day30 === 'payment-reminder' && day45 === 'payment-assistance-requested', detail: `Day 30 → ${day30}; Day 45 → ${day45}; issued sha ${String(a.issued[0]?.sha256).slice(0, 12)} unchanged`, digest: a.issued[0]?.contentDigest };
    },
  },
  {
    id: 'pages', time: '4:45', chapter: 'Page Stack', title: '250 transactions, real continuation',
    narration: 'Stress the statement with 250 transactions. The composer measures every row in a real browser, continues the table across pages and repeats its heading — the page count is measured, never predicted.',
    proof: 'Composer page tree and independent PDF page count agree.',
    run: async (nav) => {
      S().setCtx({ recordId: 'CARD-0001', journeyCursor: null, overrides: { card: { transactions: stress(50800) } } });
      nav('/studio/aster-card-demo/page-stack');
      const c = await api.composePages({ projectId: 'aster-card-demo', recordId: 'CARD-0001', overrides: S().ctx.overrides, project: S().project!, verifyPdf: true });
      const repeated = c.pages.filter((p) => p.tables['transaction-table']?.headerRepeated).length;
      return { ok: c.pageCount > 1 && c.pageCount === c.pdfPageCount && repeated > 0, detail: `${c.pageCount} measured pages (PDF ${c.pdfPageCount}); heading repeated on ${repeated} continuation pages`, digest: c.contentDigest };
    },
  },
  {
    id: 'export', time: '5:35', chapter: 'Export', title: 'One meaning, two physical experiences',
    narration: 'Export a genuine PDF and an interactive HTML file from the same resolved run. Semantic parity compares amounts, disclosures, variants and row counts — not pixels. AFP is shown as a clearly labelled simulation.',
    proof: 'Parity report: all blocking checks match.',
    run: async (nav) => {
      S().setCtx({ overrides: {} });
      nav('/studio/aster-card-demo/outputs');
      const p = await api.parity({ projectId: 'aster-card-demo', recordId: 'CARD-0001', project: S().project! });
      return { ok: p.report.ok, detail: `PDF ${p.pdf.pageCount} pages · HTML ${p.html.interactive.sortable ? 'sortable' : ''}/${p.html.interactive.filterable ? 'filterable' : ''} · parity ${p.report.ok ? 'OK' : 'MISMATCH'}`, digest: p.contentDigest };
    },
  },
  {
    id: 'eob', time: '6:30', chapter: 'HarborCare EOB', title: 'Different industry, same foundation',
    narration: 'HarborCare’s explanation of benefits uses the same engine. Avery Stone’s lab claim is denied pending review: THIS IS NOT A BILL, and the unconfirmed $300 is never presented as owed.',
    proof: 'R14 selected; member responsibility guarded; NOT A BILL disclosure present.',
    run: async (nav) => {
      await ensureProject('harborcare-demo');
      S().setCtx({ recordId: 'EOB-0002', overrides: {}, journeyCursor: null, selectedNodeId: 'eob-claim-message' });
      nav('/studio/harborcare-demo/design');
      const r = current();
      const guarded = r.semanticManifest.guardedLiabilityNodeIds.includes('member-responsibility');
      const banner = r.semanticManifest.disclosures.some((d) => d.contentPartId === 'not-a-bill-banner');
      return { ok: r.result.selectedVariants['eob-claim-message'] === 'eob-review-needed' && guarded && banner, detail: `eob-claim-message = ${r.result.selectedVariants['eob-claim-message']}; liability guarded: ${guarded}; NOT A BILL: ${banner}`, digest: r.contentDigest };
    },
  },
  {
    id: 'ai', time: '7:15', chapter: 'AI assistant', title: 'AI assists without overriding governance',
    narration: 'Ask why this message appears: the answer is sourced from the deterministic trace. A suggested rule change needs explicit approval — declining leaves the model untouched. Without a provider, the labelled offline assistant still works.',
    proof: 'Explanation evidence from trace; declined proposal → digest unchanged.',
    run: async (nav) => {
      nav('/studio/harborcare-demo/assistant');
      const ctx = { projectId: 'harborcare-demo', recordId: 'EOB-0002', overrides: {}, journeyCursor: null, selectedNodeId: 'eob-claim-message' };
      const e = await api.assistantMessage({ message: 'Why does this claim message appear?', context: ctx, project: S().project! });
      const before = projectContentDigest(S().project!);
      const p = await api.assistantMessage({ message: 'Change R14 priority to 450', context: ctx, project: S().project! });
      if (p.proposal) await api.decideProposal(p.proposal.proposalId, false, S().project!.modelVersion);
      const after = projectContentDigest(S().project!);
      return { ok: !!e.explanation?.evidence?.length && !!p.proposal && before === after, detail: `${e.mode} mode · evidence ${e.explanation?.evidence?.map((x: any) => x.ruleId).join(', ')} · declined proposal, digest ${after.slice(0, 12)} unchanged` };
    },
  },
];

interface DemoState {
  active: boolean;
  running: boolean;
  paused: boolean;
  bannerHidden: boolean;
  index: number;
  results: Record<string, Checkpoint>;
  previousRun: Record<string, Checkpoint> | null;
  runs: number;
  start(nav: (to: string) => void): Promise<void>;
  next(nav: (to: string) => void): Promise<void>;
  runStep(i: number, nav: (to: string) => void): Promise<void>;
  setPaused(p: boolean): void;
  setBannerHidden(h: boolean): void;
  reset(nav: (to: string) => void): Promise<void>;
  stop(): void;
}

async function resetAll() {
  for (const id of ['aster-card-demo', 'harborcare-demo']) {
    await api.resetProject(id);
    try { localStorage.removeItem(`iss.ctx.${id}`); } catch { /* ignore */ }
  }
  useStudio.setState({ project: null, projectStatus: 'idle', past: [], future: [] });
  await S().loadProjects();
}

export const useDemo = create<DemoState>((set, get) => ({
  active: false, running: false, paused: false, bannerHidden: false, index: -1, results: {}, previousRun: null, runs: 0,
  async start(nav) {
    set({ running: true, active: true, paused: false, bannerHidden: false });
    await resetAll();
    set((s) => ({ index: -1, previousRun: Object.keys(s.results).length ? s.results : s.previousRun, results: {}, runs: s.runs + 1, running: false }));
    await get().next(nav);
  },
  async next(nav) {
    const i = get().index + 1;
    if (i >= DEMO_STEPS.length) { set({ index: DEMO_STEPS.length }); return; }
    await get().runStep(i, nav);
  },
  async runStep(i, nav) {
    set({ running: true, index: i, active: true });
    let cp: Checkpoint;
    try { cp = await DEMO_STEPS[i].run(nav); }
    catch (e: any) { cp = { ok: false, detail: `Step failed: ${e.message ?? e}` }; }
    set((s) => ({ results: { ...s.results, [DEMO_STEPS[i].id]: cp }, running: false }));
  },
  setPaused(p) { set({ paused: p }); },
  setBannerHidden(h) { set({ bannerHidden: h }); },
  async reset(nav) {
    set({ running: true });
    await resetAll();
    set((s) => ({ running: false, index: -1, active: false, paused: false, previousRun: Object.keys(s.results).length ? s.results : s.previousRun, results: {} }));
    await S().openProject('aster-card-demo');
    nav('/studio/aster-card-demo/demo');
    S().toast({ kind: 'success', title: 'Demo reset', message: 'Approved samples restored, issued snapshots cleared, view context cleared.' });
  },
  stop() { set({ active: false }); },
}));
