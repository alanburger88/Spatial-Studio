import { projectFields, type FieldDef, type Project } from '@iss/model';
import type { ColumnMatch } from './types';

/**
 * Matches the columns of a customer file to the project's data fields, so a file whose headings are not the exact
 * field paths can still be imported after a person confirms the mapping. Pure: it proposes a mapping and points out
 * sample values that would be rejected; it never changes the file or the project.
 */

/* ------------------------------------------------------------------ names */

/** One spelling per idea, so "First Name", "first_name", "firstName" and "given name" compare equal. */
const TOKEN: Record<string, string[]> = {
  first: ['given'], forename: ['given', 'name'], firstname: ['given', 'name'], fname: ['given', 'name'], givenname: ['given', 'name'],
  last: ['family'], surname: ['family', 'name'], lastname: ['family', 'name'], lname: ['family', 'name'], familyname: ['family', 'name'],
  language: ['locale'], lang: ['locale'], min: ['minimum'], max: ['maximum'], amt: ['amount'], acct: ['account'], acc: ['account'],
  no: ['number'], num: ['number'], nbr: ['number'], nr: ['number'], pmt: ['payment'], pymt: ['payment'], pay: ['payment'], bal: ['balance'],
  prev: ['previous'], prior: ['previous'], stmt: ['statement'], txn: ['transaction'], txns: ['transactions'], resp: ['responsibility'],
  dt: ['date'], desc: ['description'], identifier: ['id'], pref: ['preference'], preferred: ['preference'], avail: ['available'],
  fee: ['fees'], pts: ['points'],
};
/** Words that add nothing to a heading: units and articles. */
const NOISE = new Set(['cents', 'cent', 'usd', 'the', 'of', 'in', 'a', 'and']);
/** Words too general to carry a guess on their own. */
const GENERIC = new Set(['name', 'date', 'amount', 'number', 'id', 'status', 'start', 'end', 'total', 'payment', 'payments', 'customer', 'card', 'claim', 'member', 'account', 'preference']);
/** Leading words that only say whose value it is. */
const SCOPE = new Set(['customer', 'cardholder', 'card', 'claim', 'member', 'patient', 'client', 'user']);

