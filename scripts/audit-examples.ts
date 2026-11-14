/**
 * The accuracy check of the example documents (D106): `npx tsx scripts/audit-examples.ts [--no-outputs] [--no-settings]`.
 *
 * A list of named checks runs over a list of examples. Each check says pass, intended exception (listed in the sample's
 * notes, with the reason) or FAILED. The script writes `reports/EXAMPLES_AUDIT.md`; `apps/api/test/examples-audit.test.ts`
 * runs the same checks and fails on any unintended finding.
 *
 * To add an example: `registerExample({ id, title, kind, project, customers, notes, domain?, recompute?, pages? })` before
 * `runAudit()` (see `EXAMPLES` below for the two built-in ones). Read-only checks of the approved card and benefits
 * fixtures (`fixtures/customers_100.json`) are reported separately and never change those files.
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RECORD_ID_PATTERN, customFieldDefs, daysBetweenIso, libraryContentFingerprint, libraryLinkProblems, lookupTableProblems, projectFileProblems,
  projectMappingProblems, roundHalfUp, validateRecordShape, validateRule,
  type Project, type SyntheticRecord,
} from '@iss/model';
import { EXTRA_SAMPLES, HOUSE, houseContent, type HouseItemId, type SampleNotes } from '@iss/model/samples/index';
import { translationCounts } from '../packages/model/src/samples/counts';
import { NW_RATES, RATE_CHANGE_DAY } from '../packages/model/src/samples/northwind';
import { feeBps, unitsOf } from '../packages/model/src/samples/meridian';
import { resolve, type Resolution } from '@iss/resolver';
import { compareManifests, pageDesignFindings, renderEmail, renderInteractiveHtml, renderPagedDocument, renderSms } from '@iss/renderers';
import { checkWording, dataDictionary, dateChecks, mappingChecks, runTestCases, coverageGaps } from '@iss/scenarios';
import { bindingAnalysis, staticRuleAnalysis } from '@iss/validation';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');

/* ================================================================== the shape of an example and a check */

export type Group = 'Data' | 'Template and rules' | 'Outcomes' | 'Outputs' | 'Settings';
export const GROUPS: Group[] = ['Data', 'Template and rules', 'Outcomes', 'Outputs', 'Settings'];
export type Status = 'pass' | 'intended' | 'failed' | 'not-run';

export interface AuditExample {
  id: string;
  title: string;
  kind: string;
  project: Project;
  customers: SyntheticRecord[];
  notes: SampleNotes;
  /** Domain arithmetic for one customer: what does not add up, in plain words (empty when everything does). */
  domain?: (record: SyntheticRecord, project: Project) => string[];
  /** The calculated values worked out independently of the studio's engine, by key (only the ones it can work out). */
  recompute?: (record: SyntheticRecord) => Record<string, unknown>;
  /** Page counts: every customer in [min, max] unless named; the last page holds the slip (a text it must contain). */
  pages?: { min: number; max: number; lastPageText?: RegExp };
  /** The released version (when the sample is seeded with one), checked like the working version. */
  release?: Project;
}

export interface CheckOutcome { status: Status; summary: string; failures: string[]; intended: string[] }
export interface AuditCheck {
  id: string;
  group: Group;
  title: string;
  /** `outputs`: composes real PDFs and web pages (a browser). `settings`: builds release packages through a studio. */
  needs?: 'outputs' | 'settings';
  run(ex: AuditExample, ctx: AuditContext): Promise<CheckOutcome> | CheckOutcome;
}

export interface AuditContext {
  resolutions(ex: AuditExample): Map<string, Resolution>;
  composer?: import('../apps/api/src/composer').Composer;
}

const outcome = (failures: string[], intended: string[], summary: string): CheckOutcome =>
  ({ status: failures.length ? 'failed' : intended.length ? 'intended' : 'pass', summary, failures, intended });
const nameOf = (r: SyntheticRecord) => `${r.recordId} (${r.customer.givenName} ${r.customer.familyName})`;
const custom = (r: SyntheticRecord) => (r.custom ?? {}) as Record<string, any>;

/* ================================================================== the examples */

export const EXAMPLES: AuditExample[] = [];
export function registerExample(e: AuditExample): void {
  const i = EXAMPLES.findIndex((x) => x.id === e.id);
  if (i >= 0) EXAMPLES[i] = e; else EXAMPLES.push(e);
}

/* ---- Northwind Energy: domain arithmetic and independent recomputation */

const ELECTRIC = ['Electricity', 'Electricidad'];
const ESTIMATED = ['estimated', 'estimada'];
const half = (x: number) => roundHalfUp(x, 0);

function northwindDomain(r: SyntheticRecord): string[] {
  const c = custom(r);
  const out: string[] = [];
  for (const [i, m] of (c.meters ?? []).entries()) if (m.usage !== m.currentRead - m.previousRead) out.push(`meter row ${i + 1}: usage ${m.usage} is not current ${m.currentRead} − previous ${m.previousRead}`);
  let sum = 0;
  for (const [i, ch] of (c.charges ?? []).entries()) {
    const expect = half((ch.quantity * ch.rateTenThousandths) / 100);
    if (ch.amountCents !== expect) out.push(`charge row ${i + 1}: ${ch.quantity} × ${ch.rateTenThousandths / 10000} = ${expect} cents, but the line says ${ch.amountCents}`);
    const dollars = (Math.abs(ch.rateTenThousandths) / 10000).toFixed(ch.unit === 'month' || ch.unit === 'mes' ? 2 : 4);
    if (!String(ch.rate).includes(dollars)) out.push(`charge row ${i + 1}: the rate text “${ch.rate}” does not show the rate ${dollars}`);
    sum += ch.amountCents;
  }
  if (c.currentChargesCents !== undefined && sum !== c.currentChargesCents) out.push(`charges add up to ${sum} cents, the current charges say ${c.currentChargesCents}`);
  const tax = half(((c.currentChargesCents ?? sum) * NW_RATES.taxBps) / 10000);
  if (c.taxesCents !== tax) out.push(`taxes ${c.taxesCents} are not 6% of the current charges (${tax})`);
  const kwh = (c.meters ?? []).filter((m: any) => ELECTRIC.includes(m.fuel)).reduce((t: number, m: any) => t + m.usage, 0);
  const therms = (c.meters ?? []).filter((m: any) => m.fuel === 'Gas').reduce((t: number, m: any) => t + m.usage, 0);
  const last = (c.usageHistory ?? [])[(c.usageHistory ?? []).length - 1];
  if (!last || last.kwh !== kwh || last.therms !== therms) out.push(`the usage history’s last month (${last?.kwh} kWh, ${last?.therms} therms) is not this bill’s usage (${kwh} kWh, ${therms} therms)`);
  if ((c.usageHistory ?? []).length !== 12) out.push(`the usage history has ${(c.usageHistory ?? []).length} months, not 12`);
  if (!(c.periodStart < c.periodEnd && c.periodEnd < c.billDate)) out.push('the billing period does not end before the bill date');
  if (c.dueDate !== undefined && !(c.billDate < c.dueDate)) out.push('the due date is not after the bill date');
  const days = daysBetweenIso(c.periodStart, c.periodEnd);
  if (days < 25 || days > 35) out.push(`the billing period is ${days} days`);
  const services = c.services as string;
  if ((services === 'gas') !== (kwh === 0 && !(c.meters ?? []).some((m: any) => ELECTRIC.includes(m.fuel)))) out.push('the meters do not match the services on the account');
  if (c.paymentPlan && !(c.planInstallmentCents > 0)) out.push('a payment plan without an installment');
  return out;
}

