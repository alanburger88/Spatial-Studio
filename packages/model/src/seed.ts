import { richFromMarkup } from './rich';
import type { ContentPart, DocNode, JourneyEvent, PresentationProfile, Project, Rule } from './types';

/** Business titles for the supplied fixture rules (the pack's rules carry IDs and logic only). */
const RULE_TITLES: Record<string, string> = {
  R01: 'Customer is up to date',
  R02: 'One missed payment — send a reminder',
  R03: 'Two or more missed payments — offer support',
  R04: 'Customer asked for payment assistance',
  R05: 'Payment arrangement approved',
  R06: 'Premium tier — show relationship team',
  R07: 'Spanish-speaking customer — use approved Spanish wording',
  R08: 'Prefers digital — interactive action with print fallback',
  R09: 'Prefers print — print-friendly guidance',
  R10: 'Long transaction list — repeat headings across pages',
  R11: 'Has rewards — show rewards summary',
  R12: 'Mandatory statement content',
  R13: 'Claim processed and covered',
  R14: 'Claim denied — under review',
  R15: 'Appeal filed',
  R16: 'Out-of-network provider — explain network',
  R17: 'Deductible applied — explain deductible',
  R18: 'Confirmed member responsibility — show summary',
  R19: 'Several claims — show claim index',
  R20: 'Mandatory EOB content',
};

/**
 * Builds the approved, editable sample projects from the supplied fixture seeds.
 * The fixture projects contain only logical placement; here we add the physical paged
 * geometry, responsive layout and supporting components while preserving every seeded
 * node ID, rule ID and content-part ID unchanged.
 */

const L = {
  flow: (o: Partial<NonNullable<DocNode['layout']>['paged']> = {}, h: NonNullable<DocNode['layout']>['html'] = { area: 'main', span: 12 }) => ({
    paged: { mode: 'flow' as const, widthPct: 100, align: 'left' as const, spaceBeforePt: 10, ...o },
    html: h,
  }),
  fixed: (xPt: number, yPt: number, wPt: number, hPt: number, pages: 'first' | 'all' | 'following' = 'first', h: NonNullable<DocNode['layout']>['html'] = { area: 'header', span: 12 }) => ({
    paged: { mode: 'fixed' as const, xPt, yPt, wPt, hPt, pages },
    html: h,
  }),
};

function profilesFor(base: PresentationProfile[]): PresentationProfile[] {
  return base.map((p) => {
    if (p.kind === 'paged') return { ...p, flowRegion: { firstPageTopPt: 184, otherPagesTopPt: 84, bottomPt: 738 } };
    if (p.kind === 'afp-simulation') return {
      ...p,
      pageMarginsMm: [14, 14, 14, 14],
      flowRegion: { firstPageTopPt: 184, otherPagesTopPt: 84, bottomPt: 738 },
      afp: {
        formdef: 'F1ISSSIM (conceptual)',
        pagedef: 'P1LTR01 (conceptual)',
        fontMap: { 'Inter Regular': 'X0ISS10 (concept mapping)', 'Inter Bold': 'X0ISSB0 (concept mapping)' },
        overlays: ['O1ISSHDR (issuer header, concept)'],
        resources: ['Page segment: issuer mark (concept)', 'Code page: T1001208 (concept)', 'Coded font mapping (concept)', 'Medium map: simplex letter (concept)'],
      },
    };
    return p;
  });
}