function tokens(s: string): string[] {
  const raw = s
    .replace(/#/g, ' number ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  return raw.flatMap((t) => TOKEN[t] ?? [t]).filter((t) => !NOISE.has(t));
}
const key = (ts: string[]): string => ts.join(' ');

/** Other names people use for a field, by path. */
const ALIASES: Record<string, string[]> = {
  recordId: ['id', 'record id', 'record number', 'customer id', 'customer number', 'source id', 'reference'],
  personaId: ['persona', 'persona id'],
  'customer.givenName': ['first name', 'given name', 'forename', 'name first'],
  'customer.familyName': ['surname', 'last name', 'family name', 'name last'],
  'customer.middleName': ['middle name', 'middle initial', 'second name'],
  'customer.locale': ['language', 'locale', 'preferred language', 'preferred locale', 'document language'],
  'customer.accessibility.largeText': ['large text', 'large print'],
  'customer.accessibility.highContrast': ['high contrast'],
  'card.maskedAccount': ['account', 'account number', 'masked account', 'masked account number', 'card number', 'masked card', 'masked card number'],
  'card.statementStart': ['statement start', 'period start', 'statement from', 'start date'],
  'card.statementEnd': ['statement end', 'period end', 'statement to', 'end date', 'closing date'],
  'card.issuedAt': ['issue date', 'issued', 'issued on', 'statement date', 'issued date'],
  'card.dueDate': ['due date', 'payment due date', 'payment due', 'due', 'pay by', 'pay by date'],
  'card.creditLimitCents': ['credit limit', 'limit'],
  'card.previousBalanceCents': ['previous balance', 'opening balance', 'last balance', 'balance previous'],
  'card.purchasesCents': ['purchases', 'new purchases', 'spend', 'spending'],
  'card.paymentsCreditsCents': ['payments', 'payments and credits', 'payments credits', 'credits', 'payments received'],
  'card.interestFeesCents': ['fees', 'interest', 'fees and interest', 'interest and fees', 'interest fees', 'charges'],
  'card.newBalanceCents': ['balance', 'new balance', 'current balance', 'statement balance', 'closing balance', 'balance due'],
  'card.minimumDueCents': ['minimum payment', 'minimum due', 'minimum payment due', 'minimum amount due', 'minimum amount', 'minimum'],
  'card.tier': ['tier', 'account tier', 'segment', 'card tier'],
  'card.paymentStatus': ['status', 'payment status', 'account status'],
  'card.missedPayments': ['missed payments', 'payments missed', 'missed', 'number missed payments'],
  'card.assistanceRequested': ['assistance requested', 'assistance', 'hardship', 'requested assistance'],
  'card.arrangementStatus': ['arrangement', 'arrangement status', 'payment arrangement', 'payment plan'],
  'card.channelPreference': ['channel', 'channel preference', 'delivery preference', 'contact preference', 'delivery channel'],
  'card.rewardsBalance': ['rewards', 'points', 'rewards points', 'reward points', 'rewards balance', 'points balance'],
  'card.transactions': ['transactions', 'transaction list'],
  'member.planName': ['plan', 'plan name', 'health plan'],
  'member.memberId': ['member id', 'member number', 'membership number', 'subscriber id', 'subscriber number'],
  'claim.claimId': ['claim id', 'claim number', 'claim', 'claim reference'],
  'claim.serviceDate': ['service date', 'date service', 'date of service', 'dos'],
  'claim.service': ['service', 'service description', 'procedure', 'treatment'],
  'claim.billedCents': ['billed', 'billed amount', 'amount billed', 'charged', 'provider charge', 'charge'],
  'claim.allowedCents': ['allowed', 'allowed amount', 'amount allowed'],
  'claim.contractualAdjustmentCents': ['adjustment', 'contractual adjustment', 'discount', 'network discount'],
  'claim.planPaidCents': ['plan paid', 'paid by plan', 'plan payment', 'insurance paid', 'amount paid by plan'],
  'claim.patientResponsibilityCents': ['patient responsibility', 'member responsibility', 'patient owes', 'member owes', 'you may owe', 'responsibility'],
  'claim.liabilityConfirmed': ['liability confirmed', 'responsibility confirmed', 'confirmed'],
  'claim.status': ['status', 'claim status'],
  'claim.network': ['network', 'network status', 'in network'],
  'claim.deductibleAppliedCents': ['deductible', 'deductible applied', 'applied to deductible'],
  'claim.amountUnderReviewCents': ['amount under review', 'under review', 'review amount'],
};

interface Target { path: string; label: string; field?: FieldDef; keys: Map<string, number> }

/** How sure a name is: the path itself, its last part or the field label, then the other names people use. */
const WEIGHT = { path: 4, leaf: 3, label: 3, alias: 2 } as const;

function targetsFor(project: Pick<Project, 'documentType' | 'customFields'>): { targets: Target[]; derived: FieldDef[] } {
  const fields = projectFields(project);
  const targets: Target[] = [];
  const add = (path: string, label: string, field?: FieldDef) => {
    const keys = new Map<string, number>();
    const put = (ts: string[], w: number) => { const k = key(ts); if (k && (keys.get(k) ?? 0) < w) keys.set(k, w); };
    put(tokens(path), WEIGHT.path);
    put(tokens(path.split('.').slice(-1)[0] ?? path), WEIGHT.leaf);
    if (path.startsWith('custom.')) put(tokens(path.slice('custom.'.length)), WEIGHT.leaf);
    put(tokens(label.replace(/\([^)]*\)/g, ' ')), WEIGHT.label);
    for (const a of ALIASES[path] ?? []) put(tokens(a), WEIGHT.alias);
    targets.push({ path, label, field, keys });
  };
  add('recordId', 'Your own record ID');
  add('personaId', 'Persona');
  for (const f of fields) {
    if (f.derived || f.path === 'documentType' || f.path === 'recordId') continue;
    if (f.type === 'array' && f.path !== 'card.transactions') continue;
    add(f.path, f.label, f);
  }
  return { targets, derived: fields.filter((f) => f.derived) };
}

/* ------------------------------------------------------------------ matching */

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const sameWord = (a: string, b: string): boolean => {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 3 && l.startsWith(s)) return true; // "bal" for "balance", "transaction" for "transactions"
  return s.length >= 5 && editDistance(s, l) <= 1; // one typo in a longer word
};

