import type { CalcType, CalculatedField, CustomField, CustomGroupMember, CustomListColumn, DocumentDateSource, DocumentType, Formatter, Project } from './types';

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
  /** Richer data shapes (wave 5): the name of the group this field belongs to. */
  group?: string;
  /** Richer data shapes (wave 5): the list (`custom.<key>`) whose items have this field; it is read inside a repeating section of that list. */
  item?: string;
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
  const index = new Map(projectFields(project).map((f) => [f.path, f]));
  // Richer data shapes (wave 5): the index remembers the fields of the items of the lists, for conditions about items.
  const items = itemFieldDefs(project.customFields, project.calculatedFields);
  if (items.length) ITEM_DEFS.set(index, items);
  return index;
}

/** The item fields remembered by a field index (see `projectFieldIndex`), for conditions about the items of a list. */
const ITEM_DEFS = new WeakMap<Map<string, FieldDef>, FieldDef[]>();
export function itemDefsOf(index: Map<string, FieldDef>): FieldDef[] {
  return ITEM_DEFS.get(index) ?? [];
}
/** A field index to test one item of `list` in: the index's fields and the item's own. */
export function itemScopeIndex(index: Map<string, FieldDef>, list: string): Map<string, FieldDef> {
  const all = itemDefsOf(index);
  const scope = new Map(index);
  for (const f of all) if (f.item === list) scope.set(f.path, f);
  if (all.length) ITEM_DEFS.set(scope, all);
  return scope;
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
  // A calculation that belongs to a list is worked out for each item: it is one of the item's fields (`itemFieldDefs`).
  return (calcs ?? []).filter((c) => !c.list).map((c) => ({ path: `${CALC_PREFIX}${c.key}`, type: CALC_FIELD_TYPE[c.type] ?? 'string', label: c.label, derived: true, calculated: true }));
}

/**
 * The typed field definitions of a project's own data fields. A list field becomes a collection (`array`) with its
 * columns, followed by a derived `custom.<key>.count` (the number of rows), evaluated like `card.transactions.count`.
 */
export function customFieldDefs(custom: CustomField[] | undefined): FieldDef[] {
  return (custom ?? []).flatMap((c): FieldDef[] => {
    if (c.type === 'list') {
      return [
        { path: `custom.${c.key}`, type: 'array', label: c.label, required: !!c.required, itemFields: rowColumns(c.itemFields) },
        { path: `custom.${c.key}.count`, type: 'int', label: `${c.label} count`, derived: true },
      ];
    }
    if (c.type === 'group') return groupMemberDefs(`custom.${c.key}`, c.label, c.fields);
    return [{ path: `custom.${c.key}`, type: c.type, label: c.label, enumValues: c.type === 'enum' ? c.enumValues ?? [] : undefined, required: !!c.required, example: c.example, dimension: !!c.dimension }];
  });
}

/* ------------------------------------------------------------- Richer data shapes (wave 5, section 2) */

/** Most fields in one group, and most columns of a list inside a list. */
export const CUSTOM_GROUP_MAX_FIELDS = 12;
const GROUP_MEMBER_TYPES = new Set<string>(['string', 'int', 'cents', 'bool', 'date', 'enum']);
/** The name a field of a group is shown with: "Mailing address: City". */
export const groupMemberLabel = (group: string, member: string): string => `${group}: ${member}`;

function groupMemberDefs(prefix: string, groupLabel: string, members: CustomGroupMember[] | undefined, item?: string): FieldDef[] {
  return (Array.isArray(members) ? members : []).map((m) => ({
    path: `${prefix}.${m.key}`, type: m.type, label: groupMemberLabel(groupLabel, m.label), group: groupLabel,
    ...(m.type === 'enum' ? { enumValues: m.enumValues ?? [] } : {}), ...(item ? { item } : { required: !!m.required, example: m.example }),
  }));
}

/**
 * The columns of a list's rows, as `itemFields`: its simple columns, then the fields of a group in a row under
 * `<group>.<field>` keys. A list inside the row is not a column (it has its own definition, `itemFieldDefs`). A list
 * of simple columns gives exactly what it always gave.
 */
function rowColumns(cols: CustomListColumn[] | undefined): NonNullable<FieldDef['itemFields']> {
  return (Array.isArray(cols) ? cols : []).flatMap((it): NonNullable<FieldDef['itemFields']> => {
    if (it.type === 'list') return [];
    if (it.type === 'group') return (it.fields ?? []).map((m) => ({ key: `${it.key}.${m.key}`, type: m.type, label: groupMemberLabel(it.label, m.label) }));
    return [{ key: it.key, type: it.type, label: it.label }];
  });
}

