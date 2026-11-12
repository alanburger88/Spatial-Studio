import { describe, expect, it } from 'vitest';
import { applyCommand, fromTranslationCsv, toTranslationCsv, translationStatus, checkTokens, parseCsv, type Project, type TranslationUsageEntry, usageEntryFromResolution } from '../src';
import { seedProjects, RECORDS } from '../src/fixtures';
import { resolve } from '@iss/resolver';

const aster = () => seedProjects().find((p) => p.projectId === 'aster-card-demo')!;

function usageFor(project: Project): TranslationUsageEntry[] {
  return (RECORDS as any[]).filter((r) => r.documentType === project.documentType).map((record) => usageEntryFromResolution(project, record, resolve({ project, record }) as any));
}

describe('translations', () => {
  it('reports status, mandatory flags and affected es-US records from real resolution', () => {
    const p = aster();
    const usage = usageFor(p);
    const st = translationStatus(p, 'es-US', usage);
    expect(st.summary.total).toBeGreaterThan(5);
    expect(st.summary.approved + st.summary.drafts + st.summary.missing).toBe(st.summary.total);
    expect(st.summary.approved).toBe(0);
    expect(st.summary.mandatoryMissing).toBeGreaterThan(0);
    // the resolver emits REQUIRED_TRANSLATION_MISSING for exactly the records we report as affected
    const spanish = (RECORDS as any[]).filter((r) => r.documentType === 'credit-statement' && r.customer.locale === 'es-US');
    const blocked = spanish.filter((r) => resolve({ project: p, record: r }).findings.some((f) => f.code === 'REQUIRED_TRANSLATION_MISSING')).map((r) => r.recordId).sort();
    const affected = [...new Set(st.rows.flatMap((r) => r.status.affectedRecordIds))].sort();
    expect(affected).toEqual(blocked);
    expect(st.summary.affectedRecords).toBe(blocked.length);
  });

  it('only lists parts the document uses and counts records that see them', () => {
    const p = aster();
    const st = translationStatus(p, 'es-US', usageFor(p));
    const ids = st.rows.map((r) => r.partId);
    expect(ids).toContain('payment-standard');
    expect(ids).not.toContain('eob-covered');
    expect(st.rows.find((r) => r.partId === 'sample-disclosure-set')!.status.mandatory).toBe(true);
    expect(st.rows.find((r) => r.partId === 'payment-standard')!.seenByRecords).toBeGreaterThan(0);
  });

  it('draft then approve moves status, bumps the version and resolves the finding', () => {
    let p = aster();
    const before = translationStatus(p).rows.find((r) => r.partId === 'billing-summary')!;
    expect(before.status.status).toBe('missing');
    const d = applyCommand(p, { type: 'SET_TRANSLATION_DRAFT', partId: 'billing-summary', locale: 'es-US', text: 'Saldo nuevo: {{card.newBalanceCents}}.' });
    expect(d.ok).toBe(true); p = (d as any).project;
    expect(translationStatus(p).rows.find((r) => r.partId === 'billing-summary')!.status.status).toBe('draft');
    const a = applyCommand(p, { type: 'APPROVE_TRANSLATION', partId: 'billing-summary', locale: 'es-US' });
    expect(a.ok).toBe(true); p = (a as any).project;
    const after = translationStatus(p).rows.find((r) => r.partId === 'billing-summary')!;
    expect(after.status.status).toBe('approved');
    expect(after.version).toBe(before.version + 1);
  });

  it('checks tokens as a multiset', () => {
    expect(checkTokens('A {{x.y}} {{a.b}}', 'B {{a.b}} {{x.y}}').ok).toBe(true);
    expect(checkTokens('A {{x.y}}', 'B').missing).toEqual(['x.y']);
    expect(checkTokens('A', 'B {{x.y}}').extra).toEqual(['x.y']);
  });

  it('exports CSV and imports it back as drafts with per-row errors', () => {
    const p = aster();
    const csv = toTranslationCsv(p, 'es-US');
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(['partId', 'title', 'mandatory', 'status', 'en-US', 'es-US']);
    expect(rows.length).toBeGreaterThan(5);
    const bad = [
      'partId,es-US',
      'billing-summary,"Saldo nuevo: {{card.newBalanceCents}}."',
      'payment-due,"Pago mínimo."',
      'nope,"Hola"',
      `payment-standard,"${'x'.repeat(4001)}"`,
      'payment-reminder,',
    ].join('\n');
    const r = fromTranslationCsv(p, bad, 'es-US');
    expect(r.drafts).toEqual([{ partId: 'billing-summary', text: 'Saldo nuevo: {{card.newBalanceCents}}.' }]);
    expect(r.errors.map((e) => e.code)).toEqual(['TOKEN_MISMATCH', 'UNKNOWN_ID', 'TOO_LONG']);
    expect(r.skipped).toBe(1);
    expect(fromTranslationCsv(p, 'a,b\n1,2', 'es-US').errors[0].code).toBe('BAD_HEADER');
  });
});
