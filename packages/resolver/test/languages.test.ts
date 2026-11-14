import { describe, expect, it } from 'vitest';
import { applyCommand, channelConfig, defaultChannels, localizeProject, projectLanguages, richFromMarkup, richToMarkup, translatableStrings, translationStatus, type Project } from '../../model/src';
import { recordById, seedProjects } from '../../model/src/fixtures';
import { formatCents, formatDate, resolve } from '../src';
import { renderEmail, renderSms } from '../../renderers/src';

const [card, eob] = seedProjects();
const rec = recordById('CARD-0001')!;
const run = (p: Project, cmd: Parameters<typeof applyCommand>[1]): Project => { const r = applyCommand(p, cmd); if (!r.ok) throw new Error(`${cmd.type}: ${r.message}`); return r.project; };
const texts = (n: any): string => [n.field?.label, n.field?.display, ...(n.text ?? []).flatMap((b: any) => (b.inlines ?? []).map((i: any) => i.text)), ...(n.children ?? []).map(texts)].filter(Boolean).join(' ');

describe('languages and formatting', () => {
  it('keeps English and Spanish (US) formatting exactly as before and follows other languages’ conventions', () => {
    expect(formatCents(124800, 'en-US')).toBe('$1,248.00');
    expect(formatCents(124800, 'es-US')).toBe('$1,248.00');
    expect(formatDate('2026-11-25', 'en-US')).toBe('Nov 25, 2026');
    expect(formatDate('2026-09-05', 'es-US')).toBe('5 sept 2026');
    expect(formatCents(124800, 'de-DE')).toBe('1.248,00 $');
    expect(formatCents(-124800, 'fr-FR')).toBe('−1 248,00 $');
    expect(formatDate('2026-11-25', 'fr-FR')).toBe('25 nov. 2026');
    expect(formatDate('2026-03-05', 'af-ZA')).toBe('5 Mrt. 2026');
    expect(formatDate('2026-03-05', 'not-a-language')).toBe('Mar 5, 2026');
  });

  it('older projects have Spanish (US) as their one target language; languages can be added and removed', () => {
    expect(projectLanguages(card)).toEqual(['es-US']);
    const p = run(card, { type: 'ADD_LANGUAGE', locale: 'fr-FR' });
    expect(projectLanguages(p)).toEqual(['es-US', 'fr-FR']);
    expect(applyCommand(p, { type: 'ADD_LANGUAGE', locale: 'fr-FR' }).ok).toBe(false);
    expect(applyCommand(p, { type: 'ADD_LANGUAGE', locale: 'ar-SA' }).ok).toBe(false); // right-to-left: not in the list
    expect(applyCommand(p, { type: 'ADD_LANGUAGE', locale: 'en-US' }).ok).toBe(false);
    expect(applyCommand(p, { type: 'REMOVE_LANGUAGE', locale: 'es-US' }).ok).toBe(false); // rule R07 selects it
    expect(projectLanguages(run(p, { type: 'REMOVE_LANGUAGE', locale: 'fr-FR' }))).toEqual(['es-US']);
    expect(applyCommand(card, { type: 'SET_TRANSLATION_DRAFT', partId: 'payment-standard', locale: 'fr-FR', text: 'Bonjour' }).ok).toBe(false); // not a project language yet
  });
});

