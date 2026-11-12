import { describe, expect, it } from 'vitest';
import { seedProjects, RECORDS } from '../src/fixtures';
import { applyCommand, defaultNode, dropRejection, projectContentDigest, validatePredicate, sanitizeRichDoc, isSafeUrl } from '@iss/model';
import { resolve } from '@iss/resolver';

const [card, eob] = seedProjects();
const rec = (id: string) => RECORDS.find((r) => r.recordId === id)!;

describe('canonical model and command bus', () => {
  it('seeds keep every fixture node, rule and content-part id (stable identities)', () => {
    expect(card.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['doc-root', 'billing-summary', 'payment-due', 'payment-guidance', 'transaction-table', 'sample-disclosure-set']));
    expect(eob.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['not-a-bill-banner', 'claim-identifiers', 'eob-claim-message', 'claim-table', 'totals-and-terms']));
    expect(card.rules.map((r) => r.id)).toEqual(['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10', 'R11', 'R12']);
    expect(eob.rules).toHaveLength(8);
    const types = new Set([...card.nodes, ...eob.nodes].map((n) => n.type));
    expect(types.size).toBe(15); // all 15 component types are used in the seeded projects
  });

  it('INSERT_NODE creates one version; serialisation round-trips (AT-02/AT-35 model layer)', () => {
    const node = defaultNode('rich-text', 'rt-test', 'credit-statement');
    const r = applyCommand(card, { type: 'INSERT_NODE', node, parentId: 'doc-root', index: 8 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.modelVersion).toBe(card.modelVersion + 1);
    const reloaded = JSON.parse(JSON.stringify(r.project));
    expect(projectContentDigest(reloaded)).toBe(projectContentDigest(r.project));
    const res = resolve({ project: reloaded, record: rec('CARD-0001') });
    expect(res.root.children.find((c) => c.id === 'rt-test')?.text?.[0].inlines?.map((i) => i.text).join('')).toContain('Jordan');
  });

  it('drops into protected areas are rejected and leave the model unchanged (AT-04)', () => {
    expect(dropRejection(card, 'sample-disclosure-set', 'rich-text')).toMatch(/protected disclosure/i);
    expect(dropRejection(card, 'page-footer', 'rich-text')).toMatch(/page chrome/i);
    const before = projectContentDigest(card);
    const r = applyCommand(card, { type: 'INSERT_NODE', node: defaultNode('rich-text', 'x-test', 'credit-statement'), parentId: 'sample-disclosure-set' });
    expect(r.ok).toBe(false);
    expect(projectContentDigest(card)).toBe(before);
  });

  it('mandatory obligations cannot be deleted or disabled', () => {
    expect(applyCommand(card, { type: 'DELETE_NODE', nodeId: 'sample-disclosure-set' }).ok).toBe(false);
    expect(applyCommand(card, { type: 'SET_RULE_ENABLED', ruleId: 'R12', enabled: false }).ok).toBe(false);
    expect(applyCommand(eob, { type: 'DELETE_NODE', nodeId: 'not-a-bill-banner' }).ok).toBe(false);
  });

  it('layout commands persist per profile and validate geometry (AT-03 model layer)', () => {
    const r = applyCommand(card, { type: 'SET_LAYOUT', nodeId: 'payment-due-date', profile: 'paged', layout: { widthPct: 40, align: 'center' } });
    expect(r.ok && r.project.nodes.find((n) => n.id === 'payment-due-date')!.layout!.paged!.widthPct).toBe(40);
    expect(r.ok && r.project.nodes.find((n) => n.id === 'payment-due-date')!.layout!.html!.span).toBe(3); // HTML profile untouched
    expect(applyCommand(card, { type: 'SET_LAYOUT', nodeId: 'issuer-logo', profile: 'paged', layout: { xPt: 600 } }).ok).toBe(false);
  });

  it('rule ASTs are typed and allowlisted; rich text and URLs are sanitised', () => {
    expect(validatePredicate({ op: 'eq', path: 'card.missedPayments', value: 2 }, 'credit-statement')).toEqual([]);
    expect(validatePredicate({ op: 'eq', path: 'card.secret', value: 1 }, 'credit-statement')[0]).toMatch(/Unknown field/);
    expect(validatePredicate({ op: 'eq', path: 'card.tier', value: 'gold' }, 'credit-statement')[0]).toMatch(/not a valid/);
    expect(validatePredicate({ op: 'exec', path: 'x' } as any, 'credit-statement')[0]).toMatch(/Unsupported operator/);
    const { doc, problems } = sanitizeRichDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }, { type: 'script', text: 'x' }] }] });
    expect(problems.length).toBe(2);
    expect(JSON.stringify(doc)).not.toMatch(/javascript|script/);
    expect(isSafeUrl('https://example.com/pay')).toBe(true);
    expect(isSafeUrl('http://example.com')).toBe(false);
  });

  it('variants can be added to a conditional region and resolve by inline condition (AT-07 model layer)', () => {
    let p = card;
    const add = (cmd: any) => { const r = applyCommand(p, cmd); if (!r.ok) throw new Error(r.message); p = r.project; };
    add({ type: 'INSERT_NODE', node: defaultNode('conditional-region', 'promo-region', 'credit-statement'), parentId: 'doc-root' });
    add({ type: 'ADD_VARIANT', nodeId: 'promo-region', variantId: 'promo-premium', title: 'Premium', text: 'Premium note', when: { op: 'eq', path: 'card.tier', value: 'premium' } });
    add({ type: 'ADD_VARIANT', nodeId: 'promo-region', variantId: 'promo-overdue', title: 'Overdue', text: 'Overdue note', when: { op: 'eq', path: 'card.paymentStatus', value: 'overdue' } });
    add({ type: 'ADD_VARIANT', nodeId: 'promo-region', variantId: 'promo-default', title: 'Default', text: 'Default note' });
    add({ type: 'UPDATE_NODE', nodeId: 'promo-region', patch: { fallbackVariantId: 'promo-default' } });
    const r1 = resolve({ project: p, record: rec('CARD-0001') });
    const r2 = resolve({ project: p, record: rec('CARD-0002') });
    const sel = (r: any) => r.root.children.find((c: any) => c.id === 'promo-region').variants.selected;
    expect(sel(r1)).toEqual(['promo-default']);
    expect(sel(r2)).toEqual(['promo-premium']);
    expect(r1.root.children.find((c) => c.id === 'promo-region')!.variants!.items).toHaveLength(3);
  });
});
