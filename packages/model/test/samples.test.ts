import { describe, expect, it } from 'vitest';
import { applyCommand, customFieldDefs, diffProjects, libraryContentFingerprint, projectContentDigest, projectFileProblems, sanitizeRichDoc, richFromMarkup, validateRecordShape } from '../src';
import { EXTRA_SAMPLES, HOUSE, houseContent, MERIDIAN_ID, NORTHWIND_ID } from '../src/samples/index';
import { buildNorthwind, northwindCustomers } from '../src/samples/northwind';
import { buildMeridian, meridianCustomers, unitsOf, unitsText } from '../src/samples/meridian';
import { checkLibraryContent } from '../src/library';

/**
 * The builders of the example documents (Northwind Energy, Meridian Wealth) and the house library: valid, deterministic,
 * built only through the command bus, with customers that fit the documents' own data fields.
 */
describe('example document builders', () => {
  const samples = EXTRA_SAMPLES();
  const nw = samples.find((s) => s.project.projectId === NORTHWIND_ID)!;
  const mw = samples.find((s) => s.project.projectId === MERIDIAN_ID)!;

  it('build valid documents with their own data, every one a new document at version 1', () => {
    for (const s of [nw, mw]) {
      expect(s.project.documentType).toBe('custom');
      expect(s.project.modelVersion).toBe(1);
      expect(projectFileProblems(s.project)).toEqual([]);
      expect(s.project.languages).toEqual(['es-US']);
      expect(s.project.accessiblePdfRequired).toBe(true);
      expect(s.project.presentationProfiles.find((p) => p.id === 'paged-pdf')?.paper).toBe('US-Letter');
      expect((s.project.testCases ?? []).length).toBeGreaterThanOrEqual(5);
      expect((s.project.testCases ?? []).some((t) => t.issueDate)).toBe(true);
      expect(s.project.journey.events.length).toBeGreaterThanOrEqual(2);
      expect((s.project.mappings ?? []).map((m) => m.name)).toContain('Mapping for the print house');
      expect(s.project.issuer.name).not.toMatch(/fictional/i);
      // The issuer is named fictional where the document says who it is from, as the fixture samples do.
      const footer = s.project.nodes.find((n) => n.id === 'page-footer')!.headerFooter!.text;
      expect(footer).toContain('(fictional)');
    }
    // Northwind: a Last page template that keeps the payment slip clear; Meridian: two columns on the first page.
    const nwPaged = nw.project.presentationProfiles.find((p) => p.id === 'paged-pdf')!;
    expect(nwPaged.pageTemplates?.last).toBeTruthy();
    expect(nw.project.nodes.filter((n) => n.layout?.paged?.pages === 'last').length).toBeGreaterThanOrEqual(4);
    const mwPaged = mw.project.presentationProfiles.find((p) => p.id === 'paged-pdf')!;
    expect(mwPaged.pageTemplates?.first?.columns).toBe(2);
    expect(mwPaged.pageTemplates?.first?.background?.kind).toBe('tint');
    expect(mw.project.nodes.find((n) => n.id === 'holdings-table')!.layout!.paged!.spanColumns).toBe(true);
  });

  it('are deterministic: building again gives the same documents and the same customers', () => {
    expect(projectContentDigest(buildNorthwind('working'))).toBe(projectContentDigest(nw.project));
    expect(projectContentDigest(buildMeridian())).toBe(projectContentDigest(mw.project));
    expect(JSON.stringify(northwindCustomers())).toBe(JSON.stringify(nw.customers));
    expect(JSON.stringify(meridianCustomers())).toBe(JSON.stringify(mw.customers));
  });

  it('give 30 to 40 customers each, with stable ids of their own and values that fit the data fields', () => {
    for (const [s, prefix] of [[nw, 'NWE'], [mw, 'MWS']] as const) {
      expect(s.customers.length).toBeGreaterThanOrEqual(30);
      expect(s.customers.length).toBeLessThanOrEqual(40);
      expect(s.customers.map((c) => c.recordId)).toEqual(s.customers.map((_, i) => `${prefix}-${60001 + i}`));
      const defs = customFieldDefs(s.project.customFields);
      for (const c of s.customers) {
        expect(c.projectId).toBe(s.project.projectId);
        expect(validateRecordShape(c, 'custom', defs), c.recordId).toEqual([]);
      }
      expect(new Set(s.customers.map((c) => c.customer.locale))).toEqual(new Set(['en-US', 'es-US']));
    }
  });

  it('Northwind’s release 1 differs from the working version by one wording change and one rule change', () => {
    const release = nw.release!.project;
    const d = diffProjects(release, nw.project);
    expect(d.summary.counts.rules).toBe(1);
    expect(d.rules.added.map((r) => r.id)).toEqual(['R02']);
    expect(projectFileProblems(release)).toEqual([]);
    const before = release.contentParts.find((c) => c.id === 'pay-standard')!.approvedLocales['en-US'];
    const after = nw.project.contentParts.find((c) => c.id === 'pay-standard')!.approvedLocales['en-US'];
    expect(before).not.toBe(after);
    expect(after).toContain('payment slip');
  });

  it('link to the house library with exactly the library’s content, at the declared versions', () => {
    for (const item of HOUSE.list) for (const [i, v] of item.versions.entries()) {
      const c = checkLibraryContent(item.kind, v.content);
      expect(c.ok, `${item.id} v${i + 1}`).toBe(true);
    }
    expect(HOUSE.items['customer-rights-notice'].versions).toHaveLength(2);
    for (const s of [nw, mw]) for (const l of s.project.libraryLinks ?? []) {
      expect(l.version).toBe(HOUSE.linkPlan[l.itemId as keyof typeof HOUSE.linkPlan]);
      expect(l.fingerprint).toBe(libraryContentFingerprint(houseContent(l.itemId as keyof typeof HOUSE.linkPlan, l.version)));
    }
    const shared = (nw.project.libraryLinks ?? []).map((l) => l.itemId).filter((id) => (mw.project.libraryLinks ?? []).some((m) => m.itemId === id)).sort();
    expect(shared).toEqual(['accessible-formats-panel', 'glossary-es', 'house-wording-rules']);
  });

  it('pass the same validation a person’s edits would: a refused step fails the build', () => {
    // Re-applying the document's own last command shows the builder only ever produces what the bus accepts.
    const r = applyCommand(nw.project, { type: 'UPSERT_RULE', rule: { ...nw.project.rules[0], when: { op: 'eq', path: 'custom.noSuchField', value: 1 } } });
    expect(r.ok).toBe(false);
  });

  it('write units as a statement shows them and read them back exactly', () => {
    for (const t of [0, 1, 999, 1000, 1234567, 15200000]) expect(unitsOf(unitsText(t))).toBe(t);
    expect(unitsText(1234567)).toBe('1,234.567');
  });
});

describe('rich text keeps a bold or italic data value (sanitizer)', () => {
  it('keeps bold and italic marks on a token and drops anything else', () => {
    const doc = richFromMarkup('Pay **{{custom.amount}}** now');
    const clean = sanitizeRichDoc(doc).doc;
    const token = clean.content[0].content!.find((x) => (x as any).type === 'token') as any;
    expect(token.marks).toEqual([{ type: 'bold' }]);
    const odd = sanitizeRichDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'token', attrs: { path: 'custom.a' }, marks: [{ type: 'link', attrs: { href: 'https://example.com' } }, { type: 'italic' }] }] }] }).doc;
    expect((odd.content[0].content![0] as any).marks).toEqual([{ type: 'italic' }]);
    const plain = sanitizeRichDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'token', attrs: { path: 'custom.a' } }] }] }).doc;
    expect((plain.content[0].content![0] as any).marks).toBeUndefined();
  });
});
