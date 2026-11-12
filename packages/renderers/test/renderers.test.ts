import { describe, expect, it } from 'vitest';
import { seedProjects, RECORDS } from '../../model/src/fixtures';
import { resolve } from '@iss/resolver';
import { renderInteractiveHtml, renderPagedDocument, compareManifests, afpSimulation, AFP_SIMULATION_LABEL } from '@iss/renderers';

const [card, eob] = seedProjects();
const rec = (id: string) => RECORDS.find((r) => r.recordId === id)!;

describe('renderers (string level; browser composition is covered by E2E)', () => {
  it('paged and HTML outputs carry lineage and facts; HTML is standalone', () => {
    const res = resolve({ project: card, record: rec('CARD-0001') });
    const paged = renderPagedDocument(res, card);
    const html = renderInteractiveHtml(res, card);
    expect(paged).toContain('data-node-id="billing-summary"');
    expect(paged).toContain('data-cents="124800"');
    expect(html).toContain('data-node-id="billing-summary"');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href="http/);
    expect(html).toContain('data-sort-key="amountCents"');
    expect(html).toContain('<details class="iss-expl"');
  });

  it('escapes data to prevent injection', () => {
    const res = resolve({ project: card, record: rec('CARD-0001'), overrides: { customer: { givenName: '<script>alert(1)</script>' } } });
    const html = renderInteractiveHtml(res, card);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('EOB outputs state THIS IS NOT A BILL', () => {
    const res = resolve({ project: eob, record: rec('EOB-0002') });
    expect(renderPagedDocument(res, eob)).toContain('THIS IS NOT A BILL');
    expect(renderInteractiveHtml(res, eob)).toContain('THIS IS NOT A BILL');
  });

  it('parity detects a missing disclosure and a changed amount', () => {
    const res = resolve({ project: card, record: rec('CARD-0001') });
    const m = res.semanticManifest;
    const good = { visibleNodeIds: m.visibleNodeIds, money: m.money, guardedLiabilityNodeIds: [], disclosures: m.disclosures, selectedVariants: m.selectedVariants, tableRows: m.tableRows, tableTotalsCents: m.tableTotalsCents, actions: m.actions, identity: { name: m.identity.name, account: m.identity.account } };
    expect(compareManifests(m, good, good).ok).toBe(true);
    const bad = { ...good, money: { ...good.money, 'billing-summary': 1 }, disclosures: [], visibleNodeIds: good.visibleNodeIds.filter((x) => x !== 'sample-disclosure-set') };
    const rep = compareManifests(m, good, bad);
    expect(rep.ok).toBe(false);
    expect(rep.checks.filter((c) => c.status === 'mismatch').map((c) => c.id)).toEqual(expect.arrayContaining(['money', 'disclosures', 'html-semantic-omission']));
  });

  it('AFP is a labelled simulation with no bytes (AT-27)', () => {
    const res = resolve({ project: card, record: rec('CARD-0001') });
    const sim = afpSimulation(res, card, null);
    expect(sim.simulationOnly).toBe(true);
    expect(sim.afpBytesGenerated).toBe(0);
    expect(sim.label).toBe(AFP_SIMULATION_LABEL);
  });
});