function cardNodes(): DocNode[] {
  return [
    {
      id: 'doc-root', type: 'container', name: 'Statement',
      children: [
        'issuer-logo', 'document-header', 'statement-title', 'customer-address', 'header-rule', 'running-header', 'page-footer',
        'greeting', 'account-summary', 'balance-breakdown', 'payment-guidance', 'relationship-manager', 'rewards-summary',
        'high-volume-note', 'payment-actions', 'spend-chart', 'transaction-table', 'interest-explainer', 'sample-disclosure-set',
      ],
    },
    { id: 'issuer-logo', type: 'image', name: 'Issuer logo', image: { src: 'asset:aster-mark', alt: 'Aster Card (fictional issuer) logo', fit: 'contain' }, layout: L.fixed(40, 36, 150, 40, 'first', { area: 'header', span: 4 }) },
    { id: 'document-header', type: 'header-footer', name: 'Document header', headerFooter: { role: 'document-header', text: 'SYNTHETIC DEMO DATA · Not a legal statement', repeat: false }, layout: L.fixed(330, 44, 242, 20, 'first', { area: 'header', span: 8 }) },
    { id: 'statement-title', type: 'rich-text', name: 'Statement title', content: richFromMarkup('# Monthly account statement\nStatement period {{card.statementStart}} – {{card.statementEnd}}'), layout: L.fixed(40, 92, 300, 60, 'first', { area: 'header', span: 7 }) },
    { id: 'customer-address', type: 'rich-text', name: 'Cardholder block', content: richFromMarkup('**{{customer.givenName}} {{customer.familyName}}**\nAccount {{card.maskedAccount}}\nIssued {{card.issuedAt}}'), layout: L.fixed(380, 92, 192, 62, 'first', { area: 'header', span: 5 }) },
    { id: 'header-rule', type: 'shape', name: 'Header rule', decorative: true, shape: { kind: 'line', stroke: '#4EAF60', strokeWidthPt: 2 }, layout: L.fixed(40, 164, 532, 3, 'first', { area: 'header', span: 12, hidden: true }) },
    { id: 'running-header', type: 'header-footer', name: 'Running header', headerFooter: { role: 'page-header', text: 'Aster Card statement · {{card.maskedAccount}} · {{customer.givenName}} {{customer.familyName}}', repeat: true }, layout: L.fixed(40, 36, 532, 30, 'following', { area: 'header', span: 12, hidden: true }) },
    { id: 'page-footer', type: 'header-footer', name: 'Page footer', headerFooter: { role: 'page-footer', text: 'Aster Card (fictional) · Synthetic demonstration — not a legal statement', repeat: true }, layout: L.fixed(40, 748, 532, 20, 'all', { area: 'footer', span: 12 }) },
    { id: 'greeting', type: 'rich-text', name: 'Greeting', content: richFromMarkup('Hello {{customer.givenName}}, here is your Aster Card statement. Your payment is due on **{{card.dueDate}}**.'), layout: L.flow({ spaceBeforePt: 0 }) },
    { id: 'account-summary', type: 'container', name: 'Account summary', children: ['billing-summary', 'payment-due', 'payment-due-date', 'available-credit'], layout: L.flow({ direction: 'row' }, { area: 'main', span: 12, direction: 'row' }) },
    { id: 'billing-summary', type: 'summary-metric', name: 'New balance', label: 'New balance', binding: 'card.newBalanceCents', formatter: 'usd-cents', importance: 'primary', layout: L.flow({ widthPct: 25, spaceBeforePt: 0 }, { span: 3 }) },
    { id: 'payment-due', type: 'summary-metric', name: 'Minimum payment', label: 'Minimum payment due', binding: 'card.minimumDueCents', formatter: 'usd-cents', importance: 'primary', layout: L.flow({ widthPct: 25, spaceBeforePt: 0 }, { span: 3 }) },
    { id: 'payment-due-date', type: 'bound-field', name: 'Payment due date', label: 'Payment due date', binding: 'card.dueDate', formatter: 'date', nullPolicy: 'error', layout: L.flow({ widthPct: 25, spaceBeforePt: 0 }, { span: 3 }) },
    { id: 'available-credit', type: 'summary-metric', name: 'Available credit', label: 'Available credit', binding: 'card.availableCreditCents', formatter: 'usd-cents', importance: 'secondary', layout: L.flow({ widthPct: 25, spaceBeforePt: 0 }, { span: 3 }) },
    { id: 'balance-breakdown', type: 'container', name: 'Balance breakdown', children: ['previous-balance', 'purchases-total', 'payments-credits', 'fees-interest'], layout: L.flow({ direction: 'row' }, { area: 'main', span: 12, direction: 'row' }) },
    { id: 'previous-balance', type: 'summary-metric', name: 'Previous balance', label: 'Previous balance', binding: 'card.previousBalanceCents', formatter: 'usd-cents', importance: 'secondary', layout: L.flow({ widthPct: 25, spaceBeforePt: 0 }, { span: 3 }) },
    { id: 'purchases-total', type: 'summary-metric', name: 'Purchases', label: '+ Purchases', binding: 'card.purchasesCents', formatter: 'usd-cents', importance: 'secondary', layout: L.flow({ widthPct: 25, spaceBeforePt: 0 }, { span: 3 }) },
    { id: 'payments-credits', type: 'summary-metric', name: 'Payments and credits', label: '− Payments & credits', binding: 'card.paymentsCreditsCents', formatter: 'usd-cents', importance: 'secondary', layout: L.flow({ widthPct: 25, spaceBeforePt: 0 }, { span: 3 }) },
    { id: 'fees-interest', type: 'summary-metric', name: 'Fees and interest', label: '+ Fees & interest', binding: 'card.interestFeesCents', formatter: 'usd-cents', importance: 'secondary', layout: L.flow({ widthPct: 25, spaceBeforePt: 0 }, { span: 3 }) },
    {
      id: 'payment-guidance', type: 'variant-set', name: 'Payment guidance', policy: 'exclusive', fallbackVariantId: 'payment-standard',
      variantIds: ['payment-standard', 'payment-reminder', 'payment-support-offer', 'payment-assistance-requested', 'payment-arrangement-active'],
      layout: L.flow({ spaceBeforePt: 14 }, { area: 'main', span: 12 }),
    },
    { id: 'relationship-manager', type: 'conditional-region', name: 'Relationship team', ruleDriven: true, policy: 'exclusive', variantIds: ['relationship-manager'], fallbackVariantId: 'relationship-manager', layout: L.flow({}, { area: 'aside', span: 4 }) },
    { id: 'rewards-summary', type: 'conditional-region', name: 'Rewards summary', ruleDriven: true, policy: 'exclusive', variantIds: ['rewards-summary'], fallbackVariantId: 'rewards-summary', layout: L.flow({}, { area: 'aside', span: 4 }) },
    { id: 'high-volume-note', type: 'conditional-region', name: 'High-volume note', policy: 'exclusive', variantIds: ['high-volume-help'], variantConditions: { 'high-volume-help': { op: 'gt', path: 'card.transactions.count', value: 25 } }, layout: L.flow({}, { area: 'main', span: 12 }) },
    { id: 'payment-actions', type: 'container', name: 'Payment actions', children: ['payment-action', 'payment-qr'], layout: L.flow({ direction: 'row' }, { area: 'aside', span: 4, direction: 'column' }) },
    { id: 'payment-action', type: 'action-link', name: 'Pay online action', action: { label: 'Review payment options', url: 'https://example.com/aster/payments', fallbackText: 'Visit example.com/aster/payments to review payment options.' }, layout: L.flow({ widthPct: 70, spaceBeforePt: 0 }, { span: 12 }) },
    { id: 'payment-qr', type: 'qr-code', name: 'Payment QR code', qr: { url: 'https://example.com/aster/payments', caption: 'Scan to review payment options' }, layout: L.flow({ widthPct: 30, spaceBeforePt: 0, align: 'right' }, { span: 12, hidden: true }) },
    { id: 'spend-chart', type: 'chart', name: 'Spending chart', binding: 'card.transactions', chart: { kind: 'bar', title: 'Top spending by merchant', groupBy: 'merchant', valueKey: 'amountCents', limit: 5, palette: 'brand' }, layout: L.flow({}, { area: 'aside', span: 4 }) },
    {
      id: 'transaction-table', type: 'repeating-table', name: 'Transactions', binding: 'card.transactions', flowContinuation: true, repeatHeader: 'when-hinted', sortable: true, filterable: true, caption: 'Transactions this period',
      columns: [
        { key: 'date', label: 'Date', format: 'date' },
        { key: 'merchant', label: 'Description', format: 'text' },
        { key: 'id', label: 'Reference', format: 'text' },
        { key: 'amountCents', label: 'Amount', format: 'usd-cents', align: 'right' },
      ],
      layout: L.flow({ spaceBeforePt: 14 }, { area: 'main', span: 12 }),
    },
    { id: 'interest-explainer', type: 'expandable-explanation', name: 'Minimum payment explainer', explanation: { title: 'How is the minimum payment shown?', summary: 'The minimum payment shown is an illustrative sample value.', details: 'This synthetic statement does not calculate APR, interest or payoff periods. Figures are fictional demonstration data and are not compliant financial calculations.' }, layout: L.flow({}, { area: 'main', span: 12 }) },
    { id: 'sample-disclosure-set', type: 'disclosure', name: 'Sample disclosures', required: true, protected: true, contentPartId: 'sample-disclosure-set', jurisdiction: ['US-demo'], layout: L.flow({ spaceBeforePt: 14 }, { area: 'footer', span: 12 }) },
  ];
}

