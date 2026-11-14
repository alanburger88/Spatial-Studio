import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyCommand, richFromMarkup, type Command, type DocNode, type Project } from '@iss/model';
import { EXPECTED_SCENARIOS, RECORDS, seedProjects } from '@iss/model/fixtures';
import { resolve, type Finding } from '@iss/resolver';
import { renderInteractiveHtml, renderPagedDocument, PAGED_RENDERER_VERSION, PAGED_DESIGN_RENDERER_VERSION, levelHeadings } from '@iss/renderers';
import { documentBlockers, fixImpact, proposeFixes } from '@iss/scenarios';
import { buildApp } from '../src/app';
import { Composer } from '../src/composer';
import { checkDocumentPdf, checkPdfAccessibility, contrastRatio, PDF_CHECKS, proofLevelOf, type PdfA11yReport, type PdfCheckId } from '../src/pdfAccessibility';
import { createRelease } from '../src/releases';
import { findVeraPdf, KNOWN_LIMIT_RULES, parseVeraPdfReport, runVeraPdf, VERAPDF_NOT_INSTALLED, veraPdfStatus } from '../src/verapdf';

/**
 * Accessible PDF, proven (wave 2, docs/design/PDF_ACCESSIBILITY.md). Every check runs on REAL PDFs composed by headless
 * Chromium exactly as the studio's export does, or, for documents the studio cannot produce (an untagged PDF, a table
 * with no header cells), on PDFs the same browser prints from deliberately broken HTML.
 */

