import type { ComponentCatalogEntry, ComponentType, DocNode } from './types';

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

/** Default, valid configuration for a freshly inserted component. */
export function defaultNode(type: ComponentType, id: string, documentType: 'credit-statement' | 'eob'): DocNode {
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
