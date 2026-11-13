import { digestOf, getPath, projectLanguages, shortDigest, SOURCE_LANGUAGE, type DocumentType, type Overrides, type Project, type ProfileId, type SyntheticRecord } from '@iss/model';
import { resolve, type Resolution } from '@iss/resolver';

/* ------------------------------------------------------------- dimensions */

export type DimensionId = 'persona' | 'journey' | 'output' | 'language' | 'paymentStatus' | 'accountTier' | 'channel' | 'claimStatus' | 'networkStatus';

export interface DimensionDef {
  id: DimensionId;
  label: string;
  documentTypes: DocumentType[];
}

/**
 * What scenarios can be compared by. A document with its own data ("custom") is compared by customer, journey state,
 * output and language; the card and claim dimensions do not apply to it and are not offered.
 */
export const DIMENSIONS: DimensionDef[] = [
  { id: 'persona', label: 'Persona', documentTypes: ['credit-statement', 'eob', 'custom'] },
  { id: 'journey', label: 'Journey state', documentTypes: ['credit-statement', 'eob', 'custom'] },
  { id: 'output', label: 'Output profile', documentTypes: ['credit-statement', 'eob', 'custom'] },
  { id: 'language', label: 'Language', documentTypes: ['credit-statement', 'eob', 'custom'] },
  { id: 'paymentStatus', label: 'Payment status', documentTypes: ['credit-statement'] },
  { id: 'accountTier', label: 'Account tier', documentTypes: ['credit-statement'] },
  { id: 'channel', label: 'Channel preference', documentTypes: ['credit-statement'] },
  { id: 'claimStatus', label: 'Claim status', documentTypes: ['eob'] },
  { id: 'networkStatus', label: 'Network status', documentTypes: ['eob'] },
];

export const OUTPUT_PROFILES: Array<{ id: ProfileId; label: string }> = [
  { id: 'paged-pdf', label: 'PDF' },
  { id: 'html-responsive', label: 'HTML' },
  { id: 'paged-afp-sim', label: 'AFP (simulation)' },
];

export const PERSONA_NAMES: Record<string, string> = {
  P01: 'Everyday', P02: 'Premier', P03: 'First Missed Payment', P04: 'Financial Assistance', P05: 'Spanish Preferred', P06: 'Digital First',
  P07: 'Paper Preferred', P08: 'High Volume', P09: 'New Cardholder', P10: 'Accessibility Focus', P11: 'Rewards Focus', P12: 'Edge-Case Customer',
};

/** A scenario is a reproducible (record, overrides, journey cursor, output profile) combination. */
export interface Scenario {
  scenarioId: string;
  recordId: string;
  overrides: Overrides;
  journeyCursor: number | null;
  profileId: ProfileId;
}

export function scenarioId(s: Omit<Scenario, 'scenarioId'>): string {
  return 'scn-' + shortDigest(s, 10);
}

export function journeyStates(project: Project): Array<{ cursor: number | null; label: string }> {
  return [{ cursor: null, label: 'Baseline' }, ...project.journey.events.map((e, i) => ({ cursor: i, label: `${e.day ? `Day ${e.day} · ` : ''}${e.label ?? e.eventType}` }))];
}

/** Value of a dimension for a resolved scenario (category key + human label). */
export function dimensionValue(dim: DimensionId, s: Scenario, res: Resolution, project: Project): { key: string; label: string } {
  const rec: any = res.effectiveRecord;
  const claim = rec.claims?.[0] ?? {};
  switch (dim) {
    case 'persona': {
      if (project.documentType === 'eob') { const st = String(claim.status ?? 'unknown'); return { key: st, label: `Claim: ${st}` }; }
      // A customer without a persona that was generated for this project, and every customer of a document with its
      // own data, is its own category: named by why it was generated, else by the customer's name.
      if (!rec.personaId && (rec.generated || project.documentType === 'custom')) {
        const name = `${rec.customer?.givenName ?? ''} ${rec.customer?.familyName ?? ''}`.trim();
        return { key: String(rec.recordId), label: (typeof rec.generated?.label === 'string' && rec.generated.label.trim()) || name || 'Customer' };
      }
      const pid = rec.personaId ?? 'none';
      return { key: pid, label: `${pid} ${PERSONA_NAMES[pid] ?? ''}`.trim() };
    }
    case 'journey': {
      const st = journeyStates(project).find((j) => j.cursor === s.journeyCursor);
      return { key: String(s.journeyCursor ?? 'baseline'), label: st?.label ?? 'Baseline' };
    }
    case 'output': return { key: s.profileId, label: OUTPUT_PROFILES.find((o) => o.id === s.profileId)?.label ?? s.profileId };
    case 'language': return { key: String(rec.customer?.locale), label: String(rec.customer?.locale) };
    case 'paymentStatus': return { key: String(rec.card?.paymentStatus), label: String(rec.card?.paymentStatus) };
    case 'accountTier': return { key: String(rec.card?.tier), label: String(rec.card?.tier) };
    case 'channel': return { key: String(rec.card?.channelPreference), label: String(rec.card?.channelPreference) };
    case 'claimStatus': return { key: String(claim.status), label: String(claim.status) };
    case 'networkStatus': return { key: String(claim.network), label: String(claim.network) };
  }
}