const composer = new Composer();
afterAll(() => composer.close());
const [card, eob] = seedProjects();
const rec = (id: string) => RECORDS.find((r) => r.recordId === id)!;
const run = (p: Project, ...cmds: Command[]) => cmds.reduce((acc, c) => { const r = applyCommand(acc, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; }, p);
const statuses = (r: PdfA11yReport): Record<string, string> => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
const failedChecks = (r: PdfA11yReport): string[] => r.checks.filter((c) => c.status === 'failed').map((c) => c.id);
const codes = (r: PdfA11yReport): string[] => [...new Set(r.findings.map((f) => f.code))].sort();
const allPass = (r: PdfA11yReport) => Object.fromEntries(PDF_CHECKS.map((c) => [c.id, 'passed'])) as Record<PdfCheckId, string>;

async function check(p: Project, recordId: string, overrides: Record<string, unknown> = {}) {
  const res = resolve({ project: p, record: rec(recordId), overrides });
  return checkDocumentPdf(composer, res, p);
}

/** A PDF printed by the same browser from hand-written HTML (for documents the studio's composer cannot produce). */
async function pdfOf(body: string, o: { lang?: string | null; title?: string | null; tagged?: boolean } = {}): Promise<Buffer> {
  const browser = await composer.getBrowser();
  const ctx = await browser.newContext({ offline: true });
  try {
    const page = await ctx.newPage();
    const lang = o.lang === undefined ? 'en-US' : o.lang;
    const title = o.title === undefined ? 'Broken document' : o.title;
    await page.setContent(`<!doctype html><html${lang ? ` lang="${lang}"` : ''}><head><meta charset="utf-8"/>${title ? `<title>${title}</title>` : ''}</head><body style="font:11pt Arial;color:#0F172A;background:#fff">${body}</body></html>`);
    await page.emulateMedia({ media: 'print' });
    return await page.pdf({ printBackground: true, tagged: o.tagged ?? true, preferCSSPageSize: true });
  } finally { await ctx.close(); }
}
const GOOD = '<h1>Statement</h1><p>Some text.</p>';
/**
 * This browser always writes a language (its own default when the page has none), so a PDF without one is made by
 * blanking the entry in the bytes (same length, so the file stays readable): a deliberately broken document.
 */
const blank = (pdf: Buffer, re: RegExp): Buffer => Buffer.from(pdf.toString('latin1').replace(re, (m) => ' '.repeat(m.length)), 'latin1');

describe('the two samples, corrected at the source', () => {
  it('the renderer versions say the page source changed (accessibility tags only)', () => {
    expect(PAGED_RENDERER_VERSION).toBe('iss-paged-renderer/1.0.1');
    expect(PAGED_DESIGN_RENDERER_VERSION).toBe('iss-paged-renderer/1.1.1');
  });

  it('the explanation of benefits passes every check of the studio', async () => {
    const r = await check(eob, 'EOB-0002');
    expect(statuses(r.studio)).toEqual(allPass(r.studio));
    expect(r.studio.findings).toEqual([]);
    expect(r.studio).toMatchObject({ level: 'studio', pageCount: 1, language: 'en-US', title: 'HarborCare Health — EOB-0002 (synthetic)' });
    // The two things this browser cannot write are always stated, never hidden.
    expect(r.studio.knownLimits.map((k) => k.id)).toEqual(['pdfua-identifier', 'artifacts']);
    expect(r.verapdf.status).toBe('not-run');
    expect(proofLevelOf(r)).toEqual({ level: 'studio', label: 'Checked by the studio' });
  });

  it('the card statement passes every check except its continued table, which its suggested fix corrects', async () => {
    const r = await check(card, 'CARD-0001');
    expect(failedChecks(r.studio)).toEqual(['tables']);
    const f = r.studio.findings.find((x) => x.code === 'PDF_A11Y_TABLE_NO_HEADERS')!;
    expect(f).toMatchObject({ nodeId: 'transaction-table', page: 2, severity: 'warning', details: { check: 'tables', continued: true } });
    const fixes = proposeFixes(card, f, { records: RECORDS });
    const repeat = fixes.find((x) => x.kind === 'change')!;
    expect(repeat.commands).toEqual([{ type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { repeatHeader: 'always' } }]);
    const fixed = run(card, { type: 'BATCH', label: repeat.title, commands: repeat.commands! });
    const after = await check(fixed, 'CARD-0001');
    expect(statuses(after.studio)).toEqual(allPass(after.studio));
    // The change is checked on the model too (the PDF confirms it when composed again).
    expect(fixImpact(card, repeat, RECORDS, { finding: f }).resolves).toBe(true);
  });

  it('more sample customers and the 250-row statement', async () => {
    const fixed = run(card, { type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { repeatHeader: 'always' } });
    for (const [p, id, ov] of [[fixed, 'CARD-0007', {}], [fixed, 'CARD-0001', EXPECTED_SCENARIOS['card-250-rows'].overrides], [eob, 'EOB-0011', {}]] as const) {
      const r = await check(p, id, ov as Record<string, unknown>);
      expect(failedChecks(r.studio), `${id}: ${r.studio.findings.map((x) => x.message).join(' | ')}`).toEqual([]);
      expect(r.studio.summary.notChecked).toBe(0);
    }
  });

  it('heading levels start at 1 and never skip, written only as aria-level (the elements stay what they were)', () => {
    expect(levelHeadings(['<h2 class="a">A</h2>', '<h3>B</h3><h4>C</h4>', '<div class="iss-table-caption" role="heading" aria-level="2">T</div>', '<h3>D</h3>']))
      .toEqual(['<h2 aria-level="1" class="a">A</h2>', '<h3 aria-level="2">B</h3><h4 aria-level="3">C</h4>', '<div class="iss-table-caption" role="heading" aria-level="2">T</div>', '<h3>D</h3>']);
    const res = resolve({ project: card, record: rec('CARD-0001') });
    const html = renderPagedDocument(res, card);
    expect(html).toContain('<h2 aria-level="1">Monthly account statement</h2>');
    expect(html).toContain('<figure class="iss-qrblock" role="group">');
    expect(html).toContain('<figure class="iss-figure" role="group">');
    // The web page is not changed by any of this.
    const web = renderInteractiveHtml(res, card);
    expect(web).not.toMatch(/aria-level|role="group"><figcaption|iss-qrblock" role/);
  });
});

describe('every check fails on a document broken for it', () => {
  it('not tagged', async () => {
    const r = await checkPdfAccessibility(await pdfOf(GOOD, { tagged: false }), { locale: 'en-US' });
    expect(statuses(r)).toMatchObject({ tagged: 'failed', headings: 'not-checked', tables: 'not-checked', pictures: 'not-checked', 'reading-order': 'not-checked' });
    expect(codes(r)).toContain('PDF_A11Y_NOT_TAGGED');
  });

  it('a missing title, then a missing language, then the wrong language', async () => {
    const noTitle = await checkPdfAccessibility(await pdfOf(GOOD, { title: null }), { locale: 'en-US' });
    expect(statuses(noTitle).title).toBe('failed');
    expect(codes(noTitle)).toContain('PDF_A11Y_NO_TITLE');
    const noLang = await checkPdfAccessibility(blank(await pdfOf(GOOD), /\/Lang \([^)]*\)/g), { locale: 'en-US' });
    expect(statuses(noLang).language).toBe('failed');
    expect(codes(noLang)).toContain('PDF_A11Y_NO_LANGUAGE');
    const wrong = await checkPdfAccessibility(await pdfOf(GOOD), { locale: 'es-US' });
    expect(codes(wrong)).toContain('PDF_A11Y_WRONG_LANGUAGE');
    const good = await checkPdfAccessibility(await pdfOf(GOOD), { locale: 'en-US' });
    expect(statuses(good)).toMatchObject({ title: 'passed', language: 'passed', headings: 'passed', tagged: 'passed' });
  });

  it('a skipped heading level, a first heading that is not level 1, and no headings at all', async () => {
    const skipped = await checkPdfAccessibility(await pdfOf('<h1>Statement</h1><p>x</p><h3>Details</h3><p>y</p>'), { locale: 'en-US' });
    expect(skipped.findings.filter((f) => f.code === 'PDF_A11Y_HEADING_SKIPPED').map((f) => f.details.level)).toEqual([3]);
    const first = await checkPdfAccessibility(await pdfOf('<h2>Statement</h2><p>x</p>'), { locale: 'en-US' });
    expect(first.findings[0]).toMatchObject({ code: 'PDF_A11Y_HEADING_SKIPPED', details: { title: 'The first heading is not a main heading', level: 2, previous: 0 } });
    const none = await checkPdfAccessibility(await pdfOf('<p>Only a paragraph.</p>'), { locale: 'en-US' });
    expect(codes(none)).toEqual(['PDF_A11Y_NO_HEADINGS']);
  });

  it('a table without header cells', async () => {
    // (A table with a caption and a border: without them this browser treats a table of plain cells as layout, not data.)
    const r = await checkPdfAccessibility(await pdfOf(`${GOOD}<table border="1"><caption>Fees</caption><tr><td>Date</td><td>Amount</td></tr><tr><td>Oct 1</td><td>$4.00</td></tr></table>`), { locale: 'en-US' });
    expect(statuses(r).tables).toBe('failed');
    expect(codes(r)).toEqual(['PDF_A11Y_TABLE_NO_HEADERS']);
    const ok = await checkPdfAccessibility(await pdfOf(`${GOOD}<table border="1"><caption>Fees</caption><tr><th>Date</th><th>Amount</th></tr><tr><td>Oct 1</td><td>$4.00</td></tr></table>`), { locale: 'en-US' });
    expect(statuses(ok).tables).toBe('passed');
  });

  it('a picture with no description: in the PDF, and in the document (where the PDF cannot show it)', async () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const raw = await checkPdfAccessibility(await pdfOf(`${GOOD}<img src="${PNG}" style="width:40px;height:40px"/>`), { locale: 'en-US' });
    expect(codes(raw)).toEqual(['PDF_A11Y_FIGURE_NO_ALT']);
    // The studio's own image without a description is left out of the tags by the browser (like decoration); the
    // check knows from the document that it is not decoration and names it.
    const img: DocNode = { id: 'promo-picture', type: 'image', name: 'Promotion picture', image: { src: 'asset:aster-mark', alt: '', fit: 'contain' }, decorative: false, layout: { paged: { mode: 'flow', widthPct: 30 } } } as DocNode;
    const p = run(card, { type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { repeatHeader: 'always' } }, { type: 'INSERT_NODE', parentId: 'doc-root', index: 8, node: img });
    const r = await check(p, 'CARD-0001');
    expect(failedChecks(r.studio)).toEqual(['pictures']);
    const f = r.studio.findings.find((x) => x.code === 'PDF_A11Y_IMAGE_NO_DESCRIPTION')!;
    expect(f).toMatchObject({ nodeId: 'promo-picture' });
    // Suggested fixes: describe it, or mark it as decoration (one undoable command each).
    const fixes = proposeFixes(p, f, { records: RECORDS });
    expect(fixes.map((x) => x.commands?.[0])).toEqual([
      { type: 'UPDATE_NODE', nodeId: 'promo-picture', patch: { image: { src: 'asset:aster-mark', alt: 'Promotion picture', fit: 'contain' } } },
      { type: 'UPDATE_NODE', nodeId: 'promo-picture', patch: { decorative: true } },
    ]);
    const decorated = await check(run(p, fixes[1].commands![0]), 'CARD-0001');
    expect(failedChecks(decorated.studio)).toEqual([]);
    const described = await check(run(p, fixes[0].commands![0]), 'CARD-0001');
    expect(failedChecks(described.studio)).toEqual([]);
  });

  it('links without readable text', async () => {
    const r = await checkPdfAccessibility(await pdfOf(`${GOOD}<p>To pay, <a href="https://example.com/pay">click here</a>.</p>`), { locale: 'en-US' });
    expect(codes(r)).toEqual(['PDF_A11Y_LINK_TEXT']);
    expect(r.knownLimits.map((k) => k.id)).toContain('link-descriptions');
    const ok = await checkPdfAccessibility(await pdfOf(`${GOOD}<p>Pay at <a href="https://example.com/pay">example.com/pay</a>.</p>`), { locale: 'en-US' });
    expect(statuses(ok).links).toBe('passed');
  });

  it('lists typed as paragraphs', async () => {
    const r = await checkPdfAccessibility(await pdfOf(`${GOOD}<p>• First thing</p><p>• Second thing</p>`), { locale: 'en-US' });
    expect(codes(r)).toEqual(['PDF_A11Y_LIST_NOT_TAGGED']);
    const ok = await checkPdfAccessibility(await pdfOf(`${GOOD}<ul><li>First thing</li><li>Second thing</li></ul>`), { locale: 'en-US' });
    expect(statuses(ok).lists).toBe('passed');
  });

  it('low contrast, named after the brand colour that causes it', async () => {
    const raw = await checkPdfAccessibility(await pdfOf(`${GOOD}<p style="color:#AAAAAA">Pale text</p><p style="color:#FFFFFF;background:#4EAF60">White on green</p>`), { locale: 'en-US' });
    expect(raw.findings.filter((f) => f.code === 'PDF_A11Y_LOW_CONTRAST').map((f) => [f.details.foreground, f.details.background])).toEqual([['#AAAAAA', '#FFFFFF'], ['#FFFFFF', '#4EAF60']]);
    const p = run(card, { type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { repeatHeader: 'always' } }, { type: 'SET_BRAND', brand: { primary: '#277656', accent: '#4EAF60', text: '#BBBBBB' } });
    const r = await check(p, 'CARD-0001');
    expect(failedChecks(r.studio)).toEqual(['contrast']);
    const f = r.studio.findings.find((x) => x.code === 'PDF_A11Y_LOW_CONTRAST' && x.nodeId === 'greeting')!;
    expect(f.details).toMatchObject({ colour: 'brand', foreground: '#BBBBBB', background: '#FFFFFF', need: 4.5, ratio: 1.92 });
    // Large text (the 15 pt bold title) needs 3:1.
    expect(r.studio.findings.find((x) => x.nodeId === 'statement-title')!.details).toMatchObject({ need: 3 });
    expect(f.message).toContain('the brand text colour');
    expect(contrastRatio([0xBB, 0xBB, 0xBB], [255, 255, 255])).toBeCloseTo(1.92, 2);
  });

  it('the wrong reading order: fixed items listed against where they sit on the page, with the fix that lists them in order', async () => {
    const root = card.nodes.find((n) => n.id === card.rootNodeId)!;
    const p = run(card, { type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { repeatHeader: 'always' } }, { type: 'MOVE_NODE', nodeId: 'document-header', parentId: root.id, index: root.children!.indexOf('customer-address') });
    const r = await check(p, 'CARD-0001');
    expect(failedChecks(r.studio)).toEqual(['reading-order']);
    const f = r.studio.findings.find((x) => x.code === 'PDF_A11Y_READING_ORDER')!;
    expect(f).toMatchObject({ nodeId: 'document-header', page: 1, details: { otherNodeId: 'statement-title', readBefore: false, placement: 'fixed' } });
    expect(f.message).toBe('On page 1, “Document header” is read after “Statement title”, although it comes before it on the page. Move “Document header” in the list of components so it is listed where it is read on the page.');
    const fix = proposeFixes(p, f, { records: RECORDS }).find((x) => x.kind === 'change')!;
    expect(fix.commands![0]).toMatchObject({ type: 'MOVE_NODE', nodeId: 'document-header' });
    const back = await check(run(p, fix.commands![0]), 'CARD-0001');
    expect(failedChecks(back.studio)).toEqual([]);
  });

  it('text left out of the tags', async () => {
    const r = await checkPdfAccessibility(await pdfOf(`${GOOD}<p aria-hidden="true">Hidden from screen readers</p>`), { locale: 'en-US' });
    expect(codes(r)).toEqual(['PDF_A11Y_UNTAGGED_TEXT']);
  });

  it('a file that is not a PDF is not checked, never passed', async () => {
    const r = await checkPdfAccessibility(Buffer.from('not a pdf'), { locale: 'en-US' });
    expect(r.summary).toMatchObject({ passed: 0, failed: 0, notChecked: PDF_CHECKS.length });
  });
});

