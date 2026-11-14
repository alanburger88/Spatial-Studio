import { richFromMarkup } from '../rich';
import { makeVariant } from '../variants';
import type { LookupTable, Project } from '../types';
import { SampleBuilder, flow, gte, text, type SampleCustomer } from './kit';
import { LATE_FEES, NORTHWIND_ID, NORTHWIND_NOTES, buildNorthwind, northwindCustomers } from './northwind';
import type { SampleNotes } from './notes';

/**
 * Northwind Energy — Lakeshore (wave 5, section 1): a variant of the Northwind Energy example for one region, built by
 * pure code through the command bus like the other examples. It follows Northwind's version 1 (release 1) on purpose,
 * one version behind the working version 2, so "Update available" shows a real update: the credit-balance message,
 * its rule and its test come in; the payment wording, which both changed, is kept as Lakeshore's.
 *
 * What Lakeshore changes: its own brand accent (the brand is no longer linked to the library); the greeting and the
 * standard payment message and the text message (with approved Spanish); the late fees in its lookup table; the higher-use rule (a fifth
 * rather than a quarter more than last year); the dual-fuel saving note is hidden (Lakeshore has no such discount); and
 * an outage-line notice of its own (with approved Spanish). Everything locked stays Northwind's.
 */

export const LAKESHORE_ID = 'northwind-energy-lakeshore';
export const LAKESHORE_TITLE = 'Northwind Energy — Lakeshore';
export const LAKESHORE_ACCENT = '#0F766E';
/** The version of Northwind the variant follows: release 1, stored as version 1 when the examples are seeded. */
export const LAKESHORE_FOLLOWS = 1;

/** Lakeshore's customers are copies of Northwind's (ids `NWL-6xxxx` for `NWE-6xxxx`), each remembering its original. */
const lakeshoreId = (nwe: string) => nwe.replace(/^NWE-/, 'NWL-');
export function lakeshoreCustomers(): SampleCustomer[] {
  return northwindCustomers().map((c) => ({ ...c, recordId: lakeshoreId(c.recordId), projectId: LAKESHORE_ID, sourceId: c.recordId }));
}
export const LAKESHORE_CUSTOMER_MAP: Record<string, string> = Object.fromEntries(northwindCustomers().map((c) => [c.recordId, lakeshoreId(c.recordId)]));

export const LAKESHORE_LATE_FEES: LookupTable = {
  ...LATE_FEES,
  description: 'Lakeshore region: the late fees approved for the Lakeshore service area.',
  rows: [
    { keys: { plan: 'standard' }, values: { fee: 1200 } },
    { keys: { plan: 'time-of-use' }, values: { fee: 1000 } },
    { keys: { plan: 'budget' }, values: { fee: 800 } },
  ],
};

const PAY_STANDARD = {
  en: 'Please pay **{{calc.totalDue}}** by **{{custom.dueDate}}**, {{calc.daysUntilDue}} days from the date of this bill. You can pay online, by phone or by mail, or in person at any Lakeshore Community Credit Union branch (fictional) at no charge.',
  es: 'Pague **{{calc.totalDue}}** antes del **{{custom.dueDate}}**, {{calc.daysUntilDue}} días a partir de la fecha de esta factura. Puede pagar en línea, por teléfono o por correo, o en persona sin costo en cualquier sucursal de Lakeshore Community Credit Union (ficticia).',
};
const GREETING = {
  en: 'Hello {{customer.givenName}}, here is your Northwind Energy Lakeshore bill for {{calc.billingDays}} days of service.',
  es: 'Hola, {{customer.givenName}}: esta es su factura de Northwind Energy Lakeshore por {{calc.billingDays}} días de servicio.',
};
/** A shorter text message, so a Spanish one fits in two parts with a long date. */
const SMS = {
  en: 'DEMO Northwind Lakeshore: your bill of {{calc.totalDue}} is due {{custom.dueDate}}. Pay: {{link}}',
  es: 'DEMO Northwind Lakeshore: su factura de {{calc.totalDue}} vence el {{custom.dueDate}}. Pague: {{link}}',
};
const OUTAGE = {
  en: '**Power out in the Lakeshore area?** Call our Lakeshore outage line at 1-800-555-0163, day or night. Stay away from fallen lines.',
  es: '**¿Se fue la luz en la zona de Lakeshore?** Llame a nuestra línea de cortes de Lakeshore al 1-800-555-0163, de día o de noche. Aléjese de los cables caídos.',
};

