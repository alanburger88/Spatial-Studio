import { languageShortName, type ProfileId, type Project, type SyntheticRecord, type TestCase } from '@iss/model';
import { resolve, type Finding } from '@iss/resolver';
import { captureExpectation, nextTestId } from '../testCases';
import { groupFindings, proposeFixes } from './fixes';
import type { Blocker, BlockerAbout, BlockerKind, BlockerLink, DocumentBlockers, FixProposal } from './types';

/**
 * Blockers: every problem that stops this document being issued, grouped by ROOT CAUSE across all customers.
 * Pure and deterministic (no network, clock, randomness or `Intl`). It reuses `groupFindings` (what the resolver finds
 * for every customer) and `proposeFixes` (the fix engine); it never applies anything.
 *
 * Two speeds: findings the resolver works out for every customer are `fast`; findings that need composed pages (layout,
 * PDF/web differences) cannot be computed here, so the caller passes the last full check's as `extraFindings` and they
 * are marked `full-check`. A caller may mark an extra finding `fast` when it is cheap and current (static rule checks).
 */

/* ------------------------------------------------------------------ kinds */

export const BLOCKER_KIND_ORDER: readonly BlockerKind[] = ['wording', 'rules', 'layout', 'data-fields', 'customer-data'];

const KIND_BY_CODE: Record<string, BlockerKind> = {
  // wording and translations, and links shown to customers
  REQUIRED_TRANSLATION_MISSING: 'wording', MISSING_CONTENT_PART: 'wording', UNCONFIRMED_DEBT_LANGUAGE: 'wording', UNSAFE_URL: 'wording',
  TRANSLATION_MISSING_TEXT: 'wording', TRANSLATION_MISSING_OPTIONAL: 'wording', UNAPPROVED_TRANSLATION_SHOWN: 'wording',
  // rules
  EXCLUSIVE_PRIORITY_TIE: 'rules', EQUAL_PRIORITY_EXCLUSIVE_RULES: 'rules', NO_VARIANT_MATCH: 'rules', VARIANT_SET_WITHOUT_FALLBACK: 'rules',
  UNKNOWN_VARIANT: 'rules', UNKNOWN_SECTION: 'rules', REQUIRED_NODE_MISSING: 'rules',
  // pages and outputs
  FLOW_OVERFLOW_NO_CONTINUATION: 'layout', TABLE_TOTAL_CLIPPED: 'layout', BLOCK_OVERFLOW: 'layout', ROW_TALLER_THAN_REGION: 'layout', ORPHANED_HEADING: 'layout', FIXED_FLOW_ADJUSTED: 'layout', PARITY_MISMATCH: 'layout',
  // page design (wave 2)
  KEEP_TOGETHER_CANNOT_FIT: 'layout', FIXED_OFF_PAGE: 'layout', PAGE_DESIGN_INVALID: 'layout',
  // data fields the document reads (a lookup table with no row for a customer is fixed in the table)
  INVALID_BINDING: 'data-fields', LOOKUP_NO_MATCH: 'data-fields',
  // the customer's own data
  RECORD_TYPE_MISMATCH: 'customer-data', INCONSISTENT_PAYMENT_STATE: 'customer-data', BALANCE_RECONCILIATION_FAILED: 'customer-data',
  UNCONFIRMED_MEMBER_LIABILITY: 'customer-data', CLAIM_RECONCILIATION_FAILED: 'customer-data', NULL_BINDING: 'customer-data',
  // calculated values and the document's date
  CALCULATION_MISSING: 'customer-data', DOCUMENT_DATE_MISSING: 'customer-data', ISSUE_DATE_INVALID: 'customer-data',
};

/** Which kind of fix a finding needs. A code this list does not know is placed by where it came from. */
export function blockerKindOf(finding: Pick<Finding, 'code' | 'source'>): BlockerKind {
  const known = KIND_BY_CODE[finding.code];
  if (known) return known;
  switch (finding.source) {
    case 'composer': case 'parity': return 'layout';
    case 'binding': return 'data-fields';
    case 'translation': return 'wording';
    case 'domain': return 'customer-data';
    default: return 'rules';
  }
}

/* ------------------------------------------------------------------ identity */

