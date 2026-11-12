import type { CustomField, DocumentType, Formatter, Project } from './types';

/**
 * Typed data contracts. Tokens, bindings and rule predicates may only reference
 * allowlisted paths. No path is ever evaluated against arbitrary objects.
 */
export type FieldType = 'string' | 'cents' | 'date' | 'int' | 'bool' | 'enum' | 'array' | 'points';

export interface FieldDef {
  path: string;
  type: FieldType;
  label: string;
  enumValues?: string[];
  required?: boolean;
  /** Derived by the versioned pure-function registry, not stored in records. */
  derived?: boolean;
  /** Rows of an array field. */
  itemFields?: Array<{ key: string; type: FieldType; label: string }>;
  example?: string;
  /** Suitable as Cube/Landscape scenario dimension. */
  dimension?: boolean;
}

const common: FieldDef[] = [
  { path: 'documentType', type: 'enum', label: 'Document type', enumValues: ['credit-statement', 'eob'], required: true },
  { path: 'recordId', type: 'string', label: 'Synthetic record ID', required: true },
  { path: 'customer.givenName', type: 'string', label: 'Given name', required: true, example: 'Jordan' },
  { path: 'customer.familyName', type: 'string', label: 'Family name', required: true, example: 'Mercer' },
  { path: 'customer.locale', type: 'enum', label: 'Preferred locale', enumValues: ['en-US', 'es-US'], required: true, dimension: true },
  { path: 'customer.accessibility.largeText', type: 'bool', label: 'Large-text preference' },
  { path: 'customer.accessibility.highContrast', type: 'bool', label: 'High-contrast preference' },
  { path: 'customer.middleName', type: 'string', label: 'Middle name (optional)' },
];

export const CARD_FIELDS: FieldDef[] = [
  ...common,
  { path: 'card.maskedAccount', type: 'string', label: 'Masked account', required: true, example: '•••• 1842' },
  { path: 'card.statementStart', type: 'date', label: 'Statement period start', required: true },
  { path: 'card.statementEnd', type: 'date', label: 'Statement period end', required: true },
  { path: 'card.issuedAt', type: 'date', label: 'Statement issue date', required: true },
  { path: 'card.dueDate', type: 'date', label: 'Payment due date', required: true },
  { path: 'card.currency', type: 'enum', label: 'Currency', enumValues: ['USD'] },
  { path: 'card.creditLimitCents', type: 'cents', label: 'Credit limit' },
  { path: 'card.previousBalanceCents', type: 'cents', label: 'Previous balance', required: true },
  { path: 'card.purchasesCents', type: 'cents', label: 'Purchases', required: true },
  { path: 'card.paymentsCreditsCents', type: 'cents', label: 'Payments and credits', required: true },
  { path: 'card.interestFeesCents', type: 'cents', label: 'Fees and interest', required: true },
  { path: 'card.newBalanceCents', type: 'cents', label: 'New balance', required: true },
  { path: 'card.minimumDueCents', type: 'cents', label: 'Minimum payment due', required: true },
  { path: 'card.tier', type: 'enum', label: 'Account tier', enumValues: ['standard', 'premium'], dimension: true },
  { path: 'card.paymentStatus', type: 'enum', label: 'Payment status', enumValues: ['current', 'overdue'], dimension: true },
  { path: 'card.missedPayments', type: 'int', label: 'Missed payments' },
  { path: 'card.assistanceRequested', type: 'bool', label: 'Assistance requested' },
  { path: 'card.arrangementStatus', type: 'enum', label: 'Arrangement status', enumValues: ['none', 'pending', 'approved'] },
  { path: 'card.channelPreference', type: 'enum', label: 'Channel preference', enumValues: ['email', 'digital', 'print'], dimension: true },
  { path: 'card.rewardsBalance', type: 'points', label: 'Rewards balance (points)' },
  {
    path: 'card.transactions', type: 'array', label: 'Transactions',
    itemFields: [
      { key: 'id', type: 'string', label: 'Transaction ID' },
      { key: 'date', type: 'date', label: 'Date' },
      { key: 'merchant', type: 'string', label: 'Description' },
      { key: 'amountCents', type: 'cents', label: 'Amount' },
    ],
  },
  { path: 'card.transactions.count', type: 'int', label: 'Transaction count', derived: true },
  { path: 'card.availableCreditCents', type: 'cents', label: 'Available credit', derived: true },
  { path: 'card.transactionsTotalCents', type: 'cents', label: 'Sum of listed transactions', derived: true },
];