function eobNodes(): DocNode[] {
  return [
    {
      id: 'doc-root', type: 'container', name: 'Explanation of benefits',
      children: [
        'issuer-logo', 'document-header', 'statement-title', 'customer-address', 'header-rule', 'running-header', 'page-footer',
        'not-a-bill-banner', 'claim-identifiers', 'claim-facts', 'eob-claim-message', 'network-explanation', 'deductible-explanation',
        'member-responsibility-summary', 'multi-claim-index', 'claim-chart', 'claim-table', 'claim-glossary', 'appeal-action', 'totals-and-terms',
      ],
    },
    { id: 'issuer-logo', type: 'image', name: 'Plan logo', image: { src: 'asset:harborcare-mark', alt: 'HarborCare Health (fictional insurer) logo', fit: 'contain' }, layout: L.fixed(40, 36, 170, 40, 'first', { area: 'header', span: 4 }) },
    { id: 'document-header', type: 'header-footer', name: 'Document header', headerFooter: { role: 'document-header', text: 'SYNTHETIC DEMO DATA · Not a medical record', repeat: false }, layout: L.fixed(330, 44, 242, 20, 'first', { area: 'header', span: 8 }) },
    { id: 'statement-title', type: 'rich-text', name: 'Document title', content: richFromMarkup('# Explanation of Benefits\nPlan {{member.planName}}'), layout: L.fixed(40, 92, 300, 60, 'first', { area: 'header', span: 7 }) },
    { id: 'customer-address', type: 'rich-text', name: 'Member block', content: richFromMarkup('**{{customer.givenName}} {{customer.familyName}}**\nMember ID {{member.memberId}}'), layout: L.fixed(380, 92, 192, 62, 'first', { area: 'header', span: 5 }) },
    { id: 'header-rule', type: 'shape', name: 'Header rule', decorative: true, shape: { kind: 'line', stroke: '#4EAF60', strokeWidthPt: 2 }, layout: L.fixed(40, 164, 532, 3, 'first', { area: 'header', span: 12, hidden: true }) },
    { id: 'running-header', type: 'header-footer', name: 'Running header', headerFooter: { role: 'page-header', text: 'HarborCare EOB · {{member.memberId}} · THIS IS NOT A BILL', repeat: true }, layout: L.fixed(40, 36, 532, 30, 'following', { area: 'header', span: 12, hidden: true }) },
    { id: 'page-footer', type: 'header-footer', name: 'Page footer', headerFooter: { role: 'page-footer', text: 'HarborCare Health (fictional) · Synthetic demonstration — THIS IS NOT A BILL', repeat: true }, layout: L.fixed(40, 748, 532, 20, 'all', { area: 'footer', span: 12 }) },
    { id: 'not-a-bill-banner', type: 'disclosure', name: 'Not a bill banner', required: true, protected: true, contentPartId: 'not-a-bill-banner', jurisdiction: ['US-demo'], layout: L.flow({ spaceBeforePt: 0 }, { area: 'main', span: 12 }) },
    { id: 'claim-identifiers', type: 'bound-field', name: 'Claim identifier', label: 'Claim', binding: 'claim.claimId', formatter: 'text', nullPolicy: 'error', layout: L.flow({ widthPct: 60 }, { area: 'main', span: 12 }) },
    { id: 'claim-facts', type: 'container', name: 'Claim amounts', children: ['billed-amount', 'allowed-amount', 'plan-paid', 'member-responsibility'], layout: L.flow({ direction: 'row' }, { area: 'main', span: 12, direction: 'row' }) },
    { id: 'billed-amount', type: 'summary-metric', name: 'Billed', label: 'Provider billed', binding: 'claim.billedCents', formatter: 'usd-cents', importance: 'secondary', layout: L.flow({ widthPct: 25, spaceBeforePt: 0 }, { span: 3 }) },
    { id: 'allowed-amount', type: 'summary-metric', name: 'Allowed', label: 'Plan allowed', binding: 'claim.allowedCents', formatter: 'usd-cents', importance: 'secondary', layout: L.flow({ widthPct: 25, spaceBeforePt: 0 }, { span: 3 }) },
    { id: 'plan-paid', type: 'summary-metric', name: 'Plan paid', label: 'Plan paid', binding: 'claim.planPaidCents', formatter: 'usd-cents', importance: 'primary', layout: L.flow({ widthPct: 25, spaceBeforePt: 0 }, { span: 3 }) },
    { id: 'member-responsibility', type: 'summary-metric', name: 'Member responsibility', label: 'You may be responsible for', binding: 'claim.patientResponsibilityCents', formatter: 'usd-cents', importance: 'primary', domainRole: 'member-liability', layout: L.flow({ widthPct: 25, spaceBeforePt: 0 }, { span: 3 }) },
    {
      id: 'eob-claim-message', type: 'variant-set', name: 'Claim message', policy: 'exclusive', fallbackVariantId: 'eob-processing',
      variantIds: ['eob-processing', 'eob-covered', 'eob-review-needed', 'eob-appeal-status'], layout: L.flow({ spaceBeforePt: 14 }),
    },
    { id: 'network-explanation', type: 'conditional-region', name: 'Network explanation', ruleDriven: true, policy: 'exclusive', variantIds: ['network-explanation'], fallbackVariantId: 'network-explanation', layout: L.flow({}, { area: 'aside', span: 4 }) },
    { id: 'deductible-explanation', type: 'conditional-region', name: 'Deductible explanation', ruleDriven: true, policy: 'exclusive', variantIds: ['deductible-explanation'], fallbackVariantId: 'deductible-explanation', layout: L.flow({}, { area: 'aside', span: 4 }) },
    { id: 'member-responsibility-summary', type: 'conditional-region', name: 'Member responsibility summary', ruleDriven: true, policy: 'exclusive', variantIds: ['member-responsibility-summary'], fallbackVariantId: 'member-responsibility-summary', layout: L.flow({}, { area: 'aside', span: 4 }) },
    { id: 'multi-claim-index', type: 'conditional-region', name: 'Multi-claim index', ruleDriven: true, policy: 'exclusive', variantIds: ['multi-claim-index'], fallbackVariantId: 'multi-claim-index', layout: L.flow({}, { area: 'aside', span: 4 }) },
    { id: 'claim-chart', type: 'chart', name: 'Claim breakdown chart', chart: { kind: 'donut', title: 'How the billed amount was handled', series: [{ label: 'Plan paid', path: 'claim.planPaidCents' }, { label: 'Contractual adjustment', path: 'claim.contractualAdjustmentCents' }, { label: 'Member responsibility', path: 'claim.patientResponsibilityCents' }, { label: 'Under review', path: 'claim.amountUnderReviewCents' }], palette: 'brand' }, layout: L.flow({}, { area: 'aside', span: 4 }) },
    {
      id: 'claim-table', type: 'repeating-table', name: 'Claims', binding: 'claims', flowContinuation: true, repeatHeader: 'always', sortable: true, filterable: true, caption: 'Claim details',
      columns: [
        { key: 'claimId', label: 'Claim', format: 'text' },
        { key: 'service', label: 'Service', format: 'text' },
        { key: 'serviceDate', label: 'Date', format: 'date' },
        { key: 'billedCents', label: 'Billed', format: 'usd-cents', align: 'right' },
        { key: 'allowedCents', label: 'Allowed', format: 'usd-cents', align: 'right' },
        { key: 'planPaidCents', label: 'Plan paid', format: 'usd-cents', align: 'right' },
        { key: 'patientResponsibilityCents', label: 'Member resp.', format: 'usd-cents', align: 'right', domainRole: 'member-liability' },
        { key: 'status', label: 'Status', format: 'text' },
      ],
      layout: L.flow({ spaceBeforePt: 14 }),
    },
    { id: 'claim-glossary', type: 'expandable-explanation', name: 'Terms explained', explanation: { title: 'Terms explained', summary: 'Allowed amount, adjustment and member responsibility.', details: 'Billed is what the provider charged. Allowed is the amount the plan recognizes. The contractual adjustment is the difference the in-network provider agreed not to charge. Member responsibility is shown only when the plan has confirmed it.' }, layout: L.flow() },
    { id: 'appeal-action', type: 'action-link', name: 'Questions action', action: { label: 'Questions about this claim?', url: 'https://example.com/harborcare/claims', fallbackText: 'Visit example.com/harborcare/claims or call the number on your member card.' }, layout: L.flow({ widthPct: 60 }) },
    { id: 'totals-and-terms', type: 'disclosure', name: 'Totals and terms', required: true, protected: true, contentPartId: 'totals-and-terms', jurisdiction: ['US-demo'], layout: L.flow({ spaceBeforePt: 14 }, { area: 'footer', span: 12 }) },
  ];
}