function northwindRecompute(r: SyntheticRecord): Record<string, unknown> {
  const c = custom(r);
  const kwh = (c.meters ?? []).filter((m: any) => ELECTRIC.includes(m.fuel)).reduce((t: number, m: any) => t + m.usage, 0);
  const therms = (c.meters ?? []).filter((m: any) => m.fuel === 'Gas').reduce((t: number, m: any) => t + m.usage, 0);
  const bandRate = kwh < 500 ? 6.12 : kwh < 1000 ? 6.88 : 7.41;
  const out: Record<string, unknown> = {
    electricUsage: kwh, gasUsage: therms,
    estimatedReads: (c.meters ?? []).filter((m: any) => ESTIMATED.includes(m.readType)).length,
    deliveryRate: bandRate, deliveryCharge: half(kwh * bandRate),
    supplyRate: c.billDate < RATE_CHANGE_DAY ? 7.85 : 8.42,
    billingDays: daysBetweenIso(c.periodStart, c.periodEnd),
    avgDailyKwh: roundHalfUp(kwh / daysBetweenIso(c.periodStart, c.periodEnd), 1),
    lateFee: c.paymentStatus === 'overdue' ? ({ standard: 1500, 'time-of-use': 1250, budget: 1000 } as Record<string, number>)[c.plan] : 0,
    serviceAddress: `${c.serviceStreet}, ${c.serviceCity}, ${c.serviceState} ${c.serviceZip}`,
    kwhChangePct: c.lastYearKwh > 0 ? roundHalfUp(((kwh - c.lastYearKwh) / c.lastYearKwh) * 100, 0) : 0,
    peakMonthKwh: Math.max(...(c.usageHistory ?? []).map((h: any) => h.kwh)),
  };
  if (c.dueDate !== undefined) out.daysUntilDue = daysBetweenIso(c.billDate, c.dueDate);
  if (c.currentChargesCents !== undefined) {
    out.totalDue = c.previousBalanceCents - c.paymentsCents + c.currentChargesCents + c.taxesCents;
    out.creditAmount = Math.abs(out.totalDue as number);
  }
  // The delivery charge line on the bill is the same amount the calculation shows.
  const delivery = (c.charges ?? []).find((ch: any) => /^(Delivery|Distribución) \(/.test(ch.description));
  if (delivery && delivery.amountCents !== out.deliveryCharge) out.deliveryChargeLine = delivery.amountCents;
  return out;
}

/* ---- Meridian Wealth */

const FEE_TYPES = ['Management fee', 'Comisión de administración'];
const INCOME_TYPES = ['Dividend', 'Interest', 'Dividendo', 'Interés'];
const typed = (c: any, types: string[]) => (c.transactions ?? []).filter((t: any) => types.includes(t.type)).reduce((s: number, t: any) => s + t.amountCents, 0);

function meridianDomain(r: SyntheticRecord): string[] {
  const c = custom(r);
  const out: string[] = [];
  let total = 0;
  let weights = 0;
  for (const [i, h] of (c.holdings ?? []).entries()) {
    const v = half((unitsOf(h.units) * h.priceCents) / 1000);
    if (v !== h.valueCents) out.push(`holding row ${i + 1}: ${h.units} × ${h.priceCents} cents = ${v}, the row says ${h.valueCents}`);
    total += h.valueCents;
    weights += Number(String(h.weight).replace('%', ''));
  }
  const n = (c.holdings ?? []).length;
  if (c.closingValueCents !== undefined) {
    if (total !== c.closingValueCents) out.push(`holdings add up to ${total} cents, the closing value says ${c.closingValueCents}`);
    if (Math.abs(weights - 100) > 0.05 * n + 1e-9) out.push(`the weights add up to ${weights.toFixed(1)}%, not 100% within rounding`);
    const flows = c.openingValueCents + c.contributionsCents - c.withdrawalsCents + c.incomeCents - c.feesCents + c.marketChangeCents;
    if (flows !== c.closingValueCents) out.push(`opening + contributions − withdrawals + income − fees + market change = ${flows}, not the closing value ${c.closingValueCents}`);
  }
  if (c.previousQuarterCloseCents !== c.openingValueCents) out.push('the opening value is not the previous quarter’s closing value');
  const byClass = new Map<string, number>();
  for (const h of c.holdings ?? []) byClass.set(h.assetClass, (byClass.get(h.assetClass) ?? 0) + h.valueCents);
  const alloc = new Map<string, number>((c.assetAllocation ?? []).map((a: any) => [a.assetClass, a.valueCents]));
  for (const [k, v] of byClass) if (v > 0 && alloc.get(k) !== v) out.push(`the allocation for ${k} is ${alloc.get(k)}, the holdings of that class add up to ${v}`);
  for (const [k] of alloc) if (!byClass.has(k)) out.push(`the allocation lists ${k}, which no holding has`);
  for (const [i, t] of (c.transactions ?? []).entries()) if (!(t.date >= c.periodStart && t.date <= c.periodEnd)) out.push(`transaction ${i + 1} on ${t.date} is outside the period`);
  if (typed(c, FEE_TYPES) !== c.feesCents) out.push(`fee transactions add up to ${typed(c, FEE_TYPES)}, the fees say ${c.feesCents}`);
  if (typed(c, INCOME_TYPES) !== c.incomeCents) out.push(`income transactions add up to ${typed(c, INCOME_TYPES)}, the income says ${c.incomeCents}`);
  const unreal = (c.holdings ?? []).reduce((s: number, h: any) => s + h.valueCents - h.costCents, 0);
  if (unreal !== c.unrealisedGainCents) out.push(`unrealized gain ${c.unrealisedGainCents} is not market value less cost (${unreal})`);
  const fee = c.openingValueCents > 0 && !c.feeWaived ? half((c.openingValueCents * feeBps(c.openingValueCents, c.periodEnd)) / 40000) : 0;
  if (c.feesCents !== fee) out.push(`the fee ${c.feesCents} is not the fee table’s quarterly fee ${fee}`);
  if (!(c.periodStart < c.periodEnd)) out.push('the period ends before it starts');
  return out;
}

function meridianRecompute(r: SyntheticRecord): Record<string, unknown> {
  const c = custom(r);
  const pct = (a: number, b: number, places: number) => roundHalfUp((a / b) * 100, places);
  const ret = c.openingValueCents > 0 ? pct(c.marketChangeCents + c.incomeCents - c.feesCents, c.openingValueCents, 2) : 0;
  const prev = roundHalfUp(c.previousQuarterReturnBps / 100, 2);
  const bps = feeBps(c.openingValueCents, c.periodEnd);
  const largest = Math.max(...(c.holdings ?? []).map((h: any) => h.valueCents));
  const out: Record<string, unknown> = {
    periodDays: daysBetweenIso(c.periodStart, c.periodEnd),
    investmentReturnPct: ret, previousReturnPct: prev, returnVsPrevious: roundHalfUp(ret - prev, 2), lossPct: Math.abs(ret), fellSharply: ret <= -5,
    totalFees: typed(c, FEE_TYPES), totalIncome: typed(c, INCOME_TYPES), largestHolding: largest,
    holdingCount: (c.holdings ?? []).filter((h: any) => h.valueCents > 0).length,
    feeRateBps: bps, feeRatePct: roundHalfUp(bps / 100, 2), quarterlyFee: c.feeWaived ? 0 : half((c.openingValueCents * bps) / 40000),
    modelPortfolio: ({ conservative: 'C-30', balanced: 'B-50', growth: 'G-70', aggressive: 'A-90' } as Record<string, string>)[c.riskProfile],
    equityTarget: ({ conservative: 30, balanced: 50, growth: 70, aggressive: 90 } as Record<string, number>)[c.riskProfile],
  };
  if (c.adviserName && c.adviserPhone) out.adviserLine = `${c.adviserName} · ${c.adviserPhone}`;
  if (c.closingValueCents !== undefined) {
    out.changeInValue = c.closingValueCents - c.openingValueCents;
    out.changePct = c.openingValueCents > 0 ? pct(c.closingValueCents - c.openingValueCents, c.openingValueCents, 2) : 0;
    out.largestWeightPct = pct(largest, c.closingValueCents, 1);
  }
  return out;
}

for (const s of EXTRA_SAMPLES()) {
  const nw = s.project.projectId.startsWith('northwind');
  registerExample({
    id: s.project.projectId, title: s.notes.title, kind: s.notes.kind, project: s.project, customers: s.customers, notes: s.notes,
    domain: nw ? northwindDomain : meridianDomain, recompute: nw ? northwindRecompute : meridianRecompute,
    pages: nw ? { min: 2, max: 4, lastPageText: /Payment slip|Talón de pago/ } : { min: 2, max: 3 },
    release: s.release?.project,
  });
}

/* ================================================================== the checks */

const notRun = (why: string): CheckOutcome => ({ status: 'not-run', summary: why, failures: [], intended: [] });
const key = (recordId: string, code: string) => `${recordId}|${code}`;

/** The outcomes a document can reach: every rule, every alternative of every message, every conditional section shown and hidden, every language. */
function outcomesOf(project: Project): string[] {
  const out: string[] = [];
  for (const r of project.rules) if (r.enabled !== false) out.push(`rule ${r.id}`);
  for (const n of project.nodes) {
    if (n.type === 'variant-set' || n.type === 'conditional-region') for (const v of n.variantIds ?? []) out.push(`alternative ${n.id}/${v}`);
    if (n.visibleWhen || n.type === 'conditional-region' || n.ruleDriven) out.push(`shown ${n.id}`, `hidden ${n.id}`);
  }
  for (const l of ['en-US', ...(project.languages ?? [])]) out.push(`language ${l}`);
  return out;
}
function reachedBy(project: Project, res: Resolution): Set<string> {
  const got = new Set<string>();
  for (const t of res.trace) if (t.kind === 'rule' && t.matched && !['outranked', 'out-of-scope', 'tie', 'not-matched'].includes(String(t.outcome))) got.add(`rule ${t.ruleId}`);
  const walk = (n: Resolution['root']) => {
    const node = project.nodes.find((x) => x.id === n.id);
    if (node && (node.visibleWhen || node.type === 'conditional-region' || node.ruleDriven)) got.add(`${n.visible ? 'shown' : 'hidden'} ${n.id}`);
    if (n.visible && n.variants) for (const v of n.variants.selected) got.add(`alternative ${n.id}/${v}`);
    for (const c of n.children) walk(c);
  };
  walk(res.root);
  got.add(`language ${res.locale}`);
  return got;
}

const UNFORMATTED = [/\bundefined\b/, /\bNaN\b/, /\bnull\b/, /\[object Object\]/, /\{\{[^}]*\}\}/, /\b\d{4}-\d{2}-\d{2}\b/, /\bcalc\.\w+/, /\bcustom\.\w+/];
const rawValues = (text: string): string[] => UNFORMATTED.filter((re) => re.test(text)).map((re) => String(text.match(re)?.[0]));