const TIE = new Set(['EXCLUSIVE_PRIORITY_TIE', 'EQUAL_PRIORITY_EXCLUSIVE_RULES']);
const NO_FALLBACK = new Set(['NO_VARIANT_MATCH', 'VARIANT_SET_WITHOUT_FALLBACK']);
const slug = (code: string): string => code.toLowerCase().replace(/_/g, '-');

function pathOf(f: Pick<Finding, 'code' | 'message' | 'details'>): string | undefined {
  const p = f.details?.path;
  if (typeof p === 'string') return p;
  if (f.code !== 'INVALID_BINDING') return undefined;
  return /[“"]([A-Za-z0-9_.]*)[”"]/.exec(f.message ?? '')?.[1] ?? /^([A-Za-z0-9_.]+) is not a collection/.exec(f.message ?? '')?.[1];
}
const ruleIdsOf = (f: Finding): string[] => [...new Set([...(f.ruleIds ?? []), ...(f.ruleId ? [f.ruleId] : [])])].sort();

/**
 * The stable id of the root cause a finding belongs to: the kind of problem, what it is about and the language, joined
 * with `~`. Two checks that report the same cause (the resolver's tie and the static equal-priority check) share one id.
 * It does not depend on which customers are stopped, on page numbers or on wording, so it survives saves and re-checks.
 */
export function blockerIdOf(f: Pick<Finding, 'code' | 'nodeId' | 'locale' | 'ruleId' | 'ruleIds' | 'message' | 'details'>): string {
  const full = f as Finding;
  const rules = ruleIdsOf(full);
  let problem = slug(f.code);
  const about: string[] = [];
  if (TIE.has(f.code)) { problem = 'priority-tie'; about.push(...(rules.length ? [rules.join('+')] : f.nodeId ? [f.nodeId] : [])); }
  else if (NO_FALLBACK.has(f.code)) { problem = 'no-fallback'; if (f.nodeId) about.push(f.nodeId); }
  else {
    if (f.nodeId) about.push(f.nodeId);
    if (rules.length) about.push(rules.join('+'));
    const path = pathOf(full);
    if (path) about.push(path);
    const check = f.details?.check;
    if (typeof check === 'string') about.push(check);
  }
  return [problem, ...about, ...(f.locale ? [f.locale] : [])].join('~');
}

/* ------------------------------------------------------------------ names and words */

const q = (s: string): string => `“${s}”`;
const humanise = (s: string): string => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.]/g, ' ').trim().toLowerCase();
const sentence = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const listOf = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

function nodeName(project: Project, id: string | undefined): string {
  if (!id) return 'the document';
  const n = project.nodes.find((x) => x.id === id);
  if (n) return n.name && n.name !== n.id ? n.name : sentence(humanise(id));
  return project.contentParts.find((c) => c.id === id)?.title ?? sentence(humanise(id));
}

function aboutOf(project: Project, f: Finding): BlockerAbout {
  const out: BlockerAbout = {};
  if (f.nodeId) {
    const isNode = project.nodes.some((n) => n.id === f.nodeId);
    const isPart = project.contentParts.some((c) => c.id === f.nodeId);
    // The wording of a message is a content part, which usually shares its id with the component that shows it.
    if (isNode || !isPart) out.component = { id: f.nodeId, name: nodeName(project, f.nodeId) };
    if (isPart) out.message = { id: f.nodeId, name: project.contentParts.find((c) => c.id === f.nodeId)!.title };
  }
  const rules = ruleIdsOf(f);
  if (rules.length) out.rules = rules.map((id) => ({ id, name: project.rules.find((r) => r.id === id)?.title ?? `Rule ${id}` }));
  const path = pathOf(f);
  if (path) out.field = { path, name: humanise(path.split('.').slice(-1)[0]) };
  if (f.locale) out.language = { code: f.locale, name: languageShortName(f.locale) };
  return out;
}

