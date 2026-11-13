import { customFieldDefs, defaultFormatterFor, type FieldDef } from './fields';
import type { ComponentCatalogEntry, ComponentType, ContentPart, CustomField, DocNode, DocumentType, Project, TableColumn } from './types';

const ALL: ComponentCatalogEntry['supportsLayoutProfiles'] = ['paged-pdf', 'paged-afp-sim', 'html-responsive'];

/** The exact 15 authorable component types (fixtures/component_catalog_15.json + POC behavior). */
export const COMPONENT_CATALOG: ComponentCatalogEntry[] = [
  { type: 'container', code: 'C01', label: 'Container / Section', supportsLayoutProfiles: ALL, supportsDataBinding: false, deep: false, canContainChildren: true, description: 'Groups children; column or row flow; fixed or flowing.' },
  { type: 'rich-text', code: 'C02', label: 'Rich Text', supportsLayoutProfiles: ALL, supportsDataBinding: true, deep: true, canContainChildren: false, description: 'Headings, paragraphs, bold/italic, lists, safe links and data tokens.' },
  { type: 'image', code: 'C03', label: 'Image / Logo', supportsLayoutProfiles: ALL, supportsDataBinding: false, deep: false, canContainChildren: false, description: 'Bundled sample image with alt text and fit.' },
  { type: 'shape', code: 'C04', label: 'Shape / Divider', supportsLayoutProfiles: ALL, supportsDataBinding: false, deep: false, canContainChildren: false, description: 'Line or rectangle with stroke and fill.' },
  { type: 'header-footer', code: 'C05', label: 'Header / Footer', supportsLayoutProfiles: ALL, supportsDataBinding: true, deep: false, canContainChildren: false, description: 'Repeating page chrome and document header.' },
  { type: 'bound-field', code: 'C06', label: 'Bound Field', supportsLayoutProfiles: ALL, supportsDataBinding: true, deep: true, canContainChildren: false, description: 'Typed schema path, formatter and null handling.' },
  { type: 'repeating-table', code: 'C07', label: 'Repeating Table', supportsLayoutProfiles: ALL, supportsDataBinding: true, deep: true, canContainChildren: false, description: 'Bound array, columns, continuation and repeated headings.' },
  { type: 'summary-metric', code: 'C08', label: 'Summary / Metric', supportsLayoutProfiles: ALL, supportsDataBinding: true, deep: false, canContainChildren: false, description: 'Bound or derived value with label and importance.' },
  { type: 'chart', code: 'C09', label: 'Chart', supportsLayoutProfiles: ALL, supportsDataBinding: true, deep: false, canContainChildren: false, description: 'Bar or donut from data with accessible summary.' },
  { type: 'conditional-region', code: 'C10', label: 'Conditional Region', supportsLayoutProfiles: ALL, supportsDataBinding: true, deep: true, canContainChildren: false, description: 'Condition expressions select one (exclusive) or several (additive) branches.' },
  { type: 'variant-set', code: 'C11', label: 'Variant Set', supportsLayoutProfiles: ALL, supportsDataBinding: true, deep: true, canContainChildren: false, description: 'Named alternatives with exclusive rule precedence and explicit fallback.' },
  { type: 'disclosure', code: 'C12', label: 'Disclosure', supportsLayoutProfiles: ALL, supportsDataBinding: false, deep: true, canContainChildren: false, description: 'Mandatory, versioned, protected approved text.' },
  { type: 'action-link', code: 'C13', label: 'Action / Link', supportsLayoutProfiles: ALL, supportsDataBinding: false, deep: false, canContainChildren: false, description: 'Safe HTTPS action with printed fallback.' },
  { type: 'qr-code', code: 'C14', label: 'QR Code', supportsLayoutProfiles: ALL, supportsDataBinding: false, deep: false, canContainChildren: false, description: 'Validated destination encoded as print QR with caption.' },
  { type: 'expandable-explanation', code: 'C15', label: 'Expandable Explanation', supportsLayoutProfiles: ALL, supportsDataBinding: false, deep: false, canContainChildren: false, description: 'Summary/details: HTML accordion, expanded in print.' },
];

export const CATALOG_BY_TYPE: Record<ComponentType, ComponentCatalogEntry> = Object.fromEntries(
  COMPONENT_CATALOG.map((c) => [c.type, c]),
) as Record<ComponentType, ComponentCatalogEntry>;

let seq = 0;
export function newNodeId(type: ComponentType, existing: Set<string>): string {
  const base = type.replace(/[^a-z]/g, '').slice(0, 8);
  let id: string;
  do { seq += 1; id = `${base}-${(Date.now() % 100000).toString(36)}${seq.toString(36)}`; } while (existing.has(id));
  return id;
}

/**
 * Default, valid configuration for a freshly inserted component.
 *
 * The two built-in kinds start from their sample data (the card's transactions, a claim's amounts). A project with its
 * own data ("custom") has none of that: a component that shows data starts on the project's first suitable data field
 * (pass the project so its fields are known), and a message or disclosure starts with wording of its own, which
 * `INSERT_NODE` creates with the component (see `starterContentParts`).
 */
