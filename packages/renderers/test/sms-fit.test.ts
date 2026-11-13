import { describe, expect, it } from 'vitest';
import { defaultChannels } from '@iss/model';
import { seedProjects } from '../../model/src/fixtures';
import { fitSms } from '../src/smsFit';
import { smsEncoding } from '../src/sms';

const [card, eob] = seedProjects();
/** Fills the tokens with the longest realistic values, the way the studio measures a text message. */
const longest = (t: string): string => t
  .replace(/\{\{\s*issuer\.name\s*\}\}/g, 'HarborCare Health')
  .replace(/\{\{\s*card\.newBalanceCents\s*\}\}/g, '$12,345.67')
  .replace(/\{\{\s*card\.minimumDueCents\s*\}\}/g, '$1,234.00')
  .replace(/\{\{\s*card\.dueDate\s*\}\}/g, 'Sep 25, 2026')
  .replace(/\{\{\s*claim\.claimId\s*\}\}/g, 'HC-10428')
  .replace(/\{\{\s*link\s*\}\}/g, 'https://example.com/harborcare/claims');
/** The same for the card statement: its own issuer name and payment link. */
const longestCard = (t: string): string => longest(t.replace(/\{\{\s*issuer\.name\s*\}\}/g, 'Aster Card').replace(/\{\{\s*link\s*\}\}/g, 'https://example.com/aster/payments'));
const tokens = (t: string): string[] => t.match(/\{\{[^}]*\}\}/g) ?? [];
/** The bundled Spanish sample wording of the statement SMS (apps/api/src/sampleTranslations.ts). */
const SPANISH_SAMPLE = 'DEMO {{issuer.name}}: Su estado de cuenta ya se puede consultar. Saldo nuevo {{card.newBalanceCents}}; pago requerido {{card.minimumDueCents}} antes del {{card.dueDate}}. {{link}}';