/** Title and explanation in plain words; the code stays out of them. `n` is how many customers this stops. */
function wordsFor(project: Project, f: Finding, about: BlockerAbout, n: number): { title: string; explanation: string } {
  const where = about.component?.name ?? about.message?.name ?? 'the document';
  const lang = about.language?.name ?? 'the other language';
  const ruleNames = (about.rules ?? []).map((r) => q(r.name));
  const who = n === 0 ? 'No sample customer reaches this today, but any customer who does will be stopped.' : n === 1 ? 'It stops 1 customer.' : `It stops ${n} customers.`;
  switch (f.code) {
    case 'REQUIRED_TRANSLATION_MISSING':
      return { title: `No approved ${lang} text for ${q(where)}`, explanation: `${q(where)} must appear in every document, but it has no approved ${lang} version. Text is never translated at send time, so customers who read ${lang} cannot be issued the document until a person approves the ${lang} text. ${who}` };
    case 'MISSING_CONTENT_PART':
      return { title: `${q(where)} lists a message that has no wording`, explanation: `${q(where)} points to wording that does not exist, so the document cannot be built for anyone who would get it. ${who}` };
    case 'UNCONFIRMED_DEBT_LANGUAGE':
      return { title: `${q(where)} reads like a bill`, explanation: `${q(where)} presents an amount as owed, but the member’s liability is not confirmed. An explanation of benefits is not a bill, so the wording must be neutral. ${who}` };
    case 'UNSAFE_URL':
      return { title: `The link in ${q(where)} is not a secure address`, explanation: `The address behind ${q(where)} is not an allowed https address, so the document is held back rather than send people somewhere unsafe. ${who}` };
    case 'EXCLUSIVE_PRIORITY_TIE':
    case 'EQUAL_PRIORITY_EXCLUSIVE_RULES':
      return { title: `${listOf(ruleNames) || 'Two rules'} ${ruleNames.length > 1 ? 'tie' : 'tie with another rule'}`, explanation: `${listOf(ruleNames) || 'Two rules'} have the same priority and can apply to the same customer, and the studio never picks a winner silently. ${n === 0 ? 'No sample customer matches both today, so this is a risk for customers who do.' : who}` };
    case 'NO_VARIANT_MATCH':
    case 'VARIANT_SET_WITHOUT_FALLBACK':
      return { title: `${q(where)} has no message for some customers`, explanation: `No rule selects a message of ${q(where)} for these customers and it has no fallback message, so there is nothing to show. ${who}` };
    case 'UNKNOWN_VARIANT':
      return { title: `${ruleNames[0] ?? 'A rule'} selects a message that ${q(where)} does not have`, explanation: `${ruleNames[0] ?? 'A rule'} chooses a message that is not part of ${q(where)}, so the document is held back for the customers it applies to. ${who}` };
    case 'UNKNOWN_SECTION':
      return { title: `${ruleNames[0] ?? 'A rule'} shows a section that does not exist`, explanation: `${ruleNames[0] ?? 'A rule'} refers to a section that is not in the document. ${who}` };
    case 'REQUIRED_NODE_MISSING':
      return { title: `A mandatory section is missing from the document`, explanation: `${ruleNames[0] ?? 'A rule'} requires the section ${q(where)}, which is no longer in the document. Mandatory content is a compliance decision. ${who}` };
    case 'FLOW_OVERFLOW_NO_CONTINUATION':
      return { title: `${q(where)} runs off the page`, explanation: `${q(where)} cannot continue on the next page, so rows are cut off for customers who have more rows than fit. ${who}` };
    case 'TABLE_TOTAL_CLIPPED':
      return { title: `The total row of ${q(where)} does not fit`, explanation: `The total row of ${q(where)} does not fit on its page. ${who}` };
    case 'KEEP_TOGETHER_CANNOT_FIT':
      return { title: `${q(where)} is too tall to keep together`, explanation: `${q(where)} is set to keep together, but it is taller than an empty page or column, so it cannot be placed in one piece. ${who}` };
    case 'FIXED_OFF_PAGE':
      return { title: `${q(where)} reaches outside the page`, explanation: `${q(where)} is fixed at a place that is partly off the page, so it is cut off. ${who}` };
    case 'PARITY_MISMATCH':
    {
      // The server words it "<what was compared>: PDF and/or HTML differ from the resolved semantic facts."
      const what = /^([^:]{1,80}):\s/.exec(f.message ?? '')?.[1];
      return { title: what ? `The PDF and the web version disagree about ${q(what)}` : 'The PDF and the web version disagree', explanation: `${f.message} ${who}` };
    }
    case 'INVALID_BINDING': {
      const field = about.field?.path;
      return { title: field ? `${q(where)} shows a field that does not exist` : `${q(where)} is not connected to a field`, explanation: `${field ? `${q(where)} reads ${field}, which is not a field of this document.` : `${q(where)} has no field chosen yet.`} Customers cannot be issued the document until it shows a real field. ${who}` };
    }
    case 'INCONSISTENT_PAYMENT_STATE':
      return { title: 'The account is “up to date” but lists missed payments', explanation: `These customers’ data contradicts itself: the account is up to date and also has missed payments. The document is fine; the customers’ data has to be corrected. ${who}` };
    case 'BALANCE_RECONCILIATION_FAILED':
      return { title: 'The new balance does not add up', explanation: `For these customers the new balance is not the previous balance plus purchases, minus payments, plus fees. The document is fine; the customers’ data has to be corrected. ${who}` };
    case 'UNCONFIRMED_MEMBER_LIABILITY':
      return { title: 'An amount is supplied for a member whose liability is not confirmed', explanation: `These claims are denied pending review, yet the data gives the member an amount to pay. The document will not present it as owed. The document is fine; the customers’ data has to be corrected. ${who}` };
    case 'CLAIM_RECONCILIATION_FAILED':
      return { title: 'The claim amounts do not add up', explanation: `For these customers billed, adjustment, allowed, plan paid and member share do not reconcile. The document is fine; the customers’ data has to be corrected. ${who}` };
    case 'NULL_BINDING':
      return { title: `A value ${q(where)} needs is empty`, explanation: `${q(where)} must show a value and it is empty in these customers’ data. The document is fine; the customers’ data has to be completed. ${who}` };
    case 'RECORD_TYPE_MISMATCH':
      return { title: 'A customer is of a different kind of document', explanation: `The customer’s record belongs to another kind of document than this one. ${who}` };
    case 'CALCULATION_MISSING': {
      const name = calcName(project, f);
      return { title: `${q(name)} cannot be worked out for some customers`, explanation: `The document needs ${q(name)}, and it cannot be worked out from these customers’ data${reasonOf(f)}. The document is fine if the data is completed; otherwise change the calculation so it copes. ${who}` };
    }
    case 'LOOKUP_NO_MATCH': {
      const name = calcName(project, f);
      return { title: `${q(name)} finds no row in its lookup table for some customers`, explanation: `${q(name)} is read from a lookup table that has no row for these customers and no default row${reasonOf(f)}. Add a row or a default row to the table. ${who}` };
    }
    case 'DOCUMENT_DATE_MISSING':
      return { title: 'Some customers’ documents have no date', explanation: `This document’s wording depends on its date, and these customers have none. ${project.documentDate?.source === 'field' ? 'Fill in the date field the document takes its date from.' : 'Give the date for the run (“as issued on”).'} ${who}` };
    case 'ISSUE_DATE_INVALID':
      return { title: 'The date given for the run is not a date', explanation: `The “as issued on” date must be written as YYYY-MM-DD. ${who}` };
    default:
      return { title: f.nodeId ? `A problem with ${q(where)}` : 'A problem that stops the document', explanation: `${f.message} ${who}` };
  }
}

