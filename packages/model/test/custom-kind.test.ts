import { describe, expect, it } from 'vitest';
import {
  applyCommand, blankProject, channelConfig, COMPONENT_CATALOG, csvToRecords, customFieldDefs, customFieldUsage, defaultChannels, defaultNode,
  defaultPresentationProfiles, DOCUMENT_TYPE_LABEL, DOCUMENT_TYPES, fieldsFor, getPath, buildContext, NEUTRAL_ACCENT, prepareImport, projectFieldIndex,
  projectFileProblems, projectFromTemplate, projectLanguages, SCHEMA_VERSION, systemStringKeysFor, SYSTEM_STRINGS, templateContentOf, projectFromSavedTemplate,
  TEMPLATES, translatableStrings, validateCustomFields, validatePredicate, validateRecordShape, validateRule,
  type ComponentType, type CustomField, type Project,
} from '../src';
import { seedProjects } from '../src/fixtures';
import { resolve } from '@iss/resolver';
import { GYM_FIELDS, gymMember, gymProject, run, SAMPLE_WORDING } from './helpers/customProject';

const listField = (over: Partial<CustomField> = {}): CustomField => ({ key: 'items', label: 'Order lines', type: 'list', itemFields: [{ key: 'name', label: 'Item', type: 'string' }, { key: 'priceCents', label: 'Price', type: 'cents' }], ...over });

describe('the third kind of document: “Your own data”', () => {
  it('is one of three kinds, each with a label a person reads', () => {
    expect(DOCUMENT_TYPES).toEqual(['credit-statement', 'eob', 'custom']);
    expect(DOCUMENT_TYPE_LABEL).toEqual({ 'credit-statement': 'Credit-card statement', eob: 'Explanation of benefits', custom: 'Your own data' });
  });

  it('has only the customer fields as standard fields: no card, member or claim data', () => {
    const paths = fieldsFor('custom').map((f) => f.path);
    expect(paths).toEqual(['documentType', 'recordId', 'customer.givenName', 'customer.familyName', 'customer.locale', 'customer.accessibility.largeText', 'customer.accessibility.highContrast', 'customer.middleName']);
    expect(fieldsFor('custom').find((f) => f.path === 'documentType')!.enumValues).toEqual(['custom']);
    // the two built-in kinds keep their own lists, untouched
    expect(fieldsFor('credit-statement').find((f) => f.path === 'documentType')!.enumValues).toEqual(['credit-statement', 'eob']);
    expect(fieldsFor('credit-statement').some((f) => f.path === 'card.newBalanceCents')).toBe(true);
    expect(fieldsFor('eob').some((f) => f.path === 'claim.status')).toBe(true);
  });
});