export const CHECKS: AuditCheck[] = [
  /* ---------------------------------------------------------------- Data */
  {
    id: 'ids', group: 'Data', title: 'Customer ids are unique and well formed',
    run(ex) {
      const f: string[] = [];
      const seen = new Set<string>();
      for (const r of ex.customers) {
        if (!RECORD_ID_PATTERN.test(r.recordId)) f.push(`${r.recordId} is not a well-formed id`);
        if (seen.has(r.recordId)) f.push(`${r.recordId} is used twice`);
        seen.add(r.recordId);
        if (r.documentType !== ex.project.documentType) f.push(`${r.recordId} is a ${r.documentType} record`);
        if (r.projectId && r.projectId !== ex.project.projectId) f.push(`${r.recordId} belongs to ${r.projectId}`);
      }
      return outcome(f, [], `${ex.customers.length} customers, ${seen.size} distinct ids`);
    },
  },
  {
    id: 'shape', group: 'Data', title: 'Required fields present; types and choice values valid',
    run(ex) {
      const defs = customFieldDefs(ex.project.customFields);
      const f: string[] = [];
      for (const r of ex.customers) for (const p of validateRecordShape(r, ex.project.documentType, defs)) f.push(`${nameOf(r)}: ${p}`);
      const req = (ex.project.customFields ?? []).filter((x) => x.required);
      for (const r of ex.customers) for (const x of req) if (custom(r)[x.key] === undefined || custom(r)[x.key] === null || custom(r)[x.key] === '') f.push(`${nameOf(r)} has no ${x.label}`);
      for (const r of ex.customers) for (const x of ex.project.customFields ?? []) if (x.type === 'enum' && custom(r)[x.key] !== undefined && !(x.enumValues ?? []).includes(custom(r)[x.key])) f.push(`${nameOf(r)}: ${x.label} “${custom(r)[x.key]}” is not one of the choices`);
      return outcome(f, [], `${ex.customers.length} customers against ${defs.length} field definitions (${req.length} required)`);
    },
  },
  {
    id: 'domain', group: 'Data', title: 'Domain arithmetic to the cent, dates in order',
    run(ex) {
      if (!ex.domain) return notRun('This example declares no domain arithmetic.');
      const f: string[] = [];
      const intended: string[] = [];
      for (const r of ex.customers) {
        const problems = ex.domain(r, ex.project);
        const meant = ex.notes.intendedBlockers.find((b) => b.recordId === r.recordId && b.code === 'CALCULATION_MISSING');
        for (const p of problems) (meant ? intended : f).push(`${nameOf(r)}: ${p}${meant ? ` — intended: ${meant.reason}` : ''}`);
      }
      return outcome(f, intended, `${ex.customers.length} customers checked`);
    },
  },
  /* ---------------------------------------------------------------- Template and rules */
  {
    id: 'model', group: 'Template and rules', title: 'The document passes every model validation',
    run(ex) {
      const f: string[] = [];
      for (const [label, p] of [['working version', ex.project], ...(ex.release ? [['released version', ex.release] as const] : [])] as Array<[string, Project]>) {
        for (const x of projectFileProblems(p)) f.push(`${label}: ${x.message}`);
        for (const x of libraryLinkProblems(p)) f.push(`${label}: ${x}`);
        for (const x of projectMappingProblems(p)) f.push(`${label}: ${x}`);
        for (const r of p.rules) for (const x of validateRule(r, p)) f.push(`${label}: rule ${r.id}: ${x}`);
        for (const x of [...staticRuleAnalysis(p, ex.customers), ...bindingAnalysis(p)]) if (x.severity === 'blocking') f.push(`${label}: ${x.code}: ${x.message}`);
        for (const x of pageDesignFindings(p)) if (x.severity === 'blocking') f.push(`${label}: ${x.code}: ${x.message}`);
      }
      return outcome(f, [], `${ex.project.nodes.length} components, ${ex.project.rules.length} rules, ${(ex.project.calculatedFields ?? []).length} calculations, ${(ex.project.lookupTables ?? []).length} lookup tables`);
    },
  },
  {
    id: 'coverage', group: 'Template and rules', title: 'Every rule, alternative, conditional section and language is reached',
    run(ex, ctx) {
      const want = outcomesOf(ex.project);
      const got = new Set<string>();
      for (const res of ctx.resolutions(ex).values()) for (const o of reachedBy(ex.project, res)) got.add(o);
      const missing = want.filter((o) => !got.has(o));
      const unreached = new Map((ex.notes.unreached ?? []).map((u) => [u.id, u.reason]));
      const f = missing.filter((m) => !unreached.has(m)).map((m) => `${m} is reached by no customer`);
      const intended = missing.filter((m) => unreached.has(m)).map((m) => `${m}: ${unreached.get(m)}`);
      const gaps = coverageGaps(ex.project, ex.customers);
      return outcome(f, intended, `${want.length - missing.length} of ${want.length} outcomes reached by the customers; the studio’s coverage engine lists ${gaps.length} gap${gaps.length === 1 ? '' : 's'}`);
    },
  },
  {
    id: 'time', group: 'Template and rules', title: 'No rule ties and no gaps in time',
    run(ex) {
      const f = dateChecks(ex.project).map((d) => `${d.kind}: ${d.message}`);
      for (const x of staticRuleAnalysis(ex.project, ex.customers)) if (/TIE|EQUAL_PRIORITY/.test(x.code)) f.push(`${x.code}: ${x.message}`);
      return outcome(f, [], 'Dated rules, alternatives and sections checked for gaps and overlaps on every boundary day');
    },
  },
  {
    id: 'fields-used', group: 'Template and rules', title: 'Every data field is used, or listed as intentionally unused',
    run(ex) {
      const dict = dataDictionary(ex.project);
      const unused: string[] = [];
      for (const fld of dict.fields) {
        if (fld.calculated || fld.path === 'documentType' || fld.path.startsWith('customer.') || fld.path === 'document.date' || fld.path.endsWith('.count')) continue;
        if (!fld.needed) unused.push(fld.path);
        for (const c of fld.columns ?? []) if (!c.used) unused.push(`${fld.path}[].${c.key}`);
      }
      const declared = new Map(ex.notes.unusedFields.map((u) => [u.path, u.reason]));
      const f = unused.filter((p) => !declared.has(p)).map((p) => `${p} is not used anywhere`);
      const intended = unused.filter((p) => declared.has(p)).map((p) => `${p}: ${declared.get(p)}`);
      for (const p of declared.keys()) if (!unused.includes(p)) f.push(`${p} is declared unused but the document uses it`);
      return outcome(f, intended, `${dict.fields.length} fields in the data dictionary`);
    },
  },
  {
    id: 'calculations', group: 'Template and rules', title: 'Every calculation has a value; totals equal an independent recomputation',
    run(ex, ctx) {
      const f: string[] = [];
      const intended: string[] = [];
      let compared = 0;
      for (const r of ex.customers) {
        const res = ctx.resolutions(ex).get(r.recordId)!;
        const meant = new Map(ex.notes.missingCalcs.filter((m) => m.recordId === r.recordId).map((m) => [m.key, m.reason]));
        for (const [k, v] of Object.entries(res.calculated ?? {})) {
          if (v.missing) (meant.has(k) ? intended : f).push(`${nameOf(r)}: ${k} has no value${meant.has(k) ? ` — intended: ${meant.get(k)}` : ` (${v.missing.message})`}`);
          else if (meant.has(k)) f.push(`${nameOf(r)}: ${k} is declared missing but has a value`);
        }
        const expect = ex.recompute?.(r) ?? {};
        for (const [k, want] of Object.entries(expect)) {
          if (k === 'deliveryChargeLine') { f.push(`${nameOf(r)}: the delivery charge line (${want}) differs from the calculation`); continue; }
          const got = res.calculated?.[k]?.value;
          compared++;
          if (JSON.stringify(got) !== JSON.stringify(want)) f.push(`${nameOf(r)}: ${k} is ${JSON.stringify(got)}, recomputed ${JSON.stringify(want)}`);
        }
      }
      return outcome(f, intended, `${(ex.project.calculatedFields ?? []).length} calculations × ${ex.customers.length} customers; ${compared} values recomputed independently`);
    },
  },
  {
    id: 'lookups', group: 'Template and rules', title: 'Lookup tables: no duplicates, overlaps or gaps; every customer finds a row',
    run(ex, ctx) {
      const f: string[] = [];
      for (const t of ex.project.lookupTables ?? []) for (const p of lookupTableProblems(t)) f.push(`${t.title}: ${p.kind}: ${p.message}`);
      for (const r of ex.customers) for (const fd of ctx.resolutions(ex).get(r.recordId)!.findings) if (fd.code === 'LOOKUP_NO_MATCH') f.push(`${nameOf(r)}: ${fd.message}`);
      return outcome(f, [], `${(ex.project.lookupTables ?? []).length} tables, ${(ex.project.lookupTables ?? []).reduce((s, t) => s + t.rows.length, 0)} rows`);
    },
  },
  /* ---------------------------------------------------------------- Outcomes */
  {
    id: 'blockers', group: 'Outcomes', title: 'The only blocking findings are the intended, listed ones',
    run(ex, ctx) {
      const want = new Map([...ex.notes.intendedBlockers, ...ex.notes.knownDataProblems].map((b) => [key(b.recordId, b.code), b.reason]));
      const seen = new Set<string>();
      const f: string[] = [];
      const intended: string[] = [];
      for (const r of ex.customers) {
        for (const fd of ctx.resolutions(ex).get(r.recordId)!.findings.filter((x) => x.severity === 'blocking')) {
          const k = key(r.recordId, fd.code);
          seen.add(k);
          if (want.has(k)) intended.push(`${nameOf(r)}: ${fd.code} — ${want.get(k)}`);
          else f.push(`${nameOf(r)}: ${fd.code}: ${fd.message}`);
        }
      }
      for (const k of want.keys()) if (!seen.has(k)) f.push(`${k.replace('|', ': ')} is declared but no longer stops that customer`);
      return outcome(f, [...new Set(intended)], `${ex.customers.length} customers resolved; ${seen.size} blocking finding${seen.size === 1 ? '' : 's'}`);
    },
  },
  {
    id: 'tests', group: 'Outcomes', title: 'Pinned tests pass',
    run(ex) {
      const results = runTestCases(ex.project, ex.customers);
      const f = results.filter((t) => !t.pass).map((t) => `${t.testId} ${t.name}: ${t.diffs.map((d) => d.message).join('; ')}`);
      if (results.length < 5) f.push(`only ${results.length} pinned tests`);
      if (!(ex.project.testCases ?? []).some((t) => t.issueDate)) f.push('no pinned test runs “as issued on” a date');
      return outcome(f, [], `${results.length} pinned tests, ${results.filter((t) => t.pass).length} passing`);
    },
  },
  {
    id: 'wording', group: 'Outcomes', title: 'Wording rules: no “must” finding, only the intended “should”',
    run(ex) {
      const check = checkWording(ex.project);
      const meant = new Map(ex.notes.intendedShould.map((s) => [s.ruleId, s.reason]));
      const f: string[] = [];
      const intended: string[] = [];
      for (const w of check.findings) {
        if (w.severity === 'should' && meant.has(w.ruleId)) intended.push(`${w.ruleId} in ${w.textTitle ?? 'the document'} (${w.locale}) — ${meant.get(w.ruleId)}`);
        else f.push(`${w.severity} ${w.ruleId}: ${w.message}`);
      }
      for (const id of meant.keys()) if (!check.findings.some((w) => w.ruleId === id)) f.push(`the intended finding of ${id} is gone`);
      return outcome(f, intended, `${check.rules.length} rules in force (house and own) over ${check.textsChecked} texts`);
    },
  },
  {
    id: 'translations', group: 'Outcomes', title: 'Translations: approved, draft and missing as declared',
    run(ex) {
      const got = translationCounts(ex.project);
      const f: string[] = [];
      for (const [loc, want] of Object.entries(ex.notes.translations)) {
        const g = got[loc] ?? { approved: 0, draft: 0, missing: 0 };
        if (JSON.stringify(g) !== JSON.stringify(want)) f.push(`${loc}: ${JSON.stringify(g)}, declared ${JSON.stringify(want)}`);
      }
      return outcome(f, [], Object.entries(got).map(([l, c]) => `${l}: ${c.approved} approved, ${c.draft} draft, ${c.missing} missing`).join('; '));
    },
  },
  {
    id: 'library', group: 'Outcomes', title: 'Library links are at the declared versions, with the library’s content',
    run(ex) {
      const f: string[] = [];
      const links = ex.project.libraryLinks ?? [];
      for (const l of links) {
        const item = HOUSE.items[l.itemId as HouseItemId];
        if (!item) { f.push(`${l.title}: not a house library item`); continue; }
        const plan = HOUSE.linkPlan[l.itemId as HouseItemId];
        if (l.version !== plan) f.push(`${l.title}: version ${l.version}, declared ${plan}`);
        if (l.fingerprint !== libraryContentFingerprint(houseContent(l.itemId as HouseItemId, l.version))) f.push(`${l.title}: the content is not the library’s version ${l.version}`);
      }
      const behind = links.filter((l) => HOUSE.items[l.itemId as HouseItemId] && HOUSE.items[l.itemId as HouseItemId].versions.length > l.version).map((l) => l.title);
      return outcome(f, behind.map((t) => `${t}: a newer approved version exists, on purpose (“Update available”)`), `${links.length} links`);
    },
  },
  {
    id: 'mappings', group: 'Outcomes', title: 'Mapping completeness as declared',
    run(ex) {
      const f: string[] = [];
      const intended: string[] = [];
      for (const m of ex.project.mappings ?? []) {
        const c = mappingChecks(ex.project, m);
        const want = ex.notes.mappings[m.id];
        if (!want) f.push(`${m.name}: not declared in the notes`);
        else if ((want === 'complete') !== c.complete) f.push(`${m.name}: ${c.complete ? 'complete' : `incomplete (${c.findings.filter((x) => x.severity === 'problem').slice(0, 3).map((x) => x.message).join(' ')})`}, declared ${want}`);
        else if (want === 'incomplete') intended.push(`${m.name}: ${c.counts.unmapped} fields unmapped, on purpose`);
      }
      return outcome(f, intended, (ex.project.mappings ?? []).map((m) => `${m.name}: ${mappingChecks(ex.project, m).complete ? 'complete' : 'incomplete'}`).join('; '));
    },
  },
  {
    id: 'channels', group: 'Outcomes', title: 'Email subject and SMS within their limits, nothing unresolved or unformatted',
    run(ex, ctx) {
      const f: string[] = [];
      const intended: string[] = [];
      let longest = 0;
      let segments = 0;
      for (const r of ex.customers) {
        const res = ctx.resolutions(ex).get(r.recordId)!;
        const email = renderEmail(res, ex.project);
        const sms = renderSms(res, ex.project);
        longest = Math.max(longest, email.subject.length);
        segments = Math.max(segments, sms.segments);
        const blocked = ex.notes.intendedBlockers.some((b) => b.recordId === r.recordId) || ex.notes.knownDataProblems.some((b) => b.recordId === r.recordId);
        const problems: string[] = [];
        if (email.subject.length > 100) problems.push(`the email subject is ${email.subject.length} characters`);
        if (sms.segments > 2) problems.push(`the SMS takes ${sms.segments} parts`);
        for (const [what, text] of [['subject', email.subject], ['SMS', sms.text], ['email', email.text]] as const) for (const v of rawValues(text.replace(/https:\/\/\S+/g, ''))) problems.push(`the ${what} contains “${v}”`);
        if (/—/.test(email.subject + sms.text)) problems.push('a value is shown as “—” (missing)');
        for (const p of problems) (blocked ? intended : f).push(`${nameOf(r)}: ${p}${blocked ? ' — a demonstration customer whose data is incomplete on purpose' : ''}`);
      }
      return outcome(f, intended, `${ex.customers.length} customers; longest subject ${longest} characters; SMS at most ${segments} part${segments === 1 ? '' : 's'}`);
    },
  },
  {
    id: 'released-version', group: 'Settings', title: 'The seeded release was approvable: no blocker but the known data problem, its pinned tests pass',
    run(ex) {
      if (!ex.release) return outcome([], [], 'Seeded without a release (it starts as a Draft): nothing to check.');
      const f: string[] = [];
      const known = new Set(ex.notes.knownDataProblems.map((k) => key(k.recordId, k.code)));
      const intended: string[] = [];
      for (const r of ex.customers) for (const fd of resolve({ project: ex.release, record: r }).findings.filter((x) => x.severity === 'blocking')) {
        if (known.has(key(r.recordId, fd.code))) intended.push(`${nameOf(r)}: ${fd.code} — set aside as a known data problem when release 1 was approved`);
        else f.push(`${nameOf(r)}: ${fd.code}: ${fd.message}`);
      }
      for (const x of [...staticRuleAnalysis(ex.release, ex.customers), ...bindingAnalysis(ex.release)]) if (x.severity === 'blocking') f.push(`${x.code}: ${x.message}`);
      for (const w of checkWording(ex.release).findings) if (w.severity === 'must') f.push(`must ${w.ruleId}: ${w.message}`);
      const tests = runTestCases(ex.release, ex.customers);
      for (const t of tests.filter((x) => !x.pass)) f.push(`pinned test ${t.testId} fails: ${t.diffs.map((d) => d.message).join('; ')}`);
      return outcome(f, intended, `${ex.customers.length} customers and ${tests.length} pinned tests against the released version`);
    },
  },
  /* ---------------------------------------------------------------- Outputs (real composition) */
  {
    id: 'outputs', group: 'Outputs', needs: 'outputs', title: 'Composed PDF and web page: no overflow, pages as declared, parity, nothing unformatted',
    async run(ex, ctx) {
      if (!ctx.composer) return notRun('Composition was not run (--no-outputs).');
      const f: string[] = [];
      const intended: string[] = [];
      const reps = representatives(ex, ctx);
      const pages: string[] = [];
      for (const r of reps) {
        const res = ctx.resolutions(ex).get(r.recordId)!;
        const blocked = ex.notes.intendedBlockers.some((b) => b.recordId === r.recordId) || ex.notes.knownDataProblems.some((b) => b.recordId === r.recordId);
        const comp = await ctx.composer.composePaged(renderPagedDocument(res, ex.project, { profileId: 'paged-pdf', watermark: '' }), { pdf: true });
        const html = await ctx.composer.inspectHtml(renderInteractiveHtml(res, ex.project));
        const problems: string[] = [];
        for (const d of comp.metrics.diagnostics) if (d.severity === 'blocking' || d.severity === 'error' || /OVERFLOW|CLIPPED|CANNOT_FIT|OFF_PAGE/.test(d.code)) problems.push(`${d.code}: ${d.message}`);
        const n = comp.metrics.pageCount;
        pages.push(`${r.recordId}: ${n}`);
        const exact = ex.notes.pages[r.recordId];
        if (exact !== undefined ? n !== exact : n < (ex.pages?.min ?? 1) || n > (ex.pages?.max ?? 99)) problems.push(`${n} pages, declared ${exact ?? `${ex.pages?.min}–${ex.pages?.max}`}`);
        if (comp.metrics.pdfPageCount !== undefined && comp.metrics.pdfPageCount !== n) problems.push(`the PDF has ${comp.metrics.pdfPageCount} pages, the composer measured ${n}`);
        const text = await pdfPageTexts(comp.pdf!);
        if (ex.pages?.lastPageText && !ex.pages.lastPageText.test(text[text.length - 1] ?? '')) problems.push('the last page does not carry the payment slip');
        if (ex.pages?.lastPageText && text.slice(0, -1).some((t) => ex.pages!.lastPageText!.test(t))) problems.push('the payment slip is on a page before the last');
        const lastTemplate = comp.metrics.pages[comp.metrics.pages.length - 1]?.template;
        if (ex.pages?.lastPageText && lastTemplate !== 'last' && lastTemplate !== 'first+last') problems.push(`the last page uses the ${lastTemplate} template`);
        const parity = compareManifests(res.semanticManifest, comp.extracted, html.extracted);
        const mismatched = parity.checks.filter((c) => c.status !== 'match' && c.blocking);
        if (mismatched.length) problems.push(`parity: ${mismatched.map((c) => `${c.label} (PDF ${JSON.stringify(c.pdf)}, web page ${JSON.stringify(c.html)})`.slice(0, 300)).join('; ')}`);
        for (const v of rawValues(text.join('\n').replace(/https:\/\/\S+/g, '').replace(/example\.com\S*/g, ''))) problems.push(`the PDF contains “${v}”`);
        for (const p of problems) (blocked && /“—”|null|parity/.test(p) ? intended : f).push(`${nameOf(r)}: ${p}`);
      }
      return outcome(f, intended, `${reps.length} representative customers composed (every outcome once); pages: ${pages.join(', ')}`);
    },
  },
  {
    id: 'pdf-accessibility', group: 'Outputs', needs: 'outputs', title: 'PDF accessibility checks pass (“Accessible PDF is required” is on)',
    async run(ex, ctx) {
      if (!ctx.composer) return notRun('Composition was not run (--no-outputs).');
      const { checkDocumentPdf } = await import('../apps/api/src/pdfAccessibility');
      const f: string[] = [];
      if (!ex.project.accessiblePdfRequired) f.push('“Accessible PDF is required” is off');
      const reps = representatives(ex, ctx).filter((r) => !ex.notes.intendedBlockers.some((b) => b.recordId === r.recordId)).slice(0, 4);
      let passed = 0;
      for (const r of reps) {
        const result = await checkDocumentPdf(ctx.composer, ctx.resolutions(ex).get(r.recordId)!, ex.project);
        if (result.studio.summary.failed) f.push(`${nameOf(r)}: ${result.studio.findings.map((x) => `${x.code} ${x.message}`).slice(0, 3).join(' | ')}`);
        else passed++;
      }
      return outcome(f, [], `${passed} of ${reps.length} composed PDFs pass every check the studio runs (veraPDF not run)`);
    },
  },
];

