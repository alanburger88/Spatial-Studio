import { describe, expect, it } from 'vitest';
import { checkSetupSpec, projectFileProblems, projectFromSetupSpec } from '@iss/model';
import { resolve } from '@iss/resolver';
import {
  alignSamples, baselineCustomer, fileSamples, markPersonalDetails, notBroughtAcross, replaceMarks, sendOutline, setupSpecFromFile,
  type FileReading, type ReadBlock,
} from '../src';

/** Every value below is invented. */
const para = (id: string, lines: string[], extra: Partial<ReadBlock> = {}): ReadBlock => ({ id, kind: 'paragraph', page: 1, lines, ...extra });
const heading = (id: string, text: string, level: 1 | 2 | 3 = 1): ReadBlock => ({ id, kind: 'heading', page: 1, level, lines: [text] });
const table = (id: string, rows: string[][]): ReadBlock => ({ id, kind: 'table', page: 1, lines: [], rows, headerRow: true });
const reading = (blocks: ReadBlock[], extra: Partial<FileReading> = {}): FileReading => ({
  kind: 'pdf', pages: 1, paper: { widthPt: 595.28, heightPt: 841.89, size: 'A4', landscape: false }, blocks, images: [], ignored: [], notes: [], fonts: ['Helvetica'], ...extra,
});

const one = (line: string) => markPersonalDetails([para('b1', [line])]);

describe('likely personal details', () => {
  it('marks the name and the address lines of an address block near the top', () => {
    const marks = markPersonalDetails([heading('b0', 'Annual statement'), para('b1', ['Ms Jane Example', '12 Sample Street', 'Springfield, IL 62704'])]);
    expect(marks.map((m) => [m.kind, m.text, m.field, m.placeholder])).toEqual([
      ['name', 'Ms Jane Example', 'Customer name', '{{First name}} {{Last name}}'],
      ['address', '12 Sample Street', 'Address line 1', '{{Address line 1}}'],
      ['address', 'Springfield, IL 62704', 'Address line 2', '{{Address line 2}}'],
    ]);
  });

  it('marks a name after a salutation, but not a generic one', () => {
    expect(one('Dear Jane Example,').map((m) => [m.kind, m.text, m.placeholder])).toEqual([['name', 'Jane Example', '{{First name}} {{Last name}}']]);
    expect(one('Dear Jane,').map((m) => m.placeholder)).toEqual(['{{First name}}']);
    expect(one('Dear Mr Example,').map((m) => m.placeholder)).toEqual(['{{Last name}}']);
    expect(one('Dear Customer,')).toEqual([]);
    expect(one('Dear Valued Member,')).toEqual([]);
  });

  it('marks each kind with a suggested field', () => {
    const cases: Array<[string, string, string, string]> = [
      ['Account number: 1234 5678 9012', 'account', '1234 5678 9012', 'Account number'],
      ['Policy no. PX-12345', 'reference', 'PX-12345', 'Policy number'],
      ['Amount due: $1,234.56', 'amount', '$1,234.56', 'Amount due'],
      ['Due date: 15 March 2026', 'date', '15 March 2026', 'Due date'],
      ['Statement date: 2026-03-01', 'date', '2026-03-01', 'Statement date'],
      ['Email: jane@example.test', 'email', 'jane@example.test', 'Email'],
      ['Call us on +1 555 010 0199 any day.', 'phone', '+1 555 010 0199', 'Phone number'],
      ['Your code is 9876543210 today.', 'number', '9876543210', 'Reference number'],
    ];
    for (const [line, kind, text, field] of cases) {
      const marks = one(line);
      expect(marks.map((m) => [m.kind, m.text, m.field]), line).toEqual([[kind, text, field]]);
    }
    expect(one('Amount due: $49.00')[0].type).toBe('amount');
    expect(one('Due date: 2026-03-01')[0].type).toBe('date');
    expect(one('Account number: 1234 5678 9012')[0].type).toBe('text');
  });

  it('does not mark ordinary wording', () => {
    for (const line of ['Thank you for being a member since the start.', 'Page 1 of 2', 'Call 911 in an emergency.', 'The year 2026 was a good one.', 'Fees are charged monthly in advance.', 'Section 3.2 applies.']) expect(one(line), line).toEqual([]);
  });

  it('marks table cells under their column heading', () => {
    const marks = markPersonalDetails([table('t1', [['Date', 'Description', 'Amount'], ['2026-01-05', 'Coffee', '$4.50'], ['2026-01-09', 'Towel hire', '$2.00']])]);
    expect(marks.map((m) => [m.line, m.cell, m.kind, m.field])).toEqual([[1, 0, 'date', 'Date'], [1, 2, 'amount', 'Amount'], [2, 0, 'date', 'Date'], [2, 2, 'amount', 'Amount']]);
  });

  it('keeps one field for a repeated value and numbers a label used for another value', () => {
    const marks = markPersonalDetails([para('b1', ['Account number: 1234 5678 9012']), para('b2', ['Account number: 1234 5678 9012']), para('b3', ['Date: 2026-01-01']), para('b4', ['Date: 2026-02-01'])]);
    expect(marks.map((m) => m.field)).toEqual(['Account number', 'Account number', 'Date', 'Date 2']);
  });

  it('replaces marked values with their placeholders', () => {
    const marks = one('Amount due: $49.00 by 2026-03-01');
    expect(replaceMarks('Amount due: $49.00 by 2026-03-01', marks)).toBe('Amount due: {{Amount due}} by {{Date}}');
  });
});

