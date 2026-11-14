import { describe, expect, it } from 'vitest';
import { RECORDS, seedProjects } from '@iss/model/fixtures';
import { resolve } from '@iss/resolver';
import type { SyntheticRecord } from '@iss/model';
import { assistantModelContext } from '../src/assistant';

/** What the live model is told about customers. No model is called here. */
describe('assistant: context sent to the live model', () => {
  const project = seedProjects().find((p) => p.projectId === 'aster-card-demo')!;
  const cards = RECORDS.filter((r) => r.documentType === 'credit-statement');
  const ctxFor = (records: SyntheticRecord[], recordId: string) => {
    const record = records.find((r) => r.recordId === recordId)!;
    return assistantModelContext({ project, records, recordId, overrides: {}, journeyCursor: null, selectedNodeId: 'payment-guidance' }, resolve({ project, record }));
  };

  it('names the customer the user is looking at, so "Morgan Santos" can be recognised', () => {
    const c = ctxFor(cards, 'CARD-0005');
    const morgan = cards.find((r) => r.recordId === 'CARD-0005')!;
    const name = `${morgan.customer.givenName} ${morgan.customer.familyName}`;
    expect(name).toBe('Morgan Santos');
    expect(c.currentCustomer).toMatchObject({ id: 'CARD-0005', name, locale: 'es-US' });
    expect(c.currentCustomer!.persona).toBeTruthy();
    expect(c.records[0]).toMatchObject({ id: 'CARD-0005', name });
  });

  it('lists every sample customer by name so another customer can be found by name', () => {
    const c = ctxFor(cards, 'CARD-0001');
    expect(c.records).toHaveLength(cards.length);
    expect(c.records.every((r) => typeof r.name === 'string' && r.name.includes(' '))).toBe(true);
    expect(c.records.find((r) => r.id === 'CARD-0002')!.name).toBe('Taylor Rivers');
    expect(c.records.every((r) => r.id.startsWith('CARD-'))).toBe(true);
  });

  it('never sends the name of a customer a person imported', () => {
    const imported: SyntheticRecord = { ...cards[0], recordId: 'CARD-5001', imported: true, customer: { ...cards[0].customer, givenName: 'Real', familyName: 'Person' } };
    const c = ctxFor([...cards, imported], 'CARD-5001');
    expect(c.currentCustomer).toMatchObject({ id: 'CARD-5001', name: 'the selected customer' });
    expect(JSON.stringify(c)).not.toContain('Real Person');
    expect(c.records.find((r) => r.id === 'CARD-5001')!.name).toBeUndefined();
  });

  it('keeps the current customer in the list even when the list is cut short', () => {
    const many: SyntheticRecord[] = [...cards];
    for (let i = 0; many.length < 200; i++) many.push({ ...cards[i % cards.length], recordId: `CARD-${60001 + i}` });
    const last = many[many.length - 1].recordId;
    const c = ctxFor(many, last);
    expect(c.records).toHaveLength(150);
    expect(c.records[0].id).toBe(last);
    expect(c.currentCustomer!.id).toBe(last);
  });
});