/** One customer for each outcome the document can reach (greedy: the customer reaching most outcomes not yet covered), plus the declared page cases. */
function representatives(ex: AuditExample, ctx: AuditContext): SyntheticRecord[] {
  const left = new Set(outcomesOf(ex.project));
  const pool = [...ex.customers];
  const out: SyntheticRecord[] = [];
  const reach = new Map(pool.map((r) => [r.recordId, reachedBy(ex.project, ctx.resolutions(ex).get(r.recordId)!)]));
  while (left.size && pool.length) {
    pool.sort((a, b) => [...reach.get(b.recordId)!].filter((o) => left.has(o)).length - [...reach.get(a.recordId)!].filter((o) => left.has(o)).length || a.recordId.localeCompare(b.recordId));
    const best = pool.shift()!;
    const gain = [...reach.get(best.recordId)!].filter((o) => left.has(o));
    if (!gain.length) break;
    gain.forEach((o) => left.delete(o));
    out.push(best);
  }
  for (const id of Object.keys(ex.notes.pages)) if (!out.some((r) => r.recordId === id)) { const r = ex.customers.find((c) => c.recordId === id); if (r) out.push(r); }
  for (const b of [...ex.notes.intendedBlockers, ...ex.notes.knownDataProblems]) if (!out.some((r) => r.recordId === b.recordId)) { const r = ex.customers.find((c) => c.recordId === b.recordId); if (r) out.push(r); }
  return out;
}