describe('list data fields', () => {
  it('validates the columns: 1 to 8, unique keys, the same key rule as a data field, four column types', () => {
    expect(validateCustomFields('custom', [listField()])).toEqual([]);
    expect(validateCustomFields('credit-statement', [listField()])).toEqual([]);
    expect(validateCustomFields('custom', [listField({ itemFields: [] })]).join(' ')).toMatch(/needs at least one column/);
    expect(validateCustomFields('custom', [listField({ itemFields: undefined })]).join(' ')).toMatch(/needs at least one column/);
    const nine = Array.from({ length: 9 }, (_, i) => ({ key: `c${i}`, label: `Column ${i}`, type: 'string' as const }));
    expect(validateCustomFields('custom', [listField({ itemFields: nine })]).join(' ')).toMatch(/at most 8 columns/);
    expect(validateCustomFields('custom', [listField({ itemFields: nine.slice(0, 8) })])).toEqual([]);
    expect(validateCustomFields('custom', [listField({ itemFields: [{ key: 'a', label: 'A', type: 'string' }, { key: 'a', label: 'Again', type: 'int' }] })]).join(' ')).toMatch(/column key “a” twice/);
    expect(validateCustomFields('custom', [listField({ itemFields: [{ key: '1st', label: 'First', type: 'string' }] })]).join(' ')).toMatch(/must start with a letter/);
    expect(validateCustomFields('custom', [listField({ itemFields: [{ key: 'ok', label: 'Flag', type: 'bool' as never }] })]).join(' ')).toMatch(/must be text, a whole number, an amount or a date/);
    expect(validateCustomFields('custom', [listField({ itemFields: [{ key: 'ok', label: '', type: 'string' }] })]).join(' ')).toMatch(/needs a label/);
    expect(validateCustomFields('custom', [listField({ dimension: true })]).join(' ')).toMatch(/cannot be a comparison dimension/);
    expect(validateCustomFields('custom', [{ key: 'plain', label: 'Plain', type: 'string', itemFields: [] }]).join(' ')).toMatch(/not a list/);
  });

  it('becomes a collection with its columns plus a derived row count that rules can test', () => {
    const defs = customFieldDefs([listField()]);
    expect(defs).toEqual([
      { path: 'custom.items', type: 'array', label: 'Order lines', required: false, itemFields: [{ key: 'name', type: 'string', label: 'Item' }, { key: 'priceCents', type: 'cents', label: 'Price' }] },
      { path: 'custom.items.count', type: 'int', label: 'Order lines count', derived: true },
    ]);
    const fields = new Map(defs.map((f) => [f.path, f]));
    expect(validatePredicate({ op: 'gt', path: 'custom.items.count', value: 2 }, fields)).toEqual([]);
    expect(validatePredicate({ op: 'gt', path: 'custom.items', value: 2 }, fields).join(' ')).toMatch(/Use custom.items.count/);
    // evaluated like card.transactions.count: the number of rows
    const ctx = buildContext(gymMember());
    expect(getPath(ctx, 'custom.sessions.count')).toBe(2);
    expect(getPath(buildContext(gymMember({ custom: { sessions: [] } })), 'custom.sessions.count')).toBe(0);
  });

  it('works for a card project too, and a rule on the row count keeps the list from being removed', () => {
    const card = seedProjects().find((p) => p.documentType === 'credit-statement')!;
    const p1 = run(card, { type: 'SET_CUSTOM_FIELDS', fields: [listField()] });
    expect(projectFieldIndex(p1).get('custom.items')!.type).toBe('array');
    const rule = { id: 'R90', scope: 'credit-statement' as const, mode: 'additive' as const, priority: 10, when: { op: 'gt' as const, path: 'custom.items.count', value: 1 }, then: { op: 'setPresentationHint' as const, hint: 'many-order-lines' }, version: 1, title: 'Several order lines' };
    expect(validateRule(rule, p1)).toEqual([]);
    const p2 = run(p1, { type: 'UPSERT_RULE', rule });
    expect(customFieldUsage(p2)).toEqual([{ path: 'custom.items.count', where: ['rule R90'] }]);
    // keeping the list keeps its row count: the edit is accepted
    expect(applyCommand(p2, { type: 'SET_CUSTOM_FIELDS', fields: [listField({ label: 'Lines' })] }).ok).toBe(true);
    expect(applyCommand(p2, { type: 'SET_CUSTOM_FIELDS', fields: [] })).toMatchObject({ ok: false, code: 'FIELD_IN_USE' });
    // a list turned into a plain field no longer has a row count
    expect(applyCommand(p2, { type: 'SET_CUSTOM_FIELDS', fields: [{ key: 'items', label: 'Order lines', type: 'string' }] })).toMatchObject({ ok: false, code: 'FIELD_IN_USE' });
    expect(applyCommand(card, { type: 'SET_CUSTOM_FIELDS', fields: [listField({ itemFields: [] })] })).toMatchObject({ ok: false, code: 'INVALID_FIELDS' });
  });

  it('is checked row by row in a customer record; a CSV cannot carry it and says so', () => {
    const extra = customFieldDefs(GYM_FIELDS);
    expect(validateRecordShape(gymMember(), 'custom', extra)).toEqual([]);
    expect(validateRecordShape(gymMember({ custom: { sessions: 'two' } }), 'custom', extra).join(' ')).toMatch(/Booked sessions \(custom.sessions\) must be a list/);
    expect(validateRecordShape(gymMember({ custom: { sessions: [{ day: 'tomorrow', className: 'Spin', priceCents: 12.5, spots: 1 }] } }), 'custom', extra)).toEqual([
      'custom.sessions[0].day: expected a date YYYY-MM-DD, got "tomorrow".',
      'custom.sessions[0].priceCents: expected a whole number of cents, got 12.5.',
    ]);
    expect(validateRecordShape(gymMember({ custom: { sessions: ['Spin'] } }), 'custom', extra).join(' ')).toMatch(/row 1 must be an object/);
    // a required plain field of the project is required of the record; a kind with its own data needs no card or claims
    expect(validateRecordShape({ customer: { givenName: 'A', familyName: 'B', locale: 'en-US' }, custom: {} }, 'custom', extra).join(' ')).toMatch(/Missing required field Plan name/);
    expect(validateRecordShape({ customer: { givenName: 'A', familyName: 'B', locale: 'en-US' } }, 'custom')).toEqual([]);

    const head = 'customer.givenName,customer.familyName,customer.locale,custom.planName,custom.monthlyFeeCents,custom.renewalDate,custom.tier,custom.autoRenew';
    const ok = csvToRecords(`${head}\nAna,Diaz,en-US,Flex,4900,2026-12-01,pro,yes\n`, 'custom', extra);
    expect(ok.headerErrors).toEqual([]);
    const rows = prepareImport(ok.records, 'custom', 0, extra);
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].record).toMatchObject({ recordId: 'REC-5001', documentType: 'custom', custom: { planName: 'Flex', monthlyFeeCents: 4900, tier: 'pro', autoRenew: true } });
    expect((rows[0].record as { card?: unknown }).card).toBeUndefined();
    const withList = csvToRecords(`${head},custom.sessions\nAna,Diaz,en-US,Flex,4900,2026-12-01,pro,yes,[]\n`, 'custom', extra);
    expect(withList.headerErrors.join(' ')).toMatch(/“custom.sessions” is a list \(Booked sessions\), and a CSV row cannot hold a list.*JSON file/);
    expect(csvToRecords(`${head},custom.sessions.count\nAna,Diaz,en-US,Flex,4900,2026-12-01,pro,yes,2\n`, 'custom', extra).headerErrors.join(' ')).toMatch(/calculated by the engine/);
    expect(csvToRecords('customer.givenName,card.tier\nAna,premium\n', 'custom', extra).headerErrors.join(' ')).toMatch(/Unknown column “card.tier” — use a data-contract path such as custom.planName/);
  });
});

