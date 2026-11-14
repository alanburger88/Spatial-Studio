import { applyCommand, type Command } from './commands';
import { defaultNode, tableColumnsFor } from './catalog';
import { channelConfig } from './channels';
import { customFieldDefs, defaultFormatterFor, fieldsFor, CUSTOM_LIST_MAX_COLUMNS } from './fields';
import { isSafeUrl, richFromMarkup } from './rich';
import { ACCENT_PATTERN, blankProject, ISSUER_NAME_MAX, ISSUER_NAME_MIN, projectFileProblems, TEMPLATE_TITLE_MAX } from './templates';
import type { ComparisonOp, CustomField, CustomListColumn, DocNode, PaperSize, Predicate, Project, Rule, Scalar } from './types';

/**
 * A document setup: a small, plain description of a new document "with its own data" that a model, the built-in data
 * reader or a person can write and a person can read. It is never applied as it stands: `checkSetupSpec` cleans it
 * (and says in plain words what it dropped or corrected) and `projectFromSetupSpec` turns the cleaned description
 * into a project through ordinary commands, exactly as a person would build it in the studio.
 *
 * Wording may mention a data field by its label in single braces (`{Renewal date}`) and the customer's name as
 * `{First name}` / `{Last name}`; the email and SMS wording may also carry `{Link}`, the web address of the
 * document's first button. Amounts (examples, condition values) are written in currency units: 49 or 49.50.
 * An empty text or an empty list means "not given", so a description in which every property is present (the form a
 * model returns) reads the same as one that leaves them out.
 */
export type SetupFieldType = 'text' | 'number' | 'amount' | 'date' | 'choice' | 'yesNo' | 'list';
export type SetupColumnType = 'text' | 'number' | 'amount' | 'date';
export interface SetupColumn { label: string; type: SetupColumnType }
export interface SetupField {
  label: string;
  type: SetupFieldType;
  /** A choice: the values it can take. */
  choices?: string[];
  /** A list: the columns of each row (1 to 8). */
  columns?: SetupColumn[];
  /** A typical value, as a person would write it (an amount as 49.00, a date as 2026-12-01, yes or no). */
  example?: string;
  required?: boolean;
}

export type SetupTest = 'is' | 'isNot' | 'moreThan' | 'atLeast' | 'lessThan' | 'atMost';
/** One test on one data field that is not a list. An amount is compared in currency units, a date as YYYY-MM-DD. */
export interface SetupCondition { field: string; test: SetupTest; value: string | number | boolean }
export interface SetupMessageVersion {
  title: string;
  text: string;
  /** Who gets this version. Absent on the fallback. */
  when?: SetupCondition;
  /** The version shown when no other applies. Exactly one per message, and it has no condition. */
  fallback?: boolean;
}

export type SetupSection =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  /** One to six data fields shown as a summary (two or more is usual). */
  | { type: 'keyFigures'; fields: string[] }
  /** A list field shown as a table: which of its columns, and optionally one amount column that is summed. */
  | { type: 'table'; list: string; columns?: string[]; totalColumn?: string }
  /** Wording that differs between customers: versions are tried in order, the first whose condition holds is shown. */
  | { type: 'messages'; name: string; versions: SetupMessageVersion[] }
  /** Required small print. */
  | { type: 'notice'; text: string }
  /** A button that opens a web page (https only). */
  | { type: 'action'; label: string; url: string }
  | { type: 'divider' };

export interface SetupSpec {
  title: string;
  issuerName: string;
  /** The issuer's colour as `#rrggbb`. */
  accent?: string;
  /** One sentence saying what the document is. */
  summary: string;
  fields: SetupField[];
  sections: SetupSection[];
  email?: { subject: string; intro: string };
  /** The text message. */
  sms?: string;
  /** The paper the pages are composed on (a document rebuilt from a file keeps the file's paper). Absent: US Letter. */
  paper?: PaperSize;
}

/** The paper sizes a setup can ask for. */
export const SETUP_PAPER_SIZES: PaperSize[] = ['US-Letter', 'A4', 'US-Legal'];

export const SETUP_FIELD_TYPES: SetupFieldType[] = ['text', 'number', 'amount', 'date', 'choice', 'yesNo', 'list'];
export const SETUP_COLUMN_TYPES: SetupColumnType[] = ['text', 'number', 'amount', 'date'];
export const SETUP_SECTION_TYPES: Array<SetupSection['type']> = ['heading', 'paragraph', 'keyFigures', 'table', 'messages', 'notice', 'action', 'divider'];
export const SETUP_TESTS: SetupTest[] = ['is', 'isNot', 'moreThan', 'atLeast', 'lessThan', 'atMost'];
/** What a person reads for each field type. */
export const SETUP_FIELD_TYPE_LABEL: Record<SetupFieldType, string> = { text: 'Text', number: 'Whole number', amount: 'Amount', date: 'Date', choice: 'Choice', yesNo: 'Yes or no', list: 'List' };

/** Hard limits. Anything beyond them is cut and reported, never stored. */
export const SETUP_LIMITS = {
  fields: 40, sections: 30, title: TEMPLATE_TITLE_MAX, issuerName: ISSUER_NAME_MAX, summary: 300,
  label: 60, choices: 12, choice: 40, columns: CUSTOM_LIST_MAX_COLUMNS, example: 80,
  heading: 120, paragraph: 1500, keyFigures: 6,
  messageName: 60, versions: 6, versionTitle: 60, versionText: 1500, conditionText: 80,
  notice: 2000, actionLabel: 60, url: 300,
  emailSubject: 160, emailIntro: 1000, sms: 320,
  notes: 60,
} as const;

export interface SetupCheck { spec: SetupSpec; notes: string[] }

/** True when there is nothing to build from: no data field and no section. */
export const isEmptySetupSpec = (spec: SetupSpec): boolean => spec.fields.length === 0 && spec.sections.length === 0;

/* ------------------------------------------------------------------ small helpers */

type Note = (text: string) => void;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
const q = (s: string): string => `“${s}”`;
const listOf = (items: string[], max = 5): string => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));

