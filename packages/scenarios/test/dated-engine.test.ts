import { describe, expect, it } from 'vitest';
import { applyCommand, type Command, type Project, type SyntheticRecord } from '../../model/src';
import { gymMember } from '../../model/test/helpers/customProject';
import { depthProject } from '../../model/test/helpers/depthProject';
import { resolve } from '../../resolver/src';
import { impactOf, replayJourney, ScenarioEngine, summarizeChanges } from '../src';

/** The scenario engine, the journey replay and the change summary take "as issued on" themselves. */

const ok = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(r.message); return r.project; };
const people: SyntheticRecord[] = [
  gymMember(),
  gymMember({ recordId: 'REC-60002', custom: { tier: 'basic', visits: 0, renewalDate: '2027-03-01', autoRenew: true } }),
  gymMember({ recordId: 'REC-60003', custom: { tier: 'pro', renewalDate: '2027-05-01' } }),
];
const scenario = (recordId: string) => ({ recordId, overrides: {}, journeyCursor: null, profileId: 'paged-pdf' as const });

describe('ScenarioEngine as issued on a day', () => {
  const p = depthProject();
  it('resolves every scenario with the day it was given', () => {
    const before = new ScenarioEngine(p, people, '2026-12-15').resolveScenario(scenario('REC-60002'));
    const after = new ScenarioEngine(p, people, '2027-01-02').resolveScenario(scenario('REC-60002'));
    expect(before.result.selectedVariants['renewal-note']).not.toBe('note-newyear');
    expect(after.result.selectedVariants['renewal-note']).toBe('note-newyear');
    expect(after.runId).toBe(resolve({ project: p, record: people[1], overrides: {}, journeyCursor: null, profileId: 'paged-pdf', issueDate: '2027-01-02' }).runId);
  });
  it('without a day works exactly as before', () => {
    const plain = new ScenarioEngine(p, people);
    expect(plain.issueDate).toBeNull();
    expect(plain.resolveScenario(scenario('REC-60002')).runId).toBe(resolve({ project: p, record: people[1], overrides: {}, journeyCursor: null, profileId: 'paged-pdf' }).runId);
  });
});

describe('replayJourney as issued on a day', () => {
  const p = depthProject();
  it('dates every snapshot like the server does', () => {
    const dated = replayJourney(p, people[1], {}, 'paged-pdf', '2027-01-02');
    const undated = replayJourney(p, people[1]);
    expect(dated[0].runId).toBe(resolve({ project: p, record: people[1], overrides: {}, journeyCursor: null, profileId: 'paged-pdf', issueDate: '2027-01-02' }).runId);
    expect(dated[0].selectedVariants['renewal-note']).toBe('note-newyear');
    expect(undated[0].runId).toBe(resolve({ project: p, record: people[1], overrides: {}, journeyCursor: null, profileId: 'paged-pdf' }).runId);
    expect(dated[0].runId).not.toBe(undated[0].runId);
  });
});

describe('the change summary as issued on a day', () => {
  const p = depthProject();
  const r04 = p.rules.find((r) => r.id === 'R04')!;
  // Turning off the new year rule only changes anything from the day it starts.
  const off = ok(p, { type: 'UPSERT_RULE', rule: { ...r04, enabled: false } });
  it('works out the customer impact on the preview date', () => {
    expect(summarizeChanges(p, off, people, { issueDate: '2026-12-15' }).impact.changedCustomers).toBe(0);
    expect(summarizeChanges(p, off, people, { issueDate: '2027-01-02' }).impact.changedCustomers).toBe(1);
    expect(impactOf(p, off, people, '2027-01-02').changed.map((c) => c.recordId)).toEqual(['REC-60002']);
    expect(impactOf(p, off, people, '2026-12-15').changed).toEqual([]);
  });
  it('names the accessible PDF setting in plain words', () => {
    const required = ok(p, { type: 'SET_ACCESSIBLE_PDF_REQUIRED', required: true } as Command);
    const settings = summarizeChanges(p, required, people).sections.find((s) => s.area === 'settings')!;
    expect(settings.items).toEqual(['Other project details changed: whether an accessible PDF is required']);
  });
});