describe('translatable strings', () => {
  it('lists every customer-visible text outside content parts, with stable ids', () => {
    const ids = translatableStrings(card).map((s) => s.id);
    for (const id of ['@billing-summary/label', '@statement-title/content', '@greeting/content', '@transaction-table/caption', '@transaction-table/col.date', '@email/subject', '@email/title', '@sms/text']) expect(ids, id).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((i) => i.startsWith('@issuer-logo/') && i !== '@issuer-logo/image.alt')).toBe(false);
    expect(translatableStrings(eob).map((s) => s.id)).toContain('@email/preheader');
  });

  it('rich text survives the markup round trip used for translation', () => {
    const doc = card.nodes.find((n) => n.id === 'greeting')!.content!;
    const markup = richToMarkup(doc);
    expect(markup).toContain('{{customer.givenName}}');
    expect(richToMarkup(richFromMarkup(markup))).toBe(markup);
    expect(richToMarkup(card.nodes.find((n) => n.id === 'statement-title')!.content)).toMatch(/^# Monthly account statement/);
  });

  it('drafts, approval, token check and origin marking work for strings exactly like for content parts', () => {
    let p = run(card, { type: 'SET_TRANSLATION_DRAFTS', locale: 'es-US', origin: 'ai', items: [{ id: '@billing-summary/label', text: 'Saldo nuevo' }, { id: 'payment-standard', text: 'Su pago vence el {{card.dueDate}}.' }] });
    let row = translationStatus(p, 'es-US').rows.find((r) => r.partId === '@billing-summary/label')!;
    expect(row).toMatchObject({ kind: 'string', group: 'labels', origin: 'ai' });
    expect(row.status.status).toBe('draft');
    expect(translationStatus(p, 'es-US').rows.find((r) => r.partId === 'payment-standard')!.origin).toBe('ai');
    // a person editing the draft clears the AI mark
    p = run(p, { type: 'SET_TRANSLATION_DRAFT', partId: '@billing-summary/label', locale: 'es-US', text: 'Nuevo saldo' });
    expect(translationStatus(p, 'es-US').rows.find((r) => r.partId === '@billing-summary/label')!.origin).toBeUndefined();
    p = run(p, { type: 'APPROVE_TRANSLATION', partId: '@billing-summary/label', locale: 'es-US' });
    expect(p.strings!['@billing-summary/label']).toEqual({ approved: { 'es-US': 'Nuevo saldo' }, basedOn: { 'es-US': 'New balance' } });
    // tokens must match the English text
    p = run(p, { type: 'SET_TRANSLATION_DRAFT', partId: '@greeting/content', locale: 'es-US', text: 'Hola, aquí está su estado de cuenta.' });
    const bad = applyCommand(p, { type: 'APPROVE_TRANSLATION', partId: '@greeting/content', locale: 'es-US' });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.code).toBe('TOKEN_MISMATCH');
    // the English label changing later is flagged
    p = run(p, { type: 'UPDATE_NODE', nodeId: 'billing-summary', patch: { label: 'Statement balance' } });
    expect(translationStatus(p, 'es-US').rows.find((r) => r.partId === '@billing-summary/label')!.sourceChanged).toBe(true);
  });
});

describe('document language in the resolver', () => {
  const spanish = { customer: { locale: 'es-US' } };

  it('an untouched project resolves exactly as before, apart from a note that labels are still English', () => {
    const res = resolve({ project: card, record: rec, overrides: spanish });
    expect(res.locale).toBe('es-US');
    expect(res.findings.filter((f) => f.severity === 'blocking').every((f) => f.code === 'REQUIRED_TRANSLATION_MISSING')).toBe(true);
    const note = res.findings.find((f) => f.code === 'TRANSLATION_MISSING_TEXT')!;
    expect(note.severity).toBe('warning');
    expect(res.result.diagnostics.some((d) => d.code === 'TRANSLATION_MISSING_TEXT')).toBe(false); // never part of the core result
    expect(texts(res.root)).toContain('New balance');
    expect(resolve({ project: card, record: rec }).findings.some((f) => f.source === 'translation')).toBe(false);
  });

  it('approved translations are shown; drafts only in previews, reported, and never in a clean run', () => {
    let p = run(card, { type: 'SET_TRANSLATION_DRAFT', partId: '@billing-summary/label', locale: 'es-US', text: 'Saldo nuevo' });
    p = run(p, { type: 'APPROVE_TRANSLATION', partId: '@billing-summary/label', locale: 'es-US' });
    p = run(p, { type: 'SET_TRANSLATION_DRAFT', partId: '@payment-due/label', locale: 'es-US', text: 'Pago mínimo' });
    p = run(p, { type: 'SET_TRANSLATION_DRAFT', partId: 'payment-standard', locale: 'es-US', text: 'Su pago vence el {{card.dueDate}}.' });
    const clean = resolve({ project: p, record: rec, overrides: spanish });
    expect(texts(clean.root)).toContain('Saldo nuevo');
    expect(texts(clean.root)).not.toContain('Pago mínimo');
    expect(clean.translation.draftsShown).toEqual([]);
    const preview = resolve({ project: p, record: rec, overrides: spanish, includeDrafts: true });
    expect(texts(preview.root)).toContain('Pago mínimo');
    expect(preview.translation.draftsShown.sort()).toEqual(['@payment-due/label', 'payment-standard']);
    expect(preview.findings.some((f) => f.code === 'UNAPPROVED_TRANSLATION_SHOWN')).toBe(true);
    // the draft does not lift the obligation: the document is still blocked until a person approves
    expect(preview.findings.some((f) => f.code === 'REQUIRED_TRANSLATION_MISSING' && f.nodeId === 'payment-standard')).toBe(true);
    expect(preview.runId).not.toBe(clean.runId);
    expect(preview.result.resultDigest).toBe(clean.result.resultDigest);
  });

  it('a language added to the project applies to customers who prefer it, without writing a rule', () => {
    const p = run(eob, { type: 'ADD_LANGUAGE', locale: 'fr-FR' });
    const r = recordById('EOB-0001')!;
    const fr = resolve({ project: p, record: r, overrides: { customer: { locale: 'fr-FR' } } });
    expect(fr.locale).toBe('fr-FR');
    expect(fr.findings.some((f) => f.code === 'REQUIRED_TRANSLATION_MISSING' && f.locale === 'fr-FR')).toBe(true);
    // not a project language: the document stays in English
    expect(resolve({ project: eob, record: r, overrides: { customer: { locale: 'fr-FR' } } }).findings.some((f) => f.code === 'REQUIRED_TRANSLATION_MISSING')).toBe(false);
  });
});

