import type { SetupFieldType } from '@iss/model';
import type { ReadBlock } from './fileReading';

/**
 * Likely personal details in a file the studio read: spans of text that look like one customer's data (a name in the
 * address block or after a salutation, an address, account, policy and reference numbers, amounts, dates, email
 * addresses, phone numbers, long runs of digits). Each mark has a kind and a suggested data field.
 *
 * It MARKS; it does not decide. The marks drive what the person sees ("What was found"), the placeholders that can
 * replace values before anything is sent to a model, and the data fields of the built-in proposal. A person can say a
 * mark is not customer data. Pure and deterministic: no clock, no `Intl`, no network.
 */
export type DetailKind = 'name' | 'address' | 'account' | 'reference' | 'amount' | 'date' | 'email' | 'phone' | 'number';

export const DETAIL_KIND_LABEL: Record<DetailKind, string> = {
  name: 'Name', address: 'Address', account: 'Account number', reference: 'Reference number', amount: 'Amount', date: 'Date', email: 'Email address', phone: 'Phone number', number: 'Long number',
};

export interface DetailMark {
  /** Unique across the samples: `<prefix>m1`, `<prefix>m2`, … */
  id: string;
  blockId: string;
  /** Paragraph, heading, list: the line. Table: the row. */
  line: number;
  /** Table: the column. */
  cell?: number;
  /** The span within that line (or cell). */
  start: number;
  end: number;
  text: string;
  kind: DetailKind;
  /** The data field it suggests, as a person reads it: "Account number", "Amount due", "Customer name". */
  field: string;
  type: Extract<SetupFieldType, 'text' | 'amount' | 'date'>;
  /** What replaces the value when placeholders are chosen: `{{Amount due}}`, or `{{First name}} {{Last name}}` for a name. */
  placeholder: string;
}

