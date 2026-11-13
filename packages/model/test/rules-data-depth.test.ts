import { describe, expect, it } from 'vitest';
import {
  addDaysToIso, applyCommand, buildContext, calcOrder, checkExpr, checkFormula, dayFromNumber, dayNumber, daysBetweenIso, dayWords, diffProjects, evaluateCalculations,
  evaluateSteps, exprScopeOf, FORMULA_FUNCTIONS, formulaInWords, isIsoDay, LOOKUP_TABLE_MAX_ROWS, lookupRowFor, lookupTableProblems, parseFormula, parseLookupPaste,
  printFormula, projectFieldIndex, projectFields, projectFileProblems, roundHalfUp, templateContentOf, validateCalculatedFields, validateLookupTable, wordsScopeOf,
  type CalculatedField, type Command, type Expr, type LookupTable, type Predicate, type Project,
} from '../src';
import { gymMember, gymProject, run } from './helpers/customProject';
import { DEPTH_CALCS, FEE_BY_TIER, RATES, depthProject } from './helpers/depthProject';

const reject = (p: Project, c: Command): string => { const r = applyCommand(p, c); if (r.ok) throw new Error(`${c.type} was accepted`); return r.message; };
const f = (path: string): Expr => ({ op: 'field', path });
const n = (value: number): Expr => ({ op: 'number', value });
const m = (cents: number): Expr => ({ op: 'money', cents });

/** Works out one expression for the gym member, with the depth project's tables and the given document date. */
function value(expr: Expr, opts: { custom?: Record<string, unknown>; date?: string | null; type?: CalculatedField['type'] } = {}) {
  const p = depthProject();
  const project = { ...p, calculatedFields: [...p.calculatedFields!, { key: 'probe', label: 'Probe', type: opts.type ?? 'number', expr }] };
  const ctx = buildContext(gymMember({ custom: opts.custom })) as Record<string, unknown>;
  const r = evaluateCalculations(project, ctx, opts.date === undefined ? '2026-11-25' : opts.date);
  return { value: r.values.probe, missing: r.missing.probe };
}

describe('calendar days without a clock', () => {
  it('counts days exactly, across leap years and centuries', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayFromNumber(dayNumber('2024-02-29'))).toBe('2024-02-29');
    for (let d = -200000; d < 200000; d += 997) expect(dayNumber(dayFromNumber(d))).toBe(d);
    expect(daysBetweenIso('2026-11-25', '2026-12-01')).toBe(6);
    expect(daysBetweenIso('2027-01-01', '2026-12-25')).toBe(-7);
    expect(addDaysToIso('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDaysToIso('2100-02-28', 1)).toBe('2100-03-01');
    expect(addDaysToIso('2000-02-28', 1)).toBe('2000-02-29');
    expect(isIsoDay('2026-02-29')).toBe(false);
    expect(isIsoDay('2026-13-01')).toBe(false);
    expect(isIsoDay('2026-1-01')).toBe(false);
    expect(isIsoDay('2026-01-01T00:00')).toBe(false);
    expect(dayWords('2027-01-01')).toBe('1 Jan 2027');
  });
});

