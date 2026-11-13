import { describe, expect, it } from 'vitest';
import { applyCommand, translationStatus, type Command, type Project } from '@iss/model';
import { seedProjects } from '../../model/src/fixtures';
import { SAMPLE_TRANSLATIONS } from '../../../apps/api/src/sampleTranslations';
import { checkTranslations, glossaryInstructions } from '../src/assist/translationQa';

const [card, eob] = seedProjects();
const run = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; };
/** The bundled Spanish sample set as drafts: a complete, careful translation of every text. */
function spanish(p: Project): Project {
  const sample = SAMPLE_TRANSLATIONS[p.projectId]['es-US'];
  const rows = new Set(translationStatus(p, 'es-US').rows.map((r) => r.partId));
  return run(p, { type: 'SET_TRANSLATION_DRAFTS', locale: 'es-US', origin: 'sample', items: Object.keys(sample).filter((id) => rows.has(id)).map((id) => ({ id, text: sample[id] })) });
}
const draft = (p: Project, id: string, text: string): Project => run(p, { type: 'SET_TRANSLATION_DRAFT', partId: id, locale: 'es-US', text });
const cardEs = spanish(card), eobEs = spanish(eob);
const kinds = (p: Project, ids?: string[]) => checkTranslations(p, 'es-US', ids ? { ids } : undefined).map((f) => `${f.textId}:${f.kind}`);

