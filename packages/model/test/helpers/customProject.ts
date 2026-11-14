import {
  applyCommand, blankProject, defaultNode, richFromMarkup,
  type Command, type CustomField, type DocNode, type Project, type Rule, type SyntheticRecord,
} from '../../src';

/**
 * A small document "with its own data" (kind `custom`) used by the tests of every package: a gym membership notice.
 * Built the way a person would build it: from the blank project, through the command bus, with default components.
 * Nothing in it comes from the card or claim samples.
 */
export const run = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; };

export const GYM_FIELDS: CustomField[] = [
  { key: 'planName', label: 'Plan name', type: 'string', required: true, example: 'Flex' },
  { key: 'monthlyFeeCents', label: 'Monthly fee', type: 'cents', required: true, example: '4900' },
  { key: 'renewalDate', label: 'Renewal date', type: 'date', required: true, example: '2026-12-01' },
  { key: 'tier', label: 'Membership tier', type: 'enum', enumValues: ['basic', 'plus', 'pro'], required: true, dimension: true },
  { key: 'autoRenew', label: 'Renews automatically', type: 'bool' },
  { key: 'visits', label: 'Visits this month', type: 'int' },
  {
    key: 'sessions', label: 'Booked sessions', type: 'list',
    itemFields: [
      { key: 'day', label: 'Day', type: 'date' },
      { key: 'className', label: 'Class', type: 'string' },
      { key: 'priceCents', label: 'Price', type: 'cents' },
      { key: 'spots', label: 'Spots', type: 'int' },
    ],
  },
];

const custom = (id: string, title: string, mode: Rule['mode'], priority: number, when: Rule['when'], then: Rule['then'], group?: string): Rule =>
  ({ id, scope: 'custom', mode, priority, when, then, version: 1, enabled: true, title, ...(group ? { exclusiveGroup: group } : {}) });

export function gymProject(opts: { withSpanish?: boolean } = {}): Project {
  let p = blankProject({ projectId: 'gym-notice', title: 'Membership notice', issuerName: 'Northside Gym', accent: '#1f4e79' });
  p = run(p, { type: 'SET_CUSTOM_FIELDS', fields: GYM_FIELDS });
  const insert = (node: DocNode) => { p = run(p, { type: 'INSERT_NODE', node, parentId: 'doc-root' }); };

  insert({ ...defaultNode('rich-text', 'heading', 'custom', p), name: 'Heading', content: richFromMarkup('# Your membership\nHello {{customer.givenName}} {{customer.familyName}}, here is your {{custom.planName}} plan.') });
  insert({ ...defaultNode('summary-metric', 'fee', 'custom', p), name: 'Monthly fee', importance: 'primary' });
  insert({ ...defaultNode('bound-field', 'renewal', 'custom', p), name: 'Renewal date', binding: 'custom.renewalDate', formatter: 'date', label: 'Renews on' });
  insert({ ...defaultNode('bound-field', 'auto', 'custom', p), name: 'Auto-renew', binding: 'custom.autoRenew', formatter: 'text', label: 'Renews automatically' });
  // The table takes the project's first list; the price column is summed.
  const table = defaultNode('repeating-table', 'sessions', 'custom', p);
  insert({ ...table, columns: table.columns!.map((c) => (c.key === 'priceCents' ? { ...c, total: true } : c)) });
  insert(defaultNode('variant-set', 'renewal-note', 'custom', p));
  p = run(p, { type: 'ADD_VARIANT', nodeId: 'renewal-note', variantId: 'note-pro', title: 'Pro members', text: 'As a Pro member you keep priority booking, {{customer.givenName}}.' });
  p = run(p, { type: 'ADD_VARIANT', nodeId: 'renewal-note', variantId: 'note-lapsing', title: 'We miss you', text: 'You visited {{custom.visits}} times this month. Your plan ends on {{custom.renewalDate}} unless you renew.' });
  p = run(p, { type: 'UPSERT_RULE', rule: custom('R01', 'Pro members get the Pro note', 'exclusive', 200, { op: 'eq', path: 'custom.tier', value: 'pro' }, { op: 'selectVariant', targetNodeId: 'renewal-note', variantId: 'note-pro' }, 'renewal-note') });
  p = run(p, {
    type: 'UPSERT_RULE',
    rule: custom('R02', 'Rare visitors who do not renew automatically', 'exclusive', 300, { op: 'and', args: [{ op: 'eq', path: 'custom.autoRenew', value: false }, { op: 'lt', path: 'custom.visits', value: 2 }] }, { op: 'selectVariant', targetNodeId: 'renewal-note', variantId: 'note-lapsing' }, 'renewal-note'),
  });
  // A section that only customers with more than three booked sessions get.
  insert({ ...defaultNode('rich-text', 'busy-note', 'custom', p), name: 'Busy month note', content: richFromMarkup('You have {{custom.sessions.count}} sessions booked. Arrive ten minutes early.'), visibleWhen: { op: 'gt', path: 'custom.sessions.count', value: 3 } });

  if (opts.withSpanish) {
    p = run(p, { type: 'ADD_LANGUAGE', locale: 'es-US' });
    const es: Record<string, string> = {
      'renewal-note-default': 'Escriba el mensaje aquí.',
      'note-pro': 'Como miembro Pro conserva la reserva prioritaria, {{customer.givenName}}.',
      'note-lapsing': 'Nos visitó {{custom.visits}} veces este mes. Su plan termina el {{custom.renewalDate}} si no lo renueva.',
      '@fee/label': 'Cuota mensual',
    };
    for (const [partId, text] of Object.entries(es)) {
      p = run(p, { type: 'SET_TRANSLATION_DRAFT', partId, locale: 'es-US', text });
      p = run(p, { type: 'APPROVE_TRANSLATION', partId, locale: 'es-US' });
    }
  }
  return p;
}

