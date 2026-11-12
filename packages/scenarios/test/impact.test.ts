import { describe, expect, it } from 'vitest';
import { seedProjects, RECORDS } from '../../model/src/fixtures';
import { applyCommand, type Project } from '@iss/model';
import { impactOf } from '@iss/scenarios';

const [card] = seedProjects();
const cmd = (p: Project, c: Parameters<typeof applyCommand>[1]) => { const r = applyCommand(p, c); if (!r.ok) throw new Error(r.message); return r.project; };

describe('impactOf', () => {
  it('identical model changes nothing', () => {
    const i = impactOf(card, structuredClone(card), RECORDS);
    expect(i.evaluated).toBe(70);
    expect(i.changed).toEqual([]);
    expect(i.newBlocking).toBe(0);
    expect(i.resolvedBlocking).toBe(0);
  });

  it('disabling R04 moves assistance-requested CARD records to another variant', () => {
    const after = cmd(card, { type: 'SET_RULE_ENABLED', ruleId: 'R04', enabled: false });
    const i = impactOf(card, after, RECORDS);
    const asked = RECORDS.filter((r) => r.documentType === 'credit-statement' && (r.card as any)?.assistanceRequested === true);
    expect(asked.length).toBeGreaterThan(0);
    const moved = i.changed.filter((c) => c.changes.some((x) => x.kind === 'variant' && x.nodeId === 'payment-guidance'));
    for (const r of asked) expect(moved.map((m) => m.recordId)).toContain(r.recordId);
    const v = moved[0].changes.find((x) => x.kind === 'variant')!;
    expect(v.before).not.toBe(v.after);
  });

  it('a priority tie introduces new blocking findings', () => {
    const r3 = card.rules.find((r) => r.id === 'R03')!;
    const r4 = card.rules.find((r) => r.id === 'R04')!;
    const after = cmd(card, { type: 'UPSERT_RULE', rule: { ...r3, when: { op: 'gte', path: 'card.missedPayments', value: 2 }, priority: r4.priority } });
    const i = impactOf(card, after, RECORDS);
    expect(i.newBlocking).toBeGreaterThan(0);
    expect(i.changed.some((c) => c.changes.some((x) => x.kind === 'blocking' && x.after === 'EXCLUSIVE_PRIORITY_TIE'))).toBe(true);
  });

  it('time for 70 records stays small', () => {
    const after = cmd(card, { type: 'SET_RULE_ENABLED', ruleId: 'R02', enabled: false });
    const t = performance.now();
    impactOf(card, after, RECORDS);
    const ms = performance.now() - t;
    console.log(`impactOf 70 records: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(2000);
  });
});