/** The variant as the studio seeds it (version 1, following Northwind's version 1). */
export function buildLakeshore(): Project {
  const base = { ...buildNorthwind('release1'), modelVersion: LAKESHORE_FOLLOWS };
  const b = new SampleBuilder(makeVariant(base, { projectId: LAKESHORE_ID, title: LAKESHORE_TITLE, purpose: 'region', label: 'Lakeshore region', customers: LAKESHORE_CUSTOMER_MAP }));

  // Its own brand: the library's Northwind brand with the Lakeshore accent (unlinked, so it can be changed here).
  const brandLink = b.project.libraryLinks!.find((l) => l.kind === 'brand')!;
  b.run({ type: 'UNLINK_LIBRARY_ITEM', linkId: brandLink.linkId });
  b.run({ type: 'SET_BRAND', brand: { ...b.project.brand!, accent: LAKESHORE_ACCENT } });

  // Wording, with approved Spanish: the greeting and the standard payment message.
  b.run({ type: 'UPDATE_NODE', nodeId: 'greeting', patch: { content: richFromMarkup(GREETING.en) } });
  const standard = b.project.contentParts.find((c) => c.id === 'pay-standard')!;
  b.run({ type: 'UPSERT_CONTENT_PART', part: { ...standard, approvedLocales: { ...standard.approvedLocales, 'en-US': PAY_STANDARD.en } } });

  // Which sections show: the dual-fuel saving is hidden; an outage-line notice of its own after the ways to pay.
  b.run({ type: 'DELETE_NODE', nodeId: 'dual-fuel-note' });
  const root = b.project.nodes.find((n) => n.id === b.project.rootNodeId)!;
  b.insert(text('lakeshore-outage', 'Lakeshore outage line', OUTAGE.en, flow({ spaceBeforePt: 12, keepTogether: true })), b.project.rootNodeId, root.children!.indexOf('pay-actions') + 1);
  b.run({ type: 'SET_CHANNELS', channels: { ...b.project.channels!, sms: { text: SMS.en } } });
  b.translate('es-US', { '@greeting/content': GREETING.es, 'pay-standard': PAY_STANDARD.es, '@lakeshore-outage/content': OUTAGE.es, '@sms/text': SMS.es });

  // A lookup table with its own values, and a rule of its own.
  b.run({ type: 'UPSERT_LOOKUP_TABLE', table: LAKESHORE_LATE_FEES });
  const r05 = b.project.rules.find((r) => r.id === 'R05')!;
  b.run({ type: 'UPSERT_RULE', rule: { ...r05, title: 'Use up by a fifth or more on last year: show the higher-use message', when: gte('calc.kwhChangePct', 20) } });

  return { ...b.project, modelVersion: 1 };
}

export const LAKESHORE_NOTES: SampleNotes = {
  ...NORTHWIND_NOTES,
  title: 'Northwind Energy — Lakeshore',
  kind: 'Utility bill (dual fuel), a variant for the Lakeshore region',
  description: 'A variant of the Northwind Energy bill for the Lakeshore region: its own accent colour, payment and text-message wording, late fees, higher-use rule and outage-line notice. It follows release 1 of Northwind, so an update is available.',
  // None: it follows release 1, which was approvable. The credit-balance rule (which the non-reconciling customer
  // cannot pass) and its draft Spanish come with the update; Overview shows them coming in.
  intendedBlockers: [],
  knownDataProblems: NORTHWIND_NOTES.knownDataProblems.map((k) => ({ ...k, recordId: lakeshoreId(k.recordId) })),
  missingCalcs: NORTHWIND_NOTES.missingCalcs.map((m) => ({ ...m, recordId: lakeshoreId(m.recordId) })),
  pages: Object.fromEntries(Object.entries(NORTHWIND_NOTES.pages).map(([id, n]) => [lakeshoreId(id), n])),
  // Release 1's texts, less the hidden dual-fuel note, plus the outage notice; the two fixed phrases stay drafts.
  translations: { 'es-US': { approved: 121, draft: 2, missing: 0 } },
};

export { NORTHWIND_ID };