describe('email and SMS wording', () => {
  it('the defaults reproduce the previous fixed wording', () => {
    const res = resolve({ project: card, record: rec });
    expect(renderEmail(res, card).subject).toBe('Your Aster Card statement is ready — $45.00 minimum due Nov 25, 2026');
    expect(renderSms(res, card).text).toMatch(/^DEMO Aster Card: Your statement is ready\. New balance \$1,248\.00; minimum due \$45\.00 by Nov 25, 2026\. https:\/\//);
    const e = resolve({ project: eob, record: recordById('EOB-0001')! });
    expect(renderEmail(e, eob).subject).toMatch(/Explanation of Benefits is ready — this is not a bill$/);
    expect(renderEmail(e, eob).preheader.startsWith('THIS IS NOT A BILL. ')).toBe(true);
    expect(channelConfig(card)).toEqual(defaultChannels(card));
  });

  it('edited wording, section choices and translations reach the email and the SMS', () => {
    const base = defaultChannels(card);
    let p = run(card, { type: 'SET_CHANNELS', channels: { email: { ...base.email, subject: 'Statement for {{customer.givenName}}: {{card.minimumDueCents}} due', intro: 'Thank you for being a customer.', closing: 'Questions? Reply to this email.', sections: [{ id: 'actions', show: true }, { id: 'keyFacts', show: true }, { id: 'messages', show: true }, { id: 'tables', show: false }, { id: 'summaries', show: false }] }, sms: { text: '{{issuer.name}}: {{card.minimumDueCents}} due {{card.dueDate}}. {{link}}' } } });
    const res = resolve({ project: p, record: rec });
    const email = renderEmail(res, p);
    expect(email.subject).toBe('Statement for Jordan: $45.00 due');
    expect(email.html).toContain('Thank you for being a customer.');
    expect(email.text).toContain('Questions? Reply to this email.');
    expect(email.html.indexOf('Review payment options')).toBeLessThan(email.html.indexOf('Key facts')); // actions moved first
    expect(email.html).not.toContain('Transactions this period'); // tables and their summaries switched off
    expect(renderSms(res, p).text).toMatch(/^Aster Card: \$45\.00 due Nov 25, 2026\. https:/);
    // unknown data fields and markup are refused
    expect(applyCommand(p, { type: 'SET_CHANNELS', channels: { ...channelConfig(p), sms: { text: 'Pay {{card.nope}}' } } }).ok).toBe(false);
    expect(applyCommand(p, { type: 'SET_CHANNELS', channels: { ...channelConfig(p), sms: { text: '<b>Pay</b>' } } }).ok).toBe(false);
    // Spanish wording, approved, is used for a Spanish document
    p = run(p, { type: 'SET_TRANSLATION_DRAFT', partId: '@sms/text', locale: 'es-US', text: '{{issuer.name}}: {{card.minimumDueCents}} vence el {{card.dueDate}}. {{link}}' });
    p = run(p, { type: 'APPROVE_TRANSLATION', partId: '@sms/text', locale: 'es-US' });
    expect(renderSms(resolve({ project: p, record: rec, overrides: { customer: { locale: 'es-US' } } }), p).text).toMatch(/^Aster Card: \$45\.00 vence el 25 nov 2026\./);
    expect(localizeProject(p, 'es-US').channels.sms.text).toContain('vence el');
  });

  it('without a link the sentence part that held it is dropped', () => {
    const noLink = { ...card, nodes: card.nodes.filter((n) => n.type !== 'action-link' && n.type !== 'qr-code').map((n) => ({ ...n, children: n.children?.filter((c) => !['payment-action', 'payment-qr'].includes(c)) })) } as Project;
    const text = renderSms(resolve({ project: noLink, record: rec }), noLink).text;
    expect(text).not.toContain('{{');
    expect(text.endsWith('2026.')).toBe(true);
  });
});