/** A customer of the gym project. Not stored anywhere; the id only has to look like one. */
export function gymMember(over: { custom?: Record<string, unknown>; customer?: Record<string, unknown>; recordId?: string } = {}): SyntheticRecord {
  return {
    recordId: over.recordId ?? 'REC-60001',
    documentType: 'custom',
    customer: { givenName: 'Robin', familyName: 'Okoye', locale: 'en-US', ...(over.customer ?? {}) },
    custom: {
      planName: 'Flex', monthlyFeeCents: 4900, renewalDate: '2026-12-01', tier: 'plus', autoRenew: true, visits: 9,
      sessions: [
        { day: '2026-11-03', className: 'Spin', priceCents: 1200, spots: 2 },
        { day: '2026-11-10', className: 'Yoga', priceCents: 900, spots: 1 },
      ],
      ...(over.custom ?? {}),
    },
  } as SyntheticRecord;
}

/** What a person reads in an HTML output: no styles, scripts, markup or attribute values (class names such as "iss-card" are not wording). */
export const visibleText = (html: string): string => {
  const body = html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ');
  // Also what assistive technology and browsers read out: labels, alternative text, tooltips, placeholders, the page description.
  const spoken = [...body.matchAll(/\s(?:aria-label|alt|title|placeholder|content)="([^"]*)"/g)].map((m) => m[1]).join(' ');
  // Markup between a word and its punctuation ("<span>Robin</span>.") leaves no gap in what is read.
  return `${body.replace(/<[^>]+>/g, ' ')} ${spoken}`.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').replace(/ ([.,;:!?])/g, '$1').trim();
};

/** Words that belong to the card and claim samples and must never appear in a document with its own data. */
export const SAMPLE_WORDING = /\b(card|cardholder|statement|claims?|bill|balance|member responsibility|explanation of benefits|transactions?|aster|harborcare|undefined|NaN)\b|\[object Object\]/i;
