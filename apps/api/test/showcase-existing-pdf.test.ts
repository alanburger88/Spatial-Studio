/**
 * The enriched samples (D106) as real PDFs: "Accessible PDF is required" is on for the explanation of benefits, so
 * every sample customer's PDF must pass all of the studio's checks; the card statement's pages keep their count for the
 * customers the approved app check composes, and the 250-row stress case still continues over real pages.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { EXPECTED_SCENARIOS, RECORDS, sampleProjects, seedProjects } from '@iss/model/fixtures';
import { resolve } from '@iss/resolver';
import { renderPagedDocument } from '@iss/renderers';
import { checkDocumentPdf } from '../src/pdfAccessibility';
import { Composer } from '../src/composer';

const composer = new Composer();
afterAll(() => composer.close());
const [card, eob] = sampleProjects();
const [baseCard] = seedProjects();
const rec = (id: string) => RECORDS.find((r) => r.recordId === id)!;

describe('the enriched samples as real PDFs', () => {
  it('every explanation-of-benefits customer passes all eleven checks (accessible PDF is required for it)', async () => {
    expect(eob.accessiblePdfRequired).toBe(true);
    for (const r of RECORDS.filter((x) => x.documentType === 'eob')) {
      const out = await checkDocumentPdf(composer, resolve({ project: eob, record: r }), eob);
      expect(out.studio.checks.filter((c) => c.status !== 'passed').map((c) => c.id), r.recordId).toEqual([]);
      expect(out.studio.findings, r.recordId).toEqual([]);
    }
  }, 300_000);

  it('the card keeps its page count for the approved app check’s customer, and 250 rows still continue over real pages', async () => {
    const pages = async (p: typeof card, id: string, overrides: Record<string, unknown> = {}) => {
      const res = resolve({ project: p, record: rec(id), overrides });
      return (await composer.composePaged(renderPagedDocument(res, p, { profileId: 'paged-pdf' }), { pdf: true })).metrics.pdfPageCount as number;
    };
    expect(await pages(card, 'CARD-0001')).toBe(await pages(baseCard, 'CARD-0001'));
    const stress = EXPECTED_SCENARIOS['card-250-rows'];
    expect(await pages(card, stress.recordId, stress.overrides)).toBeGreaterThan(1);
  }, 300_000);

  it('the card’s first page is the one the fixtures give (same components, same text) and the 250-row case keeps its 8 pages', async () => {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const compose = async (p: typeof card, id: string, overrides: Record<string, unknown> = {}) => {
      const res = resolve({ project: p, record: rec(id), overrides });
      const out = await composer.composePaged(renderPagedDocument(res, p, { profileId: 'paged-pdf', watermark: '' }), { pdf: true });
      const doc = await pdfjs.getDocument({ data: new Uint8Array(out.pdf!), useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
      // The run id is a hash of the document (it changes with any addition); everything else on page 1 must not.
      const first = (await (await doc.getPage(1)).getTextContent()).items.map((it: any) => it.str).join(' ').replace(/run-[0-9a-f]{16}/g, 'run-…');
      return { pages: out.metrics.pageCount, firstNodes: (out.metrics.pages[0] as any).nodeIds, first };
    };
    for (const id of ['CARD-0001', 'CARD-0002']) {
      const [before, after] = [await compose(baseCard, id), await compose(card, id)];
      expect(after.firstNodes, id).toEqual(before.firstNodes);
      expect(after.first, id).toBe(before.first);
    }
    const stress = EXPECTED_SCENARIOS['card-250-rows'];
    const [before, after] = [await compose(baseCard, stress.recordId, stress.overrides), await compose(card, stress.recordId, stress.overrides)];
    expect([before.pages, after.pages]).toEqual([8, 8]);
    expect(after.first).toBe(before.first);
  }, 300_000);
});
