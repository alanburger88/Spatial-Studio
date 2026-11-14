import { richFromMarkup } from '../rich';
import type { LibraryContent, LibraryContentByKind } from '../library';
import type { LibraryKind, LookupTable, WordingRule } from '../types';
import { MERIDIAN_LOGO, NORTHWIND_LOGO } from './logos';

/**
 * The house library the studio is seeded with, beside the example documents: a brand for each new issuer, a shared
 * accessible-formats panel, a required notice with its approved Spanish, a Spanish glossary, the energy rate table and
 * the house wording rules. Each item is approved at version 1; the customer-rights notice also has a version 2, so the
 * Northwind bill (which links version 1) shows "Update available". The example documents link to these items with
 * exactly this content, so "where used" is populated from the first start.
 *
 * Pure data. The server seeds an item only when the library has no item of that id (`apps/api/src/library.ts`).
 */

export interface HouseItem {
  id: string;
  kind: LibraryKind;
  title: string;
  description: string;
  /** Approved versions, in order (index 0 = version 1). */
  versions: Array<{ note: string; content: LibraryContent }>;
}

/** The delivery rate by monthly electricity use (a lookup table shared through the library). */
export const RATE_BANDS: LookupTable = {
  id: 'rateBands', title: 'Electricity delivery rate by monthly use',
  description: 'Cents per kWh for the whole month’s use, chosen by the band the total falls in (from included, until excluded).',
  keys: [{ key: 'usage', label: 'Monthly use (kWh)', match: 'number-range', unit: 'number' }],
  columns: [{ key: 'rate', label: 'Delivery rate (¢ per kWh)', type: 'number' }, { key: 'band', label: 'Band', type: 'text' }],
  rows: [
    { keys: { usage: { from: 0, until: 500 } }, values: { rate: 6.12, band: '0–499 kWh' } },
    { keys: { usage: { from: 500, until: 1000 } }, values: { rate: 6.88, band: '500–999 kWh' } },
    { keys: { usage: { from: 1000 } }, values: { rate: 7.41, band: '1,000+ kWh' } },
  ],
};

export const HOUSE_WORDING_RULES: WordingRule[] = [
  { id: 'no-click-here', kind: 'banned', severity: 'must', phrase: 'click here', replacement: 'select', appliesTo: 'anywhere', note: 'Links say where they go; printed copies cannot be clicked.' },
  { id: 'no-guarantees', kind: 'banned', severity: 'must', phrase: 'guaranteed', appliesTo: 'anywhere', note: 'We never promise an outcome we do not control.' },
  { id: 'say-fictional', kind: 'required', severity: 'must', phrase: '(fictional)', appliesTo: 'anywhere', language: 'en-US', note: 'Every demonstration document names its issuer as fictional.' },
  { id: 'plain-use', kind: 'preferred', severity: 'should', phrase: 'utilize', replacement: 'use', appliesTo: 'anywhere', note: 'Plain words.' },
  { id: 'plain-to', kind: 'preferred', severity: 'should', phrase: 'in order to', replacement: 'to', appliesTo: 'anywhere', note: 'Plain words.' },
  { id: 'short-sentences', kind: 'sentence-length', severity: 'should', limit: 40, appliesTo: 'anywhere', note: 'Long sentences are hard to follow on paper and on a phone.' },
];

const rights = (extra: boolean): LibraryContentByKind['wording'] => ({
  part: {
    id: 'customer-rights', title: 'Your rights as a customer', type: 'disclosure',
    approvedLocales: {
      'en-US': `You can ask us to explain any charge on this bill. If you disagree with a charge, contact us before the due date: while we review a disputed amount, we will not charge a late fee on it.${extra ? ' You can also ask for a copy of your meter readings for the past two years at no cost.' : ''} If you are not satisfied with our answer, you can contact the Calder Bay Public Utility Commission (fictional) at 1-800-555-0177.`,
      'es-US': `Puede pedirnos que le expliquemos cualquier cargo de esta factura. Si no está de acuerdo con un cargo, comuníquese con nosotros antes de la fecha de vencimiento: mientras revisamos un monto en disputa, no le cobraremos un cargo por pago tardío sobre ese monto.${extra ? ' También puede pedir sin costo una copia de las lecturas de su medidor de los últimos dos años.' : ''} Si no está satisfecho con nuestra respuesta, puede comunicarse con la Comisión de Servicios Públicos de Calder Bay (ficticia) al 1-800-555-0177.`,
    },
  },
  titleTranslations: { 'es-US': 'Sus derechos como cliente' },
});

