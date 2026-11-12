import { describe, expect, it } from 'vitest';
import { seedProjects, RECORDS } from '../../model/src/fixtures';
import { resolve } from '@iss/resolver';
import { renderEmail, renderSms, smsEncoding, checkChannelParity } from '@iss/renderers';

const [card, eob] = seedProjects();
const rec = (id: string) => RECORDS.find((r) => r.recordId === id)!;
const all = (p: typeof card, id: string, overrides?: Record<string, unknown>) => {
  const res = resolve({ project: p, record: rec(id), overrides });
  const email = renderEmail(res, p); const sms = renderSms(res, p);
  return { res, email, sms, parity: checkChannelParity(res, email, sms) };
};

describe('email channel', () => {
  it('EOB with unconfirmed liability says THIS IS NOT A BILL and never shows an amount owed', () => {
    const { email, sms, parity } = all(eob, 'EOB-0002');
    expect(email.html).toContain('THIS IS NOT A BILL');
    expect(email.text).toContain('THIS IS NOT A BILL');
    expect(email.text).toMatch(/responsib[^\n]*: Not determined — under review/i);
    expect(email.text.split('\n').filter((l) => /responsib/i.test(l)).join('\n')).not.toContain('$');
    expect(email.html).toContain('Not determined — under review');
    expect(sms.text).toContain('NOT A BILL');
    expect(sms.text).not.toContain('$');
    expect(parity.ok).toBe(true);
  });

  it('card email amounts and dates equal the manifest', () => {
    const { res, email, sms, parity } = all(card, 'CARD-0001');
    expect(email.subject).toBe('Your Aster Card statement is ready — $45.00 minimum due Nov 25, 2026');
    for (const s of ['$1,248.00', '$45.00', 'Nov 25, 2026']) { expect(email.text).toContain(s); expect(email.html).toContain(s); }
    expect(res.semanticManifest.money['billing-summary']).toBe(124800);
    expect(sms.text).toContain('$1,248.00'); expect(sms.text).toContain('$45.00'); expect(sms.text).toContain('Nov 25, 2026');
    expect(parity.ok).toBe(true);
    expect(parity.checks.find((c) => c.id === 'money')!.status).toBe('match');
    // 12-row table is summarised, not listed
    expect(email.facts.summaries.some((s) => s.kind === 'table')).toBe(true);
    expect(email.html).not.toContain('<thead>');
  });

  it('is client-safe: no scripts/forms/external assets, 600px role=presentation tables, lang, alt text', () => {
    const { email } = all(card, 'CARD-0001');
    expect(email.html).not.toMatch(/<script|<form|<iframe|<link|@import|url\(/i);
    expect(email.html).not.toMatch(/(src|href)="http:/);
    expect(email.html).not.toMatch(/src="https?:/);
    expect(email.html).toContain('width="600"');
    expect(email.html).toContain('role="presentation"');
    expect(email.html).toContain('lang="en-US"');
    expect(email.html).toMatch(/<img [^>]*src="data:image\/svg\+xml;base64,[^"]+"[^>]*alt="[^"]+"/);
    expect(email.html).toContain('<h1');
    expect(email.html).toContain('DEMO DATA');
  });

  it('escapes data', () => {
    const { email } = all(card, 'CARD-0001', { customer: { givenName: '<script>x</script>' } });
    expect(email.html).not.toContain('<script>x');
  });

  it('uses approved es-US text when the model has it and warns about English chrome', () => {
    const p = structuredClone(card);
    for (const c of p.contentParts) c.approvedLocales['es-US'] = `ES-APROBADO ${c.id}`;
    const res = resolve({ project: p, record: rec('CARD-0005') });
    const email = renderEmail(res, p);
    expect(res.locale).toBe('es-US');
    expect(email.html).toContain('lang="es-US"');
    expect(email.text).toContain('ES-APROBADO');
    expect(email.warnings.join(' ')).toMatch(/es-US/);
    expect(email.text).toContain('25 nov 2026');
  });
});

describe('sms channel', () => {
  it('segment maths: GSM-7 160/153 and UCS-2 70/67', () => {
    expect(smsEncoding('a'.repeat(160))).toMatchObject({ encoding: 'GSM-7', length: 160, segments: 1 });
    expect(smsEncoding('a'.repeat(161))).toMatchObject({ encoding: 'GSM-7', segments: 2 });
    expect(smsEncoding('a'.repeat(306))).toMatchObject({ segments: 2 });
    expect(smsEncoding('a'.repeat(307))).toMatchObject({ segments: 3 });
    expect(smsEncoding('€'.repeat(80))).toMatchObject({ encoding: 'GSM-7', length: 160, segments: 1 }); // extension = 2 septets
    const u = smsEncoding('Pago vencido á' + 'a'.repeat(56)); // 14 + 56 = 70
    expect(u).toMatchObject({ encoding: 'UCS-2', length: 70, segments: 1 });
    expect(u.nonGsm.map((n) => n.char)).toEqual(['á']);
    expect(smsEncoding('á' + 'a'.repeat(70))).toMatchObject({ encoding: 'UCS-2', length: 71, segments: 2 });
    expect(smsEncoding('á' + 'a'.repeat(134))).toMatchObject({ length: 135, segments: 3 });
  });

  it('card SMS has amount, due date, link and DEMO; EOB SMS does not imply a bill', () => {
    const c = all(card, 'CARD-0001').sms;
    expect(c.text).toMatch(/^DEMO /); expect(c.encoding).toBe('GSM-7'); expect(c.segments).toBe(1);
    expect(c.text).toContain('https://example.com/aster/payments');
    const e = all(eob, 'EOB-0002').sms;
    expect(e.text).toMatch(/^DEMO /); expect(e.text).toContain('THIS IS NOT A BILL');
  });

  it('a non-GSM issuer name forces UCS-2 and names the character in a warning', () => {
    const p = structuredClone(card); p.issuer.name = 'Aster Card™';
    const s = renderSms(resolve({ project: p, record: rec('CARD-0001') }), p);
    expect(s.encoding).toBe('UCS-2');
    expect(s.nonGsm[0].char).toBe('™');
    expect(s.warnings.join(' ')).toContain('™');
  });
});
