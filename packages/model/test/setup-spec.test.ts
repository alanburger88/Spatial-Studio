import { describe, expect, it } from 'vitest';
import {
  SETUP_LIMITS, SETUP_SPEC_SCHEMA, amountToCents, centsToAmount, channelConfig, checkSetupSpec, isEmptySetupSpec, projectContentDigest, projectFileProblems,
  projectFromSetupSpec, richToPlain, setupCustomFields, setupFieldKey, validateCustomFields, validateRule, NEUTRAL_ACCENT,
  type SetupSection, type SetupSpec,
} from '../src';
import { gymSetup } from './helpers/setupSpec';

const build = (spec: unknown, title = 'Membership renewal') => projectFromSetupSpec(spec as SetupSpec, { projectId: 'gym-renewal', title });
const section = <T extends SetupSection['type']>(spec: SetupSpec, type: T) => spec.sections.find((s) => s.type === type) as Extract<SetupSection, { type: T }> | undefined;
/** A setup with one field of every simple kind, to hang a junk section on. */
const base = (sections: unknown[], extra: Record<string, unknown> = {}) => ({
  title: 'Notice', issuerName: 'Acme', summary: '',
  fields: [
    { label: 'Plan', type: 'text' }, { label: 'Fee', type: 'amount' }, { label: 'Due', type: 'date' }, { label: 'Status', type: 'choice', choices: ['open', 'closed'] },
    { label: 'Active', type: 'yesNo' }, { label: 'Visits', type: 'number' }, { label: 'Items', type: 'list', columns: [{ label: 'What', type: 'text' }, { label: 'Price', type: 'amount' }, { label: 'Qty', type: 'number' }] },
  ],
  sections, ...extra,
});