const SAMPLE_A = reading([
  heading('b1', 'Membership renewal'),
  para('b2', ['Ms Jane Example', '12 Sample Street', 'Springfield, IL 62704']),
  para('b3', ['Dear Jane Example,']),
  para('b4', ['Member number: 4410 2201', 'Amount due: $49.00', 'Renewal date: 2026-12-01']),
  para('b9', ['Your plan is Flex and it renews automatically.']),
  para('b5', ['Thank you for staying with us.']),
  table('b6', [['Date', 'Description', 'Amount'], ['2026-11-01', 'Membership', '$49.00'], ['2026-11-03', 'Towels', '$5.50'], ['Total', '', '$54.50']]),
  para('b7', ['Fees are charged monthly in advance. Cancel any time from your account page or at the front desk.'], { small: true, sizePt: 7 }),
], { images: [{ page: 1, box: { x: 420, y: 30, w: 120, h: 40 }, widthPt: 120, heightPt: 40 }] });
const SAMPLE_B = reading([
  heading('b1', 'Membership renewal'),
  para('b2', ['Mr Ben Sample', '7 Example Road', 'Shelbyville, IL 62565']),
  para('b3', ['Dear Ben Sample,']),
  para('b4', ['Member number: 4410 9988', 'Amount due: $120.00', 'Renewal date: 2026-12-15']),
  para('b9', ['Your plan is Max and it renews automatically.']),
  para('b5', ['Your last payment failed. Please update your payment details before the renewal date.']),
  table('b6', [['Date', 'Description', 'Amount'], ['2026-11-01', 'Membership', '$120.00']]),
  para('b7', ['Fees are charged monthly in advance. Cancel any time from your account page or at the front desk.'], { small: true, sizePt: 7 }),
]);
const SAMPLE_C = reading([
  heading('b1', 'Membership renewal'),
  para('b2', ['Mx Cy Placeholder', '3 Test Lane', 'Ogdenville, IL 62701']),
  para('b3', ['Dear Cy Placeholder,']),
  para('b4', ['Member number: 4410 5150', 'Amount due: $49.00', 'Renewal date: 2027-01-02']),
  para('b9', ['Your plan is Flex and it renews automatically.']),
  para('b5', ['Thank you for staying with us.']),
  para('b8', ['Your locker rental ends this month.']),
  table('b6', [['Date', 'Description', 'Amount'], ['2026-11-01', 'Membership', '$49.00']]),
  para('b7', ['Fees are charged monthly in advance. Cancel any time from your account page or at the front desk.'], { small: true, sizePt: 7 }),
]);

