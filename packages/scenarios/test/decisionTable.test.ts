import { describe, expect, it } from 'vitest';
import { seedProjects, RECORDS } from '../../model/src/fixtures';
import { applyCommand, type Project } from '@iss/model';
import { ADDON_GROUP, analyseDecisionTable, decisionGroups, groupRules, termsOnField } from '@iss/scenarios';

const [card, eob] = seedProjects();
const cmd = (p: Project, c: Parameters<typeof applyCommand>[1]) => { const r = applyCommand(p, c); if (!r.ok) throw new Error(r.message); return r.project; };
const injectD01 = (p: Project) => cmd(p, { type: 'UPSERT_RULE', rule: { ...p.rules.find((r) => r.id === 'R03')!, when: { op: 'gte', path: 'card.missedPayments', value: 2 }, priority: 400 } });

describe('decision table', () => {
  it('lists exclusive groups then add-ons', () => {
    const g = decisionGroups(card);
    expect(g.map((x) => x.id)).toEqual(['payment-guidance', ADDON_GROUP]);
    expect(g[0].ruleIds.sort()).toEqual(['R01', 'R02', 'R03', 'R04', 'R05']);
  });

  it('orders rules by priority and collects every field of the group', () => {
    expect(groupRules(card, 'payment-guidance').map((r) => r.id)).toEqual(['R05', 'R04', 'R03', 'R02', 'R01']);
    const a = analyseDecisionTable(card, 'payment-guidance', RECORDS);
    expect(a.fields).toEqual(['card.arrangementStatus', 'card.assistanceRequested', 'card.missedPayments', 'card.paymentStatus']);
    expect(termsOnField(card.rules.find((r) => r.id === 'R03')!, 'card.missedPayments')).toEqual([{ op: 'gte', path: 'card.missedPayments', value: 2 }]);
  });

  it('seed: no overlaps, no shadowed rules, wins add up to the synthetic records', () => {
    const a = analyseDecisionTable(card, 'payment-guidance', RECORDS);
    expect(a.overlaps).toEqual([]);
    expect(a.shadowed).toEqual([]);
    expect(a.evaluated).toBe(70);
    const total = Object.values(a.wins).reduce((s, n) => s + n, 0) + a.fallbackWins + a.unresolved;
    expect(total).toBe(70);
    expect(a.unresolved).toBe(0);
  });

  it('Inject D01 style change creates a blocking overlap R03/R04, seen in records and possible', () => {
    const a = analyseDecisionTable(injectD01(card), 'payment-guidance', RECORDS);
    expect(a.overlaps).toHaveLength(1);
    expect(a.overlaps[0].ruleIds).toEqual(['R03', 'R04']);
    expect(a.overlaps[0].example).toBeTruthy();
    expect(a.overlaps[0].recordIds.length).toBeGreaterThan(0);
    expect(a.blocking).toBeGreaterThan(0);
    expect(a.unresolved).toBe(a.overlaps[0].recordIds.length);
  });

  it('disabling R01 leaves current-status customers to the fallback (informational gap)', () => {
    const a = analyseDecisionTable(cmd(card, { type: 'SET_RULE_ENABLED', ruleId: 'R01', enabled: false }), 'payment-guidance', RECORDS);
    expect(a.gaps.blocking).toBe(false);
    expect(a.gaps.examples.some((c) => c['card.paymentStatus'] === 'current' && c['card.missedPayments'] === 0)).toBe(true);
    expect(a.gaps.recordIds.length).toBeGreaterThan(0);
    expect(a.fallbackWins).toBe(a.gaps.recordIds.length);
    expect(a.wins.R01).toBe(0);
  });

  it('removing the fallback turns gaps blocking', () => {
    const p = cmd(cmd(card, { type: 'SET_RULE_ENABLED', ruleId: 'R01', enabled: false }), { type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: undefined } });
    const a = analyseDecisionTable(p, 'payment-guidance', RECORDS);
    expect(a.gaps.blocking).toBe(true);
    expect(a.blocking).toBeGreaterThan(0);
    expect(a.unresolved).toBeGreaterThan(0);
  });

  it('detects a shadowed rule', () => {
    const r2 = card.rules.find((r) => r.id === 'R02')!;
    // R02 now needs a missed payment AND an assistance request; R04 (higher) matches whenever assistance is requested.
    const p = cmd(card, { type: 'UPSERT_RULE', rule: { ...r2, when: { op: 'and', args: [{ op: 'eq', path: 'card.missedPayments', value: 1 }, { op: 'eq', path: 'card.assistanceRequested', value: true }] } } });
    const a = analyseDecisionTable(p, 'payment-guidance', RECORDS);
    expect(a.shadowed.map((s) => s.ruleId)).toEqual(['R02']);
    expect(a.shadowed[0].beatenBy).toContain('R04');
  });

  it('add-on rules have no ties or gaps but real counts', () => {
    const a = analyseDecisionTable(card, ADDON_GROUP, RECORDS);
    expect(a.kind).toBe('addons');
    expect(a.overlaps).toEqual([]);
    expect(a.wins.R06).toBe(RECORDS.filter((r) => r.documentType === 'credit-statement' && (r.card as any)?.tier === 'premium').length);
  });

  it('works for the EOB project', () => {
    const a = analyseDecisionTable(eob, 'eob-claim-message', RECORDS);
    expect(a.overlaps).toEqual([]);
    expect(a.evaluated).toBe(RECORDS.filter((r) => r.documentType === 'eob').length);
  });
});