describe('the evaluator', () => {
  it('adds, subtracts, multiplies and divides numbers and amounts in whole cents', () => {
    expect(value({ op: 'add', a: n(2), b: n(3) }).value).toBe(5);
    expect(value({ op: 'sub', a: m(1000), b: f('custom.monthlyFeeCents') }, { type: 'money' }).value).toBe(-3900);
    expect(value({ op: 'mul', a: f('custom.monthlyFeeCents'), b: n(3) }, { type: 'money' }).value).toBe(14700);
    expect(value({ op: 'div', a: n(7), b: n(2) }).value).toBe(3.5);
    expect(value({ op: 'div', a: m(1000), b: m(400) }).value).toBe(2.5);
    expect(value({ op: 'round', places: 2, arg: { op: 'mul', a: f('custom.monthlyFeeCents'), b: n(0.0333) } }, { type: 'money' }).value).toBe(163);
  });
  it('rounds half away from zero, to the stated places, for numbers and amounts', () => {
    expect(roundHalfUp(2.5, 0)).toBe(3);
    expect(roundHalfUp(-2.5, 0)).toBe(-3);
    expect(roundHalfUp(1.005, 2)).toBe(1.01);
    expect(roundHalfUp(0.125, 2)).toBe(0.13);
    expect(value({ op: 'round', places: 1, arg: n(2.25) }).value).toBe(2.3);
    // amounts: 2 places is to the cent, 1 to ten cents, 0 to the dollar
    const third = { op: 'div', a: m(1000), b: n(3) } as Expr;
    expect(value({ op: 'round', places: 2, arg: third }, { type: 'money' }).value).toBe(333);
    expect(value({ op: 'round', places: 1, arg: third }, { type: 'money' }).value).toBe(330);
    expect(value({ op: 'round', places: 0, arg: third }, { type: 'money' }).value).toBe(300);
    expect(value({ op: 'round', places: 0, arg: { op: 'div', a: m(-150), b: n(1) } }, { type: 'money' }).value).toBe(-200);
  });
  it('smallest, largest, absolute, dates and text', () => {
    expect(value({ op: 'min', args: [n(4), n(-2), n(9)] }).value).toBe(-2);
    expect(value({ op: 'max', args: [m(100), f('custom.monthlyFeeCents')] }, { type: 'money' }).value).toBe(4900);
    expect(value({ op: 'abs', arg: n(-7) }).value).toBe(7);
    expect(value({ op: 'days', from: { op: 'issueDate' }, to: f('custom.renewalDate') }).value).toBe(6);
    expect(value({ op: 'addDays', date: f('custom.renewalDate'), days: n(-30) }, { type: 'date' }).value).toBe('2026-11-01');
    expect(value({ op: 'earlier', a: f('custom.renewalDate'), b: { op: 'issueDate' } }, { type: 'date' }).value).toBe('2026-11-25');
    expect(value({ op: 'later', a: f('custom.renewalDate'), b: { op: 'date', value: '2026-12-31' } }, { type: 'date' }).value).toBe('2026-12-31');
    expect(value({ op: 'join', sep: ' ', parts: [f('customer.givenName'), f('customer.familyName'), { op: 'text', value: 'on' }, f('custom.renewalDate')] }, { type: 'text' }).value).toBe('Robin Okoye on 2026-12-01');
  });
  it('rows of a list: count, sum, smallest and largest, with a condition on the row', () => {
    expect(value({ op: 'count', list: 'custom.sessions' }).value).toBe(2);
    expect(value({ op: 'count', list: 'custom.sessions', where: { op: 'gt', path: 'priceCents', value: 1000 } }).value).toBe(1);
    expect(value({ op: 'sum', list: 'custom.sessions', column: 'priceCents' }, { type: 'money' }).value).toBe(2100);
    expect(value({ op: 'smallest', list: 'custom.sessions', column: 'day' }, { type: 'date' }).value).toBe('2026-11-03');
    expect(value({ op: 'largest', list: 'custom.sessions', column: 'spots' }).value).toBe(2);
    expect(value({ op: 'largest', list: 'custom.sessions', column: 'spots', where: { op: 'eq', path: 'className', value: 'Boxing' } }).missing?.code).toBe('input-missing');
    expect(value({ op: 'count', list: 'custom.sessions' }, { custom: { sessions: [] } }).value).toBe(0);
  });
  it('choice and lookup', () => {
    const choice: Expr = { op: 'if', when: { op: 'eq', path: 'custom.tier', value: 'pro' }, then: { op: 'text', value: 'P' }, else: { op: 'text', value: 'O' } };
    expect(value(choice, { type: 'text' }).value).toBe('O');
    expect(value(choice, { type: 'text', custom: { tier: 'pro' } }).value).toBe('P');
    const fee: Expr = { op: 'lookup', table: 'feeByTier', column: 'lateFee', keys: [f('custom.tier')] };
    expect(value(fee, { type: 'money' }).value).toBe(1000);
    expect(value(fee, { type: 'money', custom: { tier: 'pro' } }).missing).toMatchObject({ code: 'no-lookup-row' });
    const rate: Expr = { op: 'lookup', table: 'rates', column: 'rate', keys: [{ op: 'issueDate' }] };
    expect(value(rate, { date: '2026-12-31' }).value).toBe(1.5);
    expect(value(rate, { date: '2027-01-01' }).value).toBe(2); // "until" is the first day a row no longer applies
    expect(value(rate, { date: '2025-12-31' }).missing?.code).toBe('no-lookup-row');
  });
  it('is missing, with the reason, when an input is missing, a division is by zero or there is no date', () => {
    const perVisit: Expr = { op: 'round', places: 2, arg: { op: 'div', a: f('custom.monthlyFeeCents'), b: f('custom.visits') } };
    expect(value(perVisit, { type: 'money', custom: { visits: 0 } }).missing).toMatchObject({ code: 'division-by-zero', path: 'custom.visits', message: '“Visits this month” is zero, and nothing can be divided by zero.' });
    expect(value(perVisit, { type: 'money', custom: { visits: null } }).missing).toMatchObject({ code: 'input-missing', path: 'custom.visits', message: '“Visits this month” is missing.' });
    expect(value({ op: 'issueDate' }, { type: 'date', date: null }).missing).toMatchObject({ code: 'no-date' });
    expect(value({ op: 'addDays', date: f('custom.renewalDate'), days: n(1.5) }, { type: 'date' }).missing?.code).toBe('not-whole-days');
    // a calculation that reads a missing one is missing too, and says why
    const p = depthProject();
    const ctx = buildContext(gymMember()) as Record<string, unknown>;
    const r = evaluateCalculations(p, ctx, null);
    expect(r.values.daysToRenewal).toBeNull();
    expect(r.missing.renewSoon).toMatchObject({ code: 'no-date', via: ['daysToRenewal'] });
    expect((ctx.calc as Record<string, unknown>).renewSoon).toBeNull();
  });
  it('works calculations out once, in dependency order, whatever order they are listed in', () => {
    const calcs: CalculatedField[] = [
      { key: 'c', label: 'C', type: 'number', expr: { op: 'add', a: f('calc.b'), b: n(1) } },
      { key: 'b', label: 'B', type: 'number', expr: { op: 'mul', a: f('calc.a'), b: n(2) } },
      { key: 'a', label: 'A', type: 'number', expr: f('custom.visits') },
    ];
    expect(calcOrder(calcs)).toEqual({ order: ['a', 'b', 'c'], cycle: null });
    const p = run(gymProject(), { type: 'UPSERT_CALCULATED_FIELD', field: calcs[2] });
    const q = run(run(p, { type: 'UPSERT_CALCULATED_FIELD', field: calcs[1] }), { type: 'UPSERT_CALCULATED_FIELD', field: calcs[0], index: 0 });
    expect(q.calculatedFields!.map((c) => c.key)).toEqual(['c', 'a', 'b']);
    expect(evaluateCalculations(q, buildContext(gymMember()) as Record<string, unknown>, null).values).toEqual({ a: 9, b: 18, c: 19 });
  });
  it('step by step for one customer: every step with its value', () => {
    const p = depthProject();
    const expr = DEPTH_CALCS[2].expr;
    const ctx = buildContext(gymMember()) as Record<string, unknown>;
    const all = evaluateCalculations(p, ctx, '2026-11-25');
    const { result, steps } = evaluateSteps(p, expr, ctx, '2026-11-25', all.missing);
    expect(result).toEqual({ ok: true, value: 544 });
    expect(steps.map((s) => [s.at, s.value])).toEqual([['arg.a', 4900], ['arg.b', 9], ['arg', 4900 / 9], ['', 544]]);
  });
});