/* ------------------------------------------------------- resolution cache */

export class ScenarioEngine {
  private cache = new Map<string, Resolution>();
  constructor(public project: Project, public records: SyntheticRecord[]) {}

  get universeRecords(): SyntheticRecord[] {
    return this.records.filter((r) => r.documentType === this.project.documentType);
  }

  resolveScenario(s: Omit<Scenario, 'scenarioId'>): Resolution {
    const key = digestOf({ r: s.recordId, o: s.overrides, j: s.journeyCursor, p: s.profileId });
    let res = this.cache.get(key);
    if (!res) {
      const record = this.records.find((r) => r.recordId === s.recordId);
      if (!record) throw new Error(`Unknown record ${s.recordId}`);
      res = resolve({ project: this.project, record, overrides: s.overrides, journeyCursor: s.journeyCursor, profileId: s.profileId });
      this.cache.set(key, res);
    }
    return res;
  }

  /** Builds the scenario universe: seeded records × (journey states?) × (output profiles?). */
  universe(opts: { journeyCursors?: Array<number | null>; profiles?: ProfileId[]; overrides?: Overrides } = {}): Scenario[] {
    const cursors = opts.journeyCursors ?? [null];
    const profiles = opts.profiles ?? ['paged-pdf'];
    const out: Scenario[] = [];
    for (const r of this.universeRecords) for (const j of cursors) for (const p of profiles) {
      const base = { recordId: r.recordId, overrides: opts.overrides ?? {}, journeyCursor: j, profileId: p };
      out.push({ ...base, scenarioId: scenarioId(base) });
    }
    return out;
  }
}

/* ------------------------------------------------------------------- Cube */

export interface CubeCell {
  x: string; y: string; z: string;
  count: number;
  recordIds: string[];
  scenarios: Scenario[];
  outcomes: Record<string, number>;
  dominantOutcome: string | null;
  blocking: number;
  warnings: number;
  representative: Scenario | null;
  simulationOnly: boolean;
}

export interface CubeAxis {
  dim: DimensionId;
  label: string;
  categories: Array<{ key: string; label: string; count: number }>;
  totalCategories: number;
  offset: number;
}

export interface CubeResult {
  axes: [CubeAxis, CubeAxis, CubeAxis];
  cells: CubeCell[];
  universeSize: number;
  plannedSize: number;
  filters: Record<string, string>;
  primaryVariantSet: string | null;
  errors: string[];
}

export const MAX_CATEGORIES_PER_AXIS = 5;

export function primaryVariantSet(project: Project): string | null {
  return project.nodes.find((n) => n.type === 'variant-set')?.id ?? null;
}

/**
 * Cube intersections from real scenario resolution. Empty intersections are reported honestly
 * (count 0, no representative) — never fabricated.
 */