describe('checking a document setup', () => {
  it('leaves a sound setup as it is, and checking again changes nothing', () => {
    const once = checkSetupSpec(gymSetup());
    expect(once.notes).toEqual([]);
    expect(once.spec).toEqual(gymSetup());
    expect(checkSetupSpec(once.spec)).toEqual({ spec: once.spec, notes: [] });
    expect(isEmptySetupSpec(once.spec)).toBe(false);
  });

  it('never throws, whatever it is given', () => {
    const hostile = { get title() { throw new Error('boom'); } };
    const circular: any = { title: 'Loop', sections: [] }; circular.sections.push(circular);
    for (const raw of [null, undefined, 42, 'a setup', [], [1, 2], { fields: 'x', sections: 7 }, { fields: [null, 3, []], sections: [null, 'x', { type: 9 }] }, hostile, circular, { sections: [{ type: 'messages', versions: [{ when: 5 }, null] }] }]) {
      const r = checkSetupSpec(raw);
      expect(Array.isArray(r.notes)).toBe(true);
      expect(r.spec.title.length).toBeGreaterThan(1);
      expect(checkSetupSpec(r.spec).notes).toEqual([]);
    }
    expect(checkSetupSpec(null)).toMatchObject({ spec: { title: 'Untitled document', fields: [], sections: [] } });
    expect(checkSetupSpec('x').notes[0]).toMatch(/not a description of a document/);
    expect(isEmptySetupSpec(checkSetupSpec(hostile).spec)).toBe(true);
  });

  it('says what it dropped from the data fields: duplicates, the customer’s own name and language, a choice without choices, a list without columns', () => {
    const { spec, notes } = checkSetupSpec({
      title: 'Notice', issuerName: 'Acme',
      fields: [
        { label: 'Plan', type: 'text' }, { label: ' plan ', type: 'number' },
        { label: 'First name', type: 'text' }, { label: 'Surname', type: 'text' }, { label: 'Preferred language', type: 'text' }, { label: 'Given name', type: 'text' },
        { label: 'Tier', type: 'choice', choices: [] }, { label: 'Colour', type: 'choice', choices: ['red', 'Red', ' blue '] },
        { label: 'Lines', type: 'list', columns: [] }, { label: 'Rows', type: 'list', columns: [{ label: 'A', type: 'yesNo' }, { label: 'a', type: 'text' }, { label: '', type: 'text' }] },
        { label: 'Odd', type: 'banana' }, { label: '', type: 'text' }, { label: 'Name', type: 'text', choices: ['x'], columns: [{ label: 'c', type: 'text' }] },
      ],
      sections: [],
    });
    expect(spec.fields).toEqual([
      { label: 'Plan', type: 'text' },
      { label: 'Tier', type: 'text' },
      { label: 'Colour', type: 'choice', choices: ['red', 'blue'] },
      { label: 'Rows', type: 'list', columns: [{ label: 'A', type: 'text' }] },
      { label: 'Odd', type: 'text' },
      // a field simply called "Name" is the document's own (a plan, a pet); only the customer's name is taken
      { label: 'Name', type: 'text' },
    ]);
    const all = notes.join('\n');
    for (const expected of [
      /Two data fields are called “plan”/, /“First name” was left out as a data field: every customer already has a name/, /“Surname” was left out/, /“Preferred language” was left out as a data field: every customer already has a language/, /“Given name” was left out/,
      /“Tier” is a choice without any choices, so it was set up as text/, /The list “Lines” was left out: a list needs at least one column/, /column “A” of “Rows” must be text, a whole number, an amount or a date/,
      /“Rows” has two columns called “a”/, /“Odd” has no known type/, /A data field without a label was left out/, /“Name” is not a choice/, /“Name” is not a list/,
    ]) expect(all).toMatch(expected);
    // what was built from it is valid for the studio
    expect(validateCustomFields('custom', setupCustomFields(spec))).toEqual([]);
  });

  it('says what it dropped from the sections: an unknown field in a paragraph, a table for a field that is not a list, a list as a key figure', () => {
    const { spec, notes } = checkSetupSpec(base([
      { type: 'paragraph', text: 'Your {Plan} costs {Fee} and {Discount} applies. See {Items}. Hi {{ first name }} {Surname}, {customer.givenName}, {Customer name}!' },
      { type: 'table', list: 'Plan' }, { type: 'table', list: 'Nothing' },
      { type: 'table', list: 'items', columns: ['what', 'Colour', 'Qty'], totalColumn: 'Qty' },
      { type: 'table', list: 'Items', totalColumn: 'Price' },
      { type: 'keyFigures', fields: ['fee', 'Items', 'Bogus', 'Fee', 'Due'] },
      { type: 'keyFigures', fields: ['Items'] },
      { type: 'heading', text: '' }, { type: 'carousel', text: 'x' }, { type: 'notice' }, 'not a section',
    ]));
    expect(spec.sections).toEqual([
      { type: 'paragraph', text: 'Your {Plan} costs {Fee} and Discount applies. See Items. Hi {First name} {Last name}, {First name}, {First name} {Last name}!' },
      { type: 'table', list: 'Items', columns: ['What', 'Qty'] },
      { type: 'table', list: 'Items', columns: ['What', 'Price', 'Qty'], totalColumn: 'Price' },
      { type: 'keyFigures', fields: ['Fee', 'Due'] },
    ]);
    const all = notes.join('\n');
    for (const expected of [
      /A paragraph mentions “\{Discount\}”, which is not one of the data fields, so it was left as plain words/, /A paragraph mentions the list “Items”/,
      /A table for “Plan” was left out: it is not a list/, /A table for “Nothing” was left out: it is not one of the data fields/, /The table “Items” has no column “Colour”/, /cannot total “Qty”: only an amount column can be summed/,
      /“Items” is a list and cannot be a key figure/, /The key figure “Bogus” is not one of the data fields/, /A summary of key figures without any usable data field was left out/,
      /A heading without text was left out/, /unknown kind “carousel”/, /A notice without text was left out/, /not a description of a section/,
    ]) expect(all).toMatch(expected);
  });

  it('a message keeps exactly one fallback, and a version whose condition cannot be used is left out with the reason', () => {
    const versions = [
      { title: 'On a list', text: 'a', when: { field: 'Items', test: 'is', value: '1' } },
      { title: 'Unknown field', text: 'b', when: { field: 'Mood', test: 'is', value: 'x' } },
      { title: 'More than text', text: 'c', when: { field: 'Plan', test: 'moreThan', value: 'x' } },
      { title: 'Not a choice', text: 'd', when: { field: 'Status', test: 'is', value: 'paused' } },
      { title: 'Bad amount', text: 'e', when: { field: 'Fee', test: 'atLeast', value: 'lots' } },
      { title: 'Bad date', text: 'f', when: { field: 'Due', test: 'lessThan', value: '12/01/2026' } },
      { title: 'No test', text: 'g', when: { field: 'Visits', test: 'roughly', value: 3 } },
      { title: 'No text', text: '  ', when: { field: 'Visits', test: 'is', value: 3 } },
      { title: 'Closed', text: 'Closed.', when: { field: 'status', test: 'IS', value: 'CLOSED' } },
      { title: 'Costly', text: 'Costly.', when: { field: 'Fee', test: 'more than', value: '$1,250.5' } },
      { title: 'Inactive', text: 'Inactive.', when: { field: 'Active', test: 'is', value: 'no' } },
      { title: 'Late', text: 'Late.', when: { field: 'Due', test: 'atMost', value: '2026-11-30' } },
      { title: 'First fallback', text: 'Standard.', fallback: true, when: { field: 'Visits', test: 'is', value: 1 } },
      { title: 'Second fallback', text: 'Other.', fallback: true },
      { title: 'Third fallback', text: 'Busy.', fallback: true, when: { field: 'Visits', test: 'atLeast', value: '20' } },
      { title: 'Loose', text: 'Loose.' },
    ];
    const { spec, notes } = checkSetupSpec(base([{ type: 'messages', name: 'Note', versions }]));
    expect(section(spec, 'messages')!.versions).toEqual([
      { title: 'Closed', text: 'Closed.', when: { field: 'Status', test: 'is', value: 'closed' } },
      { title: 'Costly', text: 'Costly.', when: { field: 'Fee', test: 'moreThan', value: 1250.5 } },
      { title: 'Inactive', text: 'Inactive.', when: { field: 'Active', test: 'is', value: false } },
      { title: 'Late', text: 'Late.', when: { field: 'Due', test: 'atMost', value: '2026-11-30' } },
      { title: 'First fallback', text: 'Standard.', fallback: true },
      { title: 'Third fallback', text: 'Busy.', when: { field: 'Visits', test: 'atLeast', value: 20 } },
    ]);
    const all = notes.join('\n');
    for (const expected of [
      /“On a list” of “Note” was left out: its condition tests “Items”, which is a list/, /“Unknown field” of “Note” was left out: its condition uses “Mood”, which is not one of the data fields/,
      /“Plan” is text, so it can only be tested with “is” or “is not”/, /“paused” is not one of the choices of “Status” \(open, closed\)/, /“Fee” is an amount, and “lots” is not one/, /“Due” is a date, and “12\/01\/2026” is not a date written as YYYY-MM-DD/,
      /has no test the studio knows/, /“No text” of “Note” has no text/, /More than one version of “Note” was marked.*“First fallback” is used for that, and “Second fallback” was left out/, /“First fallback” is used for that; “Third fallback” keeps its condition/,
      /“First fallback” is the version of “Note” shown when nothing else applies, so its condition was removed/, /“Loose” of “Note” has no condition and is not the one shown when nothing else applies/,
    ]) expect(all).toMatch(expected);

    // no version marked: one without a condition is the fallback; with none, the last one is, and the note asks to check
    const unmarked = checkSetupSpec(base([{ type: 'messages', name: 'A', versions: [{ title: 'One', text: '1', when: { field: 'Visits', test: 'is', value: 1 } }, { title: 'Plain', text: 'p' }] }]));
    expect(section(unmarked.spec, 'messages')!.versions[1]).toEqual({ title: 'Plain', text: 'p', fallback: true });
    expect(unmarked.notes.join(' ')).toMatch(/“Plain” has no condition, so it is used for that/);
    const allConditional = checkSetupSpec(base([{ type: 'messages', name: 'B', versions: [{ title: 'One', text: '1', when: { field: 'Visits', test: 'is', value: 1 } }, { title: 'Two', text: '2', when: { field: 'Visits', test: 'is', value: 2 } }] }]));
    expect(section(allConditional.spec, 'messages')!.versions).toEqual([{ title: 'One', text: '1', when: { field: 'Visits', test: 'is', value: 1 } }, { title: 'Two', text: '2', fallback: true }]);
    expect(allConditional.notes.join(' ')).toMatch(/the last one \(“Two”\) is used for that and its condition was removed\. Check that this is what you want/);
    expect(checkSetupSpec(base([{ type: 'messages', name: 'C', versions: [{ title: 'x', text: '' }] }])).notes.join(' ')).toMatch(/The message “C” was left out: it has no version with text/);
    // everything above is stable: a cleaned setup is clean
    for (const cleaned of [spec, unmarked.spec, allConditional.spec]) expect(checkSetupSpec(cleaned)).toEqual({ spec: cleaned, notes: [] });
  });

  it('takes markup, hidden links, unsafe buttons and unknown properties out, and says so', () => {
    const { spec, notes } = checkSetupSpec({
      ...base([
        { type: 'paragraph', text: 'Pay <b>now</b> <script>alert(1)</script> at [our site](https://evil.example/pay) or [here](javascript:void0). 1 < 2', image: { src: 'https://evil.example/x.png' } },
        { type: 'action', label: 'Pay', url: 'http://example.com/pay' }, { type: 'action', label: 'Run', url: 'javascript:alert(1)' }, { type: 'action', label: '', url: 'https://example.com' },
        { type: 'action', label: 'Open {Plan}', url: 'https://example.com/open' },
        { type: 'notice', text: 'Terms: {{custom.secret}} and {{card.creditLimitCents}} apply.' },
      ]),
      accent: 'red; background:url(x)', documentType: 'credit-statement', nodes: [{ id: 'x', type: 'image' }], rules: [], projectId: 'aster-card-demo',
      email: { subject: 'Hi <img src=x>', intro: '' }, sms: 'Go to {link} {{issuer.name}}',
    });
    expect(spec.sections).toEqual([
      { type: 'paragraph', text: 'Pay now alert(1) at our site or here. 1 2' },
      { type: 'action', label: 'Open Plan', url: 'https://example.com/open' },
      { type: 'notice', text: 'Terms: custom.secret and card.creditLimitCents apply.' },
    ]);
    expect(spec.accent).toBeUndefined();
    expect(spec.email).toEqual({ subject: 'Hi', intro: '' });
    expect(spec.sms).toBe('Go to {Link} issuer.name');
    expect(Object.keys(spec).sort()).toEqual(['email', 'fields', 'issuerName', 'sections', 'sms', 'summary', 'title']);
    const all = notes.join('\n');
    for (const expected of [
      /Ignored “documentType”, “nodes”, “rules”, “projectId”: a document setup has no such properties/, /markup and the characters < and > are not allowed in wording and were removed/, /a link inside the text was turned into plain words/,
      /The button “Pay” was left out: its link must be a web address that starts with https:\/\//, /The button “Run” was left out/, /A button without a label was left out/, /The colour “red; background:url\(” is not a 6-digit hex colour/,
      /A notice mentions “\{custom\.secret\}”, which is not one of the data fields/,
    ]) expect(all).toMatch(expected);
  });

  it('keeps to its limits and says what was cut', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    const { spec, notes } = checkSetupSpec({
      title: 'T'.repeat(120), issuerName: 'I'.repeat(90), summary: 's'.repeat(400),
      fields: [
        ...many(45).map((i) => ({ label: `Field ${i}`, type: 'number' })),
      ].map((f, i) => (i === 0 ? { label: 'Field 1', type: 'choice', choices: many(14).map((c) => `c${c}`) } : i === 1 ? { label: 'Field 2', type: 'list', columns: many(10).map((c) => ({ label: `Col ${c}`, type: 'text' })) } : f)),
      sections: [
        { type: 'heading', text: 'h'.repeat(300) },
        { type: 'paragraph', text: 'p'.repeat(2000) },
        { type: 'keyFigures', fields: many(9).map((i) => `Field ${i + 2}`) },
        { type: 'messages', name: 'M', versions: [...many(8).map((i) => ({ title: `V${i}`, text: 'x', when: { field: 'Field 3', test: 'is', value: i } })), { title: 'Else', text: 'y', fallback: true }] },
        ...many(31).map(() => ({ type: 'divider' })),
      ],
      email: { subject: 's'.repeat(300), intro: 'i'.repeat(1500) }, sms: 'm'.repeat(500),
    });
    expect(spec.title).toHaveLength(SETUP_LIMITS.title);
    expect(spec.issuerName).toHaveLength(SETUP_LIMITS.issuerName);
    expect(spec.summary).toHaveLength(SETUP_LIMITS.summary);
    expect(spec.fields).toHaveLength(SETUP_LIMITS.fields);
    expect(spec.fields[0].choices).toHaveLength(SETUP_LIMITS.choices);
    expect(spec.fields[1].columns).toHaveLength(SETUP_LIMITS.columns);
    expect(spec.sections).toHaveLength(SETUP_LIMITS.sections);
    expect(section(spec, 'heading')!.text).toHaveLength(SETUP_LIMITS.heading);
    expect(section(spec, 'paragraph')!.text).toHaveLength(SETUP_LIMITS.paragraph);
    expect(section(spec, 'keyFigures')!.fields).toHaveLength(SETUP_LIMITS.keyFigures);
    const versions = section(spec, 'messages')!.versions;
    expect(versions.map((v) => v.title)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'Else']);
    expect(spec.email!.subject).toHaveLength(SETUP_LIMITS.emailSubject);
    expect(spec.email!.intro).toHaveLength(SETUP_LIMITS.emailIntro);
    expect(spec.sms).toHaveLength(SETUP_LIMITS.sms);
    const all = notes.join('\n');
    for (const expected of [/at most 40 data fields; 5 more were left out/, /at most 30 sections; 5 more were left out/, /The title was shortened to 80 characters/, /A paragraph was shortened to 1500 characters/, /at most 6 key figures/, /at most 6 versions; the last 3 of “M” were left out/, /more than 12 choices/, /more than 8 columns/, /The text message was shortened to 320 characters/]) expect(all).toMatch(expected);
    expect(checkSetupSpec(spec)).toEqual({ spec, notes: [] });
    // and the project it builds is still a valid one
    expect(projectFileProblems(build(spec, 'Big notice').project)).toEqual([]);
  });

  it('reads the form a model returns (every property present, empty where it does not apply) as the same setup', () => {
    const emptySection = { text: '', fields: [], list: '', columns: [], totalColumn: '', name: '', versions: [], label: '', url: '' };
    const noCondition = { field: '', test: 'is', value: '' };
    const asModel = {
      title: 'Membership renewal', issuerName: 'Northside Gym', accent: '', summary: 'A notice.',
      fields: [
        { label: 'Monthly fee', type: 'amount', choices: [], columns: [], example: '49', required: true },
        { label: 'Payment status', type: 'choice', choices: ['paid', 'failed'], columns: [], example: '', required: false },
        { label: 'Fees', type: 'list', choices: [], columns: [{ label: 'Amount', type: 'amount' }], example: '', required: false },
      ],
      sections: [
        { ...emptySection, type: 'heading', text: 'Your renewal' },
        { ...emptySection, type: 'keyFigures', fields: ['Monthly fee', 'Payment status'] },
        { ...emptySection, type: 'table', list: 'Fees' },
        { ...emptySection, type: 'messages', name: 'Payment note', versions: [
          { title: 'Failed', text: 'It failed.', fallback: false, when: { field: 'Payment status', test: 'is', value: 'failed' } },
          { title: 'Fine', text: 'All fine.', fallback: true, when: noCondition },
        ] },
        { ...emptySection, type: 'divider' },
      ],
      email: { subject: '', intro: '' }, sms: '',
    };
    const { spec, notes } = checkSetupSpec(asModel);
    expect(notes).toEqual([]);
    expect(spec).toEqual({
      title: 'Membership renewal', issuerName: 'Northside Gym', summary: 'A notice.',
      fields: [{ label: 'Monthly fee', type: 'amount', example: '49.00', required: true }, { label: 'Payment status', type: 'choice', choices: ['paid', 'failed'] }, { label: 'Fees', type: 'list', columns: [{ label: 'Amount', type: 'amount' }] }],
      sections: [
        { type: 'heading', text: 'Your renewal' }, { type: 'keyFigures', fields: ['Monthly fee', 'Payment status'] }, { type: 'table', list: 'Fees', columns: ['Amount'] },
        { type: 'messages', name: 'Payment note', versions: [{ title: 'Failed', text: 'It failed.', when: { field: 'Payment status', test: 'is', value: 'failed' } }, { title: 'Fine', text: 'All fine.', fallback: true }] },
        { type: 'divider' },
      ],
    });
  });

  it('the schema a model is given is one a strict tool accepts: every object closed, every property required, plain types only', () => {
    const seen: string[] = [];
    const walk = (node: any, where: string) => {
      expect(node.anyOf ?? node.oneOf ?? node.allOf ?? node.$ref, where).toBeUndefined();
      expect(typeof node.type, where).toBe('string');
      for (const k of ['minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'format']) expect(node[k], `${where}.${k}`).toBeUndefined();
      if (node.type === 'object') {
        expect(node.additionalProperties, where).toBe(false);
        expect(node.required, where).toEqual(Object.keys(node.properties));
        for (const [k, v] of Object.entries(node.properties)) { seen.push(`${where}.${k}`); walk(v, `${where}.${k}`); }
      }
      if (node.type === 'array') walk(node.items, `${where}[]`);
    };
    walk(SETUP_SPEC_SCHEMA, 'setup');
    expect(seen).toContain('setup.sections[].versions[].when.field');
    expect(seen.filter((s) => /^setup\.[a-zA-Z]+$/.test(s))).toEqual(['setup.title', 'setup.issuerName', 'setup.accent', 'setup.summary', 'setup.fields', 'setup.sections', 'setup.email', 'setup.sms']);
  });

  it('reads amounts in currency units and never guesses at one that is unclear', () => {
    expect([49, 49.5, '49', '49.5', '49.50', '$1,234.50', '-5', '- $5.25', ' 0.07 ', '€12'].map(amountToCents)).toEqual([4900, 4950, 4900, 4950, 4950, 123450, -500, -525, 7, 1200]);
    expect([49.999, '49.999', 'abc', '', '1,23', '12 50', null, undefined, true, NaN, Infinity, {}].map(amountToCents)).toEqual(Array(12).fill(null));
    expect([4900, 5, -525, 0, 123450].map(centsToAmount)).toEqual(['49.00', '0.05', '-5.25', '0.00', '1234.50']);
  });
});

