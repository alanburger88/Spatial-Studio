import type { BlockerKind } from '@iss/scenarios';

/** The five kinds of fix, in the order they are listed, in the words the studio uses everywhere. */
export const KINDS: readonly BlockerKind[] = ['wording', 'rules', 'layout', 'data-fields', 'customer-data'];

export const KIND_LABEL: Record<BlockerKind, string> = {
  wording: 'Wording and translations',
  rules: 'Rules',
  layout: 'Layout and pages',
  'data-fields': 'Data fields',
  'customer-data': 'The customer’s data is wrong',
};

/** Short form for counts. */
export const KIND_SHORT: Record<BlockerKind, string> = { wording: 'Wording', rules: 'Rules', layout: 'Layout', 'data-fields': 'Data fields', 'customer-data': 'Customer data' };

/** Where each kind is fixed, and what that looks like. */
export const KIND_NEXT: Record<BlockerKind, string> = {
  wording: 'Fixed in Content & Translations (or the wording in Design). A person writes and approves the text.',
  rules: 'Fixed in Rules & Data. The fixes below change a rule or a fallback message and show their effect first.',
  layout: 'Fixed in Design. Whether the pages now fit is confirmed by the full check.',
  'data-fields': 'Fixed in Design: choose a field the document really has.',
  'customer-data': 'The document is fine. The customer’s data has to be corrected in Data Explorer.',
};

export const isKind = (v: string | null): v is BlockerKind => !!v && (KINDS as readonly string[]).includes(v);

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