/** `custom.accounts` → `custom.accounts[]`: the prefix of the paths of one item of a list. */
export const itemPrefix = (list: string): string => `${list}[]`;
/** Whether a path is read inside an item of a list (it has `[]`). */
export const isItemPath = (path: string): boolean => path.includes('[]');
/** The outermost list a path belongs to (`custom.accounts[].transactions[].amountCents` → `custom.accounts`), or null. */
export function listOfItemPath(path: string): string | null {
  const i = path.indexOf('[]');
  return i < 0 ? null : path.slice(0, i);
}

/**
 * The fields of one item of each of the document's lists, read inside a repeating section of that list (or in a
 * calculation that belongs to it): `custom.accounts[].number`, the fields of a group in the item
 * (`custom.accounts[].holder.name`), a list inside the item (`custom.accounts[].transactions`, with its number of rows
 * `….transactions.count`) and the calculations that belong to the list (`calc.<key>`). Each carries `item`.
 */
export function itemFieldDefs(custom: CustomField[] | undefined, calcs?: CalculatedField[]): FieldDef[] {
  const out: FieldDef[] = [];
  for (const c of custom ?? []) {
    if (c.type !== 'list') continue;
    const list = `custom.${c.key}`;
    const pre = itemPrefix(list);
    for (const it of Array.isArray(c.itemFields) ? c.itemFields : []) {
      if (it.type === 'group') out.push(...groupMemberDefs(`${pre}.${it.key}`, it.label, it.fields, list));
      else if (it.type === 'list') {
        const inner = `${pre}.${it.key}`;
        out.push({ path: inner, type: 'array', label: it.label, item: list, itemFields: rowColumns(it.itemFields) });
        out.push({ path: `${inner}.count`, type: 'int', label: `${it.label} count`, derived: true, item: list });
        // One row of the inner list (`custom.accounts[].transactions[].amountCents`): for conditions about its rows and the data contract.
        for (const col of rowColumns(it.itemFields)) out.push({ path: `${itemPrefix(inner)}.${col.key}`, type: col.type, label: col.label, item: inner });
      } else out.push({ path: `${pre}.${it.key}`, type: it.type, label: it.label, item: list });
    }
    for (const k of calcs ?? []) if (k.list === list) out.push({ path: `${CALC_PREFIX}${k.key}`, type: CALC_FIELD_TYPE[k.type] ?? 'string', label: k.label, derived: true, calculated: true, item: list });
  }
  return out;
}

/** Whether a project uses any of the richer data shapes (a group, a list inside a list, a calculation per item, a repeating section). */
export function usesRicherShapes(project: Partial<Pick<Project, 'customFields' | 'calculatedFields' | 'nodes'>>): boolean {
  return (project.customFields ?? []).some((c) => c.type === 'group' || (c.itemFields ?? []).some((it) => it.type === 'group' || it.type === 'list'))
    || (project.calculatedFields ?? []).some((c) => !!c.list) || (project.nodes ?? []).some((n) => !!n.repeat);
}

/**
 * The fields that can be read at one place of the document: every field of the project, and when `list` is given (a
 * component inside a repeating section of it, or a calculation that belongs to it) the fields of one of its items.
 */
export function scopeFieldIndex(project: FieldScopeOf, list?: string | null): Map<string, FieldDef> {
  const base = projectFieldIndex(project);
  return list ? itemScopeIndex(base, list) : base;
}

/** Every field path of the project, the fields of list items included (for the data contract, mapping and the dictionary). */
export function allFieldIndex(project: FieldScopeOf): Map<string, FieldDef> {
  const base = projectFieldIndex(project);
  for (const f of itemFieldDefs(project.customFields, project.calculatedFields)) if (!base.has(f.path)) base.set(f.path, f);
  return base;
}

/** The project's list fields (collections a Repeating Table or a chart can be bound to), as field definitions. */
export function customListFields(custom: CustomField[] | undefined): FieldDef[] {
  return customFieldDefs(custom).filter((f) => f.type === 'array');
}

