import { describe, expect, it } from 'vitest';
import { EXPECTED_SCENARIOS, recordById, seedProjects } from '../../model/src/fixtures';
import { digestOf, type Project } from '@iss/model';
import { resolve } from '@iss/resolver';

const KEYS = ['recordId', 'documentType', 'selectedVariants', 'matchedRuleIds', 'additiveRuleIds', 'requiredNodes', 'diagnostics', 'documentFacts'] as const;
const projects = seedProjects();
const projectFor = (recordId: string) => projects.find((p) => p.documentType === (recordId.startsWith('EOB') ? 'eob' : 'credit-statement'))!;

describe('independent oracle goldens (fixtures/expected_scenarios.json)', () => {
  for (const [name, gc] of Object.entries(EXPECTED_SCENARIOS)) {
    it(name, () => {
      let project: Project = projectFor(gc.recordId);
      if (gc.rulePatches) project = { ...project, rules: project.rules.map((r) => { const p = gc.rulePatches!.find((x) => x.id === r.id); return p ? { ...r, ...p } as any : r; }) };
      const res = resolve({ project, record: recordById(gc.recordId)!, overrides: gc.overrides });
      for (const k of KEYS) expect(res.result[k], k).toEqual(gc.expected[k]);
      // Digest comparability: our canonicalisation matches the reference digest of the core fields.
      expect(res.result.resultDigest).toBe(gc.expected.resultDigest);
    });
  }
  it('does not mutate the source record and is deterministic', () => {
    const rec = recordById('CARD-0001')!;
    const before = digestOf(rec);
    const a = resolve({ project: projects[0], record: rec, overrides: { card: { missedPayments: 1, paymentStatus: 'overdue' } } });
    const b = resolve({ project: projects[0], record: rec, overrides: { card: { missedPayments: 1, paymentStatus: 'overdue' } } });
    expect(digestOf(rec)).toBe(before);
    expect(a.runId).toBe(b.runId);
    expect(a.contentDigest).toBe(b.contentDigest);
  });
});