/** The customer's own name, however it is written. Checked after the project's own field labels. */
const FIRST_NAME = new Set(['first name', 'firstname', 'given name', 'givenname', 'forename', 'customer first name', 'customer.givenname']);
const LAST_NAME = new Set(['last name', 'lastname', 'family name', 'familyname', 'surname', 'customer last name', 'customer.familyname']);
const FULL_NAME = new Set(['name', 'full name', 'fullname', 'customer name', 'customer']);
/** Labels a data field cannot have, because every customer already has that value. */
const RESERVED_LANGUAGE = new Set(['language', 'preferred language', 'locale', 'preferred locale', 'customer language']);
const RESERVED_NAME = new Set([...FIRST_NAME, ...LAST_NAME, 'full name', 'fullname', 'customer name']);

const MENTION = /\{+\s*([^{}\n]{1,80}?)\s*\}+/g;
/** Rewrites every `{…}` group through `resolve` and removes any brace left over. */
function mapMentions(text: string, resolve: (inner: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    out += text.slice(last, m.index).replace(/[{}]/g, '') + resolve(m[1]);
    last = (m.index ?? 0) + m[0].length;
  }
  return out + text.slice(last).replace(/[{}]/g, '');
}

/** Plain wording: no control characters, no tags or angle brackets, no links hidden in the text. */
function plainText(v: unknown, max: number, what: string, note: Note, multiline: boolean): string {
  if (typeof v !== 'string') return '';
  let s = v.replace(/\r\n?/g, '\n').replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ');
  if (/[<>]/.test(s)) {
    s = s.replace(/<\/?[a-zA-Z][^<>]*>/g, '').replace(/[<>]/g, '');
    note(`${what}: markup and the characters < and > are not allowed in wording and were removed.`);
  }
  if (/\[[^\]]+\]\([^)\s]+\)/.test(s)) {
    s = s.replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1');
    note(`${what}: a link inside the text was turned into plain words. Use an action section for a link.`);
  }
  s = multiline ? s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim() : s.replace(/\s+/g, ' ').trim();
  if (s.length > max) {
    s = s.slice(0, max).trimEnd();
    note(`${what} was shortened to ${max} characters.`);
  }
  return s;
}
/** A name or label: one line, no braces. */
const nameText = (v: unknown, max: number, what: string, note: Note): string => plainText(typeof v === 'string' ? v.replace(/[{}]/g, '') : v, max, what, note, false);

const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | null => {
  if (typeof v !== 'string') return null;
  const want = v.replace(/[\s_-]/g, '').toLowerCase();
  return allowed.find((a) => a.toLowerCase() === want) ?? null;
};

function validIsoDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
}

/** An amount written in currency units ("49", "49.5", "$1,234.50", 49.5) as whole cents, or null when it is not one. */
export function amountToCents(v: unknown): number | null {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Math.abs(v) > 1e11) return null;
    const cents = Math.round(v * 100);
    return Math.abs(cents - v * 100) < 1e-6 ? cents : null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^(-?)\s*[$€£]\s*/, '$1');
  const m = /^(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[2].replace(/,/g, ''));
  if (whole > 1e11) return null;
  const cents = whole * 100 + Number((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] && cents !== 0 ? -cents : cents;
}
/** Whole cents as a plain amount: 4900 → "49.00". */
export const centsToAmount = (cents: number): string => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

const wholeNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) <= 1e12 ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/(\d),(?=\d{3}\b)/g, '$1');
  return /^-?\d{1,13}$/.test(s) ? Number(s) : null;
};
const yesNo = (v: unknown): boolean | null => {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return null;
  return /^(yes|true|y)$/i.test(v.trim()) ? true : /^(no|false|n)$/i.test(v.trim()) ? false : null;
};

/* ------------------------------------------------------------------ checking */

interface CheckCtx { note: Note; byLabel: Map<string, SetupField> }