describe('documents using the new page design', () => {
  const fixedTable = run(card, { type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { repeatHeader: 'always' } });
  const design = (patch: Extract<Command, { type: 'SET_PAGE_DESIGN' }>['patch']): Command => ({ type: 'SET_PAGE_DESIGN', patch });

  it('columns, and a background tint and picture (decoration: its text is not read and not checked)', async () => {
    const p = run(fixedTable, design({ pageTemplates: { first: { columns: 2, background: { kind: 'tint', color: '#DBE64C', opacityPct: 25 } }, following: { columns: 3, columnGapPt: 12, background: { kind: 'image', image: 'asset:aster-mark', fit: 'contain', opacityPct: 10 } } } }));
    const r = await check(p, 'CARD-0001', EXPECTED_SCENARIOS['card-250-rows'].overrides);
    expect(r.studio.pageCount).toBeGreaterThan(3);
    expect(failedChecks(r.studio), r.studio.findings.map((x) => x.message).join(' | ')).toEqual([]);
    expect(statuses(r.studio)['reading-order']).toBe('passed');
    expect(r.studio.checks.find((c) => c.id === 'contrast')!.detail).toContain('page background or a decorative picture is decoration');
  });

  it('a last-page template on A4, with a payment slip fixed on the last page (read after the page content)', async () => {
    const slip = { id: 'payment-slip', type: 'rich-text' as const, name: 'Payment slip', content: richFromMarkup('## Payment slip\nReturn this part with your payment.'), layout: { paged: { mode: 'fixed' as const, xPt: 40, yPt: 600, wPt: 515, hPt: 120, pages: 'last' as const } } };
    const root = card.nodes.find((n) => n.id === card.rootNodeId)!;
    // Listed before the page footer, as it sits above it: read after the content and before the footer.
    const p = run(fixedTable, design({ paper: 'A4', pageTemplates: { last: { flowArea: { xPt: 40, yPt: 84, wPt: 515, hPt: 470 } } } }), { type: 'INSERT_NODE', parentId: 'doc-root', index: root.children!.indexOf('page-footer'), node: slip });
    const r = await check(p, 'CARD-0001', EXPECTED_SCENARIOS['card-250-rows'].overrides);
    expect(failedChecks(r.studio), r.studio.findings.map((x) => x.message).join(' | ')).toEqual([]);
    // Listed after the footer, the slip is read after it: the check says so and offers to list it before the footer.
    const late = run(fixedTable, design({ paper: 'A4', pageTemplates: { last: { flowArea: { xPt: 40, yPt: 84, wPt: 515, hPt: 470 } } } }), { type: 'INSERT_NODE', parentId: 'doc-root', node: slip });
    const lr = await check(late, 'CARD-0001', EXPECTED_SCENARIOS['card-250-rows'].overrides);
    const f = lr.studio.findings.find((x) => x.code === 'PDF_A11Y_READING_ORDER')!;
    expect(f).toMatchObject({ nodeId: 'payment-slip', details: { otherNodeId: 'page-footer' } });
    expect(proposeFixes(late, f, { records: RECORDS })[0].commands).toEqual([{ type: 'MOVE_NODE', nodeId: 'payment-slip', parentId: 'doc-root', index: root.children!.indexOf('page-footer') }]);
    const eobLandscape = await check(run(eob, design({ paper: 'A4', orientation: 'landscape', pageTemplates: { following: { columns: 2 }, last: {} } })), 'EOB-0011');
    expect(failedChecks(eobLandscape.studio)).toEqual([]);
  });
});

