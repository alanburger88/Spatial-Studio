import { it } from 'vitest';
import { resolve } from '@iss/resolver';
import { seedProjects, RECORDS } from '../../model/src/fixtures';
import { planTestData } from '../src/assist/testData';
it('dump', () => {
  for (const p of seedProjects()) for (const [name, recs, o] of [['both', RECORDS, { outcomes: true, edges: true }], ['outcomes', RECORDS, { outcomes: true, edges: false }], ['edges', RECORDS, { outcomes: false, edges: true }], ['empty-both', [], { outcomes: true, edges: true }]] as const) {
    const t = performance.now();
    const plan = planTestData(p, recs as any, o);
    const ms = (performance.now() - t).toFixed(0);
    const blocked = plan.customers.map((c) => resolve({ project: p, record: { ...c.record, recordId: 'X' } }).findings.filter((f) => f.severity === 'blocking').map((f) => f.code));
    console.log('=====', p.projectId, name, ms, 'ms', plan.customers.length, 'customers', JSON.stringify(plan.summary), 'blocked', blocked.filter((b) => b.length).length);
    if (name === 'both' || name === 'empty-both') {
      plan.customers.forEach((c, i) => console.log(i, `${c.record.customer.givenName} ${c.record.customer.familyName}`, '|', c.label, '|', c.targets.length, blocked[i].length ? `BLOCKED ${[...new Set(blocked[i])].join(',')}` : ''));
      for (const t of plan.targets) if (t.kind === 'edge' || t.kind === 'empty' || t.customer === null) console.log(' ', t.kind.padEnd(14), String(t.customer).padEnd(4), t.title, t.observed ? `=> ${t.observed}` : '', t.reason ? `!! ${t.reason}` : '');
    }
  }
});
