import type { CalculatedField, Expr, LookupTable, Project, SyntheticRecord } from '../../../model/src';
import { gymMember, run } from '../../../model/test/helpers/customProject';
import { depthProject } from '../../../model/test/helpers/depthProject';

/**
 * The performance document: the depth test project plus a 1,000-row number-range lookup table and enough calculations
 * to make 20, several of them reading each other and the table, and a rule that decides on one of them.
 */
export function depthBenchProject(): Project {
  let p = depthProject();
  const bands: LookupTable = {
    id: 'bands', title: 'Bands', keys: [{ key: 'fee', label: 'Fee', match: 'number-range', unit: 'money' }], columns: [{ key: 'points', label: 'Points', type: 'number' }],
    rows: Array.from({ length: 1000 }, (_, i) => ({ keys: { fee: { from: i * 10, until: (i + 1) * 10 } }, values: { points: i } })),
  };
  p = run(p, { type: 'UPSERT_LOOKUP_TABLE', table: bands });
  const f = (path: string): Expr => ({ op: 'field', path });
  const extra: CalculatedField[] = [
    { key: 'points', label: 'Points', type: 'number', expr: { op: 'lookup', table: 'bands', column: 'points', keys: [f('custom.monthlyFeeCents')] } },
    { key: 'pointsTwice', label: 'Points twice', type: 'number', expr: { op: 'mul', a: f('calc.points'), b: { op: 'number', value: 2 } } },
    { key: 'yogaTotal', label: 'Yoga total', type: 'money', expr: { op: 'sum', list: 'custom.sessions', column: 'priceCents', where: { op: 'eq', path: 'className', value: 'Yoga' } } },
    { key: 'allTotal', label: 'All sessions total', type: 'money', expr: { op: 'add', a: f('calc.yogaTotal'), b: f('calc.spinTotal') } },
    { key: 'sessionCount', label: 'Session count', type: 'number', expr: { op: 'count', list: 'custom.sessions' } },
    { key: 'average', label: 'Average price', type: 'money', expr: { op: 'round', places: 2, arg: { op: 'div', a: f('calc.allTotal'), b: { op: 'max', args: [f('calc.sessionCount'), { op: 'number', value: 1 }] } } } },
    { key: 'renewalNotice', label: 'Renewal notice day', type: 'date', expr: { op: 'addDays', date: f('custom.renewalDate'), days: { op: 'number', value: -14 } } },
    { key: 'noticeOrToday', label: 'Notice or today', type: 'date', expr: { op: 'later', a: f('calc.renewalNotice'), b: { op: 'issueDate' } } },
    { key: 'fullName', label: 'Full name', type: 'text', expr: { op: 'join', sep: ' ', parts: [f('customer.givenName'), f('customer.familyName')] } },
    { key: 'feeBand', label: 'Fee band', type: 'text', expr: { op: 'if', when: { op: 'gte', path: 'calc.points', value: 400 }, then: { op: 'text', value: 'High' }, else: { op: 'text', value: 'Standard' } } },
    { key: 'discount', label: 'Discount', type: 'money', expr: { op: 'round', places: 2, arg: { op: 'mul', a: f('custom.monthlyFeeCents'), b: { op: 'number', value: 0.15 } } } },
    { key: 'netFee', label: 'Net fee', type: 'money', expr: { op: 'sub', a: f('custom.monthlyFeeCents'), b: f('calc.discount') } },
    { key: 'cheapest', label: 'Cheapest session', type: 'money', expr: { op: 'smallest', list: 'custom.sessions', column: 'priceCents' } },
    { key: 'gap', label: 'Gap', type: 'money', expr: { op: 'abs', arg: { op: 'sub', a: f('calc.netFee'), b: f('calc.cheapest') } } },
  ];
  for (const field of extra) p = run(p, { type: 'UPSERT_CALCULATED_FIELD', field });
  if (p.calculatedFields!.length !== 20) throw new Error(`expected 20 calculations, got ${p.calculatedFields!.length}`);
  return run(p, { type: 'UPSERT_RULE', rule: { ...p.rules.find((r) => r.id === 'R05')!, id: 'R09', title: 'High fee band', priority: 120, when: { op: 'eq', path: 'calc.feeBand', value: 'High' } } });
}

export function depthBenchMembers(): SyntheticRecord[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((k) => gymMember({ recordId: `REC-6100${k}`, custom: { monthlyFeeCents: 1000 + k * 1100, tier: ['basic', 'plus', 'pro'][k % 3], visits: k } }));
}
