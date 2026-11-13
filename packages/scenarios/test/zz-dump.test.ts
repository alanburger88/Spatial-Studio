import { it } from 'vitest';
import { validateRecordShape } from '@iss/model';
import { seedProjects, RECORDS } from '../../model/src/fixtures';
import { planTestData } from '../src/assist/testData';
it('dump', () => {
  console.log('fixture invalid', RECORDS.filter(r => validateRecordShape(r, r.documentType).length).length);
  for (const p of seedProjects()) for (const [name, recs, o] of [['both', RECORDS, { outcomes: true, edges: true }], ['outcomes', RECORDS, { outcomes: true, edges: false }], ['edges', RECORDS, { outcomes: false, edges: true }], ['empty-both', [], { outcomes: true, edges: true }]] as const) {
    const t = performance.now();
    const plan = planTestData(p, recs as any, o);
    console.log('=====', p.projectId, name, (performance.now() - t).toFixed(0), 'ms', plan.customers.length, 'customers', JSON.stringify(plan.summary));
    if (name === 'both' || name === 'empty-both') {
      plan.customers.forEach((c, i) => console.log(i, `${c.record.customer.givenName} ${c.record.customer.familyName}`, '|', c.label, '|', c.targets.length));
      for (const t of plan.targets) console.log(' ', t.kind.padEnd(14), String(t.customer).padEnd(4), t.title, t.observed ? `=> ${t.observed}` : '', t.reason ? `!! ${t.reason}` : '');
    }
  }
});
