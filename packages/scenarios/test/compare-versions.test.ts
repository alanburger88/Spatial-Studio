import { describe, expect, it } from 'vitest';
import { applyCommand, type Command, type Project } from '@iss/model';
import { resolve } from '@iss/resolver';
import { RECORDS, seedProjects } from '../../model/src/fixtures';
import { COMPARISON_OUTCOMES, compareVersions, outcomeOf, visibleChanges, type VisibleChange } from '../src/compareVersions';

const [card, eob] = seedProjects();
const run = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; };
const cardRecords = RECORDS.filter((r) => r.documentType === 'credit-statement');
const total = (c: ReturnType<typeof compareVersions>) => COMPARISON_OUTCOMES.reduce((n, o) => n + c.groups[o].length, 0);

describe('before and after', () => {
  it('reports no visible change for identical versions, for every customer of the document’s kind', () => {
    const c = compareVersions(card, card, RECORDS);
    expect(c.identical).toBe(true);
    expect(c.evaluated).toBe(cardRecords.length);
    expect(c.groups.same.length).toBe(cardRecords.length);
    expect(c.customers.every((x) => x.changes.length === 0)).toBe(true);
    expect(c.styleChanged).toBe(false);
    expect(compareVersions(eob, eob, RECORDS).evaluated).toBe(RECORDS.length - cardRecords.length);
  });

  it('a rule change shows as a different message, only for the customers it reaches', () => {
    // R03 loses its second condition and outranks R04: customers with two or more missed payments get another message.
    const r3 = card.rules.find((r) => r.id === 'R03')!;
    const after = run(card, { type: 'UPSERT_RULE', rule: { ...r3, when: { op: 'gte', path: 'card.missedPayments', value: 2 }, priority: 900 } });
    const c = compareVersions(card, after, RECORDS);
    expect(c.identical).toBe(false);
    expect(total(c)).toBe(cardRecords.length);
    expect(c.groups.message.length).toBeGreaterThan(0);
    expect(c.groups.same.length).toBeGreaterThan(0);
    // Exactly the customers whose selected alternative differs between the two versions.
    const expected = cardRecords.filter((r) => JSON.stringify(resolve({ project: card, record: r }).result.selectedVariants) !== JSON.stringify(resolve({ project: after, record: r }).result.selectedVariants)).map((r) => r.recordId);
    expect([...c.groups.message].sort()).toEqual(expected.sort());
    const one = c.customers.find((x) => x.outcome === 'message')!;
    const change = one.changes.find((x) => x.kind === 'message')!;
    expect(change.nodeId).toBe('payment-guidance');
    expect(change.before).not.toBe(change.after);
    expect(change.before.length).toBeGreaterThan(0);
    expect(change.after.length).toBeGreaterThan(0);
  });

  it('a wording change shows as wording, with the words before and after, for the customers who get that message', () => {
    const part = card.contentParts.find((p) => p.id === 'payment-standard')!;
    const was = part.approvedLocales['en-US'];
    const after = run(card, { type: 'UPSERT_CONTENT_PART', part: { ...part, approvedLocales: { ...part.approvedLocales, 'en-US': `${was} Thank you.` } }, advanced: true, reason: 'test' });
    const c = compareVersions(card, after, RECORDS);
    expect(c.groups.message).toEqual([]);
    expect(c.groups.wording.length).toBeGreaterThan(0);
    expect(c.groups.wording.length).toBeLessThan(cardRecords.length);
    const w = c.customers.find((x) => x.outcome === 'wording')!.changes.find((x) => x.kind === 'wording')!;
    expect(w.after).toContain('Thank you.');
    expect(w.after.match(/Thank you\./g)!.length).toBe(1);
    expect(w.before).not.toContain('Thank you.');
    // Everyone who gets the standard message and nobody else (a customer whose language has no approved translation of it reads the English).
    for (const x of c.customers) {
      const res = resolve({ project: card, record: cardRecords.find((r) => r.recordId === x.recordId)! });
      const gets = Object.values(res.result.selectedVariants).includes('payment-standard');
      expect(x.outcome === 'wording', x.recordId).toBe(gets);
    }
  });

  it('removing a part shows as “disappears”; a new blocker shows as “now stopped”', () => {
    const gone = run(card, { type: 'DELETE_NODE', nodeId: 'payment-guidance' });
    const c = compareVersions(card, gone, RECORDS);
    expect(c.groups.structure.length + c.groups.stopped.length + c.groups.unstopped.length).toBe(cardRecords.length);
    expect(c.customers.some((x) => x.changes.some((ch) => ch.kind === 'disappears' && ch.nodeId === 'payment-guidance' && ch.before.length > 0 && ch.after === ''))).toBe(true);

    const noFallback = run(card, { type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: undefined } });
    const r3 = card.rules.find((r) => r.id === 'R03')!;
    const tie = run(noFallback, { type: 'UPSERT_RULE', rule: { ...r3, when: { op: 'gte', path: 'card.missedPayments', value: 2 }, priority: 400 } });
    const t = compareVersions(card, tie, RECORDS);
    expect(t.groups.stopped.length).toBeGreaterThan(0);
    for (const id of t.groups.stopped) { const x = t.customers.find((k) => k.recordId === id)!; expect(x.stoppedBefore).toBe(false); expect(x.stoppedAfter).toBe(true); expect(x.changes.find((k) => k.kind === 'stopped')!.after.length).toBeGreaterThan(0); }
    // And the other way round.
    expect(compareVersions(tie, card, RECORDS).groups.unstopped.sort()).toEqual([...t.groups.stopped].sort());
  });

  it('a brand change alone changes no words and is reported as a style change for the whole document', () => {
    const after = run(card, { type: 'SET_BRAND', brand: { primary: '#0B3D2E', accent: '#123456', fontFamily: 'Georgia' } });
    const c = compareVersions(card, after, RECORDS);
    expect(c.identical).toBe(false);
    expect(c.styleChanged).toBe(true);
    expect(c.groups.message.length + c.groups.wording.length + c.groups.structure.length).toBe(0);
  });

  it('email and SMS wording changes are reported for every customer', () => {
    const res = resolve({ project: card, record: cardRecords[0] });
    const again = resolve({ project: card, record: cardRecords[0] });
    expect(visibleChanges(res, again)).toEqual([]);
    expect(outcomeOf([])).toBe('same');
    expect(outcomeOf([{ kind: 'layout', nodeId: 'x', name: 'X', before: '', after: '' }])).toBe('layout');
    expect(outcomeOf([{ kind: 'email-sms', nodeId: '@sms', name: 'Text message', before: 'a', after: 'b' }])).toBe('wording');
  });
});