async function pdfPageTexts(pdf: Buffer): Promise<string[]> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items.map((it: any) => it.str).join(' '));
  return pages;
}

/* ================================================================== settings: releases, packages and proofs through a studio */

export interface SettingsResult { example: string; checks: Array<{ title: string; outcome: CheckOutcome }> }

/**
 * Release and package (stub composer) with no customer data, the runnable package's own `verify` (without PDF) and a
 * proof record produced and verified as "same". Runs a studio in a temporary data folder.
 */
export async function settingsChecks(): Promise<SettingsResult[]> {
  const { buildApp } = await import('../apps/api/src/app');
  const { createRelease } = await import('../apps/api/src/releases');
  const { zipEntries, zipRead } = await import('../apps/api/src/zip');
  const stub = { async pdf() { return { pdf: Buffer.from('%PDF-1.4\n% stub\n%%EOF\n'), pageCount: 1, facts: null }; }, async html() { return { facts: null }; } };
  const dir = mkdtempSync(path.join(tmpdir(), 'iss-audit-'));
  const ctx = await buildApp({ dataDir: dir, logger: false, auth: false, releasePackage: { composer: stub as any, scenarioCap: 6, referenceCap: 2 } });
  const inj = async (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });
  const out: SettingsResult[] = [];
  try {
    for (const ex of EXAMPLES.filter((e) => EXTRA_SAMPLES().some((s) => s.project.projectId === e.id))) {
      const checks: SettingsResult['checks'] = [];
      let release = ctx.store.releases(ex.id).find((r) => r.stages.production?.status === 'current' || r.stages.test.status === 'current');
      // An example seeded without a release gets one made by this check from its saved version (in the temporary studio only).
      if (!release) release = createRelease(ctx.store, ctx.store.getProject(ex.id)!, { approvedBy: { id: 'audit', name: 'Accuracy check' }, approvedAt: new Date().toISOString(), createdBy: { id: 'audit', name: 'Accuracy check' }, origin: 'manual' }).release;
      const made = (await inj('POST', `/api/v1/releases/${release.id}/package`, { wait: true })).json();
      const pkg = made.package ?? made;
      const f: string[] = [];
      if (pkg.status !== 'ready') f.push(`the package is ${pkg.status}: ${pkg.error ?? ''}`);
      const zip = (await inj('GET', `/api/v1/releases/${release.id}/package`)).rawPayload;
      const summary = pkg.summary ?? {};
      const kinds = new Set<string>();
      let manifestCustomers: any[] = [];
      try {
        const scen = zipEntries(zip).find((e) => e.name === 'tests/scenarios.json' || e.name.endsWith('/scenarios.json'));
        if (scen) manifestCustomers = JSON.parse(zipRead(zip, scen).toString('utf8')).customers ?? [];
        for (const c of manifestCustomers) kinds.add(c.kind);
      } catch { /* the summary is enough */ }
      for (const k of kinds) if (k !== 'sample' && k !== 'generated') f.push(`a customer of kind ${k} is in the package`);
      if ((summary.counts?.pinnedTestsExcluded ?? summary.tests?.pinnedTestsExcluded?.length ?? 0) > 0) f.push(`${summary.counts?.pinnedTestsExcluded ?? summary.tests?.pinnedTestsExcluded?.length} pinned tests were left out (their customers are not synthetic)`);
      checks.push({ title: `Release ${release.number} and its package (stub composer): only synthetic customers`, outcome: outcome(f, [], `${zipEntries(zip).length} files; customers in it: ${[...kinds].join(', ') || 'none listed'}`) });

      // The runnable package's own verify, without PDF.
      const rt = (await inj('POST', `/api/v1/releases/${release.id}/runtime`, { wait: true })).json();
      const rf: string[] = [];
      if (rt.runtime?.status !== 'ready') rf.push(`the runnable package is ${rt.runtime?.status}: ${rt.runtime?.error ?? ''}`);
      else {
        const rzip = (await inj('GET', `/api/v1/releases/${release.id}/runtime`)).rawPayload;
        const work = mkdtempSync(path.join(tmpdir(), 'iss-audit-run-'));
        const names = zipEntries(rzip).map((e) => e.name);
        for (const e of zipEntries(rzip)) { const file = path.join(work, ...e.name.split('/')); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, zipRead(rzip, e)); }
        const pkgDir = path.join(work, names[0].split('/')[0]);
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir(), LANG: 'C.UTF-8' };
        const v = spawnSync(process.execPath, ['verify', '--without-pdf'], { cwd: pkgDir, env, encoding: 'utf8', timeout: 240_000 });
        if (v.status !== 0) rf.push(`verify failed: ${(v.stdout + v.stderr).slice(-400)}`);
        rmSync(work, { recursive: true, force: true });
      }
      checks.push({ title: 'The runnable package’s own verify (without PDF) passes', outcome: outcome(rf, [], rt.runtime?.proofCases ? `${rt.runtime.proofCases} proof cases` : '') });

      // A proof record produced by the studio and verified as "same".
      const pf: string[] = [];
      const customer = ex.customers.find((c) => !ex.notes.intendedBlockers.some((b) => b.recordId === c.recordId) && !ex.notes.knownDataProblems.some((b) => b.recordId === c.recordId))!;
      const produced = (await inj('POST', `/api/v1/releases/${release.id}/produce`, { recordId: customer.recordId, outputs: ['email', 'sms', 'html'] })).json();
      const proofId = produced.results?.[0]?.proofId;
      if (!proofId) pf.push(`nothing was produced: ${JSON.stringify(produced).slice(0, 200)}`);
      else {
        const v = (await inj('POST', `/api/v1/proofs/${proofId}/verify`, { recordId: customer.recordId })).json();
        if (v.same !== true) pf.push(`the proof verified as ${JSON.stringify(v.verdict ?? v).slice(0, 200)}`);
      }
      checks.push({ title: 'A proof record produced by the studio verifies as “same”', outcome: outcome(pf, [], `customer ${customer.recordId}`) });
      out.push({ example: ex.id, checks });
    }
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