describe('the type check', () => {
  const scope = exprScopeOf(depthProject());
  const problem = (e: Expr) => checkExpr(e, scope).problems[0]?.message;
  it('knows the kind of every value', () => {
    for (const c of DEPTH_CALCS) expect(checkExpr(c.expr, scope)).toEqual({ type: c.type, problems: [] });
  });
  it('refuses what has no meaning, in plain words', () => {
    expect(problem(f('custom.nope'))).toBe('“custom.nope” is not a data field of this document.');
    expect(problem(f('custom.sessions'))).toMatch(/is a list\. Use COUNT, SUM/);
    expect(problem({ op: 'add', a: m(1), b: n(1) })).toMatch(/An amount and a plain number cannot be added/);
    expect(problem({ op: 'add', a: f('custom.renewalDate'), b: n(1) })).toMatch(/Use ADD_DAYS/);
    expect(problem({ op: 'mul', a: f('custom.monthlyFeeCents'), b: n(0.5) })).toMatch(/Say how this amount is rounded/);
    expect(problem({ op: 'div', a: f('custom.monthlyFeeCents'), b: n(2) })).toMatch(/Say how this amount is rounded/);
    expect(problem({ op: 'round', places: 3, arg: { op: 'div', a: m(100), b: n(3) } })).toMatch(/0, 1 or 2 places/);
    expect(problem({ op: 'mul', a: m(1), b: m(2) })).toMatch(/Two amounts cannot be multiplied/);
    expect(problem({ op: 'join', sep: '-', parts: [m(1)] })).toMatch(/JOIN cannot put an amount into text/);
    expect(problem({ op: 'if', when: { op: 'eq', path: 'custom.tier', value: 'gold' }, then: n(1), else: n(2) })).toMatch(/The condition is not valid/);
    expect(problem({ op: 'if', when: { op: 'eq', path: 'custom.tier', value: 'pro' }, then: n(1), else: { op: 'text', value: 'x' } })).toMatch(/must be the same kind of value/);
    expect(problem({ op: 'lookup', table: 'feeByTier', column: 'lateFee', keys: [n(1)] })).toMatch(/looked up by text, not a number/);
    expect(problem({ op: 'lookup', table: 'nope', column: 'x', keys: [] })).toBe('There is no lookup table “nope”.');
    expect(problem({ op: 'sum', list: 'custom.sessions', column: 'className' })).toMatch(/SUM adds up numbers or amounts/);
    expect(problem({ op: 'count', list: 'custom.sessions', where: { op: 'eq', path: 'nope', value: 1 } })).toMatch(/row condition is not valid/);
    const undated = exprScopeOf(gymProject());
    expect(checkExpr({ op: 'issueDate' }, undated).problems[0].message).toBe('This document does not have a date yet. Choose where its date comes from first.');
  });
  it('refuses a calculation that depends on itself, directly or through others', () => {
    const p = gymProject();
    const self: CalculatedField = { key: 'a', label: 'A', type: 'number', expr: { op: 'add', a: f('calc.a'), b: n(1) } };
    expect(validateCalculatedFields(p, [self])).toEqual(['“A” uses itself. A calculation cannot depend on its own result.']);
    const ring: CalculatedField[] = [
      { key: 'a', label: 'A', type: 'number', expr: f('calc.b') }, { key: 'b', label: 'B', type: 'number', expr: f('calc.c') }, { key: 'c', label: 'C', type: 'number', expr: f('calc.a') },
    ];
    expect(validateCalculatedFields(p, ring).pop()).toBe('These calculations depend on each other in a circle: “A” → “B” → “C” → “A”. A calculation cannot depend on its own result.');
    const q = run(p, { type: 'UPSERT_CALCULATED_FIELD', field: { key: 'a', label: 'A', type: 'number', expr: n(1) } });
    expect(reject(q, { type: 'UPSERT_CALCULATED_FIELD', field: self })).toMatch(/uses itself/);
  });
});