export function buildCube(engine: ScenarioEngine, axes: [DimensionId, DimensionId, DimensionId], opts: { offsets?: [number, number, number]; filters?: Partial<Record<DimensionId, string>>; journeyCursor?: number | null; profileId?: ProfileId } = {}): CubeResult {
  const errors: string[] = [];
  if (new Set(axes).size !== 3) errors.push('Each dimension can be used on only one axis.');
  const project = engine.project;
  for (const a of axes) if (!DIMENSIONS.find((d) => d.id === a)?.documentTypes.includes(project.documentType)) errors.push(project.documentType === 'custom' ? `${DIMENSIONS.find((d) => d.id === a)?.label ?? a} is not available for a document with its own data.` : `${a} is not available for ${project.documentType}.`);
  const usesJourney = axes.includes('journey') || !!opts.filters?.journey;
  const usesOutput = axes.includes('output') || !!opts.filters?.output;
  const cursors = usesJourney ? journeyStates(project).map((j) => j.cursor) : [opts.journeyCursor ?? null];
  const profiles = usesOutput ? OUTPUT_PROFILES.map((o) => o.id) : [opts.profileId ?? 'paged-pdf'];
  const scenarios = engine.universe({ journeyCursors: cursors, profiles });
  const pvs = primaryVariantSet(project);
  const rows = scenarios.map((s) => {
    const res = engine.resolveScenario(s);
    const vals = axes.map((d) => dimensionValue(d, s, res, project));
    const filterOk = Object.entries(opts.filters ?? {}).every(([d, v]) => !v || dimensionValue(d as DimensionId, s, res, project).key === v);
    return { s, res, vals, filterOk };
  }).filter((r) => r.filterOk);

  const axisDefs = axes.map((dim, i) => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const r of rows) { const v = r.vals[i]; const e = counts.get(v.key) ?? { label: v.label, count: 0 }; e.count++; counts.set(v.key, e); }
    // Include declared enum categories with zero records so empty intersections are visible.
    for (const k of declaredCategories(dim, project)) if (!counts.has(k.key)) counts.set(k.key, { label: k.label, count: 0 });
    const all = [...counts.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => categoryOrder(dim, a.key, project) - categoryOrder(dim, b.key, project) || a.key.localeCompare(b.key));
    const offset = Math.max(0, Math.min(opts.offsets?.[i] ?? 0, Math.max(0, all.length - MAX_CATEGORIES_PER_AXIS)));
    return { dim, label: DIMENSIONS.find((d) => d.id === dim)!.label, categories: all.slice(offset, offset + MAX_CATEGORIES_PER_AXIS), totalCategories: all.length, offset } as CubeAxis;
  }) as [CubeAxis, CubeAxis, CubeAxis];

  const cells: CubeCell[] = [];
  for (const cx of axisDefs[0].categories) for (const cy of axisDefs[1].categories) for (const cz of axisDefs[2].categories) {
    const hits = rows.filter((r) => r.vals[0].key === cx.key && r.vals[1].key === cy.key && r.vals[2].key === cz.key);
    const outcomes: Record<string, number> = {};
    let blocking = 0, warnings = 0;
    for (const h of hits) {
      const o = pvs ? String(h.res.result.selectedVariants[pvs] ?? 'unresolved') : 'n/a';
      outcomes[o] = (outcomes[o] ?? 0) + 1;
      if (h.res.findings.some((f) => f.severity === 'blocking')) blocking++;
      if (h.res.findings.some((f) => f.severity === 'warning')) warnings++;
    }
    const dominant = Object.entries(outcomes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    const rep = hits.find((h) => !h.res.findings.some((f) => f.severity === 'blocking')) ?? hits[0];
    cells.push({ x: cx.key, y: cy.key, z: cz.key, count: hits.length, recordIds: [...new Set(hits.map((h) => h.s.recordId))], scenarios: hits.map((h) => h.s), outcomes, dominantOutcome: dominant, blocking, warnings, representative: rep?.s ?? null, simulationOnly: hits.some((h) => h.s.profileId === 'paged-afp-sim') || [cx.key, cy.key, cz.key].includes('paged-afp-sim') });
  }
  return { axes: axisDefs, cells, universeSize: rows.length, plannedSize: scenarios.length, filters: Object.fromEntries(Object.entries(opts.filters ?? {}).filter(([, v]) => v)) as Record<string, string>, primaryVariantSet: pvs, errors };
}

