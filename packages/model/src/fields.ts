import type { CalcType, CalculatedField, CustomField, DocumentDateSource, DocumentType, Formatter, Project } from './types';

/**
 * Typed data contracts. Tokens, bindings and rule predicates may only reference
 * allowlisted paths. No path is ever evaluated against arbitrary objects.
 */
/** `number` is only ever the type of a calculated field (a number that may have decimals). */
export type FieldType = 'string' | 'cents' | 'date' | 'int' | 'bool' | 'enum' | 'array' | 'points' | 'number';

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
  /** One of the project's calculated fields (`calc.<key>`): worked out by the engine, never an input. Also `derived`. */
  calculated?: boolean;
  /** The document's date (`document.date`): from a date field or given for the run, never an input. Also `derived`. */
  documentDate?: boolean;
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

/**
 * "Your own data": only what every customer has (name, preferred language, accessibility preferences). Everything else
 * a document of this kind shows or tests is one of the project's own data fields (`custom.<key>`).
 */
export const CUSTOM_FIELDS: FieldDef[] = common.map((f) => (f.path === 'documentType' ? { ...f, enumValues: ['custom'] } : f));

export function fieldsFor(documentType: DocumentType): FieldDef[] {
  return documentType === 'eob' ? EOB_FIELDS : documentType === 'custom' ? CUSTOM_FIELDS : CARD_FIELDS;
}

export function fieldIndex(documentType: DocumentType): Map<string, FieldDef> {
  return new Map(fieldsFor(documentType).map((f) => [f.path, f]));
}

export const CUSTOM_FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
/** A list field has 1 to 8 columns. */
export const CUSTOM_LIST_MAX_COLUMNS = 8;
const LIST_COLUMN_TYPES = new Set<string>(['string', 'int', 'cents', 'date']);

/** What `projectFields` reads from a project. */
export type FieldScopeOf = Pick<Project, 'documentType' | 'customFields'> & Partial<Pick<Project, 'calculatedFields' | 'documentDate'>>;

/**
 * Data contract of one project: the standard fields of its document type plus its custom fields, then (only when the
 * project has them) the document's date and its calculated fields, both marked derived (never an input).
 */
export function projectFields(project: FieldScopeOf): FieldDef[] {
  return [...fieldsFor(project.documentType), ...customFieldDefs(project.customFields), ...documentDateDefs(project.documentDate), ...calculatedFieldDefs(project.calculatedFields)];
}

export function projectFieldIndex(project: FieldScopeOf): Map<string, FieldDef> {
  return new Map(projectFields(project).map((f) => [f.path, f]));
}

/** The path of the document's date as a value in conditions and wording. */
export const DOCUMENT_DATE_PATH = 'document.date';
/** Calculated fields are read as `calc.<key>`. */
export const CALC_PREFIX = 'calc.';

/** The field type a calculated value has in the data contract. */
export const CALC_FIELD_TYPE: Record<CalcType, FieldType> = { number: 'number', money: 'cents', date: 'date', text: 'string', bool: 'bool' };

/** `document.date`, present only when the project says where its date comes from. */
export function documentDateDefs(source: DocumentDateSource | undefined): FieldDef[] {
  return source ? [{ path: DOCUMENT_DATE_PATH, type: 'date', label: 'The document’s date', derived: true, documentDate: true }] : [];
}

/** The field definitions of a project's calculated fields (`calc.<key>`), marked calculated and derived. */
export function calculatedFieldDefs(calcs: CalculatedField[] | undefined): FieldDef[] {
  return (calcs ?? []).map((c) => ({ path: `${CALC_PREFIX}${c.key}`, type: CALC_FIELD_TYPE[c.type] ?? 'string', label: c.label, derived: true, calculated: true }));
}

/**
 * The typed field definitions of a project's own data fields. A list field becomes a collection (`array`) with its
 * columns, followed by a derived `custom.<key>.count` (the number of rows), evaluated like `card.transactions.count`.
 */
