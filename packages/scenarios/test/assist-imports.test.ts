import { describe, expect, it } from 'vitest';
import { applyCommand, blankProject, parseCsv, toTranslationCsv, translationStatus, type Command, type Project } from '@iss/model';
import { seedProjects } from '../../model/src/fixtures';

import { planFieldsImport, planWordingImport, readWordingFile, fieldsImportRefusal, ownTypeOf } from '../src';

const [card, eob] = seedProjects();
const run = (p: Project, ...cs: Command[]): Project => cs.reduce((q, c) => { const r = applyCommand(q, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; }, p);
const apply = (p: Project, c: Command | null): Project => { expect(c).not.toBeNull(); return run(p, c!); };
const csvCell = (t: string) => (/[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
const toCsv = (rows: string[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/** The card with a few Spanish drafts and one approved Spanish text. */
function spanishCard(): Project {
  const rows = translationStatus(card, 'es-US').rows;
  const [a, b, c] = rows.filter((r) => r.kind === 'part' && r.status.status !== 'approved');
  let p = run(card, { type: 'SET_TRANSLATION_DRAFTS', locale: 'es-US', items: [{ id: a.partId, text: 'Borrador A' }, { id: b.partId, text: 'Borrador B' }, { id: c.partId, text: 'Aprobado C' }] });
  p = run(p, { type: 'APPROVE_TRANSLATION', partId: c.partId, locale: 'es-US' });
  return p;
}

describe('import wording: the inverse of the studio’s own CSV export', () => {
  it('export, then import: no changes', () => {
    const p = spanishCard();
    const csv = toTranslationCsv(p, 'es-US');
    const t = readWordingFile('﻿' + csv, p);
    expect(t.kind).toBe('studio-csv');
    expect(t.columns.map((c) => c.role)).toEqual(['id', 'title', 'ignore', 'ignore', 'english', 'language']);
    const plan = planWordingImport(p, t);
    expect(plan.command).toBeNull();
    expect(plan.counts).toMatchObject({ drafts: 0, english: 0, newMessages: 0, unmatched: 0 });
    expect(plan.counts.unchanged).toBeGreaterThan(0);
  });

  it('export, edit, import: exactly the edits, as drafts with origin “imported”, in one undoable step', () => {
    const p = spanishCard();
    const rows = parseCsv(toTranslationCsv(p, 'es-US'));
    const missing = rows.findIndex((r, i) => i > 0 && r[3] === 'missing' && !r[0].startsWith('@'));
    const draft = rows.findIndex((r) => r[3] === 'draft');
    const label = rows.findIndex((r) => r[0].startsWith('@') && r[3] === 'missing' && !/\{/.test(r[4]));
    rows[missing][5] = rows[missing][4].replace(/^/, 'ES: ');
    rows[draft][5] = 'Borrador editado';
    rows[label][5] = 'Etiqueta';
    const plan = planWordingImport(p, readWordingFile(toCsv(rows), p));
    expect(plan.counts.drafts).toBe(3);
    expect(plan.rows.flatMap((r) => r.changes).map((c) => c.id).sort()).toEqual([rows[missing][0], rows[draft][0], rows[label][0]].sort());
    const after = apply(p, plan.command);
    expect(after.modelVersion).toBe(p.modelVersion + 1);
    for (const id of [rows[missing][0], rows[draft][0], rows[label][0]]) expect(after.translationOrigins?.[`es-US|${id}`]).toBe('imported');
    const st = translationStatus(after, 'es-US');
    expect(st.rows.find((r) => r.partId === rows[draft][0])!.status.draftText).toBe('Borrador editado');
    // nothing was approved by the import
    expect(st.summary.approved).toBe(translationStatus(p, 'es-US').summary.approved);
    // and importing the same file again changes nothing
    expect(planWordingImport(after, readWordingFile(toCsv(rows), after)).command).toBeNull();
  });

  it('never overwrites an approved translation silently; it can add a draft beside it when asked', () => {
    const p = spanishCard();
    const rows = parseCsv(toTranslationCsv(p, 'es-US'));
    const i = rows.findIndex((r) => r[3] === 'approved' && !r[0].startsWith('@'));
    rows[i][5] = 'Cambiado';
    const t = readWordingFile(toCsv(rows), p);
    const plan = planWordingImport(p, t);
    expect(plan.command).toBeNull();
    expect(plan.rows[i - 1].skipped[0].reason).toMatch(/approved Spanish translation, which an import never replaces/);
    const over = planWordingImport(p, t, { draftOverApproved: true });
    const after = apply(p, over.command);
    const row = translationStatus(after, 'es-US').rows.find((r) => r.partId === rows[i][0])!;
    expect(row.status).toMatchObject({ status: 'approved', approvedText: 'Aprobado C', draftText: 'Cambiado', pendingDraft: true });
  });
});

describe('import wording: a plain spreadsheet', () => {
  const part = card.contentParts.find((c) => c.id === 'payment-reminder')!;
  it('detects id, English and language columns (a new language is added)', () => {
    const t = readWordingFile(toCsv([['Key', 'English', 'French', 'Notes'], ['payment-reminder', part.approvedLocales['en-US']!, 'Rappel de paiement {{card.dueDate}}', 'x']]), card);
    expect(t.kind).toBe('plain-csv');
    expect(t.columns.map((c) => [c.role, c.locale ?? null])).toEqual([['id', null], ['english', null], ['language', 'fr-FR'], ['ignore', null]]);
    const plan = planWordingImport(card, t);
    expect(plan.languages).toEqual([{ locale: 'fr-FR', name: 'French (France)', added: true, drafts: 1 }]);
    const after = apply(card, plan.command);
    expect(after.languages).toContain('fr-FR');
    expect(after.contentParts.find((c) => c.id === 'payment-reminder')!.draftLocales?.['fr-FR']).toBe('Rappel de paiement {{card.dueDate}}');
  });

  it('matches by id first, then by English text: exact and likely are taken, a guess must be accepted', () => {
    const en = part.approvedLocales['en-US']!;
    const t = readWordingFile(toCsv([['id', 'en-US', 'es-US'], ['', en, 'Exacto'], ['', `  ${en.toUpperCase()}!! `, 'Probable'], ['', en.split(' ').slice(0, -2).join(' ') + ' soon please', 'Quizás'], ['', 'Nothing like this at all here', 'Nada']]), card);
    const plan = planWordingImport(card, t);
    expect(plan.rows.map((r) => r.match?.how ?? null)).toEqual(['exact', 'likely', expect.anything(), null]);
    expect(plan.rows[1].skipped[0]?.reason ?? '').toMatch(/already gives this text/);
    const guess = plan.rows[2];
    if (guess.match?.how === 'guess') {
      expect(guess.decision).toBe('unmatched');
      expect(planWordingImport(card, t, { decisions: { 2: { kind: 'accept' } } }).rows[2].decision).toBe('accept');
    }
    expect(plan.rows[3].decision).toBe('unmatched');
  });

  it('unmatched rows can become a new message or an alternative of a chosen message', () => {
    const t = readWordingFile(toCsv([['English', 'Spanish'], ['Thank you for banking with us.', 'Gracias por confiar en nosotros.'], ['Call us if you need help.', 'Llámenos si necesita ayuda.']]), card);
    const plan = planWordingImport(card, t, { decisions: { 0: { kind: 'new-message' }, 1: { kind: 'alternative', nodeId: 'payment-guidance' } } });
    expect(plan.counts).toMatchObject({ newMessages: 1, alternatives: 1, drafts: 2 });
    const after = apply(card, plan.command);
    const node = after.nodes.find((n) => n.id === plan.rows[0].changes[0].id)!;
    expect(node.type).toBe('variant-set');
    expect(after.contentParts.find((c) => c.id === node.fallbackVariantId)!.approvedLocales['en-US']).toBe('Thank you for banking with us.');
    const alt = plan.rows[1].changes[0].id;
    expect(after.nodes.find((n) => n.id === 'payment-guidance')!.variantIds).toContain(alt);
    expect(after.contentParts.find((c) => c.id === alt)!.draftLocales?.['es-US']).toBe('Llámenos si necesita ayuda.');
  });

  it('changes English of a message matched by id, but never of a disclosure, a label or fixed wording', () => {
    const disclosure = card.contentParts.find((c) => c.type === 'disclosure')!;
    const t = readWordingFile(toCsv([['id', 'English'], ['payment-reminder', 'Please pay by {{card.dueDate}}.'], [disclosure.id, 'Changed'], ['@sys/pageOf', 'Page {page}']]), card);
    const plan = planWordingImport(card, t);
    expect(plan.counts.english).toBe(1);
    expect(plan.rows[1].skipped[0].reason).toMatch(/approved disclosure text/);
    const after = apply(card, plan.command);
    expect(after.contentParts.find((c) => c.id === 'payment-reminder')!.approvedLocales['en-US']).toBe('Please pay by {{card.dueDate}}.');
    expect(planWordingImport(card, t, { applyEnglish: false }).counts.english).toBe(0);
  });

  it('skips linked library wording with the reason', () => {
    const linked = run(card, { type: 'LINK_LIBRARY_ITEM', item: { id: 'late-notice', kind: 'wording', title: 'Late payment notice' }, version: 1, content: { part: { id: 'late', title: 'Late', type: 'text', approvedLocales: { 'en-US': 'Late.' } } }, placement: { partId: 'payment-reminder' } });
    const plan = planWordingImport(linked, readWordingFile(toCsv([['id', 'es-US'], ['payment-reminder', 'Tarde.']]), linked));
    expect(plan.command).toBeNull();
    expect(plan.rows[0].skipped[0].reason).toMatch(/comes from the library item “Late payment notice”/);
  });

  it('checks placeholders against the English and the document’s fields, per row', () => {
    const t = readWordingFile(toCsv([['id', 'es-US'], ['payment-reminder', 'Pague antes de {{card.noSuchField}}']]), card);
    const plan = planWordingImport(card, t);
    expect(plan.rows[0].problems.join(' ')).toMatch(/\{\{card\.noSuchField\}\}, which is not a data field/);
    expect(plan.rows[0].problems.join(' ')).toMatch(/does not use the same placeholders as the English/);
    // still imported as a draft (approval will refuse it until fixed)
    expect(plan.counts.drafts).toBe(1);
  });

  it('refuses XML with a document type, and reads its own XLIFF', () => {
    expect(readWordingFile('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><xliff></xliff>', card).problems[0]).toMatch(/does not read/);
    const t = readWordingFile('<?xml version="1.0" encoding="UTF-8"?>\n<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en-US" trgLang="es-US"><file id="w"><unit id="u1" name="payment-reminder"><segment state="final"><source>x</source><target>Hola &amp; adiós</target></segment></unit></file></xliff>', card);
    expect(t.kind).toBe('xliff');
    expect(t.rows).toEqual([['payment-reminder', 'x', 'Hola & adiós']]);
  });
});

describe('import fields', () => {
  const blank = (): Project => run(blankProject({ projectId: 'own', title: 'Own' }), { type: 'SET_CUSTOM_FIELDS', fields: [{ key: 'planName', label: 'Plan name', type: 'string', required: true, example: 'Flex' }] });

  it('reads types (saying what an unrecognised one was read as), clashes and examples', () => {
    const csv = toCsv([['Field Name', 'Data Type', 'Description', 'Sample'], ['monthly_fee', 'money', 'Fee', '$49.00'], ['RenewalDate', 'DATE', '', '2026-12-01'], ['visits', 'integer', '', 'many'], ['tier', 'choice: basic|plus|pro', '', 'plus'], ['auto renew', 'yes/no', '', 'yes'], ['plan name', 'string', 'dup', ''], ['photo', 'blob', '', ''], ['sessions', 'list', '', '']]);
    const plan = planFieldsImport(blank(), csv);
    expect(plan.refused).toBeNull();
    expect(plan.columns).toMatchObject({ name: 'Field Name', type: 'Data Type', description: 'Description', example: 'Sample' });
    const by = (n: string) => plan.proposals.find((p) => p.name === n)!;
    expect(by('monthly_fee')).toMatchObject({ type: 'cents', field: { key: 'monthlyFee', label: 'Monthly fee', example: '4900' }, example: 4900, skip: null });
    expect(by('RenewalDate').field).toMatchObject({ key: 'renewalDate', type: 'date', example: '2026-12-01' });
    expect(by('visits')).toMatchObject({ type: 'int', example: null, exampleProblem: 'The example “many” is not a whole number.' });
    expect(by('tier').field).toMatchObject({ type: 'enum', enumValues: ['basic', 'plus', 'pro'], example: 'plus' });
    expect(by('auto renew').field).toMatchObject({ key: 'autoRenew', type: 'bool' });
    expect(by('plan name').skip).toMatch(/clashes with the existing field “Plan name”/);
    expect(by('photo').typeNote).toBe('“blob” is not a type the studio knows: read as text.');
    expect(by('sessions').skip).toMatch(/A list needs its columns/);
    const after = apply(blank(), plan.command);
    expect(after.customFields!.map((f) => f.key)).toEqual(['planName', 'monthlyFee', 'renewalDate', 'visits', 'tier', 'autoRenew', 'photo']);
    expect(plan.exampleCustomer!.record.custom).toEqual({ planName: 'Flex', monthlyFee: 4900, renewalDate: '2026-12-01', tier: 'plus', autoRenew: true });
  });

  it('a required field without an example stops the example customer, and says why', () => {
    const plan = planFieldsImport(blank(), 'name,type,required\nmemberNumber,string,yes\n');
    expect(plan.exampleCustomer).toBeNull();
    expect(plan.exampleCustomerNote).toMatch(/“Member number” is required and has no example/);
  });

  it('is refused for the built-in kinds, with the reason', () => {
    for (const p of [card, eob]) {
      expect(fieldsImportRefusal(p)).toMatch(/built-in ones, fixed so that its sample customers and rules keep working/);
      expect(planFieldsImport(p, 'name\nx\n').command).toBeNull();
    }
    expect(ownTypeOf('decimal(10,2)').type).toBe('cents');
    expect(ownTypeOf('timestamp').note).toMatch(/time of day is not kept/);
  });
});
