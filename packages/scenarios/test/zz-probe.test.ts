import { it } from 'vitest';
import { seedProjects, RECORDS } from '../../model/src/fixtures';
import { resolve } from '@iss/resolver';
it('probe', () => {
  for (const p of seedProjects()) {
    const recs = RECORDS.filter((r) => r.documentType === p.documentType);
    console.log(p.projectId, recs.length, 'events', p.journey.events.length);
    const reach: Record<string, Set<string>> = {};
    const sel: Record<string, Set<string>> = {};
    const codes: Record<string, number> = {};
    for (const cur of [null, ...p.journey.events.map((_, i) => i)]) {
      for (const r of recs) {
        const res = resolve({ project: p, record: r, journeyCursor: cur });
        for (const id of res.result.matchedRuleIds) (reach[id] ??= new Set()).add(String(cur));
        for (const t of res.trace) if (t.outcome === 'selected') (sel[t.ruleId] ??= new Set()).add(String(cur));
        for (const f of res.findings) codes[`${cur}|${f.code}|${f.severity}|${f.nodeId}`] = (codes[`${cur}|${f.code}|${f.severity}|${f.nodeId}`] ?? 0) + 1;
      }
    }
    for (const r of p.rules) console.log(r.id, 'matched@', [...(reach[r.id] ?? [])].join(','), ' selected@', [...(sel[r.id] ?? [])].join(','));
    console.log(codes);
  }
  console.log(JSON.stringify(RECORDS[1]).slice(0, 900));
  console.log(JSON.stringify(RECORDS.find((r) => r.documentType === 'eob')).slice(0, 1200));
});