function cleanExample(field: SetupField, raw: unknown, note: Note): string | undefined {
  const given = typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : typeof raw === 'string' ? raw.replace(/[{}<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!given) return undefined;
  const bad = (what: string): undefined => { note(`The example ${q(given.slice(0, 40))} for ${q(field.label)} is not ${what}, so it was left out.`); return undefined; };
  switch (field.type) {
    case 'amount': { const c = amountToCents(given); return c === null ? bad('an amount such as 49.00') : centsToAmount(c); }
    case 'number': { const n = wholeNumber(given); return n === null ? bad('a whole number') : String(n); }
    case 'date': return validIsoDate(given) ? given : bad('a date written as YYYY-MM-DD');
    case 'yesNo': { const b = yesNo(given); return b === null ? bad('yes or no') : b ? 'yes' : 'no'; }
    case 'choice': { const hit = (field.choices ?? []).find((c) => norm(c) === norm(given)); return hit ?? bad('one of its choices'); }
    case 'list': return undefined;
    default: return given.slice(0, SETUP_LIMITS.example);
  }
}

function cleanFields(raw: unknown, note: Note): SetupField[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) { note('The list of data fields could not be read, so no data fields were taken from it.'); return []; }
  const out: SetupField[] = [];
  const seen = new Set<string>();
  const standard = new Set(fieldsFor('custom').map((f) => norm(f.label)));
  let over = 0;
  for (const item of raw) {
    if (!isObj(item)) { note('A data field that is not a description of a field was left out.'); continue; }
    const label = nameText(item.label, SETUP_LIMITS.label, 'A data field label', note);
    if (!label) { note('A data field without a label was left out.'); continue; }
    const key = norm(label);
    if (RESERVED_NAME.has(key) || RESERVED_LANGUAGE.has(key) || standard.has(key)) {
      note(RESERVED_LANGUAGE.has(key) || key === 'preferred locale'
        ? `${q(label)} was left out as a data field: every customer already has a language.`
        : RESERVED_NAME.has(key) || key === 'middle name (optional)'
          ? `${q(label)} was left out as a data field: every customer already has a name. Mention it in text as {First name} or {Last name}.`
          : `${q(label)} was left out as a data field: the studio already keeps that for every customer.`);
      continue;
    }
    if (seen.has(key)) { note(`Two data fields are called ${q(label)}; only the first was kept.`); continue; }
    if (out.length >= SETUP_LIMITS.fields) { over++; continue; }
    let type = pick(item.type, SETUP_FIELD_TYPES);
    if (!type) { note(`${q(label)} has no known type, so it was set up as text.`); type = 'text'; }
    const field: SetupField = { label, type };
    if (type === 'choice') {
      const choices: string[] = [];
      for (const c of Array.isArray(item.choices) ? item.choices : []) {
        const v = typeof c === 'number' ? String(c) : nameText(c, SETUP_LIMITS.choice, `A choice of ${q(label)}`, note);
        if (v && !choices.some((x) => norm(x) === norm(v))) choices.push(v);
      }
      if (choices.length > SETUP_LIMITS.choices) { note(`${q(label)} has more than ${SETUP_LIMITS.choices} choices; only the first ${SETUP_LIMITS.choices} were kept.`); choices.length = SETUP_LIMITS.choices; }
      if (choices.length) field.choices = choices;
      else { note(`${q(label)} is a choice without any choices, so it was set up as text.`); field.type = 'text'; }
    } else if (Array.isArray(item.choices) && item.choices.length) note(`${q(label)} is not a choice, so its list of choices was ignored.`);
    if (type === 'list') {
      const columns: SetupColumn[] = [];
      for (const c of Array.isArray(item.columns) ? item.columns : []) {
        if (!isObj(c)) continue;
        const cl = nameText(c.label, SETUP_LIMITS.label, `A column of ${q(label)}`, note);
        if (!cl) { note(`A column of ${q(label)} without a label was left out.`); continue; }
        if (columns.some((x) => norm(x.label) === norm(cl))) { note(`${q(label)} has two columns called ${q(cl)}; only the first was kept.`); continue; }
        let ct = pick(c.type, SETUP_COLUMN_TYPES);
        if (!ct) { note(`The column ${q(cl)} of ${q(label)} must be text, a whole number, an amount or a date; it was set up as text.`); ct = 'text'; }
        columns.push({ label: cl, type: ct });
      }
      if (columns.length > SETUP_LIMITS.columns) { note(`${q(label)} has more than ${SETUP_LIMITS.columns} columns; only the first ${SETUP_LIMITS.columns} were kept.`); columns.length = SETUP_LIMITS.columns; }
      if (!columns.length) { note(`The list ${q(label)} was left out: a list needs at least one column.`); continue; }
      field.columns = columns;
    } else if (Array.isArray(item.columns) && item.columns.length) note(`${q(label)} is not a list, so its columns were ignored.`);
    const example = cleanExample(field, item.example, note);
    if (example !== undefined) field.example = example;
    if (item.required === true) field.required = true;
    seen.add(key);
    out.push(field);
  }
  if (over) note(`A document can have at most ${SETUP_LIMITS.fields} data fields; ${over} more ${over === 1 ? 'was' : 'were'} left out.`);
  return out;
}

/** Wording with its mentions checked: a known field keeps its exact label, the customer's name its standard form, anything else becomes plain words. */
function wording(v: unknown, max: number, what: string, ctx: CheckCtx, multiline: boolean, channel = false): string {
  const text = plainText(v, max, what, ctx.note, multiline);
  return mapMentions(text, (inner) => {
    const key = norm(inner);
    const field = ctx.byLabel.get(key);
    if (field) {
      if (field.type !== 'list') return `{${field.label}}`;
      ctx.note(`${what} mentions the list ${q(field.label)}. A list cannot be shown inside a sentence, so it was left as plain words. Use a table section to show it.`);
      return field.label;
    }
    if (FIRST_NAME.has(key)) return '{First name}';
    if (LAST_NAME.has(key)) return '{Last name}';
    if (FULL_NAME.has(key)) return '{First name} {Last name}';
    // Email and SMS wording may carry the web address of the document's first button.
    if (channel && key === 'link') return '{Link}';
    ctx.note(`${what} mentions ${q(`{${inner}}`)}, which is not one of the data fields, so it was left as plain words.`);
    return inner;
  });
}