export const EOB_FIELDS: FieldDef[] = [
  ...common,
  { path: 'member.planName', type: 'string', label: 'Plan name', required: true },
  { path: 'member.memberId', type: 'string', label: 'Member ID', required: true },
  {
    path: 'claims', type: 'array', label: 'Claims',
    itemFields: [
      { key: 'claimId', type: 'string', label: 'Claim' },
      { key: 'service', type: 'string', label: 'Service' },
      { key: 'serviceDate', type: 'date', label: 'Service date' },
      { key: 'billedCents', type: 'cents', label: 'Billed' },
      { key: 'allowedCents', type: 'cents', label: 'Allowed' },
      { key: 'planPaidCents', type: 'cents', label: 'Plan paid' },
      { key: 'patientResponsibilityCents', type: 'cents', label: 'Member responsibility' },
      { key: 'status', type: 'enum', label: 'Status' },
    ],
  },
  { path: 'claims.count', type: 'int', label: 'Claim count', derived: true },
  { path: 'claim.claimId', type: 'string', label: 'Claim ID', required: true },
  { path: 'claim.serviceDate', type: 'date', label: 'Service date' },
  { path: 'claim.service', type: 'string', label: 'Service description' },
  { path: 'claim.billedCents', type: 'cents', label: 'Billed amount' },
  { path: 'claim.allowedCents', type: 'cents', label: 'Allowed amount' },
  { path: 'claim.contractualAdjustmentCents', type: 'cents', label: 'Contractual adjustment' },
  { path: 'claim.planPaidCents', type: 'cents', label: 'Plan paid' },
  { path: 'claim.patientResponsibilityCents', type: 'cents', label: 'Member responsibility' },
  { path: 'claim.liabilityConfirmed', type: 'bool', label: 'Member liability confirmed' },
  {
    path: 'claim.status', type: 'enum', label: 'Claim status', dimension: true,
    enumValues: ['received', 'processed-covered', 'deductible-applied', 'out-of-network-review', 'denied-pending-review', 'appeal-filed', 'appeal-resolved'],
  },
  { path: 'claim.network', type: 'enum', label: 'Network status', enumValues: ['in-network', 'out-of-network'], dimension: true },
  { path: 'claim.deductibleAppliedCents', type: 'cents', label: 'Deductible applied' },
  { path: 'claim.amountUnderReviewCents', type: 'cents', label: 'Amount under review' },
];

export function fieldsFor(documentType: DocumentType): FieldDef[] {
  return documentType === 'eob' ? EOB_FIELDS : CARD_FIELDS;
}

export function fieldIndex(documentType: DocumentType): Map<string, FieldDef> {
  return new Map(fieldsFor(documentType).map((f) => [f.path, f]));
}

export const CUSTOM_FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;

/** Data contract of one project: the standard fields of its document type plus its custom fields. */
export function projectFields(project: Pick<Project, 'documentType' | 'customFields'>): FieldDef[] {
  return [...fieldsFor(project.documentType), ...customFieldDefs(project.customFields)];
}

export function projectFieldIndex(project: Pick<Project, 'documentType' | 'customFields'>): Map<string, FieldDef> {
  return new Map(projectFields(project).map((f) => [f.path, f]));
}

export function customFieldDefs(custom: CustomField[] | undefined): FieldDef[] {
  return (custom ?? []).map((c) => ({ path: `custom.${c.key}`, type: c.type, label: c.label, enumValues: c.type === 'enum' ? c.enumValues ?? [] : undefined, required: !!c.required, example: c.example, dimension: !!c.dimension }));
}

/** Validation for a set of custom fields (keys, labels, types, enum values, no clash with standard labels). */
export function validateCustomFields(documentType: DocumentType, custom: CustomField[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const types = new Set(['string', 'int', 'cents', 'bool', 'date', 'enum']);
  for (const c of custom) {
    if (!CUSTOM_FIELD_KEY.test(c.key ?? '')) errors.push(`Key “${c.key}” must start with a letter and use only letters and digits (max 40).`);
    if (seen.has(c.key)) errors.push(`Key “${c.key}” is used twice.`);
    seen.add(c.key);
    if (!c.label?.trim() || c.label.length > 60) errors.push(`Field “${c.key}” needs a label (max 60 characters).`);
    if (!types.has(c.type)) errors.push(`Field “${c.key}” has an unsupported type ${c.type}.`);
    if (c.type === 'enum' && (!Array.isArray(c.enumValues) || !c.enumValues.length || c.enumValues.some((v) => typeof v !== 'string' || !v.trim()))) errors.push(`Field “${c.key}” needs at least one allowed value.`);
    if (c.type === 'enum' && new Set(c.enumValues).size !== (c.enumValues ?? []).length) errors.push(`Field “${c.key}” lists an allowed value twice.`);
  }
  const std = new Set(fieldsFor(documentType).map((f) => f.label.toLowerCase()));
  for (const c of custom) if (std.has(c.label?.trim().toLowerCase())) errors.push(`Label “${c.label}” is already a standard field.`);
  return errors;
}

export function defaultFormatterFor(type: FieldType): Formatter {
  switch (type) {
    case 'cents': return 'usd-cents';
    case 'date': return 'date';
    case 'int': return 'int';
    case 'points': return 'points';
    default: return 'text';
  }
}
