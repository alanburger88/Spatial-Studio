import { checkExpr, exprChildren, type ExprScope } from './expressions';
import type { FieldDef } from './fields';
import type { ComparisonOp, Expr, Predicate, Scalar } from './types';

/**
 * The formula view of a calculation: a spreadsheet-style line such as `=DAYS(card.dueDate, ISSUE_DATE())`.
 * `parseFormula` reads it into the same tree the builder edits and `printFormula` writes the tree back, so the views
 * never disagree: parse(print(x)) gives x again. A mistake is reported with where it is (character offsets) and what
 * is wrong, in plain words. The language has the functions in `FORMULA_FUNCTIONS` and nothing else.
 */

export interface FormulaFunction {
  name: string;
  /** For auto-complete: `DAYS(from, to)`. */
  signature: string;
  /** What it gives: number, amount, date, text, yes or no, or "the same as its values". */
  gives: string;
  /** One line in plain words. */
  words: string;
  example: string;
}

/** Every function of the formula language, for auto-complete and help. */
export const FORMULA_FUNCTIONS: readonly FormulaFunction[] = [
  { name: 'ISSUE_DATE', signature: 'ISSUE_DATE()', gives: 'date', words: 'The document’s date.', example: '=DAYS(card.dueDate, ISSUE_DATE())' },
  { name: 'DATE', signature: 'DATE("YYYY-MM-DD")', gives: 'date', words: 'A fixed date.', example: '=DATE("2027-01-01")' },
  { name: 'ROUND', signature: 'ROUND(value, places)', gives: 'the same as its value', words: 'Rounds half away from zero. For an amount, 2 places is to the cent and 0 to the dollar.', example: '=ROUND(card.newBalanceCents * 0.02, 2)' },
  { name: 'MIN', signature: 'MIN(value, value, …)', gives: 'the same as its values', words: 'The smallest of two or more numbers or amounts.', example: '=MIN(card.minimumDueCents, $25.00)' },
  { name: 'MAX', signature: 'MAX(value, value, …)', gives: 'the same as its values', words: 'The largest of two or more numbers or amounts.', example: '=MAX(card.minimumDueCents, $25.00)' },
  { name: 'ABS', signature: 'ABS(value)', gives: 'the same as its value', words: 'The value without its sign.', example: '=ABS(card.paymentsCreditsCents)' },
  { name: 'DAYS', signature: 'DAYS(from, to)', gives: 'number', words: 'The number of days from one date to another (negative when the second is earlier).', example: '=DAYS(ISSUE_DATE(), card.dueDate)' },
  { name: 'ADD_DAYS', signature: 'ADD_DAYS(date, days)', gives: 'date', words: 'A date moved by a number of days (a negative number moves it earlier).', example: '=ADD_DAYS(card.dueDate, -7)' },
  { name: 'EARLIER', signature: 'EARLIER(date, date)', gives: 'date', words: 'The earlier of two dates.', example: '=EARLIER(card.dueDate, ISSUE_DATE())' },
  { name: 'LATER', signature: 'LATER(date, date)', gives: 'date', words: 'The later of two dates.', example: '=LATER(card.dueDate, ISSUE_DATE())' },
  { name: 'JOIN', signature: 'JOIN("between", part, part, …)', gives: 'text', words: 'Puts text together with fixed text between the parts.', example: '=JOIN(" ", customer.givenName, customer.familyName)' },
  { name: 'COUNT', signature: 'COUNT(list WHERE condition)', gives: 'number', words: 'The number of rows of a list, optionally only those that meet a condition.', example: '=COUNT(card.transactions WHERE amountCents > $100.00)' },
  { name: 'SUM', signature: 'SUM(list.column WHERE condition)', gives: 'the same as the column', words: 'The total of a column of a list, optionally only rows that meet a condition.', example: '=SUM(custom.sessions.priceCents WHERE className = "Spin")' },
  { name: 'SMALLEST', signature: 'SMALLEST(list.column WHERE condition)', gives: 'the same as the column', words: 'The smallest value in a column of a list.', example: '=SMALLEST(card.transactions.date)' },
  { name: 'LARGEST', signature: 'LARGEST(list.column WHERE condition)', gives: 'the same as the column', words: 'The largest value in a column of a list.', example: '=LARGEST(card.transactions.amountCents)' },
  { name: 'IF', signature: 'IF(condition, then, otherwise)', gives: 'the same as its results', words: 'One value when a condition holds, another when it does not.', example: '=IF(card.missedPayments >= 2, "Support", "Reminder")' },
  { name: 'LOOKUP', signature: 'LOOKUP("table", "column", key, …)', gives: 'the column’s kind', words: 'A value from a lookup table, found by one value per key column.', example: '=LOOKUP("feeByTier", "monthlyFee", card.tier)' },
] as const;