export function defaultNode(type: ComponentType, id: string, documentType: DocumentType, project?: Pick<Project, 'customFields'>): DocNode {
  return documentType === 'custom' ? ownDataDefault(type, id, project?.customFields ?? []) : builtInDefault(type, id, documentType);
}

const ALIGN_RIGHT = new Set<string>(['cents', 'int', 'points']);

/** Table columns for a list field: one per column of the list, formatted by its type. */
export function tableColumnsFor(list: Pick<FieldDef, 'itemFields'>): TableColumn[] {
  return (list.itemFields ?? []).map((it) => ({ key: it.key, label: it.label, format: defaultFormatterFor(it.type), ...(ALIGN_RIGHT.has(it.type) ? { align: 'right' as const } : {}) }));
}

function ownDataDefault(type: ComponentType, id: string, customFields: CustomField[]): DocNode {
  const flow = { paged: { mode: 'flow' as const, widthPct: 100, align: 'left' as const, spaceBeforePt: 8 }, html: { area: 'main' as const, span: 12 } };
  const defs = customFieldDefs(customFields).filter((f) => !f.derived);
  const values = defs.filter((f) => f.type !== 'array');
  const lists = defs.filter((f) => f.type === 'array');
  const name: Pick<FieldDef, 'path' | 'type' | 'label'> = { path: 'customer.givenName', type: 'string', label: 'Given name' };
  switch (type) {
    case 'image': return { id, type, name: 'Image', layout: { paged: { ...flow.paged, widthPct: 30 }, html: { area: 'main', span: 4 } }, image: { src: '', alt: 'Describe this image', fit: 'contain' }, decorative: false };
    // No colour of its own: the divider takes the issuer's colour.
    case 'shape': return { id, type, name: 'Divider', layout: flow, shape: { kind: 'line', strokeWidthPt: 1.5 }, decorative: true };
    case 'bound-field': {
      const f = values[0] ?? name;
      return { id, type, name: 'Bound field', layout: { paged: { ...flow.paged, widthPct: 50 }, html: { area: 'main', span: 6 } }, binding: f.path, formatter: defaultFormatterFor(f.type), label: f.label, nullPolicy: 'fallback', fallbackText: '—' };
    }
    case 'summary-metric': {
      const f = values.find((x) => x.type === 'cents') ?? values.find((x) => x.type === 'int') ?? values[0] ?? name;
      return { id, type, name: 'Metric', layout: { paged: { ...flow.paged, widthPct: 33 }, html: { area: 'main', span: 4 } }, binding: f.path, formatter: defaultFormatterFor(f.type), label: f.label, importance: 'secondary', nullPolicy: 'fallback', fallbackText: '—' };
    }
    case 'repeating-table': {
      const list = lists[0];
      // Without a list field the table is inserted unbound; the document says so until a list is chosen.
      return { id, type, name: list ? list.label : 'Table', layout: flow, ...(list ? { binding: list.path } : {}), columns: list ? tableColumnsFor(list) : [], flowContinuation: true, repeatHeader: 'always', sortable: true, filterable: true, caption: list ? list.label : 'Table' };
    }
    case 'chart': {
      // A bar per value of a text column, sized by an amount (or whole-number) column of the same list.
      for (const list of lists) {
        const group = list.itemFields?.find((it) => it.type === 'string');
        const value = list.itemFields?.find((it) => it.type === 'cents') ?? list.itemFields?.find((it) => it.type === 'int');
        if (group && value) return { id, type, name: 'Chart', layout: flow, binding: list.path, chart: { kind: 'bar', title: `${value.label} by ${group.label.toLowerCase()}`, groupBy: group.key, valueKey: value.key, limit: 5, palette: 'brand' } };
      }
      return { id, type, name: 'Chart', layout: flow, chart: { kind: 'bar', title: 'Chart', limit: 5, palette: 'brand' } };
    }
    case 'variant-set': return { id, type, name: 'Message', layout: flow, policy: 'exclusive', variantIds: [`${id}-default`], fallbackVariantId: `${id}-default` };
    case 'disclosure': return { id, type, name: 'Disclosure', layout: flow, contentPartId: id, required: false, protected: true, jurisdiction: [] };
    // Components whose built-in default holds no sample data.
    default: return builtInDefault(type, id, 'credit-statement');
  }
}

/**
 * The wording a component needs that the project does not have yet: the text of a disclosure, or the message versions
 * of a variant set or conditional region. `INSERT_NODE` adds these with the component, so a component inserted into a
 * project that has no wording at all (a blank project) is complete in one step.
 */
export function starterContentParts(node: DocNode, existing: ReadonlySet<string>): ContentPart[] {
  const part = (pid: string, title: string, text: string, kind: ContentPart['type']): ContentPart => ({ id: pid, version: 1, title, approvedLocales: { 'en-US': text }, syntheticDemoOnly: true, type: kind });
  // Only wording that is the component's own (named after it). A reference to shared wording that is missing stays a finding.
  const own = (pid: string): boolean => (pid === node.id || pid.startsWith(`${node.id}-`)) && !existing.has(pid);
  if (node.type === 'disclosure') {
    const pid = node.contentPartId ?? node.id;
    return own(pid) ? [part(pid, node.name?.trim() || 'Disclosure', 'Write the disclosure text here.', 'disclosure')] : [];
  }
  if (node.type === 'variant-set' || node.type === 'conditional-region') {
    const missing = [...new Set(node.variantIds ?? [])].filter(own);
    return missing.map((v) => part(v, v === node.fallbackVariantId ? 'Standard message' : 'New message', 'Write the message here.', 'text'));
  }
  return [];
}