describe('building a project from a document setup', () => {
  it('derives valid, unique field keys from the labels', () => {
    const used = new Set<string>();
    expect(['Monthly fee', 'monthly  FEE', '2nd address line', 'Café crème (%)', '***', 'Count', 'Constructor', 'A very long label that goes on and on and on and on'].map((l) => setupFieldKey(l, used)))
      .toEqual(['monthlyFee', 'monthlyFEE2', 'f2ndAddressLine', 'cafeCreme', 'field', 'countValue', 'constructorValue', 'aVeryLongLabelThatGoesOnAndOnAndOnAn']);
    expect(setupFieldKey('Amount due', new Set(), true)).toBe('amountDueCents');
    expect(setupFieldKey('Fee in cents', new Set(), true)).toBe('feeInCents');
    const fields = setupCustomFields(gymSetup());
    expect(fields.map((f) => `${f.key}:${f.type}`)).toEqual(['planName:string', 'monthlyFeeCents:cents', 'renewalDate:date', 'paymentStatus:enum', 'renewsAutomatically:bool', 'visitsThisMonth:int', 'fees:list']);
    expect(fields[1]).toEqual({ key: 'monthlyFeeCents', label: 'Monthly fee', type: 'cents', required: true, example: '4900' });
    expect(fields[3].enumValues).toEqual(['paid', 'failed', 'pending']);
    expect(fields[6].itemFields).toEqual([{ key: 'description', label: 'Description', type: 'string' }, { key: 'chargedOn', label: 'Charged on', type: 'date' }, { key: 'amountCents', label: 'Amount', type: 'cents' }, { key: 'quantity', label: 'Quantity', type: 'int' }]);
    expect(validateCustomFields('custom', fields)).toEqual([]);
  });

  it('builds the gym notice through commands: every kind of section becomes its component, in order', () => {
    const { project, notes } = build(gymSetup());
    expect(notes).toEqual([]);
    expect(projectFileProblems(project)).toEqual([]);
    expect(project).toMatchObject({ projectId: 'gym-renewal', title: 'Membership renewal', documentType: 'custom', modelVersion: 1, issuer: { name: 'Northside Gym', accent: '#1f4e79', product: 'Membership renewal' }, languages: [] });
    const byId = new Map(project.nodes.map((n) => [n.id, n]));
    expect(byId.get('doc-root')!.children).toEqual(['heading-1', 'greeting', 'figures-3', 'figures-3-2', 'table-4', 'message-5', 'divider-6', 'notice-7', 'action-8']);
    expect(project.nodes.map((n) => `${n.type}:${n.name}`)).toEqual([
      'container:Document', 'rich-text:Your Plan name membership renews soon', 'rich-text:Greeting',
      'container:Key figures', 'summary-metric:Monthly fee', 'summary-metric:Renewal date', 'container:Key figures (continued)', 'summary-metric:Visits this month', 'summary-metric:Renews automatically',
      'repeating-table:Fees', 'variant-set:Payment note', 'shape:Divider', 'disclosure:Notice', 'action-link:Manage your membership',
    ]);
    // no image anywhere, and the only link is the button's
    expect(project.nodes.filter((n) => n.type === 'image' || n.image)).toEqual([]);
    expect(JSON.stringify(project).match(/https?:\/\/[^"\\ ]+/g)).toEqual(['https://example.com/membership']);

    // mentions are real data tokens
    expect(richToPlain(byId.get('heading-1')!.content)).toBe('Your {{custom.planName}} membership renews soon');
    expect(byId.get('heading-1')!.content!.content[0]).toMatchObject({ type: 'heading' });
    expect(richToPlain(byId.get('greeting')!.content)).toBe('Hello {{customer.givenName}} {{customer.familyName}},\nyour {{custom.planName}} plan renews on {{custom.renewalDate}} for {{custom.monthlyFeeCents}} a month.');
    // key figures: two rows of two, bound and formatted by type
    expect(byId.get('figures-3')).toMatchObject({ children: ['figure-3-1', 'figure-3-2'], layout: { paged: { direction: 'row' }, html: { direction: 'row' } } });
    expect(byId.get('figures-3-2')!.children).toEqual(['figure-3-3', 'figure-3-4']);
    expect(['figure-3-1', 'figure-3-2', 'figure-3-3', 'figure-3-4'].map((id) => { const n = byId.get(id)!; return `${n.binding}|${n.formatter}|${n.label}|${n.importance}`; }))
      .toEqual(['custom.monthlyFeeCents|usd-cents|Monthly fee|primary', 'custom.renewalDate|date|Renewal date|secondary', 'custom.visitsThisMonth|int|Visits this month|secondary', 'custom.renewsAutomatically|text|Renews automatically|secondary']);
    // the table: the chosen columns in order, the amount column summed
    expect(byId.get('table-4')).toMatchObject({ binding: 'custom.fees', caption: 'Fees', columns: [{ key: 'description', label: 'Description', format: 'text' }, { key: 'chargedOn', label: 'Charged on', format: 'date' }, { key: 'amountCents', label: 'Amount', format: 'usd-cents', align: 'right', total: true }] });
    // the message: its versions, the fallback, one rule per condition with the first version winning
    expect(byId.get('message-5')).toMatchObject({ policy: 'exclusive', variantIds: ['message-5-v1', 'message-5-v2', 'message-5-v3', 'message-5-v4'], fallbackVariantId: 'message-5-v4' });
    expect(project.rules.map((r) => ({ id: r.id, priority: r.priority, when: r.when, then: r.then, title: r.title, mode: r.mode, group: r.exclusiveGroup }))).toEqual([
      { id: 'R01', priority: 300, when: { op: 'eq', path: 'custom.paymentStatus', value: 'failed' }, then: { op: 'selectVariant', targetNodeId: 'message-5', variantId: 'message-5-v1' }, title: 'Payment note: Payment failed', mode: 'exclusive', group: 'message-5' },
      { id: 'R02', priority: 200, when: { op: 'gte', path: 'custom.monthlyFeeCents', value: 10000 }, then: { op: 'selectVariant', targetNodeId: 'message-5', variantId: 'message-5-v2' }, title: 'Payment note: Premium member', mode: 'exclusive', group: 'message-5' },
      { id: 'R03', priority: 100, when: { op: 'gt', path: 'custom.visitsThisMonth', value: 12 }, then: { op: 'selectVariant', targetNodeId: 'message-5', variantId: 'message-5-v3' }, title: 'Payment note: Frequent visitor', mode: 'exclusive', group: 'message-5' },
    ]);
    for (const r of project.rules) expect(validateRule(r, project)).toEqual([]);
    const part = (id: string) => project.contentParts.find((c) => c.id === id)!;
    expect(project.contentParts.map((c) => `${c.id}:${c.type}:${c.title}`)).toEqual(['message-5-v1:text:Payment failed', 'message-5-v2:text:Premium member', 'message-5-v3:text:Frequent visitor', 'message-5-v4:text:Nothing to do', 'notice-7:disclosure:Notice']);
    expect(part('message-5-v1').approvedLocales['en-US']).toBe('Your last payment of {{custom.monthlyFeeCents}} did not go through, {{customer.givenName}}. Please update your payment details before {{custom.renewalDate}}.');
    expect(part('notice-7').approvedLocales['en-US']).toBe('Fees are charged monthly in advance. You can cancel at any time before {{custom.renewalDate}}.');
    expect(byId.get('notice-7')).toMatchObject({ contentPartId: 'notice-7', required: true, protected: true });
    expect(byId.get('action-8')!.action).toEqual({ label: 'Manage your membership', url: 'https://example.com/membership', fallbackText: 'Visit example.com/membership' });
    expect(byId.get('divider-6')).toMatchObject({ type: 'shape', decorative: true, shape: { kind: 'line' } });
    // email and SMS wording, on top of the standard wording
    const ch = channelConfig(project);
    expect(ch.email.subject).toBe('Your {{custom.planName}} membership renews on {{custom.renewalDate}}');
    expect(ch.email.intro).toBe('Hello {{customer.givenName}}, here is what your renewal looks like.');
    expect(ch.email.title).toBe('Your document is ready');
    expect(ch.sms.text).toBe('DEMO {{issuer.name}}: Your {{custom.planName}} membership renews on {{custom.renewalDate}}. Details: {{link}}');
  });

  it('is deterministic, and the title given at creation wins over the setup’s own', () => {
    const a = build(gymSetup(), 'Renewal 2027').project, b = build(gymSetup(), 'Renewal 2027').project;
    expect(a).toEqual(b);
    expect(projectContentDigest(a)).toBe(projectContentDigest(b));
    expect(a.title).toBe('Renewal 2027');
    expect(a.issuer.product).toBe('Renewal 2027');
    // without a colour or an issuer: the neutral colour, and the setup's title as the issuer
    const plain = build({ title: 'Plain', fields: [], sections: [{ type: 'heading', text: 'Hello' }] }, 'Plain').project;
    expect(plain.issuer).toEqual({ name: 'Plain', accent: NEUTRAL_ACCENT, product: 'Plain' });
    expect(plain.channels).toBeUndefined();
  });

  it('checks the setup itself, so junk never reaches the project', () => {
    const { project, notes } = build({
      title: 'Junk', issuerName: 'Acme', documentType: 'eob',
      fields: [{ label: 'Fee', type: 'amount' }, { label: 'Fee', type: 'text' }, { label: 'Lines', type: 'list', columns: [{ label: 'Item', type: 'text' }] }],
      sections: [
        { type: 'paragraph', text: 'You owe {Fee} and {Nothing}. <img src="https://evil.example/x.png"> [click](https://evil.example)' },
        { type: 'table', list: 'Fee' },
        { type: 'messages', name: 'Note', versions: [{ title: 'Bad', text: 'bad', when: { field: 'Lines', test: 'is', value: 1 } }, { title: 'Good', text: 'good', fallback: true }, { title: 'Extra', text: 'extra', fallback: true }] },
        { type: 'action', label: 'Go', url: 'http://insecure.example' },
      ],
    }, 'Junk');
    expect(project.documentType).toBe('custom');
    expect(project.nodes.map((n) => n.type)).toEqual(['container', 'rich-text', 'variant-set']);
    expect(richToPlain(project.nodes[1].content)).toBe('You owe {{custom.feeCents}} and Nothing. click');
    expect(JSON.stringify(project)).not.toMatch(/evil|insecure|<img|http/);
    expect(project.rules).toEqual([]);
    // (the table was dropped by the check, so the message is the second section)
    expect(project.nodes[2]).toMatchObject({ id: 'message-2', variantIds: ['message-2-v1'], fallbackVariantId: 'message-2-v1' });
    expect(projectFileProblems(project)).toEqual([]);
    expect(notes.length).toBeGreaterThanOrEqual(7);
    expect(notes.join('\n')).toMatch(/Two data fields are called “Fee”/);
  });

  it('wording the studio refuses is skipped and reported, and the rest of the document is still built', () => {
    // 333 mentions fit the setup's limit, but as data tokens they are longer than an email opening text may be
    const gym = gymSetup();
    const spec = { ...gym, fields: [...gym.fields, { label: 'X', type: 'text' as const }], email: { subject: 'Renewal for {First name}', intro: '{X}'.repeat(333) } };
    expect(checkSetupSpec(spec).notes).toEqual([]);
    const { project, notes } = build(spec);
    expect(notes).toEqual(['The email wording could not be added: Email opening text is limited to 2000 characters.']);
    expect(project.nodes).toHaveLength(14);
    expect(project.rules).toHaveLength(3);
    // the text message is a separate step, so it is kept
    expect(project.channels!.sms.text).toMatch(/^DEMO \{\{issuer\.name\}\}: Your \{\{custom\.planName\}\}/);
    expect(project.channels!.email.subject).toBe('Your {{issuer.name}} document is ready');
    expect(projectFileProblems(project)).toEqual([]);
  });
});