/* ================================================================== the approved fixtures, read only */

export interface FixtureFinding { recordId: string; problem: string; intended: boolean; why: string }

/** The same style of check over the approved card and benefits customers. Reads `fixtures/customers_100.json`; never writes it. */
export function fixtureFindings(): { checked: { card: number; eob: number }; findings: FixtureFinding[] } {
  const data = JSON.parse(readFileSync(path.join(REPO, 'fixtures/customers_100.json'), 'utf8'));
  const expected = JSON.parse(readFileSync(path.join(REPO, 'fixtures/expected_scenarios.json'), 'utf8')).cases as Record<string, { recordId: string; overrides: Record<string, unknown> }>;
  // Records the scenario oracle uses with deliberate overrides: a finding on those is about the scenario, not the record.
  const deliberate = new Map<string, string>();
  for (const [name, c] of Object.entries(expected)) if (Object.keys(c.overrides ?? {}).length) deliberate.set(`${c.recordId}|${name}`, name);
  const findings: FixtureFinding[] = [];
  let scenario: string | null = null;
  const add = (recordId: string, problem: string) => {
    if (scenario) { findings.push({ recordId: `${recordId} + “${scenario}”`, problem, intended: true, why: `Deliberate: the oracle scenario “${scenario}” overrides this record to make it inconsistent (fixtures/expected_scenarios.json).` }); return; }
    const used = [...deliberate.entries()].find(([k]) => k.startsWith(`${recordId}|`))?.[1];
    findings.push({ recordId, problem, intended: false, why: used ? `In the record itself; ${recordId} is also used with overrides by the scenario “${used}”.` : 'No deliberate inconsistency is listed for this record.' });
  };
  const checkCards = (cards: any[]) => { for (const r of cards) {
    const c = r.card;
    const sum = c.transactions.reduce((s: number, t: any) => s + t.amountCents, 0);
    if (c.newBalanceCents !== c.previousBalanceCents + c.purchasesCents - c.paymentsCreditsCents + c.interestFeesCents) add(r.recordId, `new balance ${c.newBalanceCents} ≠ previous + purchases − payments + interest and fees`);
    if (sum !== c.purchasesCents) add(r.recordId, `transactions add up to ${sum}, purchases say ${c.purchasesCents}`);
    if (!(c.statementStart <= c.statementEnd && c.statementEnd <= c.issuedAt && c.issuedAt <= c.dueDate)) add(r.recordId, 'statement dates are not in order');
    for (const t of c.transactions) if (t.date < c.statementStart || t.date > c.statementEnd) { add(r.recordId, `transaction ${t.id} on ${t.date} is outside the statement period`); break; }
    if (c.paymentStatus === 'current' && c.missedPayments > 0) add(r.recordId, 'payment status current with missed payments');
    if (c.minimumDueCents > Math.max(c.newBalanceCents, 0)) add(r.recordId, 'minimum due exceeds the new balance');
  } };
  // The fixtures' own rule (fixtures/make_fixtures.py): billed = adjustment + allowed and allowed = plan paid + member amount on
  // processed claims; a denied or appealed claim has nothing allowed or paid yet and its whole billed amount under review.
  const UNADJUDICATED = ['denied-pending-review', 'appeal-filed'];
  const checkClaims = (eobs: any[]) => { for (const r of eobs) for (const cl of r.claims) {
    if (UNADJUDICATED.includes(cl.status)) {
      if (cl.allowedCents || cl.planPaidCents || cl.patientResponsibilityCents || cl.contractualAdjustmentCents) add(r.recordId, `claim ${cl.claimId}: an unadjudicated claim with amounts allowed, adjusted or paid`);
      if (cl.amountUnderReviewCents !== cl.billedCents) add(r.recordId, `claim ${cl.claimId}: the amount under review is not the billed amount`);
      if (cl.liabilityConfirmed) add(r.recordId, `claim ${cl.claimId}: member liability confirmed on an unadjudicated claim`);
    } else {
      if (cl.billedCents - cl.contractualAdjustmentCents !== cl.allowedCents) add(r.recordId, `claim ${cl.claimId}: billed − adjustment ≠ allowed`);
      if (cl.allowedCents !== cl.planPaidCents + cl.patientResponsibilityCents) add(r.recordId, `claim ${cl.claimId}: allowed ≠ plan paid + member responsibility`);
    }
    if (cl.serviceDate > '2026-11-30') add(r.recordId, `claim ${cl.claimId}: a service date in the future`);
  } };
  checkCards(data.creditCard);
  checkClaims(data.healthcareEob);
  // The oracle's scenarios apply overrides to these records; the same checks on them show which inconsistencies are deliberate.
  const merge = (base: any, over: any): any => (over && typeof over === 'object' && !Array.isArray(over) && base && typeof base === 'object' && !Array.isArray(base) ? Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(over)])].map((k) => [k, k in over ? merge(base[k], over[k]) : base[k]])) : over === undefined ? base : over);
  for (const [name, c] of Object.entries(expected)) {
    if (!Object.keys(c.overrides ?? {}).length) continue;
    const rec = [...data.creditCard, ...data.healthcareEob].find((x: any) => x.recordId === c.recordId);
    if (!rec) continue;
    scenario = name;
    const changed = merge(rec, c.overrides);
    if (rec.card) checkCards([changed]); else checkClaims([changed]);
    scenario = null;
  }
  // The fixtures' own statement of deliberate inconsistencies: classified against the scenario list.
  for (const f of findings) if (/payment status current/.test(f.problem) && Object.values(expected).some((c) => /inconsistent/.test(JSON.stringify(c)))) { f.intended = true; f.why = 'The fixtures list an inconsistent payment state as a deliberate scenario (card-inconsistent-payment-state).'; }
  return { checked: { card: data.creditCard.length, eob: data.healthcareEob.length }, findings };
}