/** The name of the calculated field a finding is about. */
function calcName(project: Project, f: Finding): string {
  const path = typeof f.details?.path === 'string' ? f.details.path : '';
  const key = path.startsWith('calc.') ? path.slice(5) : path;
  return project.calculatedFields?.find((c) => c.key === key)?.label ?? (key || 'A calculated value');
}
/** ": “Visits this month” is missing" — the reason a calculation is missing, from the first customer's finding. */
function reasonOf(f: Finding): string {
  const m = /could not be worked out for this customer: (.*?) It is used by/.exec(f.message ?? '');
  return m ? ` (for example: ${m[1].replace(/\.$/, '')})` : '';
}

/* ------------------------------------------------------------------ where it is fixed by hand */

function linkOf(kind: BlockerKind, fixes: FixProposal[], f: Finding, about: BlockerAbout, recordId: string | undefined): BlockerLink | null {
  if (kind === 'customer-data') return { view: 'data', label: 'Open in Data Explorer', ...(recordId ? { recordId } : {}) };
  const fromFix = fixes.find((x) => x.link)?.link;
  if (fromFix) return fromFix;
  const node = about.component?.id;
  switch (kind) {
    case 'wording': return { view: 'content', ...(f.locale ? { locale: f.locale } : {}), ...(f.nodeId ? { textId: f.nodeId } : {}), label: 'Open Content & Translations' };
    case 'rules': return { view: 'rules-data', ...(about.rules?.[0] ? { ruleId: about.rules[0].id } : {}), ...(node ? { nodeId: node } : {}), label: 'Open Rules & Data' };
    case 'layout': return f.code === 'PARITY_MISMATCH' ? { view: 'validate', label: 'Open Validate & Compare' } : { view: 'design', ...(node ? { nodeId: node } : {}), label: 'Open in Design' };
    case 'data-fields': return { view: 'design', ...(node ? { nodeId: node } : {}), label: 'Open in Design' };
    default: return null;
  }
}