/** Words of a condition (`AND`, `OR`, `NOT(…)`, `IN (…)`, `IS EMPTY`, `IS PRESENT`) and the comparison signs, for auto-complete. */
export const FORMULA_CONDITION_WORDS = ['AND', 'OR', 'NOT', 'IN', 'IS EMPTY', 'IS PRESENT', 'WHERE', 'TRUE', 'FALSE', 'NULL'] as const;
export const FORMULA_COMPARISONS: Record<ComparisonOp, string> = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** A mistake in a formula: what is wrong, and where (character offsets into the text, end excluded). */
export interface FormulaError { message: string; start: number; end: number }

export type ParsedFormula =
  | { ok: true; expr: Expr; /** Where each node is in the text, by slot path (see `exprChildren`; '' is the whole formula). */ spans: Record<string, [number, number]> }
  | { ok: false; error: FormulaError };

/* ------------------------------------------------------------------ tokens */

type TokKind = 'num' | 'money' | 'str' | 'ident' | 'path' | 'op' | 'lp' | 'rp' | 'comma' | 'eof';
interface Tok { kind: TokKind; text: string; start: number; end: number; value?: number | string }

class Fail extends Error { constructor(readonly error: FormulaError) { super(error.message); } }
const fail = (message: string, start: number, end: number): never => { throw new Fail({ message, start, end: Math.max(end, start + 1) }); };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const start = i;
    if (ch === '"') {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) fail('This text has no closing quote ("). Add one where the text ends.', start, src.length);
        if (src[i] === '"') { if (src[i + 1] === '"') { s += '"'; i += 2; continue; } i++; break; }
        s += src[i++];
      }
      toks.push({ kind: 'str', text: src.slice(start, i), start, end: i, value: s });
      continue;
    }
    if (ch === '$') {
      const m = /^\$(\d+)(?:\.(\d+))?/.exec(src.slice(i));
      if (!m) fail('An amount is written like $12.50: a dollar sign, then digits.', start, i + 1);
      if ((m![2] ?? '').length > 2) fail('An amount has at most two digits after the point (cents).', start, start + m![0].length);
      const cents = Number(m![1]) * 100 + Number((m![2] ?? '').padEnd(2, '0') || 0);
      if (!Number.isSafeInteger(cents)) fail('This amount is too large.', start, start + m![0].length);
      i += m![0].length;
      toks.push({ kind: 'money', text: m![0], start, end: i, value: cents });
      continue;
    }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      i += m[0].length;
      if (/[A-Za-z_]/.test(src[i] ?? '')) fail('A number cannot run straight into letters.', start, i + 1);
      toks.push({ kind: 'num', text: m[0], start, end: i, value: Number(m[0]) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))!;
      i += m[0].length;
      if (src[i] === '.') fail('A field name cannot end with a dot.', i, i + 1);
      toks.push({ kind: m[0].includes('.') ? 'path' : 'ident', text: m[0], start, end: i });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '<>', '!='].includes(two)) { toks.push({ kind: 'op', text: two === '!=' ? '<>' : two, start, end: i + 2 }); i += 2; continue; }
    if ('+-*/=<>≠≤≥'.includes(ch)) { toks.push({ kind: 'op', text: ch === '≠' ? '<>' : ch === '≤' ? '<=' : ch === '≥' ? '>=' : ch, start, end: i + 1 }); i++; continue; }
    if (ch === '(') { toks.push({ kind: 'lp', text: ch, start, end: i + 1 }); i++; continue; }
    if (ch === ')') { toks.push({ kind: 'rp', text: ch, start, end: i + 1 }); i++; continue; }
    if (ch === ',') { toks.push({ kind: 'comma', text: ch, start, end: i + 1 }); i++; continue; }
    fail(`“${ch}” cannot be used in a formula.`, start, start + 1);
  }
  toks.push({ kind: 'eof', text: '', start: src.length, end: src.length });
  return toks;
}