/* ================================================================== running and reporting */

export interface AuditReport {
  ranAt: string;
  options: { outputs: boolean; settings: boolean };
  examples: Array<{ id: string; title: string; kind: string; customers: number; results: Array<{ check: AuditCheck; outcome: CheckOutcome }>; settings?: SettingsResult['checks'] }>;
  fixtures: ReturnType<typeof fixtureFindings>;
}

export async function runAudit(opts: { outputs?: boolean; settings?: boolean; only?: string[] } = {}): Promise<AuditReport> {
  const cache = new Map<string, Map<string, Resolution>>();
  const ctx: AuditContext = {
    resolutions: (ex) => {
      let m = cache.get(ex.id);
      if (!m) { m = new Map(ex.customers.map((r) => [r.recordId, resolve({ project: ex.project, record: r })])); cache.set(ex.id, m); }
      return m;
    },
  };
  if (opts.outputs) { const { Composer } = await import('../apps/api/src/composer'); ctx.composer = new Composer(); }
  const examples: AuditReport['examples'] = [];
  try {
    for (const ex of EXAMPLES.filter((e) => !opts.only || opts.only.includes(e.id))) {
      const results: AuditReport['examples'][number]['results'] = [];
      for (const check of CHECKS) {
        let o: CheckOutcome;
        if (check.needs === 'outputs' && !opts.outputs) o = notRun('Composition not run in this pass.');
        else { try { o = await check.run(ex, ctx); } catch (e: any) { o = outcome([`the check itself failed: ${String(e?.stack ?? e).slice(0, 400)}`], [], ''); } }
        results.push({ check, outcome: o });
      }
      examples.push({ id: ex.id, title: ex.title, kind: ex.kind, customers: ex.customers.length, results });
    }
  } finally { await ctx.composer?.close(); }
  if (opts.settings) {
    const s = await settingsChecks();
    for (const r of s) { const e = examples.find((x) => x.id === r.example); if (e) e.settings = r.checks; }
  }
  return { ranAt: new Date().toISOString(), options: { outputs: !!opts.outputs, settings: !!opts.settings }, examples, fixtures: fixtureFindings() };
}