function builtInDefault(type: ComponentType, id: string, documentType: 'credit-statement' | 'eob'): DocNode {
  const flow = { paged: { mode: 'flow' as const, widthPct: 100, align: 'left' as const, spaceBeforePt: 8 }, html: { area: 'main' as const, span: 12 } };
  const nameToken = 'customer.givenName';
  const amountPath = documentType === 'eob' ? 'claim.allowedCents' : 'card.newBalanceCents';
  switch (type) {
    case 'container': return { id, type, name: 'Section', children: [], layout: { ...flow, paged: { ...flow.paged, direction: 'column' } } };
    case 'rich-text': return { id, type, name: 'Rich text', layout: flow, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New text for ' }, { type: 'token', attrs: { path: nameToken } }, { type: 'text', text: '.' }] }] } };
    case 'image': return { id, type, name: 'Image', layout: { paged: { ...flow.paged, widthPct: 30 }, html: { area: 'main', span: 4 } }, image: { src: documentType === 'eob' ? 'asset:harborcare-mark' : 'asset:aster-mark', alt: 'Issuer logo (synthetic)', fit: 'contain' }, decorative: false };
    case 'shape': return { id, type, name: 'Divider', layout: flow, shape: { kind: 'line', stroke: '#4EAF60', strokeWidthPt: 1.5 }, decorative: true };
    case 'header-footer': return { id, type, name: 'Section header', layout: flow, headerFooter: { role: 'document-header', text: 'Section heading', repeat: false } };
    case 'bound-field': return { id, type, name: 'Bound field', layout: { paged: { ...flow.paged, widthPct: 50 }, html: { area: 'main', span: 6 } }, binding: nameToken, formatter: 'text', label: 'Given name', nullPolicy: 'fallback', fallbackText: '—' };
    case 'repeating-table': return { id, type, name: 'Table', layout: flow, binding: documentType === 'eob' ? 'claims' : 'card.transactions', columns: documentType === 'eob' ? [{ key: 'claimId', label: 'Claim' }, { key: 'service', label: 'Service' }, { key: 'billedCents', label: 'Billed', format: 'usd-cents', align: 'right' }] : [{ key: 'date', label: 'Date', format: 'date' }, { key: 'merchant', label: 'Description' }, { key: 'amountCents', label: 'Amount', format: 'usd-cents', align: 'right' }], flowContinuation: true, repeatHeader: 'always', sortable: true, filterable: true, caption: 'Table' };
    case 'summary-metric': return { id, type, name: 'Metric', layout: { paged: { ...flow.paged, widthPct: 33 }, html: { area: 'main', span: 4 } }, binding: amountPath, formatter: 'usd-cents', label: 'Amount', importance: 'secondary', nullPolicy: 'fallback', fallbackText: '—' };
    case 'chart': return { id, type, name: 'Chart', layout: flow, chart: documentType === 'eob' ? { kind: 'donut', title: 'Claim breakdown', series: [{ label: 'Plan paid', path: 'claim.planPaidCents' }, { label: 'Adjustment', path: 'claim.contractualAdjustmentCents' }] } : { kind: 'bar', title: 'Spending by merchant', groupBy: 'merchant', valueKey: 'amountCents', limit: 5, palette: 'brand' }, binding: documentType === 'eob' ? undefined : 'card.transactions' };
    case 'conditional-region': return { id, type, name: 'Conditional region', layout: flow, policy: 'exclusive', variantIds: [], variantConditions: {} };
    case 'variant-set': return { id, type, name: 'Variant set', layout: flow, policy: 'exclusive', variantIds: [] };
    case 'disclosure': return { id, type, name: 'Disclosure', layout: flow, contentPartId: documentType === 'eob' ? 'claim-glossary' : 'credit-adjustment-note', required: false, protected: true, jurisdiction: ['US-demo'] };
    case 'action-link': return { id, type, name: 'Action', layout: { paged: { ...flow.paged, widthPct: 50 }, html: { area: 'main', span: 6 } }, action: { label: 'Review options', url: 'https://example.com/demo/options', fallbackText: 'Visit example.com/demo/options' } };
    case 'qr-code': return { id, type, name: 'QR code', layout: { paged: { ...flow.paged, widthPct: 25 }, html: { area: 'main', span: 3 } }, qr: { url: 'https://example.com/demo/options', caption: 'Scan to review options' } };
    case 'expandable-explanation': return { id, type, name: 'Explanation', layout: flow, explanation: { title: 'What does this mean?', summary: 'A short explanation.', details: 'Longer details shown expanded in print and collapsible in HTML.' } };
  }
}