describe('the Blank project starter', () => {
  it('is listed as a built-in template of the new kind', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(['credit-card-statement', 'explanation-of-benefits', 'blank-letter', 'blank-project']);
    expect(TEMPLATES.find((t) => t.id === 'blank-project')).toMatchObject({ title: 'Blank project', documentType: 'custom' });
  });

  it('is built from nothing: needs no sample projects, and carries nothing of theirs', () => {
    // no seeds are registered or passed: the builder must not need them
    const p = projectFromTemplate('blank-project', { projectId: 'my-doc', title: 'Welcome letter', issuerName: 'Northside Gym', accent: '#1f4e79' }, []);
    expect(p).toEqual({
      schemaVersion: SCHEMA_VERSION, projectId: 'my-doc', title: 'Welcome letter', documentType: 'custom', modelVersion: 1,
      rootNodeId: 'doc-root', nodes: [{ id: 'doc-root', type: 'container', name: 'Document', children: [] }],
      presentationProfiles: defaultPresentationProfiles(), rules: [], contentParts: [],
      journey: { snapshotPolicy: 'issued-is-immutable', events: [] },
      issuer: { name: 'Northside Gym', accent: '#1f4e79', product: 'Welcome letter' },
      customFields: [], languages: [],
    });
    expect(JSON.stringify(p)).not.toMatch(SAMPLE_WORDING);
    const plain = blankProject({ projectId: 'my-doc', title: 'Welcome letter' });
    expect(plain.issuer).toEqual({ name: 'Welcome letter', accent: NEUTRAL_ACCENT, product: 'Welcome letter' });
    expect(blankProject({ projectId: 'x-doc', title: 'T', accent: 'red' }).issuer.accent).toBe(NEUTRAL_ACCENT);
  });

  it('starts with the same page and web profiles the two samples use', () => {
    for (const seed of seedProjects()) expect(seed.presentationProfiles).toEqual(defaultPresentationProfiles());
    // a fresh copy each time: editing one project's profile cannot leak into another
    expect(defaultPresentationProfiles()[0]).not.toBe(defaultPresentationProfiles()[0]);
  });

  it('is English only: an explicit empty language list means no other language, an absent one still means the older default', () => {
    expect(projectLanguages({ languages: [] })).toEqual([]);
    expect(projectLanguages({})).toEqual(['es-US']);
    expect(projectLanguages({ languages: ['en-US', 'fr-FR'] })).toEqual(['fr-FR']);
    expect(projectLanguages(blankProject({ projectId: 'my-doc', title: 'Welcome letter' }))).toEqual([]);
  });

  it('“Blank letter” is unchanged and still belongs to the two sample kinds', () => {
    const seeds = seedProjects();
    const letter = projectFromTemplate('blank-letter', { projectId: 'a-letter', title: 'A letter' }, seeds);
    expect(letter.documentType).toBe('credit-statement');
    expect(letter.nodes.map((n) => n.id)).toEqual(['doc-root', 'issuer-logo', 'document-header', 'page-footer', 'greeting', 'letter-body']);
    expect(projectFromTemplate('blank-letter', { projectId: 'b-letter', title: 'B letter', documentType: 'eob' }, seeds).documentType).toBe('eob');
    // asking a blank letter for the new kind does not produce a half-sample, half-own-data project
    expect(projectFromTemplate('blank-letter', { projectId: 'c-letter', title: 'C letter', documentType: 'custom' }, seeds).documentType).toBe('credit-statement');
  });

  it('travels as a saved template and as a project file like any other project', () => {
    const p = gymProject();
    const fromTemplate = projectFromSavedTemplate(templateContentOf(p), { projectId: 'gym-two', title: 'Second gym', templateId: 'saved-gym', version: 1, templateTitle: 'Gym' });
    expect(fromTemplate).toMatchObject({ documentType: 'custom', projectId: 'gym-two', customFields: GYM_FIELDS, fromTemplate: { templateId: 'saved-gym', version: 1 } });
    expect(projectFileProblems(JSON.parse(JSON.stringify(p)))).toEqual([]);
    expect(projectFileProblems({ ...p, documentType: 'invoice' })[0]).toMatchObject({ code: 'DOCUMENT_TYPE' });
    expect(projectFileProblems({ ...p, customFields: [{ key: 'items', label: 'Lines', type: 'list', itemFields: 'oops' }] })[0]).toMatchObject({ code: 'DATA_FIELDS' });
    expect(projectFileProblems({ ...p, customFields: 'none' })[0]).toMatchObject({ code: 'DATA_FIELDS' });
    // a malformed list definition never throws while field definitions are derived
    expect(() => customFieldDefs([{ key: 'items', label: 'Lines', type: 'list', itemFields: 'oops' as never }])).not.toThrow();
  });
});