/* ------------------------------------------------------------------ parser */

// Built on first use, not when the module loads, so a bundle that never parses a formula can leave the parser out.
let functionNames: Set<string> | null = null;
const FUNCTION_NAMES = (): Set<string> => (functionNames ??= new Set(FORMULA_FUNCTIONS.map((f) => f.name)));
const KEYWORDS: ReadonlySet<string> = /* @__PURE__ */ new Set(['AND', 'OR', 'NOT', 'IN', 'IS', 'EMPTY', 'PRESENT', 'WHERE', 'TRUE', 'FALSE', 'NULL']);
const COMPARE: Record<string, ComparisonOp> = { '=': 'eq', '<>': 'ne', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' };
const describe = (t: Tok): string => (t.kind === 'eof' ? 'the end of the formula' : `“${t.text}”`);

class Parser {
  private i = 0;
  readonly spans = new Map<Expr, [number, number]>();
  constructor(private toks: Tok[]) {}
  private peek(k = 0): Tok { return this.toks[Math.min(this.i + k, this.toks.length - 1)]; }
  private next(): Tok { return this.toks[this.i++] ?? this.toks[this.toks.length - 1]; }
  private isWord(t: Tok, w: string): boolean { return t.kind === 'ident' && t.text.toUpperCase() === w; }
  private expect(kind: TokKind, what: string): Tok {
    const t = this.peek();
    if (t.kind !== kind) fail(`Expected ${what} here, found ${describe(t)}.`, t.start, t.end);
    return this.next();
  }
  private mark<T extends Expr>(e: T, start: number): T { this.spans.set(e, [start, this.toks[this.i - 1].end]); return e; }

  formula(): Expr {
    if (this.peek().kind === 'op' && this.peek().text === '=') this.next();
    if (this.peek().kind === 'eof') fail('The formula is empty. Start with a field, a number or a function such as DAYS(…).', this.peek().start, this.peek().end);
    const e = this.expr();
    const t = this.peek();
    if (t.kind !== 'eof') fail(t.kind === 'rp' ? 'There is a closing bracket “)” with no opening bracket.' : `Expected an operator such as + or *, or the end of the formula, but found ${describe(t)}.`, t.start, t.end);
    return e;
  }

  expr(): Expr {
    const start = this.peek().start;
    let left = this.term();
    while (this.peek().kind === 'op' && (this.peek().text === '+' || this.peek().text === '-')) {
      const op = this.next().text === '+' ? 'add' : 'sub';
      const right = this.term();
      left = this.mark({ op, a: left, b: right }, start);
    }
    return left;
  }

  term(): Expr {
    const start = this.peek().start;
    let left = this.unary();
    while (this.peek().kind === 'op' && (this.peek().text === '*' || this.peek().text === '/')) {
      const op = this.next().text === '*' ? 'mul' : 'div';
      const right = this.unary();
      left = this.mark({ op, a: left, b: right }, start);
    }
    return left;
  }

  unary(): Expr {
    const t = this.peek();
    if (t.kind === 'op' && t.text === '-') {
      this.next();
      const n = this.peek();
      if (n.kind === 'num') { this.next(); return this.mark({ op: 'number', value: -(n.value as number) }, t.start); }
      if (n.kind === 'money') { this.next(); return this.mark({ op: 'money', cents: -(n.value as number) }, t.start); }
      fail('A minus sign in front works only on a number or an amount. To change the sign of a value, write 0 - value, or use ABS.', t.start, n.end);
    }
    return this.primary();
  }

  primary(): Expr {
    const t = this.peek();
    const start = t.start;
    switch (t.kind) {
      case 'num': this.next(); return this.mark({ op: 'number', value: t.value as number }, start);
      case 'money': this.next(); return this.mark({ op: 'money', cents: t.value as number }, start);
      case 'str': this.next(); return this.mark({ op: 'text', value: t.value as string }, start);
      case 'lp': {
        this.next();
        const e = this.expr();
        this.expect('rp', 'a closing bracket “)”');
        return e;
      }
      case 'path': this.next(); return this.mark({ op: 'field', path: t.text }, start);
      case 'ident': {
        const upper = t.text.toUpperCase();
        if (upper === 'TRUE' || upper === 'FALSE') { this.next(); return this.mark({ op: 'bool', value: upper === 'TRUE' }, start); }
        if (this.peek(1).kind === 'lp') return this.call();
        if (KEYWORDS.has(upper)) fail(`“${t.text}” belongs in a condition, inside IF(…) or after WHERE.`, t.start, t.end);
        this.next();
        return this.mark({ op: 'field', path: t.text }, start);
      }
      case 'eof': return fail('The formula ends too early: a value is missing here.', t.start, t.end);
      case 'rp': return fail('A value is missing before this closing bracket.', t.start, t.end);
      case 'comma': return fail('A value is missing before this comma.', t.start, t.end);
      default: return fail(`Expected a value (a field, a number, an amount, text or a function), found ${describe(t)}.`, t.start, t.end);
    }
  }

  call(): Expr {
    const nameTok = this.next();
    const start = nameTok.start;
    const name = nameTok.text.toUpperCase();
    if (!FUNCTION_NAMES().has(name)) fail(`“${nameTok.text}” is not a function. The functions are ${[...FUNCTION_NAMES()].join(', ')}.`, nameTok.start, nameTok.end);
    this.expect('lp', `an opening bracket “(” after ${name}`);
    const close = (): void => { const t = this.peek(); if (t.kind !== 'rp') fail(t.kind === 'comma' ? `${name} has too many values here.` : `Expected a closing bracket “)” to end ${name}(…), found ${describe(t)}.`, t.start, t.end); this.next(); };
    const comma = (): void => { const t = this.peek(); if (t.kind !== 'comma') fail(t.kind === 'rp' ? `${name} needs more values. It is written ${FORMULA_FUNCTIONS.find((f) => f.name === name)!.signature}.` : `Expected a comma “,” here, found ${describe(t)}.`, t.start, t.end); this.next(); };
    const list = (): Expr[] => { const out = [this.expr()]; while (this.peek().kind === 'comma') { this.next(); out.push(this.expr()); } return out; };
    const str = (what: string): string => { const t = this.peek(); if (t.kind !== 'str') fail(`Expected ${what} in quotes here, found ${describe(t)}.`, t.start, t.end); this.next(); return t.value as string; };
    const integer = (what: string): number => {
      const t = this.peek();
      let sign = 1;
      if (t.kind === 'op' && t.text === '-') { this.next(); sign = -1; }
      const n = this.peek();
      if (n.kind !== 'num' || !Number.isInteger(n.value)) fail(`Expected ${what} (a whole number) here, found ${describe(n)}.`, n.start, n.end);
      this.next();
      return sign * (n.value as number);
    };
    let e: Expr;
    switch (name) {
      case 'ISSUE_DATE': close(); e = { op: 'issueDate' }; break;
      case 'DATE': { const s = str('a date such as "2027-01-31"'); close(); e = { op: 'date', value: s }; break; }
      case 'ROUND': { const a = this.expr(); comma(); const p = integer('the number of places'); close(); e = { op: 'round', arg: a, places: p }; break; }
      case 'MIN': case 'MAX': { const a = list(); close(); e = { op: name === 'MIN' ? 'min' : 'max', args: a }; break; }
      case 'ABS': { const a = this.expr(); close(); e = { op: 'abs', arg: a }; break; }
      case 'DAYS': { const a = this.expr(); comma(); const b = this.expr(); close(); e = { op: 'days', from: a, to: b }; break; }
      case 'ADD_DAYS': { const a = this.expr(); comma(); const b = this.expr(); close(); e = { op: 'addDays', date: a, days: b }; break; }
      case 'EARLIER': case 'LATER': { const a = this.expr(); comma(); const b = this.expr(); close(); e = { op: name === 'EARLIER' ? 'earlier' : 'later', a, b }; break; }
      case 'JOIN': { const sep = str('the text that goes between the parts'); comma(); const parts = list(); close(); e = { op: 'join', sep, parts }; break; }
      case 'COUNT': case 'SUM': case 'SMALLEST': case 'LARGEST': {
        const t = this.peek();
        if (t.kind !== 'path' && t.kind !== 'ident') fail(name === 'COUNT' ? 'COUNT needs a list, such as card.transactions.' : `${name} needs a column of a list, such as card.transactions.amountCents.`, t.start, t.end);
        this.next();
        let where: Predicate | undefined;
        if (this.isWord(this.peek(), 'WHERE')) { this.next(); where = this.condition(); }
        close();
        if (name === 'COUNT') e = { op: 'count', list: t.text, ...(where ? { where } : {}) };
        else {
          const dot = t.text.lastIndexOf('.');
          if (dot < 0) fail(`${name} needs a column of a list, written list.column (for example card.transactions.amountCents).`, t.start, t.end);
          e = { op: name === 'SUM' ? 'sum' : name === 'SMALLEST' ? 'smallest' : 'largest', list: t.text.slice(0, dot), column: t.text.slice(dot + 1), ...(where ? { where } : {}) };
        }
        break;
      }
      case 'IF': { const c = this.condition(); comma(); const a = this.expr(); comma(); const b = this.expr(); close(); e = { op: 'if', when: c, then: a, else: b }; break; }
      case 'LOOKUP': { const table = str('the table’s id'); comma(); const column = str('the column’s key'); comma(); const keys = list(); close(); e = { op: 'lookup', table, column, keys }; break; }
      default: return fail(`“${nameTok.text}” is not a function.`, nameTok.start, nameTok.end);
    }
    return this.mark(e, start);
  }

  /* conditions (the rule conditions the studio already has) */

  condition(): Predicate {
    const first = this.andCond();
    if (!this.isWord(this.peek(), 'OR')) return first;
    const args = [first];
    while (this.isWord(this.peek(), 'OR')) { this.next(); args.push(this.andCond()); }
    return { op: 'or', args };
  }

  andCond(): Predicate {
    const first = this.notCond();
    if (!this.isWord(this.peek(), 'AND')) return first;
    const args = [first];
    while (this.isWord(this.peek(), 'AND')) { this.next(); args.push(this.notCond()); }
    return { op: 'and', args };
  }

  notCond(): Predicate {
    const t = this.peek();
    const word = t.kind === 'ident' ? t.text.toUpperCase() : '';
    if ((word === 'NOT' || word === 'AND' || word === 'OR') && this.peek(1).kind === 'lp') {
      this.next(); this.next();
      if (word === 'NOT') { const c = this.condition(); this.expect('rp', 'a closing bracket “)” to end NOT(…)'); return { op: 'not', arg: c }; }
      const args: Predicate[] = [];
      if (this.peek().kind !== 'rp') { args.push(this.condition()); while (this.peek().kind === 'comma') { this.next(); args.push(this.condition()); } }
      this.expect('rp', `a closing bracket “)” to end ${word}(…)`);
      return { op: word === 'AND' ? 'and' : 'or', args };
    }
    if (t.kind === 'lp') { this.next(); const c = this.condition(); this.expect('rp', 'a closing bracket “)”'); return c; }
    return this.comparison();
  }

  comparison(): Predicate {
    const t = this.peek();
    if (t.kind !== 'path' && !(t.kind === 'ident' && !KEYWORDS.has(t.text.toUpperCase()) && this.peek(1).kind !== 'lp')) fail(`A condition starts with a field, for example card.missedPayments >= 2. Found ${describe(t)}.`, t.start, t.end);
    this.next();
    const path = t.text;
    const op = this.peek();
    if (this.isWord(op, 'IS')) {
      this.next();
      const w = this.peek();
      if (this.isWord(w, 'EMPTY')) { this.next(); return { op: 'isNull', path }; }
      if (this.isWord(w, 'PRESENT')) { this.next(); return { op: 'notNull', path }; }
      return fail('After IS write EMPTY or PRESENT.', w.start, w.end);
    }
    if (this.isWord(op, 'IN')) {
      this.next();
      this.expect('lp', 'an opening bracket “(” after IN');
      const values: Scalar[] = [];
      if (this.peek().kind !== 'rp') { values.push(this.scalar()); while (this.peek().kind === 'comma') { this.next(); values.push(this.scalar()); } }
      this.expect('rp', 'a closing bracket “)” to end the list');
      return { op: 'in', path, value: values };
    }
    if (op.kind !== 'op' || !(op.text in COMPARE)) return fail(`Expected a comparison (=, <>, >, >=, <, <=), IN (…) or IS EMPTY after ${path}, found ${describe(op)}.`, op.start, op.end);
    this.next();
    return { op: COMPARE[op.text], path, value: this.scalar() } as Predicate;
  }

  scalar(): Scalar {
    const t = this.peek();
    if (t.kind === 'op' && t.text === '-') {
      this.next();
      const n = this.peek();
      if (n.kind === 'num' || n.kind === 'money') { this.next(); return -(n.value as number); }
      return fail('Expected a number after the minus sign.', n.start, n.end);
    }
    if (t.kind === 'num' || t.kind === 'money') { this.next(); return t.value as number; }
    if (t.kind === 'str') { this.next(); return t.value as string; }
    if (t.kind === 'ident') {
      const w = t.text.toUpperCase();
      if (w === 'TRUE' || w === 'FALSE') { this.next(); return w === 'TRUE'; }
      if (w === 'NULL') { this.next(); return null; }
      if (w === 'DATE' && this.peek(1).kind === 'lp') {
        this.next(); this.next();
        const s = this.peek();
        if (s.kind !== 'str') fail('Expected a date in quotes, such as DATE("2027-01-31").', s.start, s.end);
        this.next();
        this.expect('rp', 'a closing bracket “)” to end DATE(…)');
        return s.value as string;
      }
    }
    return fail(`Expected a value to compare with (a number, an amount, text in quotes, TRUE, FALSE or DATE("…")), found ${describe(t)}.`, t.start, t.end);
  }
}

/** Reads a formula. The leading `=` is optional. */
export function parseFormula(text: string): ParsedFormula {
  if (typeof text !== 'string') return { ok: false, error: { message: 'The formula must be text.', start: 0, end: 0 } };
  if (text.length > 4000) return { ok: false, error: { message: 'A formula is limited to 4,000 characters.', start: 4000, end: text.length } };
  try {
    const p = new Parser(tokenize(text));
    const expr = p.formula();
    const spans: Record<string, [number, number]> = {};
    const walk = (e: Expr, at: string) => {
      const s = p.spans.get(e);
      if (s) spans[at] = s;
      for (const [slot, c] of exprChildren(e)) walk(c, at ? `${at}.${slot}` : slot);
    };
    walk(expr, '');
    return { ok: true, expr, spans };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: e.error };
    return { ok: false, error: { message: 'The formula could not be read.', start: 0, end: text.length } };
  }
}