function declaredCategories(dim: DimensionId, project: Project): Array<{ key: string; label: string }> {
  switch (dim) {
    case 'output': return OUTPUT_PROFILES.map((o) => ({ key: o.id, label: o.label }));
    case 'journey': return journeyStates(project).map((j) => ({ key: String(j.cursor ?? 'baseline'), label: j.label }));
    // A document with its own data declares its own languages (English alone until one is added); the samples keep their two.
    case 'language': return project.documentType === 'custom' ? [SOURCE_LANGUAGE, ...projectLanguages(project)].map((l) => ({ key: l, label: l })) : [{ key: 'en-US', label: 'en-US' }, { key: 'es-US', label: 'es-US' }];
    case 'paymentStatus': return project.documentType === 'credit-statement' ? [{ key: 'current', label: 'current' }, { key: 'overdue', label: 'overdue' }] : [];
    case 'accountTier': return project.documentType === 'credit-statement' ? [{ key: 'standard', label: 'standard' }, { key: 'premium', label: 'premium' }] : [];
    case 'channel': return project.documentType === 'credit-statement' ? ['email', 'digital', 'print'].map((k) => ({ key: k, label: k })) : [];
    case 'networkStatus': return project.documentType === 'eob' ? ['in-network', 'out-of-network'].map((k) => ({ key: k, label: k })) : [];
    default: return [];
  }
}

function categoryOrder(dim: DimensionId, key: string, project: Project): number {
  if (dim === 'journey') return key === 'baseline' ? -1 : Number(key);
  if (dim === 'output') return OUTPUT_PROFILES.findIndex((o) => o.id === key);
  if (dim === 'persona' && project.documentType === 'credit-statement') return Number(key.replace(/\D/g, '')) || 99;
  return 0;
}

/* -------------------------------------------------------------- Landscape */

export interface LandscapeCluster {
  clusterId: string;
  signature: { variants: Record<string, string | null>; sections: string[]; journey: string; output: string };
  label: string;
  count: number;
  recordIds: string[];
  scenarios: Scenario[];
  contributingRuleIds: string[];
  blockingScenarios: number;
  warningScenarios: number;
  findingCodes: Record<string, number>;
  representative: Scenario;
  metrics: { ruleComplexity: number; exceptionCount: number };
  position: { col: number; row: number };
  severity: 'ok' | 'warning' | 'blocking';
}

export interface LandscapeResult {
  clusters: LandscapeCluster[];
  universeSize: number;
  plannedSize: number;
  evaluated: number;
  countBasis: string;
  positioning: string;
  reconciles: boolean;
}

/**
 * Deterministic outcome clustering. Signature = selected variants + visible conditional sections
 * + journey state + output target. Size = synthetic scenario count (never inferred market share).
 */
