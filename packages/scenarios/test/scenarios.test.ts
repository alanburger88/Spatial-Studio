import { describe, expect, it } from 'vitest';
import { seedProjects, RECORDS } from '../../model/src/fixtures';
import { applyCommand } from '@iss/model';
import { resolve, explainNode } from '@iss/resolver';
import { ScenarioEngine, buildCube, buildLandscape, generateEdgeCase, replayJourney, EDGE_CASE_PRESETS } from '@iss/scenarios';

const [card, eob] = seedProjects();
const rec = (id: string) => RECORDS.find((r) => r.recordId === id)!;

describe('scenario intelligence', () => {
  it('cube intersections come from resolution; empty intersections are honest (AT-14/AT-15)', () => {
    const cube = buildCube(new ScenarioEngine(card, RECORDS), ['persona', 'language', 'journey']);
    expect(cube.errors).toEqual([]);
    expect(cube.universeSize).toBe(70 * 5);
    expect(cube.axes[1].categories.map((c) => c.key)).toEqual(expect.arrayContaining(['en-US', 'es-US']));
    const empty = cube.cells.find((c) => c.count === 0)!;
    expect(empty.representative).toBeNull();
    const dup = buildCube(new ScenarioEngine(card, RECORDS), ['persona', 'persona', 'journey']);
    expect(dup.errors[0]).toMatch(/only one axis/);
  });

  it('landscape cluster sizes reconcile to the evaluated universe (AT-16) and defects are real (AT-17)', () => {
    for (const p of [card, eob]) {
      const l = buildLandscape(new ScenarioEngine(p, RECORDS));
      expect(l.reconciles).toBe(true);
      expect(l.clusters.reduce((s, c) => s + c.count, 0)).toBe(p === card ? 70 : 30);
      for (const c of l.clusters.filter((x) => x.blockingScenarios > 0)) expect(Object.keys(c.findingCodes).length).toBeGreaterThan(0);
    }
    const withJourney = buildLandscape(new ScenarioEngine(card, RECORDS), { includeJourney: true });
    expect(withJourney.universeSize).toBe(350);
  });

  it('journey events change future previews but never the issued snapshot (AT-21/AT-22)', () => {
    const snaps = replayJourney(card, rec('CARD-0001'));
    const issued = snaps.find((s) => s.kind === 'issued')!;
    expect(issued.selectedVariants['payment-guidance']).toBe('payment-standard');
    expect(snaps.find((s) => s.eventId === 'card-day30')!.selectedVariants['payment-guidance']).toBe('payment-reminder');
    const d45 = snaps.find((s) => s.eventId === 'card-day45')!;
    expect(d45.selectedVariants['payment-guidance']).toBe('payment-assistance-requested');
    expect(d45.matchedRuleIds).toContain('R04');
    // Issued digest is identical whether or not later events exist.
    const only = { ...card, journey: { ...card.journey, events: card.journey.events.slice(0, 1) } };
    expect(replayJourney(only, rec('CARD-0001'))[1].contentDigest).toBe(issued.contentDigest);
    const exp = explainNode(resolve({ project: card, record: rec('CARD-0001'), journeyCursor: 2 }), 'payment-guidance');
    expect(exp.summary).toMatch(/R04/);
  });

  it('reordering events replays deterministically with precondition skips (AT-23)', () => {
    const ev = card.journey.events;
    const reordered = [ev[0], ev[2], ev[1], ev[3]];
    const r = applyCommand(card, { type: 'SET_JOURNEY', events: reordered });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = replayJourney(r.project, rec('CARD-0001'));
    const b = replayJourney(r.project, rec('CARD-0001'));
    expect(a.map((s) => s.contentDigest)).toEqual(b.map((s) => s.contentDigest));
    expect(a.find((s) => s.eventId === 'card-day45')!.kind).toBe('skipped');
  });

  it('edge-case generator is deterministic and preserves purchase totals', () => {
    for (const preset of EDGE_CASE_PRESETS.filter((p) => p.documentType === 'credit-statement')) {
      const a = generateEdgeCase(rec('CARD-0001'), preset.id);
      expect(generateEdgeCase(rec('CARD-0001'), preset.id)).toEqual(a);
    }
    const s = generateEdgeCase(rec('CARD-0001'), 'stress-250');
    const tx = (s.overrides as any).card.transactions;
    expect(tx).toHaveLength(250);
    expect(tx.reduce((x: number, t: any) => x + t.amountCents, 0)).toBe(50800);
    const exact = resolve({ project: card, record: rec('CARD-0001'), overrides: generateEdgeCase(rec('CARD-0001'), 'threshold-exact').overrides });
    expect(exact.result.matchedRuleIds).not.toContain('R10');
  });

  it('EOB guardrails: unconfirmed liability is never presented as owed (AT-28/AT-29)', () => {
    const covered = resolve({ project: eob, record: rec('EOB-0001') });
    const f = covered.result.documentFacts as any;
    expect(f.billedCents).toBe(25000 + 15000);
    expect(f.allowedCents).toBe(f.planPaidCents + f.patientResponsibilityCents);
    const review = resolve({ project: eob, record: rec('EOB-0002'), overrides: { claims: [{ ...(rec('EOB-0002').claims![0] as any), patientResponsibilityCents: 30000 }] } });
    expect(review.result.diagnostics.map((d) => d.code)).toContain('UNCONFIRMED_MEMBER_LIABILITY');
    expect(review.semanticManifest.guardedLiabilityNodeIds).toContain('member-responsibility');
    expect(review.semanticManifest.money['member-responsibility']).toBeUndefined();
    const r = applyCommand(eob, { type: 'UPDATE_NODE', nodeId: 'billed-amount', patch: { label: 'Amount you owe' } });
    if (!r.ok) throw new Error();
    const owed = resolve({ project: r.project, record: rec('EOB-0002') });
    expect(owed.findings.some((x) => x.code === 'UNCONFIRMED_DEBT_LANGUAGE' && x.severity === 'blocking')).toBe(true);
  });

  it('unrelated chart style changes leave financial facts and content digest unchanged (AT-11)', () => {
    const base = resolve({ project: card, record: rec('CARD-0001') });
    const r = applyCommand(card, { type: 'UPDATE_NODE', nodeId: 'spend-chart', patch: { chart: { ...card.nodes.find((n) => n.id === 'spend-chart')!.chart!, kind: 'donut' } } });
    if (!r.ok) throw new Error();
    const after = resolve({ project: r.project, record: rec('CARD-0001') });
    expect(after.semanticManifest.money).toEqual(base.semanticManifest.money);
    expect(after.contentDigest).toBe(base.contentDigest);
  });

  it('removing the fallback with no matching rule is a blocking NO_VARIANT_MATCH (AT-10)', () => {
    const r = applyCommand(card, { type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: undefined } });
    if (!r.ok) throw new Error();
    const res = resolve({ project: r.project, record: rec('CARD-0001'), overrides: { card: { paymentStatus: 'overdue' } } });
    expect(res.result.diagnostics).toContainEqual({ code: 'NO_VARIANT_MATCH', severity: 'blocking', nodeId: 'payment-guidance' });
    expect(res.result.selectedVariants['payment-guidance']).toBeNull();
  });
});