describe('the setting “Accessible PDF is required”', () => {
  it('is an undoable command, off by default, that leaves existing documents exactly as they were', () => {
    expect(card.accessiblePdfRequired).toBeUndefined();
    const on = applyCommand(card, { type: 'SET_ACCESSIBLE_PDF_REQUIRED', required: true });
    expect(on.ok && on.project.accessiblePdfRequired).toBe(true);
    const off = applyCommand((on as any).project, { type: 'SET_ACCESSIBLE_PDF_REQUIRED', required: false });
    expect(off.ok && 'accessiblePdfRequired' in off.project).toBe(false);
    expect(applyCommand(card, { type: 'SET_ACCESSIBLE_PDF_REQUIRED', required: false }).ok).toBe(false);
  });

  it('turns failed checks into blockers of kind layout and pages; off, they are warnings and block nothing', async () => {
    const required = run(card, { type: 'SET_ACCESSIBLE_PDF_REQUIRED', required: true });
    const on = await check(required, 'CARD-0001');
    expect(on.studio.required).toBe(true);
    expect(on.studio.findings.map((f) => f.severity)).toEqual(['blocking']);
    const extra = (r: typeof on) => r.studio.findings.map((finding: Finding) => ({ finding, recordId: 'CARD-0001', speed: 'full-check' as const }));
    const blockers = documentBlockers(required, RECORDS, { extraFindings: extra(on) });
    const b = blockers.blockers.find((x) => x.code === 'PDF_A11Y_TABLE_NO_HEADERS')!;
    expect(b).toMatchObject({ kind: 'layout', title: 'A table continues without its header row', recordIds: ['CARD-0001'], speed: 'full-check', about: { component: { id: 'transaction-table' } } });
    expect(b.fixes[0]).toMatchObject({ kind: 'change', risk: 'review' });
    const off = await check(card, 'CARD-0001');
    expect(off.studio.findings.map((f) => f.severity)).toEqual(['warning']);
    expect(documentBlockers(card, RECORDS, { extraFindings: extra(off) }).blockers.some((x) => x.code.startsWith('PDF_A11Y_'))).toBe(false);
  });
});