interface Fuzzy { score: number; shared: string[]; how: 'spelling' | 'words' }

function fuzzy(header: string[], candidate: string[]): Fuzzy | null {
  const a = header.join(''), b = candidate.join('');
  let best: Fuzzy | null = null;
  if (a.length >= 4 && b.length >= 4) {
    const sim = 1 - editDistance(a, b) / Math.max(a.length, b.length);
    if (sim >= 0.8) best = { score: sim, shared: [], how: 'spelling' };
  }
  const used = new Set<number>();
  const shared: string[] = [];
  for (const h of header) {
    const j = candidate.findIndex((c, i) => !used.has(i) && sameWord(h, c));
    if (j >= 0) { used.add(j); shared.push(candidate[j]); }
  }
  if (shared.some((w) => !GENERIC.has(w))) {
    const dice = (2 * shared.length) / (header.length + candidate.length);
    if (dice >= 0.66 && (!best || dice > best.score)) best = { score: dice, shared, how: 'words' };
  }
  return best;
}

interface Found { path: string | null; confidence: ColumnMatch['confidence']; reason: string; score: number; target?: Target }

function matchOne(header: string, targets: Target[], derived: FieldDef[]): Found {
  const h = header.replace(/^﻿/, '').trim();
  if (!h) return { path: null, confidence: 'none', reason: 'The column has no heading.', score: 0 };
  if (h === 'documentType') return { path: null, confidence: 'none', reason: 'The kind of document comes from the project, so this column is not needed.', score: 0 };
  const isDerived = derived.find((f) => f.path === h || key(tokens(f.label)) === key(tokens(h)) || key(tokens(f.path)) === key(tokens(h)));
  const exact = targets.find((t) => t.path === h);
  if (exact) return { path: exact.path, confidence: 'exact', reason: `Same as the field “${exact.label}”.`, score: 10, target: exact };
  if (isDerived) return { path: null, confidence: 'none', reason: `“${isDerived.label}” is calculated by the studio and cannot be imported.`, score: 0 };

  const full = tokens(h);
  if (!full.length) return { path: null, confidence: 'none', reason: 'The heading has no words to match.', score: 0 };
  const variants: string[][] = [full];
  if (full.length > 1 && SCOPE.has(full[0])) variants.push(full.slice(1));
  if (full.length > 1 && full[full.length - 1] === 'amount') variants.push(full.slice(0, -1));

  // Same name once case, spacing, punctuation and common other names are set aside.
  for (const v of variants) {
    const k = key(v);
    const compact = v.join('');
    const weightOf = (t: Target): number => {
      const direct = t.keys.get(k);
      if (direct) return direct;
      // "duedate", "FIRSTNAME": the same letters with the spaces left out.
      let w = 0;
      if (compact.length >= 4) for (const [tk, tw] of t.keys) if (tk.replace(/ /g, '') === compact && tw > w) w = tw;
      return w;
    };
    const hits = targets.map((t) => ({ t, w: weightOf(t) })).filter((x) => x.w > 0).sort((a, b) => b.w - a.w);
    if (!hits.length) continue;
    if (hits.length > 1 && hits[0].w === hits[1].w) {
      return { path: null, confidence: 'none', reason: `Could be “${hits[0].t.label}” or “${hits[1].t.label}”. Choose the field yourself.`, score: 0 };
    }
    const t = hits[0].t;
    const why = hits[0].w === WEIGHT.alias ? `“${h}” is another name for “${t.label}”.` : `Same name as the field “${t.label}”, written differently.`;
    return { path: t.path, confidence: 'likely', reason: why, score: 5 + hits[0].w, target: t };
  }

  // Close spelling or shared words.
  const scored: Array<{ t: Target; f: Fuzzy }> = [];
  for (const t of targets) {
    let best: Fuzzy | null = null;
    for (const v of variants) for (const k of t.keys.keys()) {
      const f = fuzzy(v, k.split(' '));
      if (f && (!best || f.score > best.score)) best = f;
    }
    if (best) scored.push({ t, f: best });
  }
  scored.sort((a, b) => b.f.score - a.f.score);
  if (!scored.length) return { path: null, confidence: 'none', reason: 'No field has a similar name.', score: 0 };
  if (scored.length > 1 && scored[0].f.score - scored[1].f.score < 0.03) {
    return { path: null, confidence: 'none', reason: `Could be “${scored[0].t.label}” or “${scored[1].t.label}”. Choose the field yourself.`, score: 0 };
  }
  const { t, f } = scored[0];
  const reason = f.how === 'spelling'
    ? `A guess: “${h}” is spelled almost like “${t.label}”. Check it.`
    : `A guess: “${h}” shares the word${f.shared.length === 1 ? '' : 's'} ${f.shared.map((w) => `“${w}”`).join(', ')} with “${t.label}”. Check it.`;
  return { path: t.path, confidence: 'guess', reason, score: f.score, target: t };
}