describe('defaults for a document with its own data', () => {
  const TYPES = COMPONENT_CATALOG.map((c) => c.type);
  const insertAll = (base: Project): Project => TYPES.reduce((p, type, i) => run(p, { type: 'INSERT_NODE', node: defaultNode(type, `n${i}-${type}`, 'custom', p), parentId: 'doc-root' }), base);
  const blockingOf = (p: Project) => resolve({ project: p, record: gymMember() }).findings.filter((f) => f.severity === 'blocking');

  it('every one of the 15 components inserts and resolves in a blank project; only the table still needs a list', () => {
    expect(TYPES).toHaveLength(15);
    const p = insertAll(blankProject({ projectId: 'all-fifteen', title: 'All fifteen' }));
    expect(p.nodes).toHaveLength(16);
    const res = resolve({ project: p, record: { recordId: 'REC-60001', documentType: 'custom', customer: { givenName: 'Robin', familyName: 'Okoye', locale: 'en-US' } } });
    expect(res.findings.filter((f) => f.severity === 'blocking').map((f) => [f.code, f.message])).toEqual([['INVALID_BINDING', '“Table” is not bound to a list yet.']]);
    expect(res.findings.some((f) => f.code === 'IMAGE_ALT_MISSING' || f.code === 'MISSING_CONTENT_PART' || f.code === 'NO_VARIANT_MATCH')).toBe(false);
    // without data fields of its own, a field shows the customer's given name
    const node = (type: ComponentType) => p.nodes.find((n) => n.type === type)!;
    expect(node('bound-field')).toMatchObject({ binding: 'customer.givenName', label: 'Given name' });
    expect(node('summary-metric')).toMatchObject({ binding: 'customer.givenName', formatter: 'text' });
    expect(node('repeating-table').binding).toBeUndefined();
    expect(node('image').image).toEqual({ src: '', alt: 'Describe this image', fit: 'contain' });
    expect(node('shape').shape!.stroke).toBeUndefined();
    // nothing from the samples: no sample logo, sample wording, card or claim field
    expect(JSON.stringify(p.nodes)).not.toMatch(/asset:|card\.|claims?\b|credit-adjustment-note|claim-glossary|merchant/);
  });

  it('a message and a disclosure bring wording of their own in the same undoable step', () => {
    const base = blankProject({ projectId: 'own-words', title: 'Own words' });
    const withMessage = run(base, { type: 'INSERT_NODE', node: defaultNode('variant-set', 'note', 'custom', base), parentId: 'doc-root' });
    expect(withMessage.modelVersion).toBe(base.modelVersion + 1);
    expect(withMessage.nodes.find((n) => n.id === 'note')).toMatchObject({ variantIds: ['note-default'], fallbackVariantId: 'note-default' });
    expect(withMessage.contentParts).toEqual([{ id: 'note-default', version: 1, title: 'Standard message', approvedLocales: { 'en-US': 'Write the message here.' }, syntheticDemoOnly: true, type: 'text' }]);
    const withDisclosure = run(withMessage, { type: 'INSERT_NODE', node: defaultNode('disclosure', 'terms', 'custom', withMessage), parentId: 'doc-root' });
    expect(withDisclosure.contentParts.find((c) => c.id === 'terms')).toMatchObject({ type: 'disclosure', title: 'Disclosure' });
    expect(withDisclosure.contentParts).toHaveLength(2);
    // wording that already exists is never replaced, and a reference to shared wording that is missing stays a finding
    const card = seedProjects().find((p) => p.documentType === 'credit-statement')!;
    const cardAfter = run(card, { type: 'INSERT_NODE', node: defaultNode('disclosure', 'extra-terms', 'credit-statement'), parentId: 'doc-root' });
    expect(cardAfter.contentParts).toEqual(card.contentParts);
    const letter = projectFromTemplate('blank-letter', { projectId: 'a-letter', title: 'A letter' }, seedProjects());
    expect(run(letter, { type: 'INSERT_NODE', node: defaultNode('disclosure', 'extra-terms', 'credit-statement'), parentId: 'doc-root' }).contentParts).toEqual([]);
  });

  it('components that show data start on the project’s first suitable field; a table and a chart on its first list', () => {
    const p = insertAll(run(blankProject({ projectId: 'gym-defaults', title: 'Gym defaults' }), { type: 'SET_CUSTOM_FIELDS', fields: GYM_FIELDS }));
    const node = (type: ComponentType) => p.nodes.find((n) => n.type === type)!;
    expect(node('bound-field')).toMatchObject({ binding: 'custom.planName', label: 'Plan name', formatter: 'text' });
    expect(node('summary-metric')).toMatchObject({ binding: 'custom.monthlyFeeCents', label: 'Monthly fee', formatter: 'usd-cents' });
    expect(node('repeating-table')).toMatchObject({
      binding: 'custom.sessions', caption: 'Booked sessions',
      columns: [{ key: 'day', label: 'Day', format: 'date' }, { key: 'className', label: 'Class', format: 'text' }, { key: 'priceCents', label: 'Price', format: 'usd-cents', align: 'right' }, { key: 'spots', label: 'Spots', format: 'int', align: 'right' }],
    });
    expect(node('chart')).toMatchObject({ binding: 'custom.sessions', chart: { kind: 'bar', groupBy: 'className', valueKey: 'priceCents', title: 'Price by class' } });
    expect(blockingOf(p)).toEqual([]);
  });

  it('the two built-in kinds keep their own defaults', () => {
    expect(defaultNode('repeating-table', 't1', 'credit-statement').binding).toBe('card.transactions');
    expect(defaultNode('repeating-table', 't1', 'eob').binding).toBe('claims');
    expect(defaultNode('image', 'i1', 'eob').image!.src).toBe('asset:harborcare-mark');
    expect(defaultNode('variant-set', 'v1', 'credit-statement').variantIds).toEqual([]);
    expect(defaultNode('disclosure', 'd1', 'credit-statement').contentPartId).toBe('credit-adjustment-note');
  });

  it('email and SMS wording names only the issuer, the key figures and the link', () => {
    const c = defaultChannels({ documentType: 'custom' });
    expect(c.email.subject).toBe('Your {{issuer.name}} document is ready');
    expect(c.sms.text).toBe('DEMO {{issuer.name}}: Your document is ready. Details: {{link}}');
    const tokens = [...JSON.stringify(c).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
    expect([...new Set(tokens)].sort()).toEqual(['issuer.name', 'keyFacts', 'link']);
    expect(JSON.stringify(c)).not.toMatch(SAMPLE_WORDING);
    expect(channelConfig(blankProject({ projectId: 'my-doc', title: 'Welcome letter' }))).toEqual(c);
    // the samples keep their wording
    expect(defaultChannels({ documentType: 'eob' }).sms.text).toMatch(/THIS IS NOT A BILL/);
    expect(defaultChannels({ documentType: 'credit-statement' }).email.title).toBe('Your statement is ready');
  });

  it('translators see neutral fixed wording for this kind; the samples keep exactly the list they had', () => {
    const own = systemStringKeysFor('custom');
    for (const k of own) expect(SYSTEM_STRINGS[k], k).not.toMatch(/statement|claim|bill|transaction/i);
    expect(own).toContain('sectionDetails');
    expect(own).not.toContain('sectionTransactions');
    const builtIn = systemStringKeysFor('credit-statement');
    expect(builtIn).toEqual(systemStringKeysFor('eob'));
    expect(builtIn).toHaveLength(60);
    expect(builtIn.some((k) => /Document$/.test(k) || k === 'sectionDetails')).toBe(false);
    const ids = translatableStrings(gymProject()).filter((s) => s.kind === 'system').map((s) => s.id);
    expect(ids).toContain('@sys/emailSyntheticCueDocument');
    expect(ids).not.toContain('@sys/emailSyntheticCue');
  });
});