const formatsPanel: LibraryContentByKind['block'] = {
  nodes: [
    { id: 'formats-panel', type: 'container', name: 'Other formats and languages', children: ['formats-text'], layout: { paged: { mode: 'flow', widthPct: 100, align: 'left', spaceBeforePt: 12, keepTogether: true }, html: { area: 'footer', span: 12 } } },
    { id: 'formats-text', type: 'rich-text', name: 'Other formats and languages text', content: richFromMarkup('**Other formats and languages.** This document is available in large print, braille and audio, and in Spanish. To ask for another format or language, call the number on this document; calls are free.'), layout: { paged: { mode: 'flow', widthPct: 100, align: 'left', spaceBeforePt: 0 }, html: { area: 'footer', span: 12 } } },
  ],
  contentParts: [],
  strings: { '@formats-text/content': { approved: { 'es-US': '**Otros formatos e idiomas.** Este documento está disponible en letra grande, braille y audio, y en inglés. Para pedir otro formato u otro idioma, llame al número que figura en este documento; la llamada es gratuita.' } } },
};

const glossary: LibraryContentByKind['glossary'] = {
  entries: {
    'es-US': [
      { source: 'bill', target: 'factura' },
      { source: 'due date', target: 'fecha de vencimiento' },
      { source: 'meter reading', target: 'lectura del medidor' },
      { source: 'payment plan', target: 'plan de pagos' },
      { source: 'automatic payment', target: 'pago automático' },
      { source: 'late fee', target: 'cargo por pago tardío' },
      { source: 'statement', target: 'estado de cuenta' },
      { source: 'portfolio', target: 'cartera' },
      { source: 'holding', target: 'inversión', note: 'One fund or security the customer holds.' },
      { source: 'management fee', target: 'comisión de administración' },
      { source: 'adviser', target: 'asesor', note: 'Asesora when the adviser is a woman.' },
    ],
  },
};

const brand = (primary: string, accent: string, fontFamily: 'Arial' | 'Georgia', logoDataUri: string, logoAlt: string): LibraryContentByKind['brand'] => ({ primary, accent, text: '#0F172A', fontFamily, logoDataUri, logoAlt });

const ITEMS: HouseItem[] = [
  { id: 'brand-northwind', kind: 'brand', title: 'Northwind Energy brand', description: 'Colours, font and logo of Northwind Energy (fictional utility).', versions: [{ note: 'First approved brand.', content: brand('#0B4F7C', '#1C8C82', 'Arial', NORTHWIND_LOGO, 'Northwind Energy (fictional utility) logo') }] },
  { id: 'brand-meridian', kind: 'brand', title: 'Meridian Wealth brand', description: 'Colours, font and logo of Meridian Wealth (fictional wealth manager).', versions: [{ note: 'First approved brand.', content: brand('#1F2A44', '#B08D3C', 'Georgia', MERIDIAN_LOGO, 'Meridian Wealth (fictional wealth manager) logo') }] },
  { id: 'accessible-formats-panel', kind: 'block', title: 'Other formats and languages panel', description: 'The panel every customer document ends with: large print, braille, audio and Spanish on request.', versions: [{ note: 'First approved panel.', content: formatsPanel }] },
  { id: 'customer-rights-notice', kind: 'wording', title: 'Customer rights notice (utilities)', description: 'The required notice on every utility bill, with its approved Spanish.', versions: [{ note: 'First approved notice.', content: rights(false) }, { note: 'Adds the right to a free copy of two years of meter readings.', content: rights(true) }] },
  { id: 'glossary-es', kind: 'glossary', title: 'Spanish glossary', description: 'Preferred Spanish for the terms our bills and statements use.', versions: [{ note: 'First approved glossary.', content: glossary }] },
  { id: 'energy-rate-bands', kind: 'lookup-table', title: 'Electricity delivery rate bands', description: 'The delivery rate for each band of monthly electricity use, in cents per kWh.', versions: [{ note: 'Rates approved for 2026.', content: RATE_BANDS }] },
  { id: 'house-wording-rules', kind: 'wording-rules', title: 'House wording rules', description: 'Three “must” rules and three “should” rules every customer document follows.', versions: [{ note: 'First approved rules.', content: { rules: HOUSE_WORDING_RULES } }] },
];

export type HouseItemId = 'brand-northwind' | 'brand-meridian' | 'accessible-formats-panel' | 'customer-rights-notice' | 'glossary-es' | 'energy-rate-bands' | 'house-wording-rules';
/** Which version of each item the example documents link to. */
export type HouseLinkPlan = Record<HouseItemId, number>;

export const HOUSE = {
  items: Object.fromEntries(ITEMS.map((i) => [i.id, i])) as Record<HouseItemId, HouseItem>,
  list: ITEMS,
  /** Every link is at the latest version except the customer-rights notice, which stays at version 1 on purpose. */
  linkPlan: { 'brand-northwind': 1, 'brand-meridian': 1, 'accessible-formats-panel': 1, 'customer-rights-notice': 1, 'glossary-es': 1, 'energy-rate-bands': 1, 'house-wording-rules': 1 } as HouseLinkPlan,
};

/** A fresh copy of one approved version's content. */
export function houseContent(itemId: HouseItemId, version: number): LibraryContent {
  const v = HOUSE.items[itemId].versions[version - 1];
  if (!v) throw new Error(`The house library has no version ${version} of ${itemId}.`);
  return JSON.parse(JSON.stringify(v.content)) as LibraryContent;
}