export function buildLandscape(engine: ScenarioEngine, opts: { includeJourney?: boolean; profileId?: ProfileId; journeyCursor?: number | null; filters?: Partial<Record<DimensionId, string>> } = {}): LandscapeResult {
  const project = engine.project;
  const cursors = opts.includeJourney ? journeyStates(project).map((j) => j.cursor) : [opts.journeyCursor ?? null];
  const scenarios = engine.universe({ journeyCursors: cursors, profiles: [opts.profileId ?? 'paged-pdf'] });
  const groups = new Map<string, { sig: LandscapeCluster['signature']; items: Array<{ s: Scenario; res: Resolution }> }>();
  let evaluated = 0;
  for (const s of scenarios) {
    const res = engine.resolveScenario(s);
    if (opts.filters && !Object.entries(opts.filters).every(([d, v]) => !v || dimensionValue(d as DimensionId, s, res, project).key === v)) continue;
    evaluated++;
    const sections: string[] = [];
    const walk = (n: Resolution['root']) => { if (n.visible && n.type === 'conditional-region' && n.variants?.selected.length) sections.push(...n.variants.selected); n.children.forEach(walk); };
    walk(res.root);
    const sig = { variants: res.result.selectedVariants, sections: sections.sort(), journey: dimensionValue('journey', s, res, project).label, output: s.profileId };
    const key = digestOf(sig);
    const g = groups.get(key) ?? { sig, items: [] };
    g.items.push({ s, res });
    groups.set(key, g);
  }
  const pvs = primaryVariantSet(project);
  const primaryOrder = project.nodes.find((n) => n.id === pvs)?.variantIds ?? [];
  const clusters: LandscapeCluster[] = [...groups.entries()].map(([key, g]) => {
    const rules = new Set<string>();
    const codes: Record<string, number> = {};
    let blocking = 0, warn = 0;
    for (const it of g.items) {
      it.res.result.matchedRuleIds.forEach((r) => rules.add(r));
      const fs = it.res.findings.filter((f) => f.severity !== 'info');
      fs.forEach((f) => (codes[f.code] = (codes[f.code] ?? 0) + 1));
      if (fs.some((f) => f.severity === 'blocking')) blocking++; else if (fs.length) warn++;
    }
    const rep = g.items.find((i) => !i.res.findings.some((f) => f.severity === 'blocking')) ?? g.items[0];
    const v = pvs ? g.sig.variants[pvs] : null;
    return {
      clusterId: 'cl-' + key.slice(0, 10), signature: g.sig,
      // A document with its own data may have no message set at all: then the cluster is named by its sections, or as the one outcome everyone gets.
      label: !pvs && project.documentType === 'custom' ? (g.sig.sections.join(' + ') || 'Same document for everyone') : [v ?? 'unresolved', ...g.sig.sections].join(' + '),
      count: g.items.length, recordIds: [...new Set(g.items.map((i) => i.s.recordId))], scenarios: g.items.map((i) => i.s),
      contributingRuleIds: [...rules].sort(), blockingScenarios: blocking, warningScenarios: warn, findingCodes: codes, representative: rep.s,
      metrics: { ruleComplexity: rules.size, exceptionCount: Object.values(codes).reduce((a, b) => a + b, 0) },
      position: { col: 0, row: 0 }, severity: blocking ? 'blocking' : warn ? 'warning' : 'ok',
    } as LandscapeCluster;
  });
  // Deterministic positioning: column = primary variant (in variant-set order), row = descending count, ties by label.
  const colOf = (c: LandscapeCluster) => { const v = pvs ? c.signature.variants[pvs] : null; const i = v ? primaryOrder.indexOf(v) : -1; return i < 0 ? primaryOrder.length : i; };
  clusters.sort((a, b) => colOf(a) - colOf(b) || b.count - a.count || a.label.localeCompare(b.label));
  const rowCounter = new Map<number, number>();
  for (const c of clusters) { const col = colOf(c); const row = rowCounter.get(col) ?? 0; rowCounter.set(col, row + 1); c.position = { col, row }; }
  const total = clusters.reduce((s, c) => s + c.count, 0);
  return {
    clusters, universeSize: total, plannedSize: scenarios.length, evaluated,
    countBasis: project.documentType === 'custom'
      ? (opts.includeJourney ? `This project’s synthetic customers × ${cursors.length} journey states (generated combinations, unweighted)` : 'This project’s synthetic customers (actual count, unweighted)')
      : opts.includeJourney ? `Seeded synthetic records × ${cursors.length} journey states (generated combinations, unweighted)` : 'Seeded synthetic records (actual fixture count, unweighted)',
    positioning: 'Column = selected primary variant in variant-set order; row = cluster size (descending). Same signatures always land in the same place.',
    reconciles: total === evaluated,
  };
}

/* --------------------------------------------------------- edge cases */

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Ready-made what-ifs on the sample data of the two built-in kinds. A document with its own data has none: its edge values come from "Generate test customers". */
export interface EdgeCasePreset { id: string; label: string; documentType: 'credit-statement' | 'eob'; description: string }

export const EDGE_CASE_PRESETS: EdgeCasePreset[] = [
  { id: 'zero-transactions', label: 'Zero transactions', documentType: 'credit-statement', description: 'Empty transaction list; table must show an explicit empty state.' },
  { id: 'one-transaction', label: 'One transaction', documentType: 'credit-statement', description: 'Single row; purchases reconcile.' },
  { id: 'stress-250', label: '250 transactions', documentType: 'credit-statement', description: '250 rows preserving purchase total — continuation stress.' },
  { id: 'long-merchant', label: '1,000-character merchant', documentType: 'credit-statement', description: 'One very long merchant description that must wrap.' },
  { id: 'spanish-missing-content', label: 'Missing Spanish content', documentType: 'credit-statement', description: 'Locale es-US without approved translations.' },
  { id: 'negative-adjustment', label: 'Negative credit adjustment', documentType: 'credit-statement', description: 'A credit (negative) transaction row.' },
  { id: 'threshold-exact', label: 'Exactly on R10 threshold', documentType: 'credit-statement', description: '25 transactions: R10 (count > 25) must not match.' },
  { id: 'crossed-priorities', label: 'Crossed rule priorities', documentType: 'credit-statement', description: 'Missed payments + assistance + approved arrangement: R05 must win by priority.' },
  { id: 'premium-overdue-assistance', label: 'Premium + overdue + assistance', documentType: 'credit-statement', description: 'Combined additive (R06) and exclusive (R04) outcomes.' },
  { id: 'inconsistent-state', label: 'Contradictory payment state', documentType: 'credit-statement', description: 'paymentStatus=current with 2 missed payments: input-consistency diagnostic.' },
  { id: 'claim-denied-unknown-liability', label: 'Denied claim, unknown liability', documentType: 'eob', description: 'Denied pending review; liability unconfirmed; no amount owed.' },
  { id: 'claim-several-lines', label: 'Several claims', documentType: 'eob', description: 'Four claims; multi-claim index (R19).' },
  { id: 'claim-appeal', label: 'Appeal filed', documentType: 'eob', description: 'Appeal status guidance (R15).' },
  { id: 'claim-out-of-network', label: 'Out-of-network with deductible', documentType: 'eob', description: 'Network (R16) and deductible (R17) explanations.' },
];