/* ------------------------------------------------------------------ the engine */

export interface ExtraFinding { finding: Finding; recordId: string | null; /** `fast` only for checks that are cheap and current (default `full-check`). */ speed?: 'fast' | 'full-check' }

interface Acc { id: string; finding: Finding; recordIds: Set<string>; fast: boolean }

/**
 * Every blocker of the document across every customer of its kind, one per root cause. `extraFindings` carries what this
 * package cannot compute itself (the last full check's page-layout and PDF/web findings, static rule checks). Only
 * findings of blocking severity count.
 */
export function documentBlockers(project: Project, records: SyntheticRecord[], opts?: { profileId?: ProfileId; journeyCursor?: number | null; extraFindings?: ExtraFinding[]; /** "As issued on": the document's date for a document that uses dates. */ issueDate?: string | null }): DocumentBlockers {
  const ofType = records.filter((r) => r.documentType === project.documentType);
  const known = new Set(ofType.map((r) => r.recordId));
  const acc = new Map<string, Acc>();
  const add = (finding: Finding, recordIds: string[], fast: boolean): void => {
    const id = blockerIdOf(finding);
    let a = acc.get(id);
    if (!a) { a = { id, finding, recordIds: new Set(), fast }; acc.set(id, a); }
    else if (fast && !a.fast) { a.fast = true; a.finding = finding; }
    for (const r of recordIds) a.recordIds.add(r);
  };
  for (const g of groupFindings(project, records, opts)) if (g.finding.severity === 'blocking') add(g.finding, g.recordIds, true);
  for (const x of opts?.extraFindings ?? []) {
    if (x.finding.severity !== 'blocking') continue;
    add(x.finding, x.recordId && known.has(x.recordId) ? [x.recordId] : [], x.speed === 'fast');
  }

  const blockers: Blocker[] = [];
  const stopped = new Set<string>();
  for (const a of acc.values()) {
    const recordIds = [...a.recordIds].sort();
    recordIds.forEach((r) => stopped.add(r));
    const kind = blockerKindOf(a.finding);
    const about = aboutOf(project, a.finding);
    const fixes = proposeFixes(project, a.finding, { records, recordId: recordIds[0], journeyCursor: opts?.journeyCursor, profileId: opts?.profileId, issueDate: opts?.issueDate });
    const words = wordsFor(project, a.finding, about, recordIds.length);
    blockers.push({
      id: a.id, kind, code: a.finding.code, ...words, about, recordIds, customerCount: recordIds.length, speed: a.fast ? 'fast' : 'full-check',
      fixes, link: linkOf(kind, fixes, a.finding, about, recordIds[0]), finding: a.finding,
    });
  }
  const order = (k: BlockerKind): number => BLOCKER_KIND_ORDER.indexOf(k);
  blockers.sort((x, y) => y.customerCount - x.customerCount || order(x.kind) - order(y.kind) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { checked: ofType.length, issuable: ofType.length - stopped.size, stopped: stopped.size, blockers };
}

/* ------------------------------------------------------------------ phase 2: one customer's blockers, and the offending fields */

/** The kind of a blocker from its id alone (the first part names the kind of problem). Null for an id this engine never makes. */
export function blockerKindOfId(id: string): BlockerKind | null {
  const problem = String(id ?? '').split('~')[0];
  if (problem === 'priority-tie' || problem === 'no-fallback') return 'rules';
  return KIND_BY_CODE[problem.toUpperCase().replace(/-/g, '_')] ?? null;
}

/** One blocker as it stops ONE customer: plain words and the customer's values that are wrong (as Data Explorer paths). */
export interface CustomerBlocker {
  id: string;
  kind: BlockerKind;
  code: string;
  title: string;
  explanation: string;
  /** For a customer-data blocker: the customer's fields that disagree (`card.missedPayments`, `claims[1].billedCents`). Empty otherwise. */
  fields: string[];
}

const CARD_BALANCE = ['card.previousBalanceCents', 'card.purchasesCents', 'card.paymentsCreditsCents', 'card.interestFeesCents', 'card.newBalanceCents'];
const CLAIM_FIELDS: Record<string, string[]> = {
  UNCONFIRMED_MEMBER_LIABILITY: ['status', 'liabilityConfirmed', 'patientResponsibilityCents'],
  CLAIM_RECONCILIATION_FAILED: ['billedCents', 'contractualAdjustmentCents', 'allowedCents', 'planPaidCents', 'patientResponsibilityCents'],
};

/** The customer's own values a customer-data finding is about, read from the finding and the record (the checks stay in the resolver). */
function offendingFields(f: Finding, record: SyntheticRecord): string[] {
  switch (f.code) {
    case 'INCONSISTENT_PAYMENT_STATE': return ['card.paymentStatus', 'card.missedPayments'];
    case 'BALANCE_RECONCILIATION_FAILED': return CARD_BALANCE;
    case 'UNCONFIRMED_MEMBER_LIABILITY':
    case 'CLAIM_RECONCILIATION_FAILED': {
      const claimId = /^Claim (\S+) /.exec(f.message ?? '')?.[1];
      const claims = (record as { claims?: Array<{ claimId?: string }> }).claims ?? [];
      const i = claims.findIndex((c) => c.claimId === claimId);
      return i < 0 ? [] : CLAIM_FIELDS[f.code].map((k) => `claims[${i}].${k}`);
    }
    case 'CALCULATION_MISSING': {
      const input = f.details?.input;
      return typeof input === 'string' ? [input.startsWith('claim.') ? `claims[0].${input.slice(6)}` : input] : [];
    }
    case 'DOCUMENT_DATE_MISSING': return typeof f.details?.input === 'string' ? [f.details.input] : [];
    case 'NULL_BINDING': {
      const path = /^([A-Za-z0-9_.]+) is empty/.exec(f.message ?? '')?.[1];
      // The resolver reads one claim as `claim.*`; Data Explorer shows it as the first row of the claims list.
      return path ? [path.startsWith('claim.') ? `claims[0].${path.slice(6)}` : path] : [];
    }
    default: return [];
  }
}

/**
 * Every blocker that stops ONE customer, with the same ids as `documentBlockers`, without working out fixes (one
 * resolution, so it is cheap). Data Explorer uses it to open a customer on the right fields; the server uses it to check
 * and lapse known data problems. Static rule checks and composed-page checks are not included.
 */
export function customerBlockers(project: Project, record: SyntheticRecord, opts?: { profileId?: ProfileId; journeyCursor?: number | null; issueDate?: string | null }): CustomerBlocker[] {
  if (record.documentType !== project.documentType) return [];
  const res = resolve({ project, record, profileId: opts?.profileId, journeyCursor: opts?.journeyCursor ?? null, ...(opts?.issueDate ? { issueDate: opts.issueDate } : {}) });
  const by = new Map<string, CustomerBlocker>();
  for (const f of res.findings) {
    if (f.severity !== 'blocking') continue;
    const id = blockerIdOf(f);
    const kind = blockerKindOf(f);
    let b = by.get(id);
    if (!b) { b = { id, kind, code: f.code, ...wordsFor(project, f, aboutOf(project, f), 1), fields: [] }; by.set(id, b); }
    if (kind === 'customer-data') for (const p of offendingFields(f, record)) if (!b.fields.includes(p)) b.fields.push(p);
  }
  return [...by.values()].sort((a, b) => BLOCKER_KIND_ORDER.indexOf(a.kind) - BLOCKER_KIND_ORDER.indexOf(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* ------------------------------------------------------------------ phase 2: known data problems */

/** The longest reason a person may give for setting a customer's data problem aside. */
export const KNOWN_REASON_MAX = 500;

/** A customer-data blocker an approver has set aside for ONE customer, with the reason. Stored by the server. */
export interface KnownDataProblem {
  /** The server's id of the entry (absent before it is stored). */
  id?: string;
  blockerId: string;
  recordId: string;
  reason: string;
  markedBy: { id: string | null; name: string } | null;
  markedAt: string;
}

/**
 * Splits stored known data problems into those in force and those that have LAPSED: the blocker no longer stops that
 * customer (the customer's data or the document changed, or the customer is gone), or the entry is not about a
 * customer's own data. `stops(recordId, blockerId)` says whether that blocker stops that customer now.
 */
export function splitKnownDataProblems(known: readonly KnownDataProblem[], stops: (recordId: string, blockerId: string) => boolean): { active: KnownDataProblem[]; lapsed: KnownDataProblem[] } {
  const active: KnownDataProblem[] = [];
  const lapsed: KnownDataProblem[] = [];
  const seen = new Set<string>();
  for (const k of known) {
    const key = `${k.blockerId}|${k.recordId}`;
    if (blockerKindOfId(k.blockerId) === 'customer-data' && !seen.has(key) && stops(k.recordId, k.blockerId)) { active.push(k); seen.add(key); }
    else lapsed.push(k);
  }
  return { active, lapsed };
}

export type KnownRefusalCode = 'REASON_REQUIRED' | 'REASON_TOO_LONG' | 'NOT_A_DATA_PROBLEM' | 'UNKNOWN_CUSTOMER' | 'NOT_STOPPING_THIS_CUSTOMER';

/**
 * Why a known data problem cannot be recorded, in plain words, or null when it can. The server enforces it and the
 * screens use it to explain before asking. Who may record one (an approver) is checked by the server's permissions.
 */
export function knownDataProblemRefusal(a: { blockerId: string; reason: unknown; customer: SyntheticRecord | null; blockers: CustomerBlocker[] }): { code: KnownRefusalCode; status: number; message: string } | null {
  const reason = typeof a.reason === 'string' ? a.reason.trim() : '';
  if (!reason) return { code: 'REASON_REQUIRED', status: 400, message: 'Say why this customer’s data problem can be set aside.' };
  if (reason.length > KNOWN_REASON_MAX) return { code: 'REASON_TOO_LONG', status: 400, message: `Keep the reason to ${KNOWN_REASON_MAX} characters at most.` };
  const kind = a.blockers.find((b) => b.id === a.blockerId)?.kind ?? blockerKindOfId(a.blockerId);
  if (kind !== 'customer-data') return { code: 'NOT_A_DATA_PROBLEM', status: 422, message: 'Only a problem in one customer’s own data can be set aside. A blocker in the document itself (wording, rules, layout or data fields) must always be fixed.' };
  if (!a.customer) return { code: 'UNKNOWN_CUSTOMER', status: 404, message: 'This document has no such customer.' };
  if (!a.blockers.some((b) => b.id === a.blockerId)) return { code: 'NOT_STOPPING_THIS_CUSTOMER', status: 409, message: 'This problem does not stop this customer (any more), so there is nothing to set aside.' };
  return null;
}

/** A blocker with what the known data problems do to it. */
export interface BlockerWithStatus extends Blocker {
  /** `known-data-problem` when every customer it stops has it set aside; otherwise `open`. */
  status: 'open' | 'known-data-problem';
  /** The known data problems in force for this blocker (one per customer). */
  known: KnownDataProblem[];
  /** The customers it stops that are NOT set aside. */
  openRecordIds: string[];
}

export interface DocumentBlockersWithStatus extends DocumentBlockers {
  blockers: BlockerWithStatus[];
  /** Customers whose only blockers are known data problems: not stopped by an open blocker, and not issuable either. */
  setAside: number;
  setAsideRecordIds: string[];
  /** Known data problems in force. */
  known: KnownDataProblem[];
  /** Stored known data problems that no longer apply: not counted (the server removes them). */
  lapsed: KnownDataProblem[];
}

/**
 * The status of every blocker and customer once known data problems are taken into account. Pure; the Blockers screen
 * and the server use the same function. `stopped` counts customers stopped by at least one OPEN blocker; customers whose
 * only blockers are known data problems are `setAside`; `issuable + stopped + setAside = checked`. Ids never change.
 */
export function withKnownDataProblems(result: DocumentBlockers, known: readonly KnownDataProblem[]): DocumentBlockersWithStatus {
  const byId = new Map(result.blockers.map((b) => [b.id, b]));
  const { active, lapsed } = splitKnownDataProblems(known, (recordId, blockerId) => !!byId.get(blockerId)?.recordIds.includes(recordId));
  const excused = new Set(active.map((k) => `${k.blockerId}|${k.recordId}`));
  const open = new Set<string>();
  const any = new Set<string>();
  const blockers: BlockerWithStatus[] = result.blockers.map((b) => {
    const openRecordIds = b.recordIds.filter((r) => !excused.has(`${b.id}|${r}`));
    openRecordIds.forEach((r) => open.add(r));
    b.recordIds.forEach((r) => any.add(r));
    return { ...b, status: b.customerCount > 0 && openRecordIds.length === 0 ? 'known-data-problem' : 'open', known: active.filter((k) => k.blockerId === b.id), openRecordIds };
  });
  const setAsideRecordIds = [...any].filter((r) => !open.has(r)).sort();
  return { ...result, blockers, stopped: open.size, issuable: result.checked - open.size - setAsideRecordIds.length, setAside: setAsideRecordIds.length, setAsideRecordIds, known: active, lapsed };
}

/** `documentBlockers` with the known data problems applied: the one call the screen makes. */
export function documentBlockerStatus(project: Project, records: SyntheticRecord[], opts?: { profileId?: ProfileId; journeyCursor?: number | null; extraFindings?: ExtraFinding[]; known?: readonly KnownDataProblem[]; issueDate?: string | null }): DocumentBlockersWithStatus {
  return withKnownDataProblems(documentBlockers(project, records, opts), opts?.known ?? []);
}

/* ------------------------------------------------------------------ phase 3: resolving one by one, and pinning a test when fixed */

/** The open blockers in the order the guided pass takes them: most customers still stopped first, then kind order, then id. */
export function resolveOrder(result: DocumentBlockersWithStatus): BlockerWithStatus[] {
  const order = (k: BlockerKind): number => BLOCKER_KIND_ORDER.indexOf(k);
  return result.blockers.filter((b) => b.status === 'open')
    .sort((x, y) => y.openRecordIds.length - x.openRecordIds.length || order(x.kind) - order(y.kind) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * Ready-to-pin tests (for UPSERT_TEST_CASE) for blockers that were fixed: one affected customer each, expecting the
 * outcome the document gives that customer NOW, so the problem cannot come back unnoticed. Nothing is pinned here. A
 * customer not among `records` is skipped. Test names hold the blocker in plain words, never a customer's name.
 */
export function testsForFixedBlockers(project: Project, records: SyntheticRecord[], fixed: ReadonlyArray<{ blockerId: string; title: string; recordId: string }>, opts?: { journeyCursor?: number | null; issueDate?: string | null }): TestCase[] {
  const out: TestCase[] = [];
  const cursor = opts?.journeyCursor ?? null;
  for (const f of fixed) {
    const record = records.find((r) => r.recordId === f.recordId && r.documentType === project.documentType);
    if (!record) continue;
    out.push({ id: nextTestId([...(project.testCases ?? []), ...out]), name: `Stays fixed: ${f.title}`.slice(0, 160), recordId: record.recordId, overrides: {}, journeyCursor: cursor, ...(opts?.issueDate && project.documentDate ? { issueDate: opts.issueDate } : {}), expect: captureExpectation(project, record, {}, cursor, opts?.issueDate) });
  }
  return out;
}