/** Every failure in a report (what the vitest file asserts is empty). */
export function failuresOf(r: AuditReport): string[] {
  return r.examples.flatMap((e) => [
    ...e.results.filter((x) => x.outcome.status === 'failed').flatMap((x) => x.outcome.failures.map((f) => `${e.id} · ${x.check.title}: ${f}`)),
    ...(e.settings ?? []).filter((x) => x.outcome.status === 'failed').flatMap((x) => x.outcome.failures.map((f) => `${e.id} · ${x.title}: ${f}`)),
  ]);
}

const STATUS_WORD: Record<Status, string> = { pass: 'pass', intended: 'intended exception', failed: '**FAILED**', 'not-run': 'not run' };
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function reportMarkdown(r: AuditReport): string {
  const L: string[] = [];
  L.push('# Examples audit', '');
  L.push(`Written by \`npx tsx scripts/audit-examples.ts\` on ${r.ranAt.slice(0, 10)}. It checks that the example documents’ data, templates, outputs and settings are accurate. Everything in them is synthetic.`, '');
  L.push('## What was checked', '');
  L.push('- **Data**: customer ids, required fields, types and choices, dates in order, and the arithmetic of each kind of document to the cent.');
  L.push('- **Template and rules**: every model validation; that every rule, alternative, conditional section and language is reached by a customer; no rule ties or gaps in time; every data field used; every calculation with a value and equal to an independent recomputation; lookup tables without duplicates, overlaps or gaps.');
  L.push('- **Outcomes**: every customer resolves and the only blocking findings are the intended ones; pinned tests; wording rules; translation counts; library links; mappings; the email subject and SMS.');
  L.push(`- **Outputs**${r.options.outputs ? '' : ' (not run in this pass)'}: real PDFs and web pages for one customer of each outcome: no overflow or clipped content, page counts, the payment slip on the last page, PDF and web page in parity, the studio’s PDF accessibility checks, nothing unformatted.`);
  L.push(`- **Settings**${r.options.settings ? '' : ' (not run in this pass)'}: a release and its package with no customer data, the runnable package’s own verify, a proof record verified as the same.`, '');
  L.push('Each check is a pass, an intended exception (deliberate, listed in the example’s notes with the reason) or FAILED.', '');
  const total = (s: Status) => r.examples.reduce((n, e) => n + e.results.filter((x) => x.outcome.status === s).length + (e.settings ?? []).filter((x) => x.outcome.status === s).length, 0);
  L.push(`**Overall:** ${total('pass')} passed, ${total('intended')} with intended exceptions only, ${total('failed')} failed, ${total('not-run')} not run.`, '');
  for (const e of r.examples) {
    L.push(`## ${e.title} — ${e.kind}`, '', `${e.customers} synthetic customers. Document \`${e.id}\`.`, '');
    L.push('| Group | Check | Result | Counts |', '|---|---|---|---|');
    for (const x of e.results) L.push(`| ${x.check.group} | ${cell(x.check.title)} | ${STATUS_WORD[x.outcome.status]} | ${cell(x.outcome.summary)} |`);
    for (const x of e.settings ?? []) L.push(`| Settings | ${cell(x.title)} | ${STATUS_WORD[x.outcome.status]} | ${cell(x.outcome.summary)} |`);
    L.push('');
    const intended = [...e.results.map((x) => ({ title: x.check.title, o: x.outcome })), ...(e.settings ?? []).map((x) => ({ title: x.title, o: x.outcome }))].filter((x) => x.o.intended.length);
    if (intended.length) {
      L.push('**Intended exceptions**', '');
      for (const x of intended) { L.push(`- ${x.title}:`); for (const i of x.o.intended) L.push(`  - ${i}`); }
      L.push('');
    }
    const failed = [...e.results.map((x) => ({ title: x.check.title, o: x.outcome })), ...(e.settings ?? []).map((x) => ({ title: x.title, o: x.outcome }))].filter((x) => x.o.failures.length);
    if (failed.length) {
      L.push('**Failures**', '');
      for (const x of failed) { L.push(`- ${x.title}:`); for (const i of x.o.failures.slice(0, 20)) L.push(`  - ${i}`); }
      L.push('');
    }
  }
  L.push('## The approved card and benefits fixtures (read only)', '');
  L.push(`The same style of arithmetic and date checks over \`fixtures/customers_100.json\` (${r.fixtures.checked.card} card and ${r.fixtures.checked.eob} benefits customers). The files are never changed; their deliberate inconsistencies are listed in \`fixtures/expected_scenarios.json\`.`, '');
  if (!r.fixtures.findings.some((f) => !f.intended)) L.push('No findings: every card record adds up (new balance, purchases and transactions) with its dates in order, and every claim follows the fixtures’ own rule — on a processed claim billed less the adjustment is the allowed amount and the allowed amount is what the plan paid plus the member’s amount; a denied or appealed claim has nothing allowed or paid and its whole billed amount under review. The oracle’s deliberate inconsistencies are made by overrides in `fixtures/expected_scenarios.json`, not in the records; run on those scenarios, the same checks find exactly them (below, all intended).', '');
  if (r.fixtures.findings.length) {
    L.push('| Customer | Finding | Intended? | Why |', '|---|---|---|---|');
    for (const f of r.fixtures.findings) L.push(`| ${f.recordId} | ${cell(f.problem)} | ${f.intended ? 'yes' : 'no'} | ${cell(f.why)} |`);
    L.push('');
  }
  return `${L.join('\n')}\n`;
}

/* ================================================================== the command line */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = new Set(process.argv.slice(2));
  const report = await runAudit({ outputs: !args.has('--no-outputs'), settings: !args.has('--no-settings') });
  const md = reportMarkdown(report);
  if (!args.has('--no-write')) writeFileSync(path.join(REPO, 'reports/EXAMPLES_AUDIT.md'), md);
  const failures = failuresOf(report);
  for (const e of report.examples) {
    console.log(`\n${e.title}`);
    for (const x of e.results) console.log(`  ${x.outcome.status.padEnd(8)} ${x.check.title} — ${x.outcome.summary}`);
    for (const x of e.settings ?? []) console.log(`  ${x.outcome.status.padEnd(8)} ${x.title} — ${x.outcome.summary}`);
  }
  console.log(`\nFixtures: ${report.fixtures.findings.length} finding(s).`);
  if (failures.length) { console.log(`\n${failures.length} FAILURE(S):`); for (const f of failures.slice(0, 80)) console.log(`  - ${f}`); process.exitCode = 1; }
  else console.log('\nNo unintended findings.');
}