describe('the veraPDF bridge (with a stand-in program: no real veraPDF run is made here)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iss-verapdf-test-'));
  // A report in veraPDF's machine-readable (MRR) format, written for this test from veraPDF's documented report
  // structure; it is NOT a recording of a real veraPDF run.
  const REPORT = `<?xml version="1.0" encoding="utf-8"?>
<report>
  <buildInformation><releaseDetails id="core" version="1.26.2" buildDate="2024-06-01T00:00:00Z"></releaseDetails></buildInformation>
  <jobs><job><item size="1000"><name>document.pdf</name></item>
    <validationReport jobEndStatus="normal" profileName="PDF/UA-1 validation profile" statement="PDF file is not compliant with Validation Profile requirements." isCompliant="false">
      <details passedRules="104" failedRules="3" passedChecks="4200" failedChecks="57">
        <rule specification="ISO 14289-1:2014" clause="5" testNumber="1" status="failed" failedChecks="1"><description>The PDF/UA version and conformance level of a file shall be specified using the PDF/UA Identification extension schema</description><object>MainXMPPackage</object><test>containsPDFUAIdentification == true</test><check status="failed"><context>root/document[0]</context></check></rule>
        <rule specification="ISO 14289-1:2014" clause="7.1" testNumber="3" status="failed" failedChecks="55"><description>Content shall be marked as Artifact or tagged as real content</description><object>SESimpleContentItem</object><test>isTaggedContent == true || parentsTags.contains('Artifact') == true</test></rule>
        <rule specification="ISO 14289-1:2014" clause="7.18.1" testNumber="2" status="failed" failedChecks="1"><description>An annotation &amp; its widget shall be nested within a tag</description><object>PDAnnot</object><test>x</test></rule>
        <rule specification="ISO 14289-1:2014" clause="7.2" testNumber="1" status="passed" passedChecks="10"><description>Passed rule</description></rule>
      </details>
    </validationReport>
  </job></jobs>
</report>`;
  const stand = (name: string, body: string) => { const p = path.join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };
  const reportFile = path.join(dir, 'report.xml');
  writeFileSync(reportFile, REPORT);
  const good = stand('verapdf', `if [ "$1" = "--version" ]; then echo "veraPDF 1.26.2"; echo "Built: 2024-06-01"; exit 0; fi\ncase "$*" in *"--flavour ua1 --format mrr"*) cat "${reportFile}"; exit 1;; esac\necho "unexpected arguments: $*" >&2; exit 2`);
  const slow = stand('slow-verapdf', 'sleep 5');
  const garbage = stand('garbage-verapdf', 'echo "Error: could not start Java"; exit 3');

  it('is not installed when it is not on VERAPDF_PATH or the PATH, and says so plainly', async () => {
    expect(findVeraPdf({ PATH: '/nonexistent' })).toBeNull();
    expect(await runVeraPdf(Buffer.from('%PDF'), { env: { PATH: '/nonexistent' } })).toEqual({ status: 'not-installed', message: VERAPDF_NOT_INSTALLED });
    expect(VERAPDF_NOT_INSTALLED).toBe('veraPDF is not installed on this machine');
    expect(await veraPdfStatus({ PATH: '/nonexistent' })).toEqual({ installed: false, message: VERAPDF_NOT_INSTALLED });
  });

  it('is found at VERAPDF_PATH (the program or its folder) and on the PATH', async () => {
    expect(findVeraPdf({ VERAPDF_PATH: good })).toBe(good);
    expect(findVeraPdf({ VERAPDF_PATH: dir })).toBe(good);
    expect(findVeraPdf({ PATH: `/nonexistent${path.delimiter}${dir}` })).toBe(good);
    expect(findVeraPdf({ VERAPDF_PATH: path.join(dir, 'missing') })).toBeNull();
    expect(await veraPdfStatus({ VERAPDF_PATH: good })).toEqual({ installed: true, version: '1.26.2' });
  });

  it('runs against PDF/UA-1 with machine-readable output and gives the verdict, the version and the failed rules in plain words', async () => {
    const r = await runVeraPdf(Buffer.from('%PDF-1.4'), { env: { VERAPDF_PATH: good } });
    expect(r.status).toBe('ran');
    if (r.status !== 'ran') return;
    expect(r).toMatchObject({ version: '1.26.2', profile: 'PDF/UA-1 validation profile', compliant: false, passedRules: 104, failedChecks: 57 });
    expect(r.failedRules.map((x) => [x.id, x.count, !!x.knownLimit])).toEqual([['ISO 14289-1:2014 5-1', 1, true], ['ISO 14289-1:2014 7.1-3', 55, true], ['ISO 14289-1:2014 7.18.1-2', 1, false]]);
    expect(r.failedRules[2].description).toBe('An annotation & its widget shall be nested within a tag');
    expect(proofLevelOf({ verapdf: r })).toEqual({ level: 'verapdf', label: 'Validated by veraPDF' });
    expect(KNOWN_LIMIT_RULES.length).toBeGreaterThan(0);
  });

  it('a compliant report is read as compliant', () => {
    const ok = parseVeraPdfReport(REPORT.replace('isCompliant="false"', 'isCompliant="true"').replace(/<rule [^>]*status="failed"[\s\S]*?<\/rule>/g, ''));
    expect(ok).toMatchObject({ compliant: true, failedRules: [] });
  });

  it('stops a run that takes too long, and reports output it cannot read as an error', async () => {
    const t = await runVeraPdf(Buffer.from('%PDF'), { env: { VERAPDF_PATH: slow }, timeoutMs: 300 });
    expect(t.status).toBe('timeout');
    const e = await runVeraPdf(Buffer.from('%PDF'), { env: { VERAPDF_PATH: garbage } });
    expect(e).toMatchObject({ status: 'error' });
    expect((e as { message: string }).message).toContain('did not return a validation report');
  });

  it('runs on a real composed PDF through the document check when asked for', async () => {
    const res = resolve({ project: eob, record: rec('EOB-0002') });
    const r = await checkDocumentPdf(composer, res, eob, { verapdf: true, env: { VERAPDF_PATH: good } });
    expect(r.verapdf).toMatchObject({ status: 'ran', compliant: false });
    const none = await checkDocumentPdf(composer, res, eob, { verapdf: true, env: { PATH: '/nonexistent' } });
    expect(none.verapdf).toEqual({ status: 'not-installed', message: VERAPDF_NOT_INSTALLED });
  });
});