function cleanCondition(raw: Record<string, unknown>, ctx: CheckCtx): { when: SetupCondition } | { reason: string } {
  const name = typeof raw.field === 'string' ? raw.field.replace(/[{}]/g, '').trim() : '';
  const field = ctx.byLabel.get(norm(name));
  if (!field) return { reason: `its condition uses ${q(name.slice(0, 60))}, which is not one of the data fields` };
  if (field.type === 'list') return { reason: `its condition tests ${q(field.label)}, which is a list. A condition can only test a single value` };
  const test = pick(raw.test, SETUP_TESTS);
  if (!test) return { reason: `its condition on ${q(field.label)} has no test the studio knows (is, is not, more than, at least, less than, at most)` };
  const ordered = test !== 'is' && test !== 'isNot';
  const v = raw.value;
  const shown = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? q(String(v).slice(0, 40)) : 'the value given';
  switch (field.type) {
    case 'amount': { const c = amountToCents(v); return c === null ? { reason: `${q(field.label)} is an amount, and ${shown} is not one (write it as 49 or 49.50)` } : { when: { field: field.label, test, value: c / 100 } }; }
    case 'number': { const n = wholeNumber(v); return n === null ? { reason: `${q(field.label)} is a whole number, and ${shown} is not one` } : { when: { field: field.label, test, value: n } }; }
    case 'date': return typeof v === 'string' && validIsoDate(v.trim()) ? { when: { field: field.label, test, value: v.trim() } } : { reason: `${q(field.label)} is a date, and ${shown} is not a date written as YYYY-MM-DD` };
    case 'yesNo': {
      if (ordered) return { reason: `${q(field.label)} is yes or no, so it can only be tested with “is” or “is not”` };
      const b = yesNo(v);
      return b === null ? { reason: `${q(field.label)} is yes or no, and ${shown} is neither` } : { when: { field: field.label, test, value: b } };
    }
    case 'choice': {
      if (ordered) return { reason: `${q(field.label)} is a choice, so it can only be tested with “is” or “is not”` };
      const hit = (field.choices ?? []).find((c) => norm(c) === norm(String(v ?? '')));
      return hit === undefined ? { reason: `${shown} is not one of the choices of ${q(field.label)} (${listOf(field.choices ?? [])})` } : { when: { field: field.label, test, value: hit } };
    }
    default: {
      if (ordered) return { reason: `${q(field.label)} is text, so it can only be tested with “is” or “is not”` };
      const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.replace(/[{}<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SETUP_LIMITS.conditionText) : '';
      return s ? { when: { field: field.label, test, value: s } } : { reason: `its condition on ${q(field.label)} has no value to compare with` };
    }
  }
}

function cleanMessages(raw: Record<string, unknown>, ctx: CheckCtx): SetupSection | null {
  const { note } = ctx;
  const name = nameText(raw.name, SETUP_LIMITS.messageName, 'The name of a message', note) || 'Message';
  interface V { title: string; text: string; when?: SetupCondition; flagged: boolean }
  const all: V[] = [];
  const list = Array.isArray(raw.versions) ? raw.versions : [];
  list.forEach((item, i) => {
    if (!isObj(item)) return;
    const title = nameText(item.title, SETUP_LIMITS.versionTitle, `A version title in ${q(name)}`, note) || `Version ${i + 1}`;
    const text = wording(item.text, SETUP_LIMITS.versionText, `The version ${q(title)} of ${q(name)}`, ctx, true);
    if (!text) { note(`The version ${q(title)} of ${q(name)} has no text, so it was left out.`); return; }
    const flagged = item.fallback === true;
    const given = isObj(item.when) && typeof item.when.field === 'string' && item.when.field.trim() !== '' ? item.when : null;
    if (!given) { all.push({ title, text, flagged }); return; }
    const c = cleanCondition(given, ctx);
    if ('when' in c) all.push({ title, text, when: c.when, flagged });
    else if (flagged) all.push({ title, text, flagged });
    else note(`The version ${q(title)} of ${q(name)} was left out: ${c.reason}.`);
  });
  if (!all.length) { note(`The message ${q(name)} was left out: it has no version with text.`); return null; }

  // Exactly one fallback, and it has no condition.
  let fallback = all.find((v) => v.flagged);
  if (fallback) {
    for (const v of all.filter((x) => x.flagged && x !== fallback)) {
      if (v.when) note(`More than one version of ${q(name)} was marked as the one shown when nothing else applies. ${q(fallback.title)} is used for that; ${q(v.title)} keeps its condition.`);
      else note(`More than one version of ${q(name)} was marked as the one shown when nothing else applies. ${q(fallback.title)} is used for that, and ${q(v.title)} was left out because it could never be shown.`);
    }
    if (fallback.when) note(`${q(fallback.title)} is the version of ${q(name)} shown when nothing else applies, so its condition was removed.`);
  } else {
    fallback = all.find((v) => !v.when);
    if (fallback) note(`No version of ${q(name)} was marked as the one shown when nothing else applies; ${q(fallback.title)} has no condition, so it is used for that.`);
    else {
      fallback = all[all.length - 1];
      note(`No version of ${q(name)} was marked as the one shown when nothing else applies, so the last one (${q(fallback.title)}) is used for that and its condition was removed. Check that this is what you want.`);
    }
  }
  const kept: V[] = [];
  for (const v of all) {
    if (v === fallback || v.when) { kept.push(v); continue; }
    if (!v.flagged) note(`The version ${q(v.title)} of ${q(name)} has no condition and is not the one shown when nothing else applies, so it could never be shown. It was left out.`);
  }
  let conditional = kept.filter((v) => v !== fallback).length;
  if (conditional > SETUP_LIMITS.versions - 1) {
    note(`A message can have at most ${SETUP_LIMITS.versions} versions; the last ${conditional - (SETUP_LIMITS.versions - 1)} of ${q(name)} ${conditional - (SETUP_LIMITS.versions - 1) === 1 ? 'was' : 'were'} left out.`);
    for (let i = kept.length - 1; i >= 0 && conditional > SETUP_LIMITS.versions - 1; i--) if (kept[i] !== fallback) { kept.splice(i, 1); conditional--; }
  }
  return {
    type: 'messages', name,
    versions: kept.map((v): SetupMessageVersion => (v === fallback ? { title: v.title, text: v.text, fallback: true } : { title: v.title, text: v.text, when: v.when! })),
  };
}

function cleanSection(raw: unknown, ctx: CheckCtx): SetupSection | null {
  const { note } = ctx;
  if (!isObj(raw)) { note('A section that is not a description of a section was left out.'); return null; }
  const type = pick(raw.type, SETUP_SECTION_TYPES);
  switch (type) {
    case 'heading': {
      const text = wording(raw.text, SETUP_LIMITS.heading, 'A heading', ctx, false);
      if (!text) { note('A heading without text was left out.'); return null; }
      return { type, text };
    }
    case 'paragraph': {
      const text = wording(raw.text, SETUP_LIMITS.paragraph, 'A paragraph', ctx, true);
      if (!text) { note('A paragraph without text was left out.'); return null; }
      return { type, text };
    }
    case 'keyFigures': {
      const fields: string[] = [];
      for (const item of Array.isArray(raw.fields) ? raw.fields : []) {
        const name = typeof item === 'string' ? item.replace(/[{}]/g, '').trim() : '';
        const f = ctx.byLabel.get(norm(name));
        if (!f) { note(`The key figure ${q(name.slice(0, 60))} is not one of the data fields, so it was left out.`); continue; }
        if (f.type === 'list') { note(`${q(f.label)} is a list and cannot be a key figure. Use a table section to show it.`); continue; }
        if (!fields.includes(f.label)) fields.push(f.label);
      }
      if (fields.length > SETUP_LIMITS.keyFigures) { note(`A summary shows at most ${SETUP_LIMITS.keyFigures} key figures; the first ${SETUP_LIMITS.keyFigures} were kept.`); fields.length = SETUP_LIMITS.keyFigures; }
      if (!fields.length) { note('A summary of key figures without any usable data field was left out.'); return null; }
      return { type, fields };
    }
    case 'table': {
      const name = typeof raw.list === 'string' ? raw.list.replace(/[{}]/g, '').trim() : '';
      const f = ctx.byLabel.get(norm(name));
      if (!f) { note(`A table for ${q(name.slice(0, 60))} was left out: it is not one of the data fields.`); return null; }
      if (f.type !== 'list' || !f.columns) { note(`A table for ${q(f.label)} was left out: it is not a list. Show it as a key figure or mention it in a paragraph.`); return null; }
      const columns: string[] = [];
      for (const item of Array.isArray(raw.columns) ? raw.columns : []) {
        const cn = typeof item === 'string' ? item.trim() : '';
        const col = f.columns.find((x) => norm(x.label) === norm(cn));
        if (!col) { if (cn) note(`The table ${q(f.label)} has no column ${q(cn.slice(0, 60))}, so it was left out of the table.`); continue; }
        if (!columns.includes(col.label)) columns.push(col.label);
      }
      const shown = columns.length ? columns : f.columns.map((x) => x.label);
      const out: Extract<SetupSection, { type: 'table' }> = { type, list: f.label, columns: shown };
      const tn = typeof raw.totalColumn === 'string' ? raw.totalColumn.trim() : '';
      if (tn) {
        const col = f.columns.find((x) => norm(x.label) === norm(tn));
        if (!col || !shown.includes(col.label)) note(`The table ${q(f.label)} cannot total ${q(tn.slice(0, 60))}: it is not one of the columns shown.`);
        else if (col.type !== 'amount') note(`The table ${q(f.label)} cannot total ${q(col.label)}: only an amount column can be summed.`);
        else out.totalColumn = col.label;
      }
      return out;
    }
    case 'messages': return cleanMessages(raw, ctx);
    case 'notice': {
      const text = wording(raw.text, SETUP_LIMITS.notice, 'A notice', ctx, true);
      if (!text) { note('A notice without text was left out.'); return null; }
      return { type, text };
    }
    case 'action': {
      const label = nameText(raw.label, SETUP_LIMITS.actionLabel, 'A button label', note);
      const url = typeof raw.url === 'string' ? raw.url.trim() : '';
      if (!label) { note('A button without a label was left out.'); return null; }
      if (url.length > SETUP_LIMITS.url || !isSafeUrl(url)) { note(`The button ${q(label)} was left out: its link must be a web address that starts with https://.`); return null; }
      return { type, label, url };
    }
    case 'divider': return { type };
    default:
      note(`A section of the unknown kind ${q(String(raw.type ?? '').slice(0, 40))} was left out.`);
      return null;
  }
}

const TOP_KEYS = new Set(['title', 'issuerName', 'accent', 'summary', 'fields', 'sections', 'email', 'sms', 'paper']);

function clean(raw: unknown, note: Note): SetupSpec {
  let o: Record<string, unknown> = {};
  if (isObj(raw)) o = raw;
  else note('This is not a description of a document, so nothing was taken from it.');
  const extra = Object.keys(o).filter((k) => !TOP_KEYS.has(k));
  if (extra.length) note(`Ignored ${listOf(extra.map((k) => q(k.slice(0, 30))))}: a document setup has no such ${extra.length === 1 ? 'property' : 'properties'}.`);

  let title = nameText(o.title, SETUP_LIMITS.title, 'The title', note);
  if (title.length < 2) { title = 'Untitled document'; note('No title was given, so “Untitled document” is used.'); }
  let issuerName = nameText(o.issuerName, SETUP_LIMITS.issuerName, 'The issuer name', note);
  if (issuerName.length < ISSUER_NAME_MIN) issuerName = title.slice(0, SETUP_LIMITS.issuerName).trim();
  const spec: SetupSpec = { title, issuerName, summary: nameText(o.summary, SETUP_LIMITS.summary, 'The summary', note), fields: [], sections: [] };
  if (typeof o.accent === 'string' && o.accent.trim()) {
    if (ACCENT_PATTERN.test(o.accent.trim())) spec.accent = o.accent.trim().toLowerCase();
    else note(`The colour ${q(o.accent.trim().slice(0, 20))} is not a 6-digit hex colour such as #1f4e79, so the standard colour is used.`);
  }

  spec.fields = cleanFields(o.fields, note);
  const ctx: CheckCtx = { note, byLabel: new Map(spec.fields.map((f) => [norm(f.label), f])) };

  if (o.sections !== undefined && o.sections !== null && !Array.isArray(o.sections)) note('The list of sections could not be read, so no sections were taken from it.');
  let over = 0;
  for (const item of Array.isArray(o.sections) ? o.sections : []) {
    if (spec.sections.length >= SETUP_LIMITS.sections) { over++; continue; }
    const s = cleanSection(item, ctx);
    if (s) spec.sections.push(s);
  }
  if (over) note(`A document setup can have at most ${SETUP_LIMITS.sections} sections; ${over} more ${over === 1 ? 'was' : 'were'} left out.`);

  if (isObj(o.email)) {
    const subject = wording(o.email.subject, SETUP_LIMITS.emailSubject, 'The email subject', ctx, false, true);
    const intro = wording(o.email.intro, SETUP_LIMITS.emailIntro, 'The email opening text', ctx, true, true);
    if (subject || intro) spec.email = { subject, intro };
  }
  const sms = wording(o.sms, SETUP_LIMITS.sms, 'The text message', ctx, false, true);
  if (sms) spec.sms = sms;
  if (typeof o.paper === 'string' && o.paper.trim()) {
    const paper = pick(o.paper, SETUP_PAPER_SIZES);
    if (paper) spec.paper = paper;
    else note(`The paper ${q(o.paper.trim().slice(0, 20))} is not one the studio offers (US Letter, A4 or US Legal), so US Letter is used.`);
  }
  return spec;
}

/**
 * Checks a document setup from anywhere (a model, a file, a person's edits) and returns a cleaned one plus a note, in
 * plain words, for everything it dropped or corrected. Checking a cleaned setup again changes nothing and adds no note.
 * Never throws.
 */
export function checkSetupSpec(raw: unknown): SetupCheck {
  const notes: string[] = [];
  const note: Note = (text) => { if (notes.length < SETUP_LIMITS.notes && !notes.includes(text)) notes.push(text); };
  try {
    return { spec: clean(raw, note), notes };
  } catch {
    return { spec: { title: 'Untitled document', issuerName: 'Untitled document', summary: '', fields: [], sections: [] }, notes: ['The setup could not be read, so nothing was taken from it.'] };
  }
}

/* ------------------------------------------------------------------ building */

/** Names a record value can never be stored under: `count` is how a list's number of rows is read, the rest belong to every object. */
const UNUSABLE_KEYS = new Set(['count', 'constructor', 'prototype', 'tostring', 'valueof', 'hasownproperty', 'isprototypeof', 'propertyisenumerable', 'tolocalestring']);

/** A valid, unused field key from a label: "Monthly fee" → `monthlyFee` (an amount: `monthlyFeeCents`). */
export function setupFieldKey(label: string, used: Set<string>, amount = false): string {
  const words = label.normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  let key = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('');
  if (!key) key = 'field';
  if (!/^[A-Za-z]/.test(key)) key = `f${key}`;
  if (amount && !/cents$/i.test(key)) key = `${key.slice(0, 31)}Cents`;
  key = key.slice(0, 36);
  if (UNUSABLE_KEYS.has(key.toLowerCase())) key = `${key}Value`;
  let out = key;
  for (let n = 2; used.has(out.toLowerCase()); n++) out = `${key}${n}`;
  used.add(out.toLowerCase());
  return out;
}

const COLUMN_TYPE: Record<SetupColumnType, CustomListColumn['type']> = { text: 'string', number: 'int', amount: 'cents', date: 'date' };
const FIELD_TYPE: Record<SetupFieldType, CustomField['type']> = { text: 'string', number: 'int', amount: 'cents', date: 'date', choice: 'enum', yesNo: 'bool', list: 'list' };
const TEST_OP: Record<SetupTest, ComparisonOp> = { is: 'eq', isNot: 'ne', moreThan: 'gt', atLeast: 'gte', lessThan: 'lt', atMost: 'lte' };

/** The project data fields a cleaned setup asks for, with keys derived from the labels. */
export function setupCustomFields(spec: SetupSpec): CustomField[] {
  const used = new Set<string>();
  return spec.fields.map((f): CustomField => {
    const out: CustomField = { key: setupFieldKey(f.label, used, f.type === 'amount'), label: f.label, type: FIELD_TYPE[f.type] };
    if (f.type === 'choice') out.enumValues = [...(f.choices ?? [])];
    if (f.type === 'list') {
      const cols = new Set<string>();
      out.itemFields = (f.columns ?? []).map((c) => ({ key: setupFieldKey(c.label, cols, c.type === 'amount'), label: c.label, type: COLUMN_TYPE[c.type] }));
    }
    if (f.required) out.required = true;
    if (f.example !== undefined && f.type !== 'list') out.example = f.type === 'amount' ? String(amountToCents(f.example) ?? 0) : f.example;
    return out;
  });
}

export interface SetupBuild { project: Project; notes: string[] }

/**
 * Builds the project a setup describes: starts from the blank project and applies ordinary commands, in the order a
 * person would (data fields, then each section, its wording and its rules, then the email and SMS wording). The setup
 * is checked first, so anything a file or a model slipped in is already gone; whatever a command still refuses is
 * skipped and reported in `notes`. Pure and deterministic.
 */
export function projectFromSetupSpec(raw: SetupSpec, opts: { projectId: string; title: string }): SetupBuild {
  const checked = checkSetupSpec(raw);
  const spec = checked.spec;
  const notes = [...checked.notes];
  const note = (text: string) => { if (!notes.includes(text)) notes.push(text); };
  let project = blankProject({ projectId: opts.projectId, title: opts.title, issuerName: spec.issuerName, accent: spec.accent });
  /** Applies one command; a refusal leaves the project as it was and is reported in plain words. */
  const run = (cmd: Command, what: string): boolean => {
    const r = applyCommand(project, cmd);
    if (r.ok) { project = r.project; return true; }
    note(`${what} could not be added: ${r.message}`);
    return false;
  };

  // 0. The paper, before anything is placed on the pages.
  if (spec.paper && spec.paper !== 'US-Letter') run({ type: 'SET_PAGE_DESIGN', patch: { paper: spec.paper } }, 'The paper size');

  // 1. Data fields: all at once, or one by one when the set as a whole is refused.
  const wanted = setupCustomFields(spec);
  if (wanted.length) {
    const all = applyCommand(project, { type: 'SET_CUSTOM_FIELDS', fields: wanted });
    if (all.ok) project = all.project;
    else {
      const kept: CustomField[] = [];
      for (const f of wanted) if (run({ type: 'SET_CUSTOM_FIELDS', fields: [...kept, f] }, `The data field ${q(f.label)}`)) kept.push(f);
    }
  }
  const byLabel = new Map((project.customFields ?? []).map((f) => [norm(f.label), f]));
  const path = (label: string): string | null => { const f = byLabel.get(norm(label)); return f ? `custom.${f.key}` : null; };

  /** Mentions become real data tokens; a field that did not make it into the project stays as plain words. */
  const tokens = (text: string, channel = false): string => mapMentions(text, (inner) => {
    const key = norm(inner);
    const p = path(inner);
    if (p) return `{{${p}}}`;
    if (key === 'first name') return '{{customer.givenName}}';
    if (key === 'last name') return '{{customer.familyName}}';
    return channel && key === 'link' ? '{{link}}' : inner;
  });
  const short = (text: string, max = 48): string => { const s = mapMentions(text, (inner) => inner).replace(/[#*\n]+/g, ' ').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s; };
  const insert = (node: DocNode, what: string, parentId = project.rootNodeId): boolean => run({ type: 'INSERT_NODE', node, parentId }, what);

  let ruleNo = 0;
  let greeted = false;
  let notices = 0;
  spec.sections.forEach((section, i) => {
    const n = i + 1;
    switch (section.type) {
      case 'heading': {
        const id = `heading-${n}`;
        insert({ ...defaultNode('rich-text', id, 'custom', project), name: short(section.text), content: richFromMarkup(`# ${tokens(section.text)}`) }, `The heading ${q(short(section.text))}`);
        break;
      }
      case 'paragraph': {
        // The first paragraph that greets the customer by name also opens the email.
        const greets = !greeted && /\{First name\}/.test(section.text);
        const id = greets ? 'greeting' : `text-${n}`;
        if (insert({ ...defaultNode('rich-text', id, 'custom', project), name: greets ? 'Greeting' : short(section.text), content: richFromMarkup(tokens(section.text)) }, `The paragraph ${q(short(section.text))}`) && greets) greeted = true;
        break;
      }
      case 'keyFigures': {
        const fields = section.fields.map((label) => byLabel.get(norm(label))).filter((f): f is CustomField => !!f && f.type !== 'list');
        if (!fields.length) { note('A summary of key figures was left out: none of its data fields could be added.'); break; }
        // At most three figures side by side; four are shown two and two.
        const perRow = fields.length === 4 ? 2 : 3;
        for (let r = 0; r * perRow < fields.length; r++) {
          const rowId = `figures-${n}${r ? `-${r + 1}` : ''}`;
          const row = defaultNode('container', rowId, 'custom', project);
          if (!insert({ ...row, name: r ? 'Key figures (continued)' : 'Key figures', layout: { paged: { ...row.layout?.paged, mode: 'flow', direction: 'row' }, html: { ...row.layout?.html, direction: 'row' } } }, 'The summary of key figures')) continue;
          const inRow = fields.slice(r * perRow, (r + 1) * perRow);
          inRow.forEach((f, k) => {
            const def = customFieldDefs([f])[0];
            insert({
              ...defaultNode('summary-metric', `figure-${n}-${r * perRow + k + 1}`, 'custom', project), name: f.label, binding: def.path, formatter: defaultFormatterFor(def.type), label: f.label,
              importance: r === 0 && k === 0 ? 'primary' : 'secondary',
              layout: { paged: { mode: 'flow', widthPct: inRow.length === 3 ? 33 : 50, align: 'left', spaceBeforePt: 8 }, html: { area: 'main', span: inRow.length === 3 ? 4 : 6 } },
            }, `The key figure ${q(f.label)}`, rowId);
          });
        }
        break;
      }
      case 'table': {
        const list = byLabel.get(norm(section.list));
        const def = list && list.type === 'list' ? customFieldDefs([list])[0] : undefined;
        if (!list || !def) { note(`The table ${q(section.list)} was left out: its list could not be added.`); break; }
        const all = tableColumnsFor(def);
        const wantedCols = (section.columns ?? []).map((label) => all.find((c) => norm(c.label) === norm(label))).filter((c): c is NonNullable<typeof c> => !!c);
        const columns = (wantedCols.length ? wantedCols : all).map((c) => (section.totalColumn && norm(c.label) === norm(section.totalColumn) && c.format === 'usd-cents' ? { ...c, total: true } : c));
        insert({ ...defaultNode('repeating-table', `table-${n}`, 'custom', project), name: list.label, caption: list.label, binding: def.path, columns }, `The table ${q(list.label)}`);
        break;
      }
      case 'messages': {
        const id = `message-${n}`;
        const { fallbackVariantId: _f, ...base } = defaultNode('variant-set', id, 'custom', project);
        if (!insert({ ...base, name: section.name, variantIds: [] }, `The message ${q(section.name)}`)) break;
        const added: Array<{ variantId: string; version: SetupMessageVersion }> = [];
        section.versions.forEach((version, k) => {
          const variantId = `${id}-v${k + 1}`;
          if (run({ type: 'ADD_VARIANT', nodeId: id, variantId, title: version.title, text: tokens(version.text) }, `The version ${q(version.title)} of ${q(section.name)}`)) added.push({ variantId, version });
        });
        const fallback = added.find((a) => a.version.fallback);
        if (!fallback || !run({ type: 'UPDATE_NODE', nodeId: id, patch: { fallbackVariantId: fallback.variantId } }, `The version of ${q(section.name)} shown when nothing else applies`)) {
          // Without a version to fall back on, some customers would get no message at all: leave the whole message out.
          note(`The message ${q(section.name)} was left out: the version shown when nothing else applies could not be added.`);
          run({ type: 'DELETE_NODE', nodeId: id }, `The message ${q(section.name)}`);
          break;
        }
        // One rule per version with a condition; the first version listed wins when several apply.
        const conditional = added.filter((a) => a !== fallback);
        conditional.forEach((a, k) => {
          const when = a.version.when ? predicateOf(a.version.when, byLabel) : null;
          ruleNo += 1;
          const rule: Rule | null = when && {
            id: `R${String(ruleNo).padStart(2, '0')}`, scope: 'custom', mode: 'exclusive', priority: (conditional.length - k) * 100, when,
            then: { op: 'selectVariant', targetNodeId: id, variantId: a.variantId }, version: 1, exclusiveGroup: id, enabled: true,
            title: `${section.name}: ${a.version.title}`.slice(0, 140),
          };
          if (rule && run({ type: 'UPSERT_RULE', rule }, `The rule for the version ${q(a.version.title)} of ${q(section.name)}`)) return;
          ruleNo -= 1;
          if (!rule) note(`The version ${q(a.version.title)} of ${q(section.name)} was left out: its condition uses a data field that could not be added.`);
          // A version no rule chooses could never be shown.
          run({ type: 'REMOVE_VARIANT', nodeId: id, variantId: a.variantId }, `Removing the version ${q(a.version.title)} of ${q(section.name)}`);
        });
        break;
      }
      case 'notice': {
        notices += 1;
        const id = `notice-${n}`;
        const title = notices === 1 ? 'Notice' : `Notice ${notices}`;
        // The wording first, so the component is inserted with its own text instead of a placeholder.
        if (!run({ type: 'UPSERT_CONTENT_PART', part: { id, version: 1, title, approvedLocales: { 'en-US': tokens(section.text) }, syntheticDemoOnly: true, type: 'disclosure' } }, `The notice ${q(short(section.text))}`)) { notices -= 1; break; }
        insert({ ...defaultNode('disclosure', id, 'custom', project), name: title, contentPartId: id, required: true }, `The notice ${q(short(section.text))}`);
        break;
      }
      case 'action': {
        const base = defaultNode('action-link', `action-${n}`, 'custom', project);
        insert({ ...base, name: section.label, action: { label: section.label, url: section.url, fallbackText: `Visit ${section.url.replace(/^https:\/\//, '')}` } }, `The button ${q(section.label)}`);
        break;
      }
      case 'divider':
        insert(defaultNode('shape', `divider-${n}`, 'custom', project), 'A divider');
        break;
    }
  });

  // Email and SMS wording, on top of the standard wording for a document with its own data.
  if (spec.email || spec.sms) {
    const channels = channelConfig(project);
    const subject = spec.email?.subject ? tokens(spec.email.subject, true) : channels.email.subject;
    const intro = spec.email?.intro ? tokens(spec.email.intro, true) : channels.email.intro;
    // A text message has no page around it to say that this is demonstration data, so the wording itself says it.
    const sms = spec.sms ? (/^DEMO\b/.test(spec.sms) ? tokens(spec.sms, true) : `DEMO {{issuer.name}}: ${tokens(spec.sms, true)}`) : channels.sms.text;
    // Two steps, so that wording the studio refuses for one of them does not cost the other.
    if (spec.email) run({ type: 'SET_CHANNELS', channels: { ...channels, email: { ...channels.email, subject, intro } } }, 'The email wording');
    if (spec.sms) run({ type: 'SET_CHANNELS', channels: { ...channelConfig(project), sms: { text: sms } } }, 'The text message wording');
  }

  for (const p of projectFileProblems(project)) note(p.message);
  // A new document starts at version 1, however many steps it took to build.
  return { project: { ...project, modelVersion: 1 }, notes };
}

function predicateOf(when: SetupCondition, byLabel: Map<string, CustomField>): Predicate | null {
  const f = byLabel.get(norm(when.field));
  if (!f || f.type === 'list') return null;
  let value: Scalar = when.value;
  if (f.type === 'cents') { const c = amountToCents(when.value); if (c === null) return null; value = c; }
  return { op: TEST_OP[when.test], path: `custom.${f.key}`, value };
}

/* ------------------------------------------------------------------ the same description as a schema */

const text = (description: string) => ({ type: 'string', description });
const strings = (description: string) => ({ type: 'array', description, items: { type: 'string' } });
const object = (properties: Record<string, unknown>, description?: string) => ({ type: 'object', ...(description ? { description } : {}), additionalProperties: false, required: Object.keys(properties), properties });

/**
 * The setup as a JSON Schema, for a model that returns one through a strict tool. Every property is required and has
 * a plain type (a strict schema is compiled into a grammar, and optional or either-or properties make that much more
 * costly), so "not given" is an empty text or an empty list, which `checkSetupSpec` reads as absent.
 */
export const SETUP_SPEC_SCHEMA = object({
  title: text('The name of the document, 2 to 80 characters, for example "Membership renewal notice".'),
  issuerName: text('Who the document is from (the organisation). Empty when the description does not say.'),
  accent: text('The issuer colour as #rrggbb, only when the description names a colour. Otherwise empty.'),
  summary: text('One sentence saying what the document is and who gets it.'),
  fields: {
    type: 'array',
    description: 'The data fields: everything that differs from customer to customer. Never the customer’s first name, last name or language, which every customer already has.',
    items: object({
      label: text('The name of the field as a person reads it, for example "Monthly fee". Unique.'),
      type: { type: 'string', enum: SETUP_FIELD_TYPES, description: 'text, number (a whole number), amount (money), date, choice (one of a few fixed values), yesNo, or list (several rows, shown as a table).' },
      choices: strings('For a choice: its values, in lower case where that reads naturally. Empty for every other type.'),
      columns: { type: 'array', description: 'For a list: the columns of each row (1 to 8). Empty for every other type.', items: object({ label: text('The column heading.'), type: { type: 'string', enum: SETUP_COLUMN_TYPES } }) },
      example: text('A typical value: an amount as 49.00, a date as 2026-12-01, yes or no, one of the choices. Empty for a list.'),
      required: { type: 'boolean', description: 'True when every customer must have a value.' },
    }),
  },
  sections: {
    type: 'array',
    description: 'What the document shows, from top to bottom. Each section uses only the properties of its type; the others stay empty.',
    items: object({
      type: { type: 'string', enum: SETUP_SECTION_TYPES, description: 'heading, paragraph, keyFigures (2 to 6 data fields as a summary), table (one list field), messages (wording that differs between customers), notice (required small print), action (a button with an https link) or divider.' },
      text: text('heading, paragraph, notice: the wording. It may mention a data field by its exact label in single braces, such as {Renewal date}, and the customer as {First name} and {Last name}.'),
      fields: strings('keyFigures: the labels of the data fields to show (not lists).'),
      list: text('table: the label of the list field to show.'),
      columns: strings('table: the labels of the columns to show, in order. Empty shows all of them.'),
      totalColumn: text('table: the label of one amount column to sum under the table, or empty.'),
      name: text('messages: a short name for this message, for example "Payment note".'),
      versions: {
        type: 'array',
        description: 'messages: 1 to 6 versions. They are tried in the order given and the first whose condition holds is shown. Exactly one version is the fallback, shown when no other applies.',
        items: object({
          title: text('A short name for the version, for example "Payment failed".'),
          text: text('The wording of this version. It may mention data fields and the customer’s name in single braces.'),
          fallback: { type: 'boolean', description: 'True for the one version shown when no other applies. It has no condition.' },
          when: object({
            field: text('The label of the data field the condition tests (never a list). Empty on the fallback.'),
            test: { type: 'string', enum: SETUP_TESTS, description: 'moreThan, atLeast, lessThan and atMost only for a number, an amount or a date.' },
            value: text('What to compare with, as text: one of the choices, yes or no, a whole number, an amount such as 25 or 25.50, a date as YYYY-MM-DD. Empty on the fallback.'),
          }, 'Who gets this version: one test on one data field.'),
        }),
      },
      label: text('action: the wording on the button.'),
      url: text('action: the web address the button opens. It must start with https://.'),
    }),
  },
  email: object({
    subject: text('The subject line of the email that tells the customer the document is ready. May mention data fields in single braces. Empty to keep the standard wording.'),
    intro: text('One or two opening sentences for that email. Empty to leave it out.'),
  }),
  sms: text('The text message that tells the customer the document is ready, under 160 characters. It may end with {Link}, which becomes the web address of the first button. Empty to keep the standard wording.'),
});