/* ------------------------------------------------------------------ sample values */

const INT = /^-?\d+$/;
const MONEY = /^-?\s?[$€£]?\s?-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|^-?\s?[$€£]?\s?-?\d+(?:\.\d{1,2})?$/;

function validIsoDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
}

function valueProblem(f: FieldDef, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  switch (f.type) {
    case 'cents': {
      if (INT.test(v)) return null;
      if (MONEY.test(v)) {
        const amount = Number(v.replace(/[^0-9.-]/g, ''));
        const cents = Number.isFinite(amount) ? Math.round(amount * 100) : null;
        return `“${v}” looks like dollars, expected cents${cents !== null ? ` (${cents} for this value)` : ''}`;
      }
      return `“${v}” is not a number; expected whole cents`;
    }
    case 'int':
    case 'points':
      return INT.test(v) ? null : `“${v}” is not a whole number`;
    case 'date':
      return validIsoDate(v) ? null : `“${v}” is not a date written as YYYY-MM-DD`;
    case 'bool':
      return /^(true|yes|y|1|false|no|n|0)$/i.test(v) ? null : `“${v}” is not yes or no`;
    case 'enum':
      return !f.enumValues?.length || f.enumValues.includes(v) ? null : `“${v}” is not one of the allowed values (${f.enumValues.join(', ')})`;
    case 'array': {
      try { return Array.isArray(JSON.parse(v)) ? null : `“${v.slice(0, 24)}” is not a list`; } catch { return 'The value is not a list in JSON form'; }
    }
    default:
      return null;
  }
}

function sampleProblem(f: FieldDef | undefined, index: number, rows: string[][]): string | undefined {
  if (!f) return undefined;
  let checked = 0, bad = 0, first: string | null = null;
  for (const row of rows) {
    const cell = row?.[index];
    if (typeof cell !== 'string' || !cell.trim()) continue;
    checked++;
    const p = valueProblem(f, cell);
    if (p) { bad++; first ??= p; }
  }
  if (!first) return undefined;
  return `${first}${checked > 1 ? ` (${bad} of ${checked} sample values do not fit)` : ''}.`;
}

/* ------------------------------------------------------------------ api */

const RANK: Record<ColumnMatch['confidence'], number> = { exact: 3, likely: 2, guess: 1, none: 0 };

export function matchColumns(headers: string[], sampleRows: string[][], project: Pick<Project, 'documentType' | 'customFields'>): ColumnMatch[] {
  const { targets, derived } = targetsFor(project);
  const found = headers.map((h) => matchOne(String(h ?? ''), targets, derived));

  // One column per field: the better match keeps it.
  const winner = new Map<string, number>();
  found.forEach((f, i) => {
    if (!f.path) return;
    const w = winner.get(f.path);
    if (w === undefined) { winner.set(f.path, i); return; }
    const cur = found[w];
    if (RANK[f.confidence] > RANK[cur.confidence] || (RANK[f.confidence] === RANK[cur.confidence] && f.score > cur.score)) winner.set(f.path, i);
  });

  return found.map((f, i): ColumnMatch => {
    const column = String(headers[i] ?? '');
    if (f.path && winner.get(f.path) !== i) {
      const other = String(headers[winner.get(f.path)!] ?? '').trim();
      return { column, path: null, confidence: 'none', reason: `Column “${other}” is the better match for “${f.target?.label ?? f.path}”, and a field takes one column only.` };
    }
    const problem = f.path ? sampleProblem(f.target?.field, i, sampleRows ?? []) : undefined;
    return { column, path: f.path, confidence: f.confidence, reason: f.reason, ...(problem ? { sampleProblem: problem } : {}) };
  });
}