describe('fitSms', () => {
  it('leaves the default English wording alone: it already fits one part', () => {
    for (const p of [card, eob]) {
      const text = defaultChannels(p).sms.text;
      const fit = fitSms(text, { sample: longest });
      expect(fit).toMatchObject({ text, changes: [], fits: true });
      expect(fit.before).toEqual(fit.after);
      expect(fit.before).toMatchObject({ segments: 1, encoding: 'GSM-7' });
      expect(fit.before.length).toBe(smsEncoding(longest(text)).length); // measured on the filled message, not the template
    }
  });

  it('leaves the bundled Spanish wording alone, and removes only the accents the SMS alphabet lacks from an accented one', () => {
    expect(fitSms(SPANISH_SAMPLE, { sample: longestCard })).toMatchObject({ text: SPANISH_SAMPLE, changes: [], fits: true });

    const accented = 'DEMO {{issuer.name}}: Señor, su estado de cuenta ya está listo. Saldo nuevo {{card.newBalanceCents}}; pago mínimo {{card.minimumDueCents}} antes del {{card.dueDate}}. {{link}}';
    const fit = fitSms(accented, { sample: longestCard });
    expect(fit.before).toMatchObject({ encoding: 'UCS-2', segments: 3 });
    expect(fit.text).toBe('DEMO {{issuer.name}}: Señor, su estado de cuenta ya esta listo. Saldo nuevo {{card.newBalanceCents}}; pago minimo {{card.minimumDueCents}} antes del {{card.dueDate}}. {{link}}');
    expect(fit.changes).toEqual(['Removed accents the standard SMS alphabet does not have (á to a, í to i); ñ stayed because the alphabet has it']);
    expect(fit.after).toMatchObject({ encoding: 'GSM-7', segments: 1 });
    expect(fit.fits).toBe(true);
    // é, ü and ñ are in the alphabet: a text with only those is not touched at all
    expect(fitSms('José Müller, año nuevo')).toMatchObject({ text: 'José Müller, año nuevo', changes: [], fits: true });
  });

  it('replaces curly quotes, long dashes and the ellipsis character, and stops as soon as the message fits', () => {
    const fit = fitSms('“Hello” — your statement’s ready…  Pay now!!  {{link}}');
    expect(fit.text).toBe('"Hello" - your statement\'s ready...  Pay now!!  {{link}}'); // the double spaces stay: it already fits
    expect(fit.changes).toEqual([
      'Replaced curly apostrophes and single quotes with straight ones',
      'Replaced curly double quotes with straight ones',
      'Replaced long dashes with hyphens',
      'Replaced the single “…” character with three full stops',
    ]);
    expect(fit.before.encoding).toBe('UCS-2');
    expect(fit.after).toMatchObject({ encoding: 'GSM-7', segments: 1 });
    expect(fit.fits).toBe(true);
    expect(fitSms('Saldo nuevo • pago pendiente')).toMatchObject({ text: 'Saldo nuevo - pago pendiente', fits: true });
  });

  it('then removes extra spaces and repeated punctuation, only when the message is still too long', () => {
    const text = `Pay  now ,  please!!   ${'More words to make this message a little longer. '.repeat(3)}`;
    const fit = fitSms(text);
    expect(fit.before).toMatchObject({ encoding: 'GSM-7', segments: 2 });
    expect(fit.text).toBe(`Pay now, please! ${'More words to make this message a little longer. '.repeat(3)}`.trim());
    expect(fit.changes).toEqual(['Removed extra spaces', 'Removed repeated punctuation']);
    expect(fit.fits).toBe(false); // still two parts: the best attempt is returned, nothing is dropped
  });

  it('uses common English short forms one at a time and only as many as needed', () => {
    const one = 'DEMO {{issuer.name}}: Your benefits summary is ready and you do not need to pay today. THIS IS NOT A BILL. Details: https://example.com/minimum-and-more/is-not';
    const a = fitSms(one, { sample: longest });
    expect(a.before).toMatchObject({ length: 161, segments: 2 });
    expect(a.text).toBe('DEMO {{issuer.name}}: Your benefits summary is ready and you don\'t need to pay today. THIS IS NOT A BILL. Details: https://example.com/minimum-and-more/is-not');
    expect(a.changes).toEqual(['Used short forms such as “isn’t” and “don’t”']); // "and" stays: one change was enough
    expect(a.after).toMatchObject({ length: 160, segments: 1, encoding: 'GSM-7' });
    expect(a.fits).toBe(true);

    const three = 'DEMO {{issuer.name}}: Your statement is ready and the minimum due is {{card.minimumDueCents}} by {{card.dueDate}}. You do not need to do anything. {{link}}';
    const b = fitSms(three, { sample: longest });
    expect(b.before).toMatchObject({ length: 167, segments: 2 });
    expect(b.text).toBe('DEMO {{issuer.name}}: Your statement is ready & the min due is {{card.minimumDueCents}} by {{card.dueDate}}. You don\'t need to do anything. {{link}}');
    expect(b.changes).toEqual(['Used short forms such as “isn’t” and “don’t”', 'Replaced “and” with “&”', 'Shortened “minimum” to “min”']);
    expect(b.fits).toBe(true);
    expect(tokens(b.text)).toEqual(tokens(three));
  });

  it('never alters tokens, web addresses or wording in capitals such as THIS IS NOT A BILL', () => {
    const text = 'DEMO {{issuer.name}}: Your Explanation of Benefits for claim {{ claim.claimId }} is ready and we have included the minimum information you need. It is not a request for payment and you do not need to do anything now. THIS IS NOT A BILL. Details: https://example.com/Minimum-and-more/it-is-not?information=1.';
    const fit = fitSms(text, { sample: longest });
    expect(fit.before.segments).toBe(2);
    expect(fit.fits).toBe(false);
    expect(fit.text).toBe(text); // no short form would bring it down to one part, so nothing is abbreviated
    expect(fit.text).toContain('THIS IS NOT A BILL.');
    expect(fit.text).toContain('https://example.com/Minimum-and-more/it-is-not?information=1.');
    expect(tokens(fit.text)).toEqual(['{{issuer.name}}', '{{ claim.claimId }}']);
    // the capitals of another language are protected in the same way
    const es = fitSms('Ya está: su reclamo — ESTO NO ES UNA FACTURA. Más información en https://example.com/más/información {{link}}');
    expect(es.text).toBe('Ya esta: su reclamo - ESTO NO ES UNA FACTURA. Mas informacion en https://example.com/más/información {{link}}');
    expect(es.fits).toBe(false); // the address itself has letters outside the alphabet, and addresses are never changed
    const pt = fitSms('ISTO NÃO É UMA FATURA. Veja os detalhes da sua conta.');
    expect(pt).toMatchObject({ text: 'ISTO NÃO É UMA FATURA. Veja os detalhes da sua conta.', changes: [], fits: false });
  });

  it('returns the best attempt with fits: false when the message cannot fit, without dropping a sentence or abbreviating for nothing', () => {
    const text = `DEMO {{issuer.name}}: ${'Your statement is ready and the minimum payment is due. '.repeat(8)}{{link}}`;
    const fit = fitSms(text, { sample: longest });
    expect(fit.fits).toBe(false);
    expect(fit.after.segments).toBeGreaterThan(1);
    expect(fit.text.split('. ').length).toBe(text.split('. ').length);
    expect(fit.text).toBe(text); // short forms would not save a part here, so the wording is left as written
    expect(fit.changes).toEqual([]);
    // Spanish is never given English short forms
    const es = fitSms(`DEMO: ${'Su estado de cuenta ya se puede consultar and el pago minimum vence pronto. '.repeat(3)}`);
    expect(es.changes).toEqual(['Removed extra spaces']);
    expect(es.text).toContain(' and el pago minimum ');
  });

  it('honours maxSegments and is deterministic', () => {
    const text = 'DEMO {{issuer.name}}: Your Explanation of Benefits for claim {{claim.claimId}} is ready and we have included the minimum information you need. THIS IS NOT A BILL. Details: {{link}}';
    expect(fitSms(text, { sample: longest }).fits).toBe(false);
    const two = fitSms(text, { sample: longest, maxSegments: 2 });
    expect(two).toMatchObject({ text, changes: [], fits: true });
    expect(two.after.segments).toBe(2);
    expect(fitSms(text, { sample: longest, maxSegments: 2 })).toEqual(two);
    expect(fitSms('')).toMatchObject({ text: '', changes: [], fits: true });
  });
});