/* ------------------------------------------------------------------ patterns */

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DATE_RES = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}[/.]\d{1,2}[/.](?:\d{4}|\d{2})\b/g,
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?\\s+\\d{4}\\b`, 'gi'),
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'gi'),
];
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
/** "Account number: 1234 5678", "Policy no. PX-12345", "Ref: AB/778812". The value has at least three digits. */
const LABELLED_RE = /\b(account|acct|card|loan|policy|reference|ref|customer|member(?:ship)?|invoice|claim|contract|meter|client|patient|order|statement|tax|vat|national id|id)\.?(?:\s+(?:number|no\.?|nr\.?|num\.?|#|id))?\s*[:#.]?\s*((?:\d{2,6}(?: \d{2,6}){1,4})|(?:[A-Z0-9]+[-/])*[A-Z0-9]*\d[A-Z0-9]*(?:[-/][A-Z0-9]+)*)/gi;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){1,3}\b/g;
const PHONE_LABEL = /\b(tel|telephone|phone|mobile|cell|fax|call(?: us)?(?: on| at)?)\b\.?\s*:?\s*$/i;
const AMOUNT_RE = /(?:(?:[$€£¥₹]|\bR(?=\s?\d)|\b(?:USD|EUR|GBP|ZAR|CAD|AUD)\b)\s?-?\d{1,3}(?:[, ]\d{3})*(?:\.\d{1,2})?|-?\b\d{1,3}(?:,\d{3})*\.\d{2}\b)(?:\s?(?:CR|DR)\b)?/g;
const DIGITS_RE = /\b\d(?:[\d -]{5,}\d)\b/g;

const TITLES = /^(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof)\.?$/i;
const NAME_WORD = /^\p{Lu}[\p{L}'’-]+$/u;
const COMPANY = /\b(ltd|limited|inc|llc|plc|corp|corporation|company|co|bank|gym|insurance|group|services|health|care|association|club|society|university|clinic|hospital|council|department|trust|fund|energy|water|telecom|mobile|pty|gmbh|sa|ag)\b\.?/i;
const STREET = /\b(street|st|road|rd|avenue|ave|lane|ln|drive|dr|way|boulevard|blvd|close|court|ct|place|pl|crescent|terrace|square|sq|highway|hwy|parkway|pkwy|suite|apt|apartment|unit|floor|po box|p\.o\. box|private bag)\b\.?/i;
const POSTAL = [/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/, /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/, /^\d{4,5}\s+\p{Lu}/u, /\p{L},?\s+\d{4,5}$/u];
const SALUTATION = /^\s*(?:dear|hello|hi|good (?:morning|afternoon|day|evening))\s+((?:(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof)\.?\s+)?)(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+){0,2})\s*[,!:]?/iu;
const GENERIC_ADDRESSEE = /^(customer|customers|member|members|client|clients|patient|patients|sir|madam|valued|policyholder|policyholders|holder|team|all|friend|friends|colleague|colleagues|reader|subscriber|resident|parent|guardian|applicant|user)$/i;

const NAME_PLACEHOLDER = { full: '{{First name}} {{Last name}}', first: '{{First name}}', last: '{{Last name}}' } as const;

/* ------------------------------------------------------------------ labels */

const clean = (s: string): string => s.replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const sentenceCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
const STOP_WORDS = new Set(['of', 'the', 'a', 'an', 'to', 'for', 'on', 'by', 'is', 'are', 'was', 'be', 'at', 'in', 'your', 'our', 'and', 'or', 'with', 'from', 'before', 'after', 'until', 'than', 'about', 'per', 'as']);

/** The words just before a value that name it: "Amount due: $12.00" → "Amount due". Null when there are none. */
export function labelBefore(line: string, start: number): string | null {
  const before = line.slice(0, start);
  const m = /([\p{L}][\p{L}\p{N}'’ ./&()-]{0,48}?)\s*[:–-]\s*$/u.exec(before) ?? /^\s*([\p{L}][\p{L}\p{N}'’ ./&()-]{0,40}?)\s+$/u.exec(before);
  if (!m) return null;
  // Only the last few words, and only when they read like a label (not the end of a sentence).
  const words = clean(m[1]).split(' ').filter(Boolean);
  const colon = /[:–-]\s*$/.test(before);
  if (!words.length || words.length > 6) return words.length > 6 && colon ? sentenceCase(words.slice(-4).join(' ')) : null;
  // Without a colon, words that run into the value ("your balance of $12") are part of a sentence, not a label.
  if (!colon && (words.length > 4 || STOP_WORDS.has(words[words.length - 1].toLowerCase()))) return null;
  const label = sentenceCase(words.join(' '));
  return label.length >= 2 && label.length <= 40 ? label : null;
}

const LABEL_WORD: Record<string, string> = {
  account: 'Account number', acct: 'Account number', card: 'Card number', loan: 'Loan number', policy: 'Policy number', reference: 'Reference number', ref: 'Reference number',
  customer: 'Customer number', member: 'Member number', membership: 'Membership number', invoice: 'Invoice number', claim: 'Claim number', contract: 'Contract number',
  meter: 'Meter number', client: 'Client number', patient: 'Patient number', order: 'Order number', statement: 'Statement number', tax: 'Tax number', vat: 'VAT number', 'national id': 'National ID', id: 'ID number',
};
const ACCOUNT_WORDS = new Set(['account', 'acct', 'card', 'loan']);
const DEFAULT_FIELD: Record<DetailKind, string> = { name: 'Customer name', address: 'Address', account: 'Account number', reference: 'Reference number', amount: 'Amount', date: 'Date', email: 'Email address', phone: 'Phone number', number: 'Reference number' };
const TYPE_OF: Record<DetailKind, DetailMark['type']> = { name: 'text', address: 'text', account: 'text', reference: 'text', amount: 'amount', date: 'date', email: 'text', phone: 'text', number: 'text' };

/* ------------------------------------------------------------------ marking */

interface Span { start: number; end: number; kind: DetailKind; field: string; placeholder?: string }

function overlaps(spans: Span[], s: number, e: number): boolean { return spans.some((x) => s < x.end && e > x.start); }

function allMatches(re: RegExp, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) { out.push(m); if (m[0].length === 0) g.lastIndex++; }
  return out;
}

/** Marks within one line of text (or one table cell). `header`: the column heading, for a cell. */
function markLine(text: string, header: string | null): Span[] {
  const spans: Span[] = [];
  const add = (start: number, end: number, kind: DetailKind, field?: string | null) => {
    while (end > start && /[\s.,;:)]/.test(text[end - 1])) end--;
    while (start < end && /[\s(]/.test(text[start])) start++;
    if (end <= start || overlaps(spans, start, end)) return;
    spans.push({ start, end, kind, field: field || header || DEFAULT_FIELD[kind] });
  };
  for (const m of allMatches(EMAIL_RE, text)) add(m.index, m.index + m[0].length, 'email', labelBefore(text, m.index));
  for (const m of allMatches(LABELLED_RE, text)) {
    const value = m[2];
    if ((value.match(/\d/g) ?? []).length < 3) continue;
    const word = m[1].toLowerCase().replace(/\.$/, '');
    // A date that happens to follow "Statement" is a date, not a statement number.
    if (DATE_RES.some((re) => new RegExp(`^${re.source}$`, re.flags.replace('g', '')).test(value.trim()))) continue;
    const at = m.index + m[0].length - value.length;
    add(at, at + value.length, ACCOUNT_WORDS.has(word) ? 'account' : 'reference', LABEL_WORD[word] ?? labelBefore(text, at));
  }
  for (const re of DATE_RES) for (const m of allMatches(re, text)) add(m.index, m.index + m[0].length, 'date', labelBefore(text, m.index));
  for (const m of allMatches(PHONE_RE, text)) {
    const digits = (m[0].match(/\d/g) ?? []).length;
    const labelled = PHONE_LABEL.test(text.slice(0, m.index));
    if (digits < 9 || digits > 15 || !(labelled || /^\+|\(/.test(m[0]))) continue;
    add(m.index, m.index + m[0].length, 'phone', labelled ? 'Phone number' : labelBefore(text, m.index));
  }
  for (const m of allMatches(AMOUNT_RE, text)) add(m.index, m.index + m[0].length, 'amount', labelBefore(text, m.index));
  for (const m of allMatches(DIGITS_RE, text)) {
    if ((m[0].match(/\d/g) ?? []).length < 7) continue;
    add(m.index, m.index + m[0].length, 'number', labelBefore(text, m.index));
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** The words of a line that read as a person's name: two to four capitalised words, optionally after a title, no company word. */
function personName(line: string): { start: number; end: number; words: number; titled: boolean } | null {
  const t = line.trim();
  if (!t || t.length > 50 || COMPANY.test(t) || /\d/.test(t)) return null;
  const words = t.split(/\s+/);
  let i = 0;
  const titled = TITLES.test(words[0]);
  if (titled) i = 1;
  const rest = words.slice(i);
  if (rest.length < 1 || rest.length > 4 || (!titled && rest.length < 2)) return null;
  if (!rest.every((w) => NAME_WORD.test(w.replace(/[,.]$/, '')) || /^\p{Lu}\.?$/u.test(w))) return null;
  const lead = line.indexOf(t);
  const start = lead + (titled ? t.indexOf(rest[0]) : 0);
  return { start, end: lead + t.replace(/[,.]$/, '').length, words: rest.length, titled };
}

const isPostal = (l: string) => POSTAL.some((re) => re.test(l.trim()));
const isStreet = (l: string) => /\d/.test(l) && STREET.test(l);

/** The block that is the customer's address: near the top of the first page, a name line followed by address lines. */
function addressBlock(blocks: ReadBlock[]): ReadBlock | null {
  const early = blocks.filter((b) => b.page === 1 && b.kind === 'paragraph').slice(0, 10);
  let fallback: ReadBlock | null = null;
  for (const b of early) {
    const ls = b.lines;
    if (ls.length < 2 || ls.length > 7 || ls.some((l) => l.length > 70)) continue;
    const looksAddress = ls.slice(1).some((l) => isPostal(l) || isStreet(l));
    if (!looksAddress) continue;
    if (personName(ls[0])) return b;
    fallback ??= b;
  }
  return fallback && !COMPANY.test(fallback.lines[0]) ? fallback : null;
}

/**
 * Marks the likely personal details in the blocks of one reading. `prefix` keeps mark ids unique across samples.
 * The same value under the same label is the same field; a label used for different values gets a number ("Date 2").
 */
export function markPersonalDetails(blocks: ReadBlock[], opts: { prefix?: string } = {}): DetailMark[] {
  const prefix = opts.prefix ?? '';
  const out: Array<Omit<DetailMark, 'id' | 'placeholder' | 'type'> & { placeholder?: string }> = [];
  const addr = addressBlock(blocks);
  for (const b of blocks) {
    if (b.kind === 'table') {
      const rows = b.rows ?? [];
      rows.forEach((row, r) => {
        if (b.headerRow && r === 0) return;
        row.forEach((cell, c) => {
          const header = b.headerRow ? clean(rows[0][c] ?? '') || null : null;
          for (const s of markLine(cell, header ? sentenceCase(header) : null)) out.push({ blockId: b.id, line: r, cell: c, start: s.start, end: s.end, text: cell.slice(s.start, s.end), kind: s.kind, field: s.field });
        });
      });
      continue;
    }
    b.lines.forEach((line, li) => {
      const taken: Span[] = [];
      if (b === addr) {
        const firstIsName = !!personName(b.lines[0]);
        const name = li === 0 ? personName(line) : null;
        const t = line.trim();
        // In an address the title goes with the name: it differs from customer to customer too.
        if (name) taken.push({ start: line.indexOf(t), end: name.end, kind: 'name', field: 'Customer name', placeholder: name.words === 1 && name.titled ? NAME_PLACEHOLDER.last : NAME_PLACEHOLDER.full });
        else if (t && !/^(?:tel|phone|email|e-mail|fax)\b/i.test(t)) {
          const start = line.indexOf(t);
          taken.push({ start, end: start + t.length, kind: 'address', field: `Address line ${firstIsName ? li : li + 1}` });
        }
      }
      const sal = SALUTATION.exec(line);
      if (sal && !taken.length) {
        const nameText = sal[2];
        if (!nameText.split(/\s+/).some((w) => GENERIC_ADDRESSEE.test(w)) && !COMPANY.test(nameText)) {
          const start = (sal.index ?? 0) + sal[0].indexOf(nameText, sal[0].indexOf(sal[1]) + sal[1].length);
          const words = nameText.split(/\s+/).length;
          const titled = !!sal[1].trim();
          taken.push({ start, end: start + nameText.length, kind: 'name', field: 'Customer name', placeholder: words > 1 ? NAME_PLACEHOLDER.full : titled ? NAME_PLACEHOLDER.last : NAME_PLACEHOLDER.first });
        }
      }
      const rest = taken.length && taken[0].kind === 'address' ? [] : markLine(line, null).filter((s) => !overlaps(taken, s.start, s.end));
      for (const s of [...taken, ...rest].sort((a, b2) => a.start - b2.start)) out.push({ blockId: b.id, line: li, start: s.start, end: s.end, text: line.slice(s.start, s.end), kind: s.kind, field: s.field, ...(s.placeholder ? { placeholder: s.placeholder } : {}) });
    });
  }

  // One field per label and value; a label used for another value of another kind or value gets a number.
  const byField = new Map<string, { kind: DetailKind; values: Set<string> }>();
  const counts = new Map<string, number>();
  const named = new Map<string, string>();
  const valueKey = (t: string) => t.toLowerCase().replace(/\s+/g, '');
  return out.map((m, i): DetailMark => {
    let field = m.field;
    if (m.kind !== 'name' && m.cell === undefined) {
      const key = `${field.toLowerCase()}|${valueKey(m.text)}`;
      const seen = named.get(key);
      if (seen) field = seen;
      else {
        const base = field.toLowerCase();
        const entry = byField.get(base);
        if (entry) {
          const n = (counts.get(base) ?? 1) + 1;
          counts.set(base, n);
          field = `${field} ${n}`;
        }
        byField.set(base, { kind: m.kind, values: new Set([valueKey(m.text)]) });
        named.set(key, field);
      }
    }
    return { id: `${prefix}m${i + 1}`, blockId: m.blockId, line: m.line, ...(m.cell !== undefined ? { cell: m.cell } : {}), start: m.start, end: m.end, text: m.text, kind: m.kind, field, type: TYPE_OF[m.kind], placeholder: m.placeholder ?? `{{${field}}}` };
  });
}

/**
 * One line (or cell) with the given marks replaced. `as`: what replaces each mark (its placeholder by default).
 * Marks must belong to that line; overlapping marks never occur (the marker does not produce them).
 */
export function replaceMarks(text: string, marks: DetailMark[], as: (m: DetailMark) => string = (m) => m.placeholder): string {
  let out = '';
  let at = 0;
  for (const m of [...marks].sort((a, b) => a.start - b.start)) {
    if (m.start < at) continue;
    out += text.slice(at, m.start) + as(m);
    at = m.end;
  }
  return out + text.slice(at);
}

/** The marks of one line of one block (or one cell of a table row). */
export function marksAt(marks: DetailMark[], blockId: string, line: number, cell?: number): DetailMark[] {
  return marks.filter((m) => m.blockId === blockId && m.line === line && m.cell === cell);
}