/**
 * Reads a formula and checks it against the project (fields, lookup tables, kinds of value): the one call the formula
 * view needs. Every mistake comes with where it is.
 */
export function checkFormula(text: string, scope: ExprScope): { ok: true; expr: Expr; type: NonNullable<ReturnType<typeof checkExpr>['type']>; spans: Record<string, [number, number]> } | { ok: false; errors: FormulaError[]; expr?: Expr } {
  const parsed = parseFormula(text);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  const { type, problems } = checkExpr(parsed.expr, scope);
  if (!problems.length && type) return { ok: true, expr: parsed.expr, type, spans: parsed.spans };
  const errors = problems.map((p) => {
    // The closest node that has a place in the text.
    let at = p.at;
    while (at && !parsed.spans[at]) at = at.includes('.') ? at.slice(0, at.lastIndexOf('.')).replace(/\.(args|parts|keys)$/, '') : '';
    const [start, end] = parsed.spans[at] ?? [0, text.length];
    return { message: p.message, start, end };
  });
  return { ok: false, errors, expr: parsed.expr };
}

/* ------------------------------------------------------------------ printer */

const PREC: Partial<Record<Expr['op'], number>> = { add: 1, sub: 1, mul: 2, div: 2 };

const printNumber = (v: number): string => (Object.is(v, -0) ? '-0' : String(v));
const printMoney = (cents: number): string => {
  const neg = cents < 0 || Object.is(cents, -0);
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};
const printText = (s: string): string => `"${s.replace(/"/g, '""')}"`;