describe('checkTranslations', () => {
  it('has nothing to say about texts without a translation, or about a careful complete translation', () => {
    expect(checkTranslations(card, 'es-US')).toEqual([]);
    expect(checkTranslations(cardEs, 'es-US')).toEqual([]);
    expect(checkTranslations(eobEs, 'es-US')).toEqual([]);
    expect(translationStatus(cardEs, 'es-US').summary.drafts).toBeGreaterThan(100); // …and that was a real set, not an empty one
  });

  it('length: a label that grew a lot may not fit; longer texts get more room', () => {
    let p = draft(cardEs, '@billing-summary/label', 'El saldo nuevo total de su cuenta de tarjeta');
    p = draft(p, '@payment-due/label', 'Pago mínimo que se adeuda'); // longer, but not by much: fine
    p = draft(p, 'payment-reminder', 'Notamos que su pago programado aún no ha llegado a nuestra oficina central y por eso le enviamos este recordatorio amable para que lo revise cuando pueda hacerlo.');
    const flags = checkTranslations(p, 'es-US');
    expect(flags.map((f) => `${f.textId}:${f.kind}:${f.severity}`)).toEqual(['payment-reminder:length:info', '@billing-summary/label:length:warning']);
    expect(flags[1].message).toBe('The Spanish text is 44 characters and the English is 11. It may not fit in the space this label or heading has.');
    expect(flags.every((f) => f.source === 'builtin')).toBe(true);
  });

  it('glossary: flags a text whose English has the term but whose translation lacks the preferred wording', () => {
    const g = run(cardEs, { type: 'SET_GLOSSARY', locale: 'es-US', entries: [{ source: 'Statement', target: 'estado de cuenta', note: 'never “extracto”' }, { source: 'payment', target: 'pago' }] });
    // the sample set already says "estado de cuenta" wherever the customer's statement is meant; {{card.statementStart}} is a token, not the word
    const baseline = kinds(g);
    expect(baseline).toEqual(['@sys/metaDescriptionStatement:glossary']); // "a real financial statement" is worded "estado financiero"
    const p = draft(g, '@email/title', 'Su extracto está listo');
    const flags = checkTranslations(p, 'es-US', { ids: ['@email/title', '@statement-title/content'] });
    expect(flags).toEqual([{ textId: '@email/title', kind: 'glossary', severity: 'warning', source: 'builtin', message: 'The glossary says to translate “Statement” as “estado de cuenta”, but this text does not use that wording.' }]);
    expect(glossaryInstructions(g, 'es-US')).toEqual(['Translate “Statement” as “estado de cuenta” (never “extracto”)', 'Translate “payment” as “pago”']);
    expect(glossaryInstructions(g, 'fr-FR')).toEqual([]);
    expect(glossaryInstructions(card, 'es-US')).toEqual([]);
  });

  it('inconsistent-term: the same English text with two translations, and a label term another text does not use', () => {
    // "Plan paid" is a figure label, a chart series and a table column
    const dup = checkTranslations(draft(eobEs, '@claim-table/col.planPaidCents', 'Plan pagó'), 'es-US');
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({ textId: '@claim-table/col.planPaidCents', kind: 'inconsistent-term', severity: 'warning' });
    expect(dup[0].message).toBe('The same English text “Plan paid” is translated as “Pagado por el plan” in “Plan paid · label” and as “Plan pagó” here. Use one Spanish wording for both.');

    // "Claim" is the label "Reclamo"; one sentence about the claim calls it something else
    const term = checkTranslations(draft(eobEs, 'eob-review-needed', 'Este siniestro requiere revisión; no considere los cargos en revisión como una factura.'), 'es-US');
    expect(term.map((f) => `${f.textId}:${f.kind}:${f.severity}`)).toEqual(['eob-review-needed:inconsistent-term:info']);
    expect(term[0].message).toMatch(/^“Claim” is translated as “Reclamo” in “.+” and in \d+ other texts, but this text reads “Este siniestro requiere/);
  });

  it('untranslated: a sentence or two-word label left in English, but not single words or names', () => {
    let p = draft(cardEs, 'payment-reminder', 'We noticed your scheduled payment has not yet arrived.');
    p = draft(p, '@billing-summary/label', 'New balance');
    p = draft(p, '@transaction-table/col.date', 'Date'); // one word: could be the same in another language
    p = draft(p, '@running-header/headerFooter', card.nodes.find((n) => n.id === 'running-header')!.headerFooter!.text); // "Aster Card statement · tokens": one real word besides the name
    expect(kinds(p)).toEqual(['payment-reminder:untranslated', '@billing-summary/label:untranslated']);
    expect(checkTranslations(p, 'es-US')[0].message).toBe('The Spanish text is the same as the English. It may not have been translated.');
  });

  it('number-mismatch: digits outside tokens must be the same; grouping marks may differ', () => {
    const part = cardEs.contentParts.find((c) => c.id === 'payment-reminder')!;
    const en = run(cardEs, { type: 'UPSERT_CONTENT_PART', part: { ...part, approvedLocales: { ...part.approvedLocales, 'en-US': 'Your payment is 30 days late. Pay 1,000 points by day 15 at https://example.com/pay/24.' } } });
    const bad = checkTranslations(draft(en, 'payment-reminder', 'Su pago tiene 15 días de atraso. Pague 1.000 puntos antes del día 15 en https://example.com/pay/7.'), 'es-US', { ids: ['payment-reminder'] });
    expect(bad).toEqual([{ textId: 'payment-reminder', kind: 'number-mismatch', severity: 'warning', source: 'builtin', message: 'The numbers differ from the English: 30 is in the English but not in the translation; 15 is only in the translation.' }]);
    expect(checkTranslations(draft(en, 'payment-reminder', 'Su pago tiene 30 días de atraso. Pague 1.000 puntos antes del día 15 en https://example.com/pagar/7.'), 'es-US', { ids: ['payment-reminder'] })).toEqual([]);
  });

  it('punctuation: a question stays a question; Spanish opening marks are fine', () => {
    expect(kinds(cardEs, ['@interest-explainer/explanation.title'])).toEqual([]); // "¿Cómo se muestra el pago mínimo?"
    const p = draft(cardEs, '@interest-explainer/explanation.title', 'Cómo se muestra el pago mínimo');
    const flags = checkTranslations(p, 'es-US');
    expect(flags).toEqual([{ textId: '@interest-explainer/explanation.title', kind: 'punctuation', severity: 'info', source: 'builtin', message: 'The English ends with a question mark, but the translation does not.' }]);
  });

  it('sms-encoding: only the text message, only characters outside the SMS alphabet', () => {
    const p = draft(cardEs, '@sms/text', 'DEMO {{issuer.name}}: Su estado de cuenta ya está listo — saldo {{card.newBalanceCents}}; mínimo {{card.minimumDueCents}} antes del {{card.dueDate}}. Señor, {{link}}');
    const flags = checkTranslations(p, 'es-US');
    expect(flags.map((f) => `${f.textId}:${f.kind}:${f.severity}`)).toEqual(['@sms/text:sms-encoding:warning']);
    expect(flags[0].message).toBe('The text message uses “á”, “—”, “í”, which are not in the standard SMS alphabet. The message is then sent in parts of 70 characters instead of 160 and may cost more.');
    // ñ and the braces of the tokens are fine; accents in any other text are never an SMS matter
    expect(kinds(draft(cardEs, '@sms/text', 'DEMO {{issuer.name}}: Señor, su saldo es {{card.newBalanceCents}}; pague {{card.minimumDueCents}} antes del {{card.dueDate}}. {{link}}'))).toEqual([]);
  });

  it('checks approved text when there is no draft, orders by text then kind, honours ids and never judges meaning', () => {
    let p = draft(cardEs, '@interest-explainer/explanation.title', 'How is the minimum payment shown');
    p = draft(p, 'payment-reminder', 'We noticed your scheduled payment has not yet arrived.');
    p = run(p, { type: 'APPROVE_TRANSLATIONS', locale: 'es-US', ids: ['payment-reminder'] });
    expect(translationStatus(p, 'es-US').rows.find((r) => r.partId === 'payment-reminder')!.status.draftText).toBeUndefined();
    const all = checkTranslations(p, 'es-US');
    expect(all.map((f) => `${f.textId}:${f.kind}`)).toEqual(['payment-reminder:untranslated', '@interest-explainer/explanation.title:punctuation']);
    // a text with two flags lists them by kind
    const two = draft(p, '@interest-explainer/explanation.title', 'How is the minimum payment shown? It is an illustrative sample value that we show for the demonstration');
    expect(kinds(two, ['@interest-explainer/explanation.title'])).toEqual(['@interest-explainer/explanation.title:length', '@interest-explainer/explanation.title:punctuation']);
    expect(kinds(p, ['@interest-explainer/explanation.title'])).toEqual(['@interest-explainer/explanation.title:punctuation']);
    expect(kinds(p, [])).toEqual([]);
    expect(all.some((f) => f.kind === 'meaning')).toBe(false);
    expect(checkTranslations(p, 'es-US')).toEqual(all);
    expect(checkTranslations(p, 'fr-FR')).toEqual([]);
  });
});