describe('what would be sent', () => {
  const fs = fileSamples([SAMPLE_A]);
  it('with placeholders: no marked value and no table row leaves, and the picture is position and size only', () => {
    const text = sendOutline(fs, { placeholders: true });
    for (const value of ['Jane', 'Example', '12 Sample Street', '62704', '$49.00', '2026-12-01', '$5.50', 'Towels']) expect(text, value).not.toContain(value);
    expect(text).toContain('{{First name}} {{Last name}}');
    expect(text).toContain('Amount due: {{Amount due}}');
    expect(text).toContain('| {{Date}} | {{Description}} | {{Amount}} |');
    expect(text).toContain('(3 rows of data, replaced by placeholders)');
    expect(text).toMatch(/\[p1 · image · 120 × 40 pt · top 30, left 420 · picture not read\]/);
    expect(text).toContain('Thank you for staying with us.');
  });
  it('without placeholders: the text as it is in the file', () => {
    const text = sendOutline(fs, { placeholders: false });
    for (const value of ['Jane Example', '12 Sample Street', '$49.00', 'Towels']) expect(text).toContain(value);
  });
  it('a value the person unmarked stays as it is, even with placeholders', () => {
    const plan = fs.samples[0].marks.find((m) => m.text === '$49.00' && m.cell === undefined)!;
    const text = sendOutline(fs, { placeholders: true, unmarked: [plan.id] });
    expect(text).toContain('Amount due: $49.00');
    expect(text).not.toContain('Jane');
  });
});

describe('comparing samples', () => {
  it('two samples: fixed wording, values that differ, wording that differs', () => {
    const fs = fileSamples([SAMPLE_A, SAMPLE_B]);
    const a = fs.alignment!;
    expect(a.samples).toBe(2);
    expect(a.rows.map((r) => [r.blocks.join(','), r.kind])).toEqual([
      ['b1,b1', 'same'], ['b2,b2', 'values'], ['b3,b3', 'values'], ['b4,b4', 'values'], ['b9,b9', 'values'], ['b5,b5', 'different'], ['b6,b6', 'values'], ['b7,b7', 'same'],
    ]);
    const plan = a.rows[3];
    expect(plan.template).toContain('Amount due: {{Amount due}}');
    expect(plan.slots!.find((s) => s.name === 'Amount due')!.values).toEqual(['$49.00', '$120.00']);
    expect(plan.slots!.find((s) => s.name === 'Member number')!.values).toEqual(['4410 2201', '4410 9988']);
    expect(a.rows[4]).toMatchObject({ template: 'Your plan is {{Value 1}} and it renews automatically.', slots: [{ name: 'Value 1', values: ['Flex', 'Max'] }] });
    expect(a.counts).toEqual({ same: 2, values: 5, different: 1, partial: 0 });
  });

  it('three samples: a block only some samples have is partial', () => {
    const a = alignSamples([SAMPLE_A, SAMPLE_B, SAMPLE_C].map((r, i) => ({ blocks: r.blocks, marks: markPersonalDetails(r.blocks, { prefix: `s${i + 1}` }) })));
    expect(a.samples).toBe(3);
    const locker = a.rows.find((r) => r.blocks[2] === 'b8')!;
    expect(locker).toMatchObject({ kind: 'partial', blocks: [null, null, 'b8'] });
    expect(a.rows.find((r) => r.blocks[0] === 'b5')!.kind).toBe('different');
    expect(a.rows.find((r) => r.blocks[0] === 'b7')!.kind).toBe('same');
    expect(a.counts.partial).toBe(1);
  });

  it('the comparison goes into the outline, without values when placeholders are chosen', () => {
    const fs = fileSamples([SAMPLE_A, SAMPLE_B]);
    const withPh = sendOutline(fs, { placeholders: true });
    expect(withPh).toContain('Comparison of the 2 samples');
    expect(withPh).toContain('the wording differs');
    expect(withPh).toContain('Sample 2: Your last payment failed.');
    expect(withPh).not.toContain('$120.00');
    expect(withPh).not.toContain('Ben');
    expect(sendOutline(fs, { placeholders: false })).toContain('sample 2: $120.00');
  });
});