/** Validation for a set of custom fields (keys, labels, types, enum values, list columns, no clash with standard labels). */
export function validateCustomFields(documentType: DocumentType, custom: CustomField[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const types = new Set(['string', 'int', 'cents', 'bool', 'date', 'enum', 'list', 'group']);
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
        // Richer data shapes (wave 5): a group of fields in each row, or a list inside each row (one level).
        if (col?.type === 'group') errors.push(...groupProblems(`List “${name}”: the group “${col.label?.trim() || col.key}”`, col.fields, (col as { itemFields?: unknown }).itemFields));
        else if (col?.type === 'list') errors.push(...innerListProblems(name, col));
        else if (!LIST_COLUMN_TYPES.has(col?.type)) errors.push(`List “${name}”: column “${col?.label?.trim() || col?.key}” must be text, a whole number, an amount or a date.`);
        else if (col.fields !== undefined || col.itemFields !== undefined) errors.push(`List “${name}”: column “${col.label?.trim() || col.key}” has fields of its own but is not a group or a list.`);
      }
      if (c.dimension) errors.push(`List “${name}” cannot be a comparison dimension. Use its number of rows in a rule instead.`);
    } else if (c.type === 'group') {
      const name = c.label?.trim() || c.key;
      errors.push(...groupProblems(`The group “${name}”`, c.fields, c.itemFields));
      if (c.dimension) errors.push(`The group “${name}” cannot be a comparison dimension. Choose one of its fields instead.`);
    } else {
      if (c.itemFields !== undefined) errors.push(`Field “${c.key}” has columns but is not a list.`);
      if (c.fields !== undefined) errors.push(`Field “${c.key}” has fields of its own but is not a group.`);
    }
  }
  const std = new Set(fieldsFor(documentType).map((f) => f.label.toLowerCase()));
  for (const c of custom) if (std.has(c.label?.trim().toLowerCase())) errors.push(`Label “${c.label}” is already a standard field.`);
  return errors;
}

/** Problems of a group's fields: 1 to 12 simple fields, no group in a group and no list in a group. */
function groupProblems(name: string, members: CustomGroupMember[] | undefined, itemFields: unknown): string[] {
  const errors: string[] = [];
  const list = Array.isArray(members) ? members : [];
  if (!list.length) errors.push(`${name} needs at least one field.`);
  if (list.length > CUSTOM_GROUP_MAX_FIELDS) errors.push(`${name} can have at most ${CUSTOM_GROUP_MAX_FIELDS} fields.`);
  if (itemFields !== undefined) errors.push(`${name} cannot hold a list. A list can sit at the top level or inside the items of a list, never inside a group.`);
  const keys = new Set<string>();
  for (const m of list) {
    const t = (m as { type?: string })?.type;
    if (!CUSTOM_FIELD_KEY.test(m?.key ?? '')) errors.push(`${name}: the key “${m?.key}” must start with a letter and use only letters and digits (max 40).`);
    else if (keys.has(m.key)) errors.push(`${name} uses the key “${m.key}” twice.`);
    keys.add(m?.key);
    if (!m?.label?.trim() || m.label.length > 60) errors.push(`${name}: the field “${m?.key}” needs a label (max 60 characters).`);
    if (t === 'group') errors.push(`${name} cannot hold another group. Put the fields straight into “${name.replace(/^.*“|”.*$/g, '')}”, or make a second group beside it.`);
    else if (t === 'list') errors.push(`${name} cannot hold a list. A list can sit at the top level or inside the items of a list, never inside a group.`);
    else if (!GROUP_MEMBER_TYPES.has(t ?? '')) errors.push(`${name}: the field “${m?.label?.trim() || m?.key}” must be text, a whole number, an amount, yes or no, a date or a choice.`);
    if (t === 'enum' && (!Array.isArray(m.enumValues) || !m.enumValues.length || m.enumValues.some((v) => typeof v !== 'string' || !v.trim()))) errors.push(`${name}: the field “${m.label?.trim() || m.key}” needs at least one allowed value.`);
  }
  return errors;
}

/** Problems of a list inside the items of a list: one level only, 1 to 8 simple columns. */
function innerListProblems(outer: string, col: CustomListColumn): string[] {
  const errors: string[] = [];
  const name = `List “${outer}”: the list “${col.label?.trim() || col.key}”`;
  const cols = Array.isArray(col.itemFields) ? col.itemFields : [];
  if (!cols.length) errors.push(`${name} needs at least one column.`);
  if (cols.length > CUSTOM_LIST_MAX_COLUMNS) errors.push(`${name} can have at most ${CUSTOM_LIST_MAX_COLUMNS} columns.`);
  if (col.fields !== undefined) errors.push(`${name} has group fields but is a list.`);
  const keys = new Set<string>();
  for (const it of cols) {
    if (!CUSTOM_FIELD_KEY.test(it?.key ?? '')) errors.push(`${name}: the column key “${it?.key}” must start with a letter and use only letters and digits (max 40).`);
    else if (keys.has(it.key)) errors.push(`${name} uses the column key “${it.key}” twice.`);
    keys.add(it?.key);
    if (!it?.label?.trim() || it.label.length > 60) errors.push(`${name}: the column “${it?.key}” needs a label (max 60 characters).`);
    if (it?.type === 'list') errors.push(`${name} cannot hold another list. Lists go at most two levels deep (for example accounts, each with its transactions); a third level is not supported.`);
    else if (it?.type === 'group') errors.push(`${name} cannot hold a group. Groups can sit at the top level or in the items of the outer list.`);
    else if (!LIST_COLUMN_TYPES.has(it?.type)) errors.push(`${name}: the column “${it?.label?.trim() || it?.key}” must be text, a whole number, an amount or a date.`);
  }
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