function printScalar(v: Scalar, f: FieldDef | undefined): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return f?.type === 'cents' && Number.isSafeInteger(v) && !Object.is(v, -0) ? printMoney(v) : printNumber(v);
  return f?.type === 'date' ? `DATE(${printText(v)})` : printText(v);
}

/** Writes a condition in the formula language. `fields` (optional) prints amounts as $… and dates as DATE("…"). */
export function printCondition(p: Predicate, fields?: ReadonlyMap<string, FieldDef>, inside: 'and' | 'or' | null = null): string {
  switch (p.op) {
    case 'and': case 'or': {
      const word = p.op.toUpperCase();
      if (p.args.length < 2) return `${word}(${p.args.map((a) => printCondition(a, fields)).join(', ')})`;
      const body = p.args.map((a) => printCondition(a, fields, p.op as 'and' | 'or')).join(` ${word} `);
      // An AND inside an OR needs no brackets; anything else nested keeps its own.
      return inside && !(inside === 'or' && p.op === 'and') ? `(${body})` : body;
    }
    case 'not': return `NOT(${printCondition(p.arg, fields)})`;
    case 'isNull': return `${p.path} IS EMPTY`;
    case 'notNull': return `${p.path} IS PRESENT`;
    case 'in': return `${p.path} IN (${p.value.map((v) => printScalar(v, fields?.get(p.path))).join(', ')})`;
    default: return `${p.path} ${FORMULA_COMPARISONS[p.op]} ${printScalar(p.value, fields?.get(p.path))}`;
  }
}