function journeyFor(kind: 'card' | 'eob', fixture: { events: JourneyEvent[] }): JourneyEvent[] {
  const days: Record<string, number> = { 'card-day1': 1, 'card-day30': 30, 'card-day45': 45, 'card-day60': 60, 'eob-received': 1, 'eob-adjudicated': 5, 'eob-review': 20, 'eob-appeal': 35 };
  const labels: Record<string, string> = {
    'card-day1': 'Statement issued', 'card-day30': 'Payment missed', 'card-day45': 'Assistance requested', 'card-day60': 'Arrangement approved',
    'eob-received': 'Claim received', 'eob-adjudicated': 'Claim adjudicated', 'eob-review': 'Review requested', 'eob-appeal': 'Appeal filed', 'eob-appeal-resolved': 'Appeal resolved',
  };
  const preconditions: Record<string, JourneyEvent['preconditions']> = {
    'card-day45': [{ path: 'card.paymentStatus', op: 'eq', value: 'overdue' }],
    'card-day60': [{ path: 'card.assistanceRequested', op: 'eq', value: true }],
  };
  const payloads: Record<string, JourneyEvent['payload']> = {
    'card-day30': { missedAmountCents: 4500 }, 'card-day45': { requested: true, channel: 'phone' }, 'card-day60': { arrangementMonths: 6 },
  };
  const events: JourneyEvent[] = fixture.events.map((e) => ({ ...e, day: days[e.eventId], label: labels[e.eventId], payload: payloads[e.eventId] ?? {}, ...(preconditions[e.eventId] ? { preconditions: preconditions[e.eventId] } : {}) }));
  if (kind === 'eob') {
    for (const e of events) if (e.eventId === 'eob-adjudicated') e.emits = 'immutable-issued-snapshot';
    events.push({ eventId: 'eob-appeal-resolved', eventType: 'appeal.resolved', day: 50, label: labels['eob-appeal-resolved'], effects: [{ op: 'set', path: 'claim.status', value: 'processed-covered' }], emits: 'new-communication-preview' });
  }
  return events;
}