export function customFieldDefs(custom: CustomField[] | undefined): FieldDef[] {
  return (custom ?? []).flatMap((c): FieldDef[] => {
    if (c.type === 'list') {
      return [
        { path: `custom.${c.key}`, type: 'array', label: c.label, required: !!c.required, itemFields: (Array.isArray(c.itemFields) ? c.itemFields : []).map((it) => ({ key: it.key, type: it.type, label: it.label })) },
        { path: `custom.${c.key}.count`, type: 'int', label: `${c.label} count`, derived: true },
      ];
    }
    return [{ path: `custom.${c.key}`, type: c.type, label: c.label, enumValues: c.type === 'enum' ? c.enumValues ?? [] : undefined, required: !!c.required, example: c.example, dimension: !!c.dimension }];
  });
}

/** The project's list fields (collections a Repeating Table or a chart can be bound to), as field definitions. */
export function customListFields(custom: CustomField[] | undefined): FieldDef[] {
  return customFieldDefs(custom).filter((f) => f.type === 'array');
}

/** Validation for a set of custom fields (keys, labels, types, enum values, list columns, no clash with standard labels). */
export function validateCustomFields(documentType: DocumentType, custom: CustomField[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const types = new Set(['string', 'int', 'cents', 'bool', 'date', 'enum', 'list']);
  for (const c of custom) {
    if (!CUSTOM_FIELD_KEY.test(c.key ?? '')) errors.push(`Key “${c.key}” must start with a letter and use only letters and digits (max 40).`);
    if (seen.has(c.key)) errors.push(`Key “${c.key}” is used twice.`);
    seen.add(c.key);
    if (!c.label?.trim() || c.label.length > 60) errors.push(`Field “${c.key}” needs a label (max 60 characters).`);
    if (!types.has(c.type)) errors.push(`Field “${c.key}” has an unsupported type ${c.type}.`);
    if (c.type === 'enum' && (!Array.isArray(c.enumValues) || !c.enumValues.length || c.enumValues.some((v) => typeof v !== 'string' || !v.trim()))) errors.push(`Field “${c.key}” needs at least one allowed value.`);
    if (c.type === 'enum' && new Set(c.enumValues).size !== (c.enumValues ?? []).length) errors.push(`Field “${c.key}” lists an allowed value twice.`);
    if (c.type === 'list') {
      const name = c.label?.trim() || c.key;
      const cols = Array.isArray(c.itemFields) ? c.itemFields : [];
      if (!cols.length) errors.push(`List “${name}” needs at least one column.`);
      if (cols.length > CUSTOM_LIST_MAX_COLUMNS) errors.push(`List “${name}” can have at most ${CUSTOM_LIST_MAX_COLUMNS} columns.`);
      const colKeys = new Set<string>();
      for (const col of cols) {
        if (!CUSTOM_FIELD_KEY.test(col?.key ?? '')) errors.push(`List “${name}”: column key “${col?.key}” must start with a letter and use only letters and digits (max 40).`);
        else if (colKeys.has(col.key)) errors.push(`List “${name}” uses the column key “${col.key}” twice.`);
        colKeys.add(col?.key);
        if (!col?.label?.trim() || col.label.length > 60) errors.push(`List “${name}”: column “${col?.key}” needs a label (max 60 characters).`);
        if (!LIST_COLUMN_TYPES.has(col?.type)) errors.push(`List “${name}”: column “${col?.label?.trim() || col?.key}” must be text, a whole number, an amount or a date.`);
      }
      if (c.dimension) errors.push(`List “${name}” cannot be a comparison dimension. Use its number of rows in a rule instead.`);
    } else if (c.itemFields !== undefined) errors.push(`Field “${c.key}” has columns but is not a list.`);
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
    case 'number': return 'text';
    default: return 'text';
  }
}