describe('a part replaced by an identical one under another id', () => {
  const change = (kind: VisibleChange['kind'], nodeId: string, name: string, before: string, after: string): VisibleChange => ({ kind, nodeId, name, before, after });
  // Two resolutions built by hand: the same text in a part with a new id (as when a block is linked again to the library).
  const res = (id: string, text: string, layout: unknown) => ({
    locale: 'en-US', findings: [], channelTexts: { subject: '', preheader: '', title: '', intro: [], closing: [], sections: [], sms: '' },
    root: { id: 'root', name: 'Page', type: 'container', visible: true, children: [{ id, name: 'Rights notice', type: 'rich-text', visible: true, children: [], text: [{ inlines: [{ kind: 'text', text }] }], layout }] },
  }) as never;

  it('is not a visible difference when the words and the layout are the same', () => {
    expect(visibleChanges(res('notice', 'You have the right to a paper copy.', { mode: 'flow' }), res('notice-2', 'You have the right to a paper copy.', { mode: 'flow' }))).toEqual([]);
    // (with different words the same pair is two differences, so the parts are being read)
    expect(visibleChanges(res('notice', 'A.', { mode: 'flow' }), res('notice-2', 'B.', { mode: 'flow' }))).toHaveLength(2);
  });
  it('is one layout difference when only its layout differs, and stays two differences when the words differ', () => {
    expect(visibleChanges(res('notice', 'Same words.', { mode: 'flow' }), res('notice-2', 'Same words.', { mode: 'flow', widthPt: 200 }))).toEqual([change('layout', 'notice-2', 'Rights notice', '', '')]);
    expect(visibleChanges(res('notice', 'Old words.', { mode: 'flow' }), res('notice-2', 'New words.', { mode: 'flow' })).map((c) => c.kind).sort()).toEqual(['appears', 'disappears']);
  });
});