const MERCHANTS = ['Maple Groceries', 'Harbor Fuel', 'South Bay Pharmacy', 'Riverside Books', 'Aster Coffee', 'Seaside Market', 'Transit Pass'];

function spreadTransactions(count: number, totalCents: number, prefix: string, rnd: () => number) {
  const base = Math.floor(totalCents / Math.max(1, count));
  const extra = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${String(i + 1).padStart(4, '0')}`, date: `2026-10-${String((i % 31) + 1).padStart(2, '0')}`, merchant: MERCHANTS[Math.floor(rnd() * MERCHANTS.length)], amountCents: base + (i < extra ? 1 : 0) }));
}

/** Deterministic edge-case generator: same (record, preset, seed) → identical overrides. Nonmutating. */
export function generateEdgeCase(record: SyntheticRecord, presetId: string, seed = 'SPATIAL-STUDIO-DEMO-2026-11'): { presetId: string; recordId: string; seed: string; scenarioHash: string; overrides: Overrides; description: string } {
  const preset = EDGE_CASE_PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`Unknown edge-case preset ${presetId}`);
  if (preset.documentType !== record.documentType) throw new Error(`${presetId} applies to ${preset.documentType} records`);
  const scenarioHash = shortDigest({ seed, presetId, recordId: record.recordId }, 12);
  const rnd = mulberry32(parseInt(scenarioHash.slice(0, 8), 16));
  const card: any = record.card;
  const claim0: any = record.claims?.[0];
  let overrides: Overrides = {};
  switch (presetId) {
    case 'zero-transactions': overrides = { card: { transactions: [], purchasesCents: 0, newBalanceCents: card.previousBalanceCents - card.paymentsCreditsCents + card.interestFeesCents } }; break;
    case 'one-transaction': overrides = { card: { transactions: spreadTransactions(1, card.purchasesCents, 'EDGE1', rnd) } }; break;
    case 'stress-250': overrides = { card: { transactions: spreadTransactions(250, card.purchasesCents, 'GEN250', rnd) } }; break;
    case 'long-merchant': {
      const tx = (card.transactions as any[]).map((t) => ({ ...t }));
      const words = 'Synthetic extended merchant descriptor for layout testing with continued wrapping text'.split(' ');
      let long = '';
      while (long.length < 1000) long += words[Math.floor(rnd() * words.length)] + ' ';
      if (tx.length) tx[0].merchant = long.slice(0, 1000);
      overrides = { card: { transactions: tx } };
      break;
    }
    case 'spanish-missing-content': overrides = { customer: { locale: 'es-US' } }; break;
    case 'negative-adjustment': {
      const tx = (card.transactions as any[]).map((t) => ({ ...t }));
      tx.push({ id: 'ADJ-0001', date: '2026-10-20', merchant: 'Credit adjustment (synthetic)', amountCents: -1500 });
      overrides = { card: { transactions: tx, purchasesCents: card.purchasesCents - 1500, newBalanceCents: card.newBalanceCents - 1500 } };
      break;
    }
    case 'threshold-exact': overrides = { card: { transactions: spreadTransactions(25, card.purchasesCents, 'EDGE25', rnd) } }; break;
    case 'crossed-priorities': overrides = { card: { paymentStatus: 'overdue', missedPayments: 2, assistanceRequested: true, arrangementStatus: 'approved' } }; break;
    case 'premium-overdue-assistance': overrides = { card: { tier: 'premium', paymentStatus: 'overdue', missedPayments: 2, assistanceRequested: true } }; break;
    case 'inconsistent-state': overrides = { card: { paymentStatus: 'current', missedPayments: 2 } }; break;
    case 'claim-denied-unknown-liability': overrides = { claims: [{ ...claim0, status: 'denied-pending-review', liabilityConfirmed: false, allowedCents: 0, planPaidCents: 0, patientResponsibilityCents: 0, contractualAdjustmentCents: 0, amountUnderReviewCents: claim0.billedCents }] }; break;
    case 'claim-several-lines': {
      const services = ['Office visit', 'Diagnostic laboratory', 'Imaging', 'Physical therapy'];
      overrides = { claims: services.map((svc, i) => { const billed = 20000 + Math.floor(rnd() * 20) * 1000; const allowed = Math.round(billed * 0.6); const plan = Math.round(allowed * 0.8); return { claimId: `HC-2${String(i + 1).padStart(4, '0')}`, serviceDate: `2026-10-${String(10 + i).padStart(2, '0')}`, service: svc, billedCents: billed, allowedCents: allowed, contractualAdjustmentCents: billed - allowed, planPaidCents: plan, patientResponsibilityCents: allowed - plan, liabilityConfirmed: true, status: 'processed-covered', network: 'in-network', deductibleAppliedCents: 0, amountUnderReviewCents: 0 }; }) };
      break;
    }
    case 'claim-appeal': overrides = { claims: [{ ...claim0, status: 'appeal-filed', liabilityConfirmed: false }] }; break;
    case 'claim-out-of-network': overrides = { claims: [{ ...claim0, network: 'out-of-network', deductibleAppliedCents: 5000 }] }; break;
  }
  return { presetId, recordId: record.recordId, seed, scenarioHash, overrides, description: preset.description };
}

/* ------------------------------------------------------------ journey */

export interface JourneySnapshot {
  eventId: string | null;
  cursor: number | null;
  label: string;
  day: number | null;
  kind: 'baseline' | 'issued' | 'preview' | 'skipped';
  runId: string;
  contentDigest: string;
  selectedVariants: Record<string, string | null>;
  matchedRuleIds: string[];
  changes: Array<{ path: string; before: unknown; after: unknown }>;
  skippedReason?: string;
  state: Record<string, unknown>;
}

const STATE_PATHS = ['card.paymentStatus', 'card.missedPayments', 'card.assistanceRequested', 'card.arrangementStatus', 'claim.status', 'claim.liabilityConfirmed'];

/** Deterministic replay: one resolution per event position. Issued snapshots are the positions whose event emits an immutable snapshot. */
export function replayJourney(project: Project, record: SyntheticRecord, overrides: Overrides = {}, profileId: ProfileId = 'paged-pdf'): JourneySnapshot[] {
  const out: JourneySnapshot[] = [];
  const states = journeyStates(project);
  // The values worth showing at each step: the card and claim state for the built-in kinds; for a document with its
  // own data, whatever its journey events change.
  const statePaths = project.documentType === 'custom' ? [...new Set(project.journey.events.flatMap((e) => e.effects.map((x) => x.path)))] : STATE_PATHS;
  for (const st of states) {
    const res = resolve({ project, record, overrides, journeyCursor: st.cursor, profileId });
    const ctx: any = { ...res.effectiveRecord, claim: (res.effectiveRecord as any).claims?.[0] };
    const event = st.cursor === null ? null : project.journey.events[st.cursor];
    const step = st.cursor === null ? null : res.journeySteps[st.cursor];
    out.push({
      eventId: event?.eventId ?? null, cursor: st.cursor, label: st.label, day: event?.day ?? null,
      kind: st.cursor === null ? 'baseline' : step && !step.applied ? 'skipped' : event?.emits === 'immutable-issued-snapshot' ? 'issued' : 'preview',
      runId: res.runId, contentDigest: res.contentDigest, selectedVariants: res.result.selectedVariants, matchedRuleIds: res.result.matchedRuleIds,
      changes: (step?.changes ?? []) as JourneySnapshot['changes'], skippedReason: step?.skippedReason,
      state: Object.fromEntries(statePaths.map((p) => [p, getPath(ctx, p)]).filter(([, v]) => v !== null)),
    });
  }
  return out;
}
export * from './impact';
export * from './decisionTable';
export * from './testCases';
export * from './assist';