describe('the formula view', () => {
  const scope = exprScopeOf(depthProject());
  const fields = projectFieldIndex(depthProject());
  it('reads the design’s examples', () => {
    const a = parseFormula('=DAYS(card.dueDate, ISSUE_DATE())');
    expect(a).toMatchObject({ ok: true, expr: { op: 'days', from: { op: 'field', path: 'card.dueDate' }, to: { op: 'issueDate' } } });
    const b = parseFormula('=SUM(custom.sessions.priceCents WHERE className = "Spin")');
    expect(b).toMatchObject({ ok: true, expr: { op: 'sum', list: 'custom.sessions', column: 'priceCents', where: { op: 'eq', path: 'className', value: 'Spin' } } });
    const c = parseFormula('LOOKUP("feeByTier", "monthlyFee", card.accountTier)');
    expect(c).toMatchObject({ ok: true, expr: { op: 'lookup', table: 'feeByTier', column: 'monthlyFee', keys: [{ op: 'field', path: 'card.accountTier' }] } });
  });
  it('prints every calculation and reads it back to the same tree', () => {
    for (const c of DEPTH_CALCS) {
      const text = printFormula(c.expr, fields);
      const back = parseFormula(text);
      expect(back.ok && back.expr).toEqual(c.expr);
    }
    expect(printFormula(DEPTH_CALCS[2].expr)).toBe('=ROUND(custom.monthlyFeeCents / custom.visits, 2)');
    expect(printFormula({ op: 'sub', a: n(1), b: { op: 'sub', a: n(2), b: n(3) } })).toBe('=1 - (2 - 3)');
    expect(printFormula({ op: 'mul', a: { op: 'add', a: n(1), b: n(2) }, b: n(3) })).toBe('=(1 + 2) * 3');
    expect(printFormula({ op: 'if', when: { op: 'and', args: [{ op: 'gte', path: 'custom.monthlyFeeCents', value: 4900 }, { op: 'or', args: [{ op: 'eq', path: 'custom.tier', value: 'pro' }, { op: 'isNull', path: 'custom.visits' }] }] }, then: m(-150), else: m(0) }, fields))
      .toBe('=IF(custom.monthlyFeeCents >= $49.00 AND (custom.tier = "pro" OR custom.visits IS EMPTY), -$1.50, $0.00)');
  });

  it('round-trips generated trees: parse(print(x)) is x (property test, 3,000 trees)', () => {
    let seed = 20261113;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const paths = ['custom.visits', 'custom.monthlyFeeCents', 'customer.givenName', 'calc.spinTotal', 'card.dueDate', 'recordId', 'claims.count'];
    const scalar = (): import('../src').Scalar => pick([() => Math.round(rnd() * 2000 - 1000), () => Math.round(rnd() * 1e6) / 1000, () => pick(['a "q"', '', 'Spin', 'x,y']), () => rnd() < 0.5, () => null])();
    const cond = (d: number): Predicate => {
      const k = d > 2 ? 4 : Math.floor(rnd() * 9);
      if (k === 0) return { op: pick(['and', 'or'] as const), args: Array.from({ length: Math.floor(rnd() * 4) }, () => cond(d + 1)) };
      if (k === 1) return { op: 'not', arg: cond(d + 1) };
      if (k === 2) return { op: 'in', path: pick(paths), value: Array.from({ length: Math.floor(rnd() * 3) }, scalar) };
      if (k === 3) return { op: pick(['isNull', 'notNull'] as const), path: pick(paths) };
      return { op: pick(['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const), path: pick(paths), value: scalar() };
    };
    const tree = (d: number): Expr => {
      const leaf = d > 3;
      const k = leaf ? Math.floor(rnd() * 7) : Math.floor(rnd() * 21);
      switch (k) {
        case 0: return f(pick(paths));
        case 1: return n(pick([0, 1, -3, 2.5, 1e-7, 123456789, -0.125]));
        case 2: return m(pick([0, 1, -150, 4900, 123456]));
        case 3: return { op: 'text', value: pick(['', 'a', 'say ""hi""', 'line\nbreak', 'é']) };
        case 4: return { op: 'date', value: pick(['2026-01-01', '2027-12-31']) };
        case 5: return { op: 'bool', value: rnd() < 0.5 };
        case 6: return { op: 'issueDate' };
        case 7: case 8: return { op: pick(['add', 'sub', 'mul', 'div'] as const), a: tree(d + 1), b: tree(d + 1) };
        case 9: return { op: 'round', arg: tree(d + 1), places: pick([0, 1, 2, 6]) };
        case 10: return { op: pick(['min', 'max'] as const), args: [tree(d + 1), tree(d + 1), ...(rnd() < 0.3 ? [tree(d + 1)] : [])] };
        case 11: return { op: 'abs', arg: tree(d + 1) };
        case 12: return { op: 'days', from: tree(d + 1), to: tree(d + 1) };
        case 13: return { op: 'addDays', date: tree(d + 1), days: tree(d + 1) };
        case 14: return { op: pick(['earlier', 'later'] as const), a: tree(d + 1), b: tree(d + 1) };
        case 15: return { op: 'join', sep: pick(['', ' ', '"', ', ']), parts: [tree(d + 1), ...(rnd() < 0.5 ? [tree(d + 1)] : [])] };
        case 16: return rnd() < 0.5 ? { op: 'count', list: pick(['custom.sessions', 'claims']) } : { op: 'count', list: 'custom.sessions', where: cond(2) };
        case 17: return { op: pick(['sum', 'smallest', 'largest'] as const), list: pick(['custom.sessions', 'card.transactions', 'claims']), column: pick(['priceCents', 'day']), ...(rnd() < 0.5 ? { where: cond(1) } : {}) };
        case 18: return { op: 'if', when: cond(0), then: tree(d + 1), else: tree(d + 1) };
        case 19: return { op: 'lookup', table: pick(['feeByTier', 'a "b"']), column: 'lateFee', keys: [tree(d + 1)] };
        default: return { op: 'sub', a: tree(d + 1), b: n(-1) };
      }
    };
    for (let i = 0; i < 3000; i++) {
      const x = tree(0);
      for (const flds of [undefined, fields]) {
        const text = printFormula(x, flds);
        const back = parseFormula(text);
        if (!back.ok || JSON.stringify(back.expr) !== JSON.stringify(x)) throw new Error(`Round trip failed for ${text}: ${back.ok ? JSON.stringify(back.expr) : back.error.message}`);
        expect(back.expr).toEqual(x);
      }
    }
  });

  it('says what is wrong and where', () => {
    const err = (text: string) => { const r = parseFormula(text); if (r.ok) throw new Error('parsed'); return r.error; };
    expect(err('=DAYS(card.dueDate ISSUE_DATE())')).toEqual({ message: 'Expected a comma “,” here, found “ISSUE_DATE”.', start: 19, end: 29 });
    expect(err('=ROUND(1, 2')).toEqual({ message: 'Expected a closing bracket “)” to end ROUND(…), found the end of the formula.', start: 11, end: 12 });
    expect(err('=FOO(1)')).toMatchObject({ message: expect.stringMatching(/^“FOO” is not a function\. The functions are ISSUE_DATE, DATE, ROUND/), start: 1, end: 4 });
    expect(err('="abc')).toEqual({ message: 'This text has no closing quote ("). Add one where the text ends.', start: 1, end: 5 });
    expect(err('=$12.505')).toMatchObject({ message: 'An amount has at most two digits after the point (cents).', start: 1 });
    expect(err('=1 +')).toEqual({ message: 'The formula ends too early: a value is missing here.', start: 4, end: 5 });
    expect(err('=(1 + 2')).toEqual({ message: 'Expected a closing bracket “)” here, found the end of the formula.', start: 7, end: 8 });
    expect(err('=1 + 2)')).toEqual({ message: 'There is a closing bracket “)” with no opening bracket.', start: 6, end: 7 });
    expect(err('=-custom.visits')).toMatchObject({ message: expect.stringMatching(/^A minus sign in front works only on a number or an amount/) });
    expect(err('')).toMatchObject({ message: expect.stringMatching(/^The formula is empty/) });
    expect(err('=IF(custom.tier pro, 1, 2)')).toMatchObject({ message: expect.stringMatching(/^Expected a comparison/), start: 16 });
    expect(err('=1 # 2')).toEqual({ message: '“#” cannot be used in a formula.', start: 3, end: 4 });
    // checked against the project: the mistake is pointed at
    const text = '=custom.visits + custom.nope';
    const checked = checkFormula(text, scope);
    expect(checked).toEqual({ ok: false, errors: [{ message: '“custom.nope” is not a data field of this document.', start: 17, end: 28 }], expr: expect.anything() });
    const kind = checkFormula('=ROUND(custom.visits * 2, 0) + $1.00', scope);
    expect(kind.ok ? null : kind.errors[0]).toEqual({ message: expect.stringMatching(/^An amount and a plain number cannot be added/), start: 1, end: 36 });
    const ok = checkFormula('=DAYS(ISSUE_DATE(), custom.renewalDate)', scope);
    expect(ok).toMatchObject({ ok: true, type: 'number', spans: { '': [1, 39], from: [6, 18], to: [20, 38] } });
  });

  it('lists every function with its signature for auto-complete', () => {
    expect(FORMULA_FUNCTIONS.map((x) => x.name)).toEqual(['ISSUE_DATE', 'DATE', 'ROUND', 'MIN', 'MAX', 'ABS', 'DAYS', 'ADD_DAYS', 'EARLIER', 'LATER', 'JOIN', 'COUNT', 'SUM', 'SMALLEST', 'LARGEST', 'IF', 'LOOKUP']);
    for (const fn of FORMULA_FUNCTIONS) {
      expect(fn.signature.startsWith(`${fn.name}(`)).toBe(true);
      expect(parseFormula(fn.example).ok).toBe(true);
    }
  });

  it('reads a calculation in plain words', () => {
    const p = depthProject();
    const scopeW = wordsScopeOf(p, projectFieldIndex(p));
    const words = (e: Expr) => formulaInWords(e, scopeW);
    expect(words(DEPTH_CALCS[0].expr)).toBe('The number of days from the document’s date to “Renewal date”.');
    expect(words(DEPTH_CALCS[1].expr)).toBe('The total of “Price” in “Booked sessions” where “Class” is “Spin”.');
    expect(words(DEPTH_CALCS[2].expr)).toBe('“Monthly fee” divided by “Visits this month”, rounded to 2 decimal places.');
    expect(words(DEPTH_CALCS[3].expr)).toBe('“Late fee” from the table “Late fee by tier” for “Membership tier” “Membership tier”.');
    expect(words(DEPTH_CALCS[5].expr)).toBe('If “Days to renewal” is less than 14, yes; otherwise no.');
    expect(words({ op: 'addDays', date: f('custom.renewalDate'), days: n(-7) })).toBe('7 days before “Renewal date”.');
    expect(words({ op: 'mul', a: { op: 'add', a: m(150), b: f('calc.spinTotal') }, b: n(2) })).toBe('($1.50 plus “Spin total”) times 2.');
    expect(words({ op: 'join', sep: ' ', parts: [f('customer.givenName'), f('customer.familyName')] })).toBe('“Given name” and “Family name” joined with “ ” between them.');
  });
});

describe('lookup tables', () => {
  it('match exact text, number ranges and date ranges; from is included and until is not', () => {
    expect(lookupRowFor(FEE_BY_TIER, ['plus'])?.values.lateFee).toBe(1000);
    expect(lookupRowFor(FEE_BY_TIER, ['Plus'])).toBeNull();
    expect(lookupRowFor(RATES, ['2026-01-01'])?.values.rate).toBe(1.5);
    expect(lookupRowFor(RATES, ['2099-01-01'])?.values.rate).toBe(2);
    const bands: LookupTable = { id: 'bands', title: 'Bands', keys: [{ key: 'balance', label: 'Balance', match: 'number-range', unit: 'money' }, { key: 'tier', label: 'Tier', match: 'text' }], columns: [{ key: 'band', label: 'Band', type: 'text' }],
      rows: [{ keys: { balance: { until: 10000 }, tier: 'plus' }, values: { band: 'low' } }, { keys: { balance: { from: 10000 }, tier: 'plus' }, values: { band: 'high' } }], defaultRow: { band: 'other' } };
    expect(validateLookupTable(bands)).toEqual([]);
    expect(lookupRowFor(bands, [9999, 'plus'])?.values.band).toBe('low');
    expect(lookupRowFor(bands, [10000, 'plus'])?.values.band).toBe('high');
    expect(lookupRowFor(bands, [10000, 'basic'])).toBeNull();
  });
  it('report duplicates and overlaps (refused) and gaps (warned), with the rows', () => {
    const dup = { ...FEE_BY_TIER, rows: [...FEE_BY_TIER.rows, { keys: { tier: 'plus' }, values: { lateFee: 1, note: 'x' } }] };
    expect(lookupTableProblems(dup)).toEqual([{ kind: 'duplicate', severity: 'error', rows: [2, 3], message: 'Rows 2 and 3 of “Late fee by tier” have the same key (“plus”), so a customer would match both.' }]);
    expect(validateLookupTable(dup)).toEqual(['Rows 2 and 3 of “Late fee by tier” have the same key (“plus”), so a customer would match both.']);
    const overlap = { ...RATES, rows: [...RATES.rows, { keys: { period: { from: '2026-06-01', until: '2026-07-01' } }, values: { rate: 9 } }] };
    expect(lookupTableProblems(overlap)[0]).toMatchObject({ kind: 'overlap', severity: 'error', rows: [1, 3] });
    const gap = { ...RATES, rows: [RATES.rows[0], { keys: { period: { from: '2027-02-01' } }, values: { rate: 2 } }] };
    expect(lookupTableProblems(gap)).toEqual([{ kind: 'gap', severity: 'warning', rows: [1, 2], message: '“In effect” of “Bonus points rate” has a gap from 2027-01-01 until 2027-02-01 (between rows 1 and 2): a customer there matches no row.' }]);
    expect(validateLookupTable(gap)).toEqual([]);
  });
  it('refuse bad shapes, wrong cells and more than 5,000 rows', () => {
    expect(validateLookupTable({ ...FEE_BY_TIER, id: '9x' })[0]).toMatch(/must start with a letter/);
    expect(validateLookupTable({ ...FEE_BY_TIER, rows: [{ keys: { tier: 'basic' }, values: { lateFee: 12.5, note: 'n' } }] })).toEqual(['Table “Late fee by tier”, row 1: “Late fee” must be an amount in cents.']);
    expect(validateLookupTable({ ...RATES, rows: [{ keys: { period: { from: '2027-01-01', until: '2026-01-01' } }, values: { rate: 1 } }] })[0]).toMatch(/must end after it starts/);
    const big = { ...FEE_BY_TIER, rows: Array.from({ length: LOOKUP_TABLE_MAX_ROWS + 1 }, (_, i) => ({ keys: { tier: `t${i}` }, values: { lateFee: i, note: 'n' } })) };
    expect(validateLookupTable(big)).toEqual(['Table “Late fee by tier” has 5001 rows; the most is 5,000.']);
    const p = run(gymProject(), { type: 'UPSERT_LOOKUP_TABLE', table: FEE_BY_TIER });
    expect(reject(p, { type: 'UPSERT_LOOKUP_TABLE', table: big })).toMatch(/the most is 5,000/);
    const ok = { ...big, rows: big.rows.slice(0, LOOKUP_TABLE_MAX_ROWS) };
    expect(run(p, { type: 'UPSERT_LOOKUP_TABLE', table: ok }).lookupTables![0].rows).toHaveLength(5000);
  });
  it('a large table is searched through an index that finds exactly the row a row-by-row search finds', () => {
    const bands: LookupTable = { id: 'bands', title: 'Bands', keys: [{ key: 'tier', label: 'Tier', match: 'text' }, { key: 'fee', label: 'Fee', match: 'number-range', unit: 'money' }], columns: [{ key: 'points', label: 'Points', type: 'number' }],
      rows: ['basic', 'plus'].flatMap((tier) => Array.from({ length: 500 }, (_, i) => ({ keys: { tier, fee: i === 0 ? { until: 10 } : i === 499 ? { from: i * 10 } : { from: i * 10, until: (i + 1) * 10 } }, values: { points: i } }))) };
    // a gap: values 1000 to 1009 of "plus" match nothing
    bands.rows = bands.rows.filter((r) => !(r.keys.tier === 'plus' && (r.keys.fee as { from?: number }).from === 1000));
    expect(validateLookupTable(bands)).toEqual([]);
    const linear = (keys: unknown[]) => bands.rows.find((r) => r.keys.tier === keys[0] && ((r.keys.fee as { from?: number }).from ?? -Infinity) <= (keys[1] as number) && (keys[1] as number) < ((r.keys.fee as { until?: number }).until ?? Infinity)) ?? null;
    for (const tier of ['basic', 'plus', 'pro']) for (const fee of [-5, 0, 9, 10, 999, 1000, 1005, 1010, 4989, 4990, 4999, 5000, 99999]) expect(lookupRowFor(bands, [tier, fee])).toBe(linear([tier, fee]));
    expect(lookupRowFor(bands, ['plus', '10'])).toBeNull();
  });
  it('read a paste from a spreadsheet, with problems by row and column', () => {
    const tsv = 'Membership tier\tLate fee\tNote\nbasic\t15.00\tBasic\nplus\t$1,000\t\npro\ttwelve\tPro';
    const r = parseLookupPaste(FEE_BY_TIER, tsv);
    expect(r.headerSkipped).toBe(true);
    expect(r.rows).toEqual([{ keys: { tier: 'basic' }, values: { lateFee: 1500, note: 'Basic' } }, { keys: { tier: 'plus' }, values: { lateFee: 100000, note: null } }]);
    expect(r.problems).toEqual([{ row: 4, column: 2, message: 'Row 4, column 2 (Late fee): "twelve" is not an amount (for example 12.50).' }]);
    const csv = parseLookupPaste(RATES, '2026-01-01,2027-01-01,1.5\n2027-01-01,,2\n2027-02-30,,3\n"a,b"');
    expect(csv.rows).toEqual([{ keys: { period: { from: '2026-01-01', until: '2027-01-01' } }, values: { rate: 1.5 } }, { keys: { period: { from: '2027-01-01' } }, values: { rate: 2 } }]);
    expect(csv.problems).toEqual([
      { row: 3, column: 1, message: 'Row 3, column 1 (In effect from): "2027-02-30" is not a date; write it as YYYY-MM-DD.' },
      { row: 4, column: null, message: 'Row 4 has 1 cell; 3 are expected (In effect from, In effect until, Rate).' },
    ]);
  });
});

describe('commands: add, change, remove and reorder, each validated', () => {
  it('calculated fields', () => {
    const p = depthProject();
    expect(p.calculatedFields!.map((c) => c.key)).toEqual(DEPTH_CALCS.map((c) => c.key));
    expect(reject(p, { type: 'UPSERT_CALCULATED_FIELD', field: { ...DEPTH_CALCS[0], key: 'other', label: 'Days to renewal' } })).toMatch(/Two calculated fields are called “Days to renewal”/);
    expect(reject(p, { type: 'UPSERT_CALCULATED_FIELD', field: { key: 'x y', label: 'X', type: 'number', expr: n(1) } })).toMatch(/must start with a letter and use only letters and digits/);
    expect(reject(p, { type: 'UPSERT_CALCULATED_FIELD', field: { key: 'x', label: 'Plan name', type: 'number', expr: n(1) } })).toMatch(/already the name of a data field/);
    expect(reject(p, { type: 'UPSERT_CALCULATED_FIELD', field: { ...DEPTH_CALCS[1], type: 'number' } })).toMatch(/is set to give a number, but its calculation gives an amount/);
    // a change that would break a rule reading it is refused
    expect(reject(p, { type: 'UPSERT_CALCULATED_FIELD', field: { ...DEPTH_CALCS[5], type: 'number', expr: n(1) } })).toMatch(/would break rule R03/);
    // removing one that is used is refused, with where it is used
    expect(reject(p, { type: 'DELETE_CALCULATED_FIELD', key: 'daysToRenewal' })).toMatch(/“Days to renewal” is still used by calculation “Renews soon”/);
    const extra = run(p, { type: 'UPSERT_CALCULATED_FIELD', field: { key: 'twice', label: 'Twice the visits', type: 'number', expr: { op: 'mul', a: f('custom.visits'), b: n(2) } } });
    const moved = run(extra, { type: 'MOVE_CALCULATED_FIELD', key: 'twice', index: 0 });
    expect(moved.calculatedFields![0].key).toBe('twice');
    const changed = run(moved, { type: 'UPSERT_CALCULATED_FIELD', field: { key: 'twice', label: 'Double visits', type: 'number', description: ' Shown in the summary. ', expr: f('custom.visits') } });
    expect(changed.calculatedFields![0]).toEqual({ key: 'twice', label: 'Double visits', type: 'number', description: 'Shown in the summary.', expr: f('custom.visits') });
    expect(run(changed, { type: 'DELETE_CALCULATED_FIELD', key: 'twice' }).calculatedFields).toHaveLength(DEPTH_CALCS.length);
    // a data field a calculation reads cannot be removed
    expect(reject(p, { type: 'SET_CUSTOM_FIELDS', fields: p.customFields!.filter((x) => x.key !== 'visits') })).toMatch(/^custom\.visits is still used by .*calculation “Fee per visit”/);
  });
  it('appear in the data contract marked calculated, never as an input', () => {
    const p = depthProject();
    const defs = projectFields(p);
    expect(defs.filter((x) => x.calculated).map((x) => [x.path, x.type, x.derived])).toEqual([
      ['calc.daysToRenewal', 'number', true], ['calc.spinTotal', 'cents', true], ['calc.feePerVisit', 'cents', true], ['calc.lateFee', 'cents', true], ['calc.bonusRate', 'number', true], ['calc.renewSoon', 'bool', true],
    ]);
    expect(defs.find((x) => x.path === 'document.date')).toMatchObject({ type: 'date', derived: true, documentDate: true });
    // a project without them has exactly the fields it had
    expect(projectFields(gymProject()).some((x) => x.calculated || x.documentDate)).toBe(false);
  });
  it('lookup tables', () => {
    const p = depthProject();
    expect(reject(p, { type: 'DELETE_LOOKUP_TABLE', tableId: 'feeByTier' })).toBe('“Late fee by tier” is still read by “Late fee”. Remove those uses first.');
    expect(reject(p, { type: 'UPSERT_LOOKUP_TABLE', table: { ...FEE_BY_TIER, columns: [FEE_BY_TIER.columns[1]], rows: FEE_BY_TIER.rows.map((r) => ({ ...r, values: { note: 'n' } })) } })).toMatch(/would no longer work: “Late fee”: The table “Late fee by tier” has no column “lateFee”/);
    const extra = run(p, { type: 'UPSERT_LOOKUP_TABLE', table: { ...FEE_BY_TIER, id: 'spare', title: 'Spare' }, index: 0 });
    expect(extra.lookupTables!.map((t) => t.id)).toEqual(['spare', 'feeByTier', 'rates']);
    expect(run(extra, { type: 'MOVE_LOOKUP_TABLE', tableId: 'spare', index: 9 }).lookupTables!.map((t) => t.id)).toEqual(['feeByTier', 'rates', 'spare']);
    expect(run(extra, { type: 'DELETE_LOOKUP_TABLE', tableId: 'spare' }).lookupTables).toHaveLength(2);
  });
  it('the document’s date and effective periods', () => {
    const g = gymProject();
    expect(reject(g, { type: 'SET_RULE_PERIOD', ruleId: 'R01', period: { from: '2027-01-01' } })).toMatch(/Choose where the document’s date comes from/);
    expect(reject(g, { type: 'SET_DOCUMENT_DATE', source: { source: 'field', path: 'custom.visits' } })).toBe('“Visits this month” is not a date, so it cannot be the document’s date.');
    expect(reject(g, { type: 'SET_DOCUMENT_DATE', source: { source: 'field', path: 'custom.nope' } })).toMatch(/is not a data field/);
    const dated = run(g, { type: 'SET_DOCUMENT_DATE', source: { source: 'field', path: 'custom.renewalDate' } });
    expect(reject(dated, { type: 'SET_RULE_PERIOD', ruleId: 'R01', period: { from: '2027-01-01', until: '2027-01-01' } })).toMatch(/must end after it starts/);
    expect(reject(dated, { type: 'SET_RULE_PERIOD', ruleId: 'R01', period: { from: '2027-02-30' } })).toMatch(/is not a date/);
    const withRule = run(dated, { type: 'SET_RULE_PERIOD', ruleId: 'R01', period: { from: '2027-01-01' } });
    expect(withRule.rules.find((r) => r.id === 'R01')!.effective).toEqual({ from: '2027-01-01' });
    expect(reject(withRule, { type: 'SET_DOCUMENT_DATE', source: null })).toBe('The document’s date is still used (1 period). Remove those first.');
    expect(reject(withRule, { type: 'SET_SECTION_PERIOD', nodeId: 'heading', period: { from: '2027-01-01' } })).toBe('Only a conditional section can be in effect for a period.');
    const section = run(withRule, { type: 'SET_SECTION_PERIOD', nodeId: 'busy-note', period: { until: '2027-06-01' } });
    expect(section.nodes.find((x) => x.id === 'busy-note')!.effective).toEqual({ until: '2027-06-01' });
    const variant = run(section, { type: 'SET_VARIANT_PERIOD', nodeId: 'renewal-note', variantId: 'note-pro', period: { from: '2026-12-01', until: '2027-01-01' } });
    expect(variant.nodes.find((x) => x.id === 'renewal-note')!.variantPeriods).toEqual({ 'note-pro': { from: '2026-12-01', until: '2027-01-01' } });
    // removing the alternative removes its period
    const rid = run(run(variant, { type: 'DELETE_RULE', ruleId: 'R01' }), { type: 'REMOVE_VARIANT', nodeId: 'renewal-note', variantId: 'note-pro' });
    expect(rid.nodes.find((x) => x.id === 'renewal-note')!.variantPeriods).toBeUndefined();
    // and every period can be cleared again
    const clear = run(run(section, { type: 'SET_RULE_PERIOD', ruleId: 'R01', period: null }), { type: 'SET_SECTION_PERIOD', nodeId: 'busy-note', period: null });
    expect(run(clear, { type: 'SET_DOCUMENT_DATE', source: null }).documentDate).toBeUndefined();
    // a rule saved with a period through the ordinary rule command is checked the same way
    const r01 = g.rules.find((r) => r.id === 'R01')!;
    expect(reject(dated, { type: 'UPSERT_RULE', rule: { ...r01, effective: { from: '2027-01-01', until: '2026-01-01' } } })).toMatch(/must end after it starts/);
    // a test can be pinned "as issued on" a date
    expect(reject(g, { type: 'UPSERT_TEST_CASE', testCase: { id: 'T1', name: 'x', recordId: 'REC-60001', issueDate: '2027-13-01', expect: {} } })).toMatch(/“as issued on” date/);
  });
  it('the table footer can show a calculated amount', () => {
    const p = depthProject();
    expect(p.nodes.find((x) => x.id === 'sessions')!.totalFrom).toBe('calc.spinTotal');
    expect(reject(p, { type: 'UPDATE_NODE', nodeId: 'sessions', patch: { totalFrom: 'calc.daysToRenewal' } })).toMatch(/must be an amount field/);
    expect(reject(p, { type: 'DELETE_CALCULATED_FIELD', key: 'spinTotal' })).toMatch(/still used by .*Booked sessions|still used by/);
  });
});

describe('the rest of the model knows about them', () => {
  it('the project diff names calculations, tables, the date and periods', () => {
    const a = depthProject();
    let b = run(a, { type: 'UPSERT_CALCULATED_FIELD', field: { ...DEPTH_CALCS[1], expr: { ...DEPTH_CALCS[1].expr, where: { op: 'eq', path: 'className', value: 'Yoga' } } as Expr } });
    b = run(b, { type: 'UPSERT_LOOKUP_TABLE', table: { ...FEE_BY_TIER, rows: FEE_BY_TIER.rows.slice(0, 1) } });
    b = run(b, { type: 'SET_RULE_PERIOD', ruleId: 'R04', period: { from: '2027-02-01' } });
    b = run(b, { type: 'SET_DOCUMENT_DATE', source: { source: 'field', path: 'custom.renewalDate' } });
    const d = diffProjects(a, b);
    expect(d.calculations.changed).toEqual([{ id: 'spinTotal', name: 'Spin total', fields: ['expr'], formula: { from: '=SUM(custom.sessions.priceCents WHERE className = "Spin")', to: '=SUM(custom.sessions.priceCents WHERE className = "Yoga")' } }]);
    expect(d.lookupTables.changed).toEqual([{ id: 'feeByTier', name: 'Late fee by tier', fields: ['rows'], rows: { from: 2, to: 1 } }]);
    expect(d.rules.changed[0]).toMatchObject({ id: 'R04', period: { from: 'from 1 Jan 2027', to: 'from 1 Feb 2027' } });
    expect(d.documentDate).toEqual({ from: 'given for each run', to: 'from custom.renewalDate' });
    expect(d.summary.counts).toMatchObject({ calculations: 1, lookupTables: 1, documentDate: 1, rules: 1, other: 0 });
    // two identical projects: nothing, and the counts stay at zero for documents without these features
    const g = gymProject();
    expect(diffProjects(g, g).summary).toMatchObject({ identical: true, counts: { calculations: 0, lookupTables: 0, documentDate: 0 } });
  });
  it('templates keep them; a project file with broken ones is refused in plain words', () => {
    const p = depthProject();
    const t = templateContentOf(p);
    expect(t.calculatedFields).toEqual(p.calculatedFields);
    expect(t.lookupTables).toEqual(p.lookupTables);
    expect(t.documentDate).toEqual(p.documentDate);
    expect(projectFileProblems(JSON.parse(JSON.stringify(p)))).toEqual([]);
    const broken = JSON.parse(JSON.stringify(p));
    broken.calculatedFields[0].expr = { op: 'days', from: { op: 'field', path: 'custom.nope' }, to: { op: 'issueDate' } };
    broken.lookupTables[0].rows.push({ keys: { tier: 'plus' }, values: { lateFee: 1, note: 'x' } });
    broken.rules.find((r: { id: string }) => r.id === 'R04').effective = { from: 'soon' };
    expect(projectFileProblems(broken).map((x) => x.code)).toEqual(['PERIOD', 'LOOKUP_TABLE']);
    delete broken.documentDate;
    broken.lookupTables[0].rows.pop();
    broken.rules.find((r: { id: string }) => r.id === 'R04').effective = { from: '2027-01-01' };
    expect(projectFileProblems(broken).map((x) => [x.code, x.message])).toEqual([
      ['DOCUMENT_DATE', 'The file gives something a period but does not say where the document’s date comes from.'],
    ]);
    broken.documentDate = { source: 'run' };
    expect(projectFileProblems(broken)).toEqual([{ code: 'CALCULATION', message: 'A calculated field in the file is not valid: “Days to renewal”: “custom.nope” is not a data field of this document.' }]);
  });
});