export interface SeedInputs {
  projects: any[];
  rules: Rule[];
  contentParts: ContentPart[];
  journeys: { card: { events: JourneyEvent[] }; eob: { events: JourneyEvent[] } };
}

export function buildSeedProjects(inputs: SeedInputs): Project[] {
  return inputs.projects.map((fp) => {
    const isEob = fp.documentType === 'eob';
    const project: Project = {
      schemaVersion: fp.schemaVersion,
      projectId: fp.projectId,
      title: fp.title,
      documentType: fp.documentType,
      modelVersion: fp.modelVersion,
      rootNodeId: fp.rootNodeId,
      nodes: isEob ? eobNodes() : cardNodes(),
      presentationProfiles: profilesFor(fp.presentationProfiles),
      rules: inputs.rules.filter((r) => r.scope === fp.documentType).map((r) => ({ ...r, enabled: true, title: r.title ?? RULE_TITLES[r.id] })),
      contentParts: inputs.contentParts.map((c) => ({ ...c, approvedLocales: { ...c.approvedLocales } })),
      journey: { snapshotPolicy: 'issued-is-immutable', events: journeyFor(isEob ? 'eob' : 'card', isEob ? inputs.journeys.eob : inputs.journeys.card) },
      issuer: isEob ? { name: 'HarborCare Health', accent: '#1D5941', product: 'HarborCare Select' } : { name: 'Aster Card', accent: '#277656', product: 'Aster Card' },
    };
    // Integrity: every seeded fixture node ID must survive enrichment unchanged.
    const ids = new Set(project.nodes.map((n) => n.id));
    for (const n of fp.nodes) if (!ids.has(n.id)) throw new Error(`Seed enrichment dropped fixture node ${n.id}`);
    return project;
  });
}