describe('the API', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-pdfa11y-')), logger: false, auth: false }); });
  afterAll(async () => { await ctx.app.close(); });
  const json = async (method: 'GET' | 'POST', url: string, payload?: unknown) => (await ctx.app.inject({ method, url, payload: payload as any })).json();

  it('validation gives the PDF accessibility result in the accessibility suite; the full check asks for the PDF part only', async () => {
    const required = run(card, { type: 'SET_ACCESSIBLE_PDF_REQUIRED', required: true });
    const out = await json('POST', '/api/v1/validate', { projectId: card.projectId, recordId: 'CARD-0001', project: required, suites: ['accessibility'], accessibilityScope: 'pdf' });
    expect(out.pdfAccessibility.studio.summary).toMatchObject({ ran: 11, failed: 1 });
    expect(out.pdfAccessibility.verapdf.status).toBe('not-run');
    const pdfIssues = out.issues.filter((i: any) => i.code.startsWith('PDF_A11Y_'));
    expect(pdfIssues.map((i: any) => [i.code, i.severity, i.nodeId, i.suite])).toEqual([['PDF_A11Y_TABLE_NO_HEADERS', 'blocking', 'transaction-table', 'accessibility']]);
    expect(out.issues.some((i: any) => i.code.startsWith('AXE_') || i.code.startsWith('A11Y_'))).toBe(false);
    expect(out.suites.accessibility.status).toBe('errors');
    const plain = await json('POST', '/api/v1/validate', { projectId: eob.projectId, recordId: 'EOB-0002', suites: ['accessibility'], verapdf: true });
    expect(plain.pdfAccessibility.studio.summary.failed).toBe(0);
    expect(['not-installed', 'ran', 'error', 'timeout']).toContain(plain.pdfAccessibility.verapdf.status);
  });

  it('says whether veraPDF is installed', async () => {
    const s = await json('GET', '/api/v1/pdf-accessibility/verapdf');
    expect(typeof s.installed).toBe('boolean');
  });

  it('records the level reached for a release on demand, and shows the latest', async () => {
    const created = createRelease(ctx.store, ctx.store.getProject(eob.projectId)!, { approvedBy: { id: null, name: 'Test' }, approvedAt: new Date().toISOString(), createdBy: { id: null, name: 'Test' }, origin: 'manual' });
    const id = created.release.id;
    expect((await json('GET', `/api/v1/releases/${id}/pdf-accessibility`)).record).toBeNull();
    const made = (await json('POST', `/api/v1/releases/${id}/pdf-accessibility`)).record;
    expect(made).toMatchObject({ releaseId: id, recordId: 'EOB-0001', studio: { summary: { failed: 0, ran: 11 } } });
    expect(['studio', 'verapdf']).toContain(made.level);
    expect(made.levelLabel).toBe(made.level === 'verapdf' ? 'Validated by veraPDF' : 'Checked by the studio');
    expect((await json('GET', `/api/v1/releases/${id}/pdf-accessibility`)).record).toEqual(made);
  });
});