describe('the built-in proposal and the report', () => {
  const build = (spec: ReturnType<typeof setupSpecFromFile>['spec']) => {
    const checked = checkSetupSpec(spec);
    const { project, notes } = projectFromSetupSpec(checked.spec, { projectId: 'rebuilt', title: checked.spec.title });
    expect(projectFileProblems(project)).toEqual([]);
    const res = resolve({ project, record: { ...baselineCustomer(project).record, recordId: 'REC-0000' } });
    return { checked, project, notes, res };
  };

  it('one sample: sections in reading order, marked values as typed data fields, a table as a list, no rules, the paper kept', () => {
    const { spec } = setupSpecFromFile(fileSamples([SAMPLE_A]));
    expect(spec.title).toBe('Membership renewal');
    expect(spec.paper).toBe('A4');
    expect(spec.sections.map((s) => s.type)).toEqual(['heading', 'paragraph', 'paragraph', 'keyFigures', 'paragraph', 'paragraph', 'table', 'notice']);
    expect(spec.sections[1]).toEqual({ type: 'paragraph', text: '{First name} {Last name}\n{Address line 1}\n{Address line 2}' });
    expect(spec.sections[2]).toEqual({ type: 'paragraph', text: 'Dear {First name} {Last name},' });
    expect(spec.fields.map((f) => [f.label, f.type])).toEqual([
      ['Address line 1', 'text'], ['Address line 2', 'text'], ['Member number', 'text'], ['Amount due', 'amount'], ['Renewal date', 'date'],
      ['Table 1', 'list'],
    ]);
    expect(spec.fields.find((f) => f.type === 'list')!.columns).toEqual([{ label: 'Date', type: 'date' }, { label: 'Description', type: 'text' }, { label: 'Amount', type: 'amount' }]);
    expect(spec.sections[3]).toEqual({ type: 'keyFigures', fields: ['Member number', 'Amount due', 'Renewal date'] });
    expect(spec.sections[4]).toEqual({ type: 'paragraph', text: 'Your plan is Flex and it renews automatically.' });
    expect(spec.sections[6]).toEqual({ type: 'table', list: 'Table 1', columns: ['Date', 'Description', 'Amount'], totalColumn: 'Amount' });
    // Never an example value from the file.
    expect(spec.fields.every((f) => f.example === undefined)).toBe(true);
    const { checked, project, res } = build(spec);
    expect(checked.notes).toEqual([]);
    expect(project.rules).toEqual([]);
    expect(project.presentationProfiles.find((p) => p.id === 'paged-pdf')!.paper).toBe('A4');
    expect(res.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
  });

  it('two samples: differing wording becomes a message chosen by a stand-in choice field, fixed wording keeps no marks', () => {
    const { spec, notes } = setupSpecFromFile(fileSamples([SAMPLE_A, SAMPLE_B]), { title: 'Gym renewal' });
    expect(spec.title).toBe('Gym renewal');
    const msg = spec.sections.find((s) => s.type === 'messages');
    expect(msg).toMatchObject({ type: 'messages', name: 'Message 1', versions: [{ title: 'Version A', fallback: true }, { title: 'Version B', when: { field: 'Message 1 version', test: 'is', value: 'B' } }] });
    expect(spec.fields.find((f) => f.label === 'Message 1 version')).toEqual({ label: 'Message 1 version', type: 'choice', choices: ['A', 'B'] });
    expect(notes.join(' ')).toMatch(/stands in for the rule/);
    const { project, res } = build(spec);
    expect(project.rules).toHaveLength(1);
    expect(res.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
  });

  it('the report says what is not brought across, without quoting the file', () => {
    const one = notBroughtAcross(fileSamples([SAMPLE_A]));
    const topics = one.map((i) => i.topic);
    expect(topics).toEqual(expect.arrayContaining(['images', 'fonts', 'layout', 'rules']));
    expect(one.find((i) => i.topic === 'images')!.text).toMatch(/1 picture \(120 × 40 pt at the top right of page 1\) was noted by position and size only/);
    expect(one.find((i) => i.topic === 'rules')!.text).toMatch(/One sample shows one customer’s copy/);
    const three = notBroughtAcross(fileSamples([SAMPLE_A, SAMPLE_B, SAMPLE_C]));
    expect(three.map((i) => i.text).join(' ')).toMatch(/not in every sample/);
    for (const item of [...one, ...three]) for (const value of ['Jane', '$49.00', 'Towels', 'Thank you']) expect(item.text).not.toContain(value);
  });
});
