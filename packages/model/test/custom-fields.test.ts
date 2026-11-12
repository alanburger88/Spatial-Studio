import { describe, expect, it } from 'vitest';
import { applyCommand, csvToRecords, customFieldDefs, prepareImport, projectFieldIndex, validateRule } from '../src';
import { seedProjects, RECORDS } from '../src/fixtures';
import { resolve } from '@iss/resolver';

const aster = () => seedProjects().find((p) => p.projectId === 'aster-card-demo')!;

describe('custom data fields', () => {
  it('adds a validated custom field, lets rules use it, and blocks removing it while in use', () => {
    const bad = applyCommand(aster(), { type: 'SET_CUSTOM_FIELDS', fields: [{ key: '9x', label: 'Bad', type: 'enum', enumValues: [] }] });
    expect(bad.ok).toBe(false);
    const ok = applyCommand(aster(), { type: 'SET_CUSTOM_FIELDS', fields: [{ key: 'segment', label: 'Customer segment', type: 'enum', enumValues: ['gold', 'standard'] }] });
    expect(ok.ok).toBe(true);
    const p1 = (ok as any).project;
    expect(projectFieldIndex(p1).get('custom.segment')).toMatchObject({ type: 'enum', label: 'Customer segment' });
    const rule = { ...p1.rules.find((r: any) => r.id === 'R06'), when: { op: 'eq', path: 'custom.segment', value: 'gold' } };
    expect(validateRule(rule, p1)).toEqual([]);
    expect(validateRule({ ...rule, when: { op: 'eq', path: 'custom.segment', value: 'platinum' } }, p1).join(' ')).toMatch(/not a valid/);
    const p2 = (applyCommand(p1, { type: 'UPSERT_RULE', rule }) as any).project;
    const removed = applyCommand(p2, { type: 'SET_CUSTOM_FIELDS', fields: [] });
    expect(removed).toMatchObject({ ok: false, code: 'FIELD_IN_USE' });
    // a record carrying custom.segment = gold now gets the relationship section via R06
    const rec = structuredClone(RECORDS.find((r) => r.recordId === 'CARD-0001')!) as any;
    rec.custom = { segment: 'gold' };
    const res = resolve({ project: p2, record: rec });
    expect(res.result.matchedRuleIds).toContain('R06');
  });

  it('imports CSV columns for custom fields when the target project declares them', () => {
    const extra = customFieldDefs([{ key: 'segment', label: 'Customer segment', type: 'enum', enumValues: ['gold', 'standard'], required: true }]);
    const base = RECORDS.find((r) => r.recordId === 'CARD-0001')! as any;
    const head = 'customer.givenName,customer.familyName,customer.locale,card.maskedAccount,card.statementStart,card.statementEnd,card.issuedAt,card.dueDate,card.previousBalanceCents,card.purchasesCents,card.paymentsCreditsCents,card.interestFeesCents,card.newBalanceCents,card.minimumDueCents,custom.segment';
    const vals = (seg: string) => ['Ana', 'Diaz', 'en-US', base.card.maskedAccount, base.card.statementStart, base.card.statementEnd, base.card.issuedAt, base.card.dueDate, base.card.previousBalanceCents, base.card.purchasesCents, base.card.paymentsCreditsCents, base.card.interestFeesCents, base.card.newBalanceCents, base.card.minimumDueCents, seg].join(',');
    expect(csvToRecords(`${head}\n${vals('gold')}\n`, 'credit-statement').headerErrors.join(' ')).toMatch(/Unknown column “custom.segment”/);
    const parsed = csvToRecords(`${head}\n${vals('gold')}\n${vals('vip')}\n`, 'credit-statement', extra);
    expect(parsed.headerErrors).toEqual([]);
    const rows = prepareImport(parsed.records, 'credit-statement', 0, extra);
    expect(rows[0].record?.recordId).toBe('CARD-5001');
    expect((rows[0].record as any).custom).toEqual({ segment: 'gold' });
    expect(rows[1].errors.join(' ')).toMatch(/vip/);
  });
});