/**
 * Writes a calculation as a formula (with the leading `=`). `fields` (optional, the project's fields) only changes how
 * values in conditions are written ($ amounts, DATE("…")), never what they mean.
 */
export function printFormula(e: Expr, fields?: ReadonlyMap<string, FieldDef>): string {
  return `=${printExpr(e, fields)}`;
}

function rowFields(fields: ReadonlyMap<string, FieldDef> | undefined, list: string): Map<string, FieldDef> | undefined {
  const f = fields?.get(list);
  return f?.itemFields ? new Map(f.itemFields.map((c) => [c.key, { path: c.key, type: c.type, label: c.label } as FieldDef])) : undefined;
}

export function printExpr(e: Expr, fields?: ReadonlyMap<string, FieldDef>): string {
  const p = (x: Expr) => printExpr(x, fields);
  switch (e.op) {
    case 'field': return e.path;
    case 'number': return printNumber(e.value);
    case 'money': return printMoney(e.cents);
    case 'text': return printText(e.value);
    case 'date': return `DATE(${printText(e.value)})`;
    case 'bool': return e.value ? 'TRUE' : 'FALSE';
    case 'issueDate': return 'ISSUE_DATE()';
    case 'add': case 'sub': case 'mul': case 'div': {
      const prec = PREC[e.op]!;
      const sym = { add: '+', sub: '-', mul: '*', div: '/' }[e.op];
      const left = PREC[e.a.op] !== undefined && PREC[e.a.op]! < prec ? `(${p(e.a)})` : p(e.a);
      // The right side keeps its brackets at the same level too: a - (b - c), a / (b * c).
      const right = PREC[e.b.op] !== undefined && PREC[e.b.op]! <= prec ? `(${p(e.b)})` : p(e.b);
      return `${left} ${sym} ${right}`;
    }
    case 'round': return `ROUND(${p(e.arg)}, ${e.places})`;
    case 'min': case 'max': return `${e.op.toUpperCase()}(${e.args.map(p).join(', ')})`;
    case 'abs': return `ABS(${p(e.arg)})`;
    case 'days': return `DAYS(${p(e.from)}, ${p(e.to)})`;
    case 'addDays': return `ADD_DAYS(${p(e.date)}, ${p(e.days)})`;
    case 'earlier': case 'later': return `${e.op.toUpperCase()}(${p(e.a)}, ${p(e.b)})`;
    case 'join': return `JOIN(${printText(e.sep)}, ${e.parts.map(p).join(', ')})`;
    case 'count': return `COUNT(${e.list}${e.where ? ` WHERE ${printCondition(e.where, rowFields(fields, e.list))}` : ''})`;
    case 'sum': case 'smallest': case 'largest': return `${e.op.toUpperCase()}(${e.list}.${e.column}${e.where ? ` WHERE ${printCondition(e.where, rowFields(fields, e.list))}` : ''})`;
    case 'if': return `IF(${printCondition(e.when, fields)}, ${p(e.then)}, ${p(e.else)})`;
    case 'lookup': return `LOOKUP(${printText(e.table)}, ${printText(e.column)}, ${e.keys.map(p).join(', ')})`;
  }
}
