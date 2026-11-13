import { inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { seedProjects, RECORDS, EXPECTED_SCENARIOS } from '../../model/src/fixtures';
import { applyCommand, richFromMarkup, type Command, type Project } from '@iss/model';
import { resolve } from '@iss/resolver';
import { blockerKindOf, fixImpact, proposeFixes } from '@iss/scenarios';
import {
  afpSimulation, checkChannelParity, compareManifests, pageDesignFindings, PAGINATOR_JS, PAGINATOR_JS_V2, renderEmail, renderInteractiveHtml, renderPagedDocument, renderSms,
  usesPageDesign, type ExtractedManifest,
} from '@iss/renderers';
import { Composer, countPdfPages } from '../../../apps/api/src/composer';

/**
 * Page design (roadmap wave 2) on REAL composed pages: the page source goes through headless Chromium exactly as the
 * studio's PDF export does (apps/api/src/composer.ts), and the checks read the composer's page tree, the composed DOM
 * and the PDF bytes.
 */

const composer = new Composer();
afterAll(() => composer.close());

const [card, eob] = seedProjects();
const rec = (id: string) => RECORDS.find((r) => r.recordId === id)!;
const stress = EXPECTED_SCENARIOS['card-250-rows'].overrides;
const run = (p: Project, ...cmds: Command[]) => cmds.reduce((acc, c) => { const r = applyCommand(acc, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; }, p);
const design = (patch: Extract<Command, { type: 'SET_PAGE_DESIGN' }>['patch']): Command => ({ type: 'SET_PAGE_DESIGN', patch });
const layout = (nodeId: string, l: Record<string, unknown>): Command => ({ type: 'SET_LAYOUT', nodeId, profile: 'paged', layout: l });

async function compose(p: Project, recordId = 'CARD-0001', overrides: Record<string, unknown> = {}, opts: { pdf?: boolean; force?: boolean } = {}) {
  const res = resolve({ project: p, record: rec(recordId), overrides });
  const html = renderPagedDocument(res, p, { profileId: 'paged-pdf', watermark: '', forceDesignEngine: opts.force });
  const comp = await composer.composePaged(html, { pdf: opts.pdf, snapshot: true });
  return { res, html, comp, metrics: comp.metrics as any, pages: comp.snapshot!.pages };
}

/** Runs `fn` in the browser on the composed page (for checks on the laid-out DOM: lines, columns, order). */
async function inPage<T>(html: string, fn: () => T): Promise<T> {
  const browser = await composer.getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 }, offline: true });
  try {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-composed') === '1');
    return await page.evaluate(fn);
  } finally { await ctx.close(); }
}
/** The decompressed streams of a PDF (content streams among them). */
const pdfStreams = (pdf: Buffer): string[] => {
  const s = pdf.toString('latin1'), out: string[] = [];
  const re = /stream\r?\n/g; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) { const start = m.index + m[0].length; try { out.push(inflateSync(pdf.subarray(start, s.indexOf('endstream', start))).toString('latin1')); } catch { /* not compressed content */ } }
  return out;
};
const mediaBox = (pdf: Buffer) => { const m = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString('latin1')); return [Number(m![1]), Number(m![2])]; };
const pageShape = (m: any) => m.pages.map((p: any) => ({ nodeIds: p.nodeIds, fixedNodeIds: p.fixedNodeIds, tables: p.tables, flowTopPt: p.flowTopPt, flowBottomPt: p.flowBottomPt, usedPt: p.usedPt }));
const strip = ({ text: _t, ...rest }: ExtractedManifest) => rest;

describe('existing documents compose exactly as before', () => {
  it('the sample documents keep the original page source and composer', () => {
    for (const [p, id] of [[card, 'CARD-0001'], [eob, 'EOB-0002']] as const) {
      const res = resolve({ project: p, record: rec(id) });
      expect(usesPageDesign(res, p)).toBe(false);
      const html = renderPagedDocument(res, p);
      expect(html).toContain(PAGINATOR_JS);
      expect(html).not.toContain(PAGINATOR_JS_V2);
      expect(html).toContain('data-renderer="iss-paged-renderer/1.0.0"');
      expect(html).toContain('@page{size:8.5in 11in;margin:0}');
      expect(html).toContain('.page{width:612pt;height:792pt;');
      expect(html).toContain('"firstPageTopPt":184,"otherPagesTopPt":84,"bottomPt":738,"leftPt":40,"widthPt":532');
    }
  });

  it('the page-design composer gives the same pages and content for the sample documents (page count, page tree, extracted facts and text)', async () => {
    const cases: Array<[Project, string, Record<string, unknown>]> = [[card, 'CARD-0001', {}], [card, 'CARD-0007', {}], [card, 'CARD-0001', stress], [eob, 'EOB-0002', {}], [eob, 'EOB-0011', {}]];
    for (const [p, id, ov] of cases) {
      const a = await compose(p, id, ov);
      const b = await compose(p, id, ov, { force: true });
      expect(a.metrics.engine).toBe('iss-paged-composer/1');
      expect(b.metrics.engine).toBe('iss-paged-composer/2');
      expect(b.metrics.pageCount).toBe(a.metrics.pageCount);
      expect(pageShape(b.metrics)).toEqual(pageShape(a.metrics));
      expect(b.metrics.diagnostics).toEqual(a.metrics.diagnostics);
      expect(strip(b.comp.extracted)).toEqual(strip(a.comp.extracted));
      expect(b.comp.extracted.text).toBe(a.comp.extracted.text);
    }
  });
});

describe('paper', () => {
  it('A4 and US Legal reach the composer and the PDF page size; landscape swaps them', async () => {
    const a4 = await compose(run(card, design({ paper: 'A4' })), 'CARD-0001', {}, { pdf: true });
    const [w, h] = mediaBox(a4.comp.pdf!);
    expect(w).toBeCloseTo(595.3, 0);
    expect(h).toBeCloseTo(841.9, 0);
    expect(a4.metrics.page).toEqual({ widthPt: 595.28, heightPt: 841.89 });
    expect(countPdfPages(a4.comp.pdf!)).toBe(a4.metrics.pageCount);

    const land = await compose(run(card, design({ paper: 'A4', orientation: 'landscape' })), 'CARD-0001', {}, { pdf: true });
    const [lw, lh] = mediaBox(land.comp.pdf!);
    expect(lw).toBeGreaterThan(lh);
    expect(countPdfPages(land.comp.pdf!)).toBe(land.metrics.pageCount);
    expect(land.metrics.diagnostics.filter((d: any) => d.code === 'FIXED_OFF_PAGE')).toEqual([]);

    const legal = await compose(run(card, design({ paper: 'US-Legal' })), 'CARD-0001', stress, { pdf: true });
    expect(mediaBox(legal.comp.pdf!)).toEqual([612, 1008]);
    // Taller pages hold more rows: fewer pages than Letter.
    const letter = await compose(card, 'CARD-0001', stress);
    expect(legal.metrics.pageCount).toBeLessThan(letter.metrics.pageCount);
  });
});

describe('page templates', () => {
  it('each page takes its flow area from its template', async () => {
    const p = run(card, design({ pageTemplates: { first: { flowArea: { xPt: 60, yPt: 200, wPt: 492, hPt: 500 } }, following: { flowArea: { xPt: 50, yPt: 100, wPt: 512, hPt: 600 } } } }));
    const { metrics, pages } = await compose(p, 'CARD-0001', stress);
    expect(metrics.pages[0]).toMatchObject({ template: 'first', flowTopPt: 200, flowBottomPt: 700 });
    expect(metrics.pages[1]).toMatchObject({ template: 'following', flowTopPt: 100, flowBottomPt: 700 });
    expect(pages[0]).toContain('left: 60pt; top: 200pt; width: 492pt; height: 500pt;');
    expect(pages[1]).toContain('left: 50pt; top: 100pt; width: 512pt; height: 600pt;');
    // No more than the area holds.
    for (const pg of metrics.pages) expect(pg.usedPt).toBeLessThanOrEqual(pg.flowBottomPt - pg.flowTopPt + 0.5);
  });

  it('the Last page template: its own flow area and fixed items, on the last page only', async () => {
    const slip = { id: 'payment-slip', type: 'rich-text' as const, name: 'Payment slip', content: richFromMarkup('## Payment slip\nReturn this part with your payment.'), layout: { paged: { mode: 'fixed' as const, xPt: 40, yPt: 600, wPt: 532, hPt: 120, pages: 'last' as const } } };
    const p = run(card, design({ pageTemplates: { last: { flowArea: { xPt: 40, yPt: 84, wPt: 532, hPt: 470 } } } }), { type: 'INSERT_NODE', parentId: 'doc-root', node: slip });
    const long = await compose(p, 'CARD-0001', stress);
    const n = long.metrics.pageCount;
    expect(long.metrics.pages.map((x: any) => x.template)).toEqual(['first', ...Array(n - 2).fill('following'), 'last']);
    expect(long.metrics.pages[n - 1]).toMatchObject({ flowTopPt: 84, flowBottomPt: 554 });
    expect(long.metrics.pages.filter((x: any) => x.fixedNodeIds.includes('payment-slip')).map((x: any) => x.index)).toEqual([n]);
    expect(long.metrics.pages[n - 1].usedPt).toBeLessThanOrEqual(470.5);
    // Every row is placed exactly once.
    expect(long.metrics.pages.reduce((s: number, x: any) => s + (x.tables['transaction-table']?.rows ?? 0), 0)).toBe(250);
    expect(long.comp.extracted.tableRows['transaction-table']).toBe(250);
    // A short document: page 1 is first and last; the slip is on it and the flow area stops above it.
    const short = await compose(p, 'CARD-0001', { card: { transactions: [] } });
    if (short.metrics.pageCount === 1) {
      expect(short.metrics.pages[0]).toMatchObject({ template: 'first+last', flowTopPt: 184, flowBottomPt: 554 });
      expect(short.metrics.pages[0].fixedNodeIds).toEqual(expect.arrayContaining(['issuer-logo', 'payment-slip']));
    } else {
      expect(short.metrics.pages.at(-1)!.template).toBe('last');
    }
  });
});

describe('backgrounds are decoration', () => {
  const p = run(card, design({ pageTemplates: { first: { background: { kind: 'tint', color: '#DBE64C', opacityPct: 25 } }, following: { background: { kind: 'image', image: 'asset:aster-mark', fit: 'contain', opacityPct: 10 } } } }));

  it('on every page, hidden from assistive technology, never a node, never in the semantic facts', async () => {
    const withBg = await compose(p, 'CARD-0001', stress, { pdf: true });
    const without = await compose(run(card, design({ pageTemplates: { first: { columns: 1, flowArea: { xPt: 40, yPt: 184, wPt: 532, hPt: 554 } } } })), 'CARD-0001', stress);
    expect(withBg.html).toContain('.iss-bg--0{background:#DBE64C;opacity:0.25}');
    expect(withBg.html).toMatch(/\.iss-bg--1\{background-image:url\("data:image\/svg\+xml;base64,/);
    for (const [i, html] of withBg.pages.entries()) {
      expect(html).toContain(`<div class="iss-bg iss-bg--${i === 0 ? 0 : 1}" aria-hidden="true"></div>`);
      expect(/<div class="iss-bg[^>]*data-node-id/.test(html)).toBe(false);
    }
    // The same facts, the same text and the same pages as without a background.
    expect(strip(withBg.comp.extracted)).toEqual(strip(without.comp.extracted));
    expect(withBg.comp.extracted.text).toBe(without.comp.extracted.text);
    expect(withBg.metrics.pageCount).toBe(without.metrics.pageCount);
    expect(compareManifests(withBg.res.semanticManifest, withBg.comp.extracted).ok).toBe(true);
    // Tagged PDF: the background (painted first on the page) is drawn outside every marked-content sequence, so it is
    // not in the structure tree and is not read out.
    const depthAtFirstDraw = (pdf: Buffer) => {
      const content = pdfStreams(pdf).find((x) => /BDC/.test(x))!;
      const at = content.search(/\/\w+ Do\b/);
      const before = content.slice(0, at);
      return (before.match(/\bBDC\b|\bBMC\b/g) ?? []).length - (before.match(/\bEMC\b/g) ?? []).length;
    };
    expect(withBg.comp.pdf!.toString('latin1')).toContain('/StructTreeRoot');
    expect(depthAtFirstDraw(withBg.comp.pdf!)).toBe(0);
    // The logo, which is content, is still tagged as a figure.
    expect(pdfStreams(withBg.comp.pdf!).find((x) => /BDC/.test(x))).toMatch(/\/Figure\s*<</);
    // Without a background nothing is drawn as an image before the first tag.
    expect(pdfStreams((await compose(card, 'CARD-0001', {}, { pdf: true })).comp.pdf!).find((x) => /BDC/.test(x))!.search(/\/\w+ Do\b/)).toBe(-1);
  });

  it('never in the web page, email or SMS', () => {
    const res = resolve({ project: p, record: rec('CARD-0001') });
    const web = renderInteractiveHtml(res, p), email = renderEmail(res, p), sms = renderSms(res, p);
    for (const out of [web, email.html, email.text, sms.text]) {
      expect(out).not.toContain('iss-bg');
      expect(out).not.toContain('#DBE64C;opacity');
    }
    // The other outputs are exactly what they are without a page design.
    const base = resolve({ project: card, record: rec('CARD-0001') });
    // Apart from the run id, the content digest and the model version (the project changed), identical.
    const norm = (s: string, r: typeof res) => s.split(r.runId).join('RUN').split(r.contentDigest).join('DIGEST').replace(/model v\d+/g, 'model v').replace(/"modelVersion":\d+/g, '').replace(/\b[0-9a-f]{12,}\b/g, 'HASH');
    expect(norm(web, res)).toBe(norm(renderInteractiveHtml(base, card), base));
    expect(norm(email.html, res)).toBe(norm(renderEmail(base, card).html, base));
    expect(sms.text).toBe(renderSms(base, card).text);
    expect(checkChannelParity(res, email, sms)).toEqual(checkChannelParity(base, renderEmail(base, card), renderSms(base, card)));
  });

  it('an image that is not from the image library is left out', () => {
    const bad = structuredClone(p);
    bad.presentationProfiles.find((x) => x.id === 'paged-pdf')!.pageTemplates!.first!.background = { kind: 'image', image: 'https://example.com/x.png', opacityPct: 50 };
    const html = renderPagedDocument(resolve({ project: bad, record: rec('CARD-0001') }), bad);
    expect(html).not.toContain('example.com/x.png');
    expect(pageDesignFindings(bad).map((f) => f.code)).toContain('PAGE_DESIGN_INVALID');
  });
});

describe('columns', () => {
  it('fill column by column, then page by page; tables continue in columns with their headers', async () => {
    const p = run(card, design({ pageTemplates: { following: { columns: 3, columnGapPt: 12 } } }));
    const { metrics, html } = await compose(p, 'CARD-0001', stress);
    expect(metrics.pages[1]).toMatchObject({ template: 'following', columns: 3 });
    expect(metrics.pages.reduce((s: number, x: any) => s + (x.tables['transaction-table']?.rows ?? 0), 0)).toBe(250);
    const order = await inPage(html, () => {
      const out: Array<{ page: number; col: number; first: string; last: string; caption: string; header: boolean; left: number }> = [];
      document.querySelectorAll('.page').forEach((pg) => pg.querySelectorAll('.iss-col').forEach((c) => {
        const rows = c.querySelectorAll('tr[data-row-id]');
        if (!rows.length) return;
        out.push({ page: Number(pg.getAttribute('data-page')), col: Number(c.getAttribute('data-column')), first: rows[0].getAttribute('data-row-id')!, last: rows[rows.length - 1].getAttribute('data-row-id')!,
          caption: c.querySelector('.iss-table-caption')!.textContent!, header: !!c.querySelector('thead'), left: c.getBoundingClientRect().left });
      }));
      return out;
    });
    // Columns sit side by side, left to right, and rows run in order through them.
    const page2 = order.filter((o) => o.page === 2);
    expect(page2.map((o) => o.col)).toEqual([1, 2, 3]);
    expect(page2[0].left).toBeLessThan(page2[1].left);
    expect(page2[1].left).toBeLessThan(page2[2].left);
    const ids = order.flatMap((o) => [o.first, o.last]);
    expect([...ids].sort()).toEqual(ids);
    expect(page2.every((o) => /\(continued\)$/.test(o.caption))).toBe(true);
    // The card table repeats its header only when hinted; continuation keeps the same rule in a column as on a page.
    expect(new Set(order.map((o) => o.header)).size).toBe(1);
  });

  it('a component can span all columns; the columns below start under it', async () => {
    const p = run(card, design({ pageTemplates: { first: { columns: 2 }, following: { columns: 2 } } }), layout('transaction-table', { spanColumns: true }), layout('greeting', { spanColumns: true }));
    const { metrics, html } = await compose(p, 'CARD-0001', stress);
    expect(metrics.pages.reduce((s: number, x: any) => s + (x.tables['transaction-table']?.rows ?? 0), 0)).toBe(250);
    const geo = await inPage(html, () => {
      const pg = document.querySelector('.page[data-page="1"]')!;
      const greeting = pg.querySelector('.iss-span [data-node-id="greeting"]')!;
      const span = { width: greeting.closest('.iss-span')!.getBoundingClientRect().width, bottom: greeting.getBoundingClientRect().bottom };
      const col = pg.querySelector('.iss-col')!.getBoundingClientRect();
      const flow = pg.querySelector('.iss-flow')!.getBoundingClientRect();
      const tableSpan = document.querySelector('.page[data-page="2"] .iss-span table');
      return { spanW: span.width, flowW: flow.width, colTop: col.top, spanBottom: span.bottom, colW: col.width, tableSpans: !!tableSpan };
    });
    expect(geo.spanW).toBeCloseTo(geo.flowW, 0);
    expect(geo.colW).toBeLessThan(geo.flowW / 2);
    expect(geo.colTop).toBeGreaterThanOrEqual(geo.spanBottom - 0.5);
    expect(geo.tableSpans).toBe(true);
  });
});

describe('keeping things together', () => {
  it('keep together moves a component whole to the next page; a new page and a new column start where asked', async () => {
    const base = await compose(card);
    const where = (m: any, id: string) => m.pages.filter((x: any) => x.nodeIds.includes(id)).map((x: any) => x.index);
    expect(where(base.metrics, 'spend-chart')).toEqual([1]);
    const p = run(card, layout('spend-chart', { breakBefore: 'page' }));
    const moved = await compose(p);
    expect(where(moved.metrics, 'spend-chart')).toEqual([2]);
    expect(moved.metrics.pages[1].nodeIds[0]).toBe('spend-chart');
    // The table that follows was split over pages 1–2; kept together it goes whole to page 2.
    expect(where(base.metrics, 'transaction-table')).toEqual([1, 2]);
    const kept = await compose(run(card, layout('transaction-table', { keepTogether: true })));
    expect(where(kept.metrics, 'transaction-table')).toEqual([2]);
    expect(kept.metrics.pages[1].tables['transaction-table']).toMatchObject({ rows: 12, continued: false });
    expect(kept.metrics.diagnostics).toEqual([]);
    // New column: in a two-column flow area the component starts at the top of the next column.
    const col = await compose(run(card, design({ pageTemplates: { first: { columns: 2 } } }), layout('payment-guidance', { breakBefore: 'column' })));
    const colOf = await inPage(col.html, () => document.querySelector('.page[data-page="1"] [data-node-id="payment-guidance"]')!.closest('.iss-col')!.getAttribute('data-column'));
    expect(colOf).toBe('2');
  });

  it('a component that cannot fit an empty flow area while kept together is a blocker that names it, with a fix', async () => {
    const p = run(card, layout('transaction-table', { keepTogether: true }));
    const { metrics } = await compose(p, 'CARD-0001', stress);
    const d = metrics.diagnostics.find((x: any) => x.code === 'KEEP_TOGETHER_CANNOT_FIT');
    expect(d).toMatchObject({ severity: 'blocking', nodeId: 'transaction-table' });
    expect(d.message).toContain('transaction-table');
    // Nothing is lost: the table is then placed as usual, every row once.
    expect(metrics.pages.reduce((s: number, x: any) => s + (x.tables['transaction-table']?.rows ?? 0), 0)).toBe(250);
    // The same paths as the other layout findings: kind, plain words and a fix with its effect.
    const finding = { code: d.code, severity: d.severity, nodeId: d.nodeId, page: d.page, message: d.message, source: 'composer' as const };
    expect(blockerKindOf(finding)).toBe('layout');
    const fixes = proposeFixes(p, finding, { records: RECORDS });
    expect(fixes.map((f) => f.kind)).toEqual(['change', 'link']);
    expect(fixes[0].commands).toEqual([{ type: 'SET_LAYOUT', nodeId: 'transaction-table', profile: 'paged', layout: { keepTogether: false } }]);
    expect(fixes[0].risk).toBe('review');
    const impact = fixImpact(p, fixes[0], RECORDS, { finding });
    expect(impact).toMatchObject({ resolves: true, newlyBlocked: [] });
    expect(impact.summary).toMatch(/page layout is confirmed when the pages are composed again/);
    // Applied, the pages compose without the blocker.
    const fixed = run(p, ...fixes[0].commands!);
    expect((await compose(fixed, 'CARD-0001', stress)).metrics.diagnostics).toEqual([]);
  });

  it('text splits by lines, leaving and carrying at least the lines asked for (orphans and widows), without losing or repeating words', async () => {
    const para = (i: number) => `Paragraph ${i}. ` + 'This sentence belongs to a long explanation written to fill several lines so that it must split between columns and pages. '.repeat(3);
    const text = Array.from({ length: 14 }, (_, i) => para(i + 1)).join('\n\n');
    const node = { id: 'long-text', type: 'rich-text' as const, name: 'Long text', content: richFromMarkup(text), layout: { paged: { mode: 'flow' as const, splitText: true, minLinesLeft: 2, minLinesCarried: 3 } } };
    const p = run(card, design({ pageTemplates: { first: { columns: 2 }, following: { columns: 2 } } }), { type: 'INSERT_NODE', parentId: 'doc-root', index: 9, node });
    const { html, comp } = await compose(p);
    for (let i = 1; i <= 14; i++) expect(comp.extracted.text!.split(`Paragraph ${i}.`).length - 1).toBe(1);
    const parts = await inPage(html, () => Array.from(document.querySelectorAll('[data-node-id="long-text"]')).map((el) => {
      // Lines of the paragraph that is split at the end of this part and at the start of the next.
      const lines = (p: Element | null) => { if (!p) return 0; const r = document.createRange(); r.selectNodeContents(p); const tops = new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top))); return tops.size; };
      const ps = el.querySelectorAll('p');
      return { continues: el.getAttribute('data-continues') === '1', continued: el.getAttribute('data-continued') === '1', firstLines: lines(ps[0]), lastLines: lines(ps[ps.length - 1]), lastText: ps[ps.length - 1]?.textContent ?? '', firstText: ps[0]?.textContent ?? '' };
    }));
    expect(parts.length).toBeGreaterThan(1);
    for (let i = 0; i + 1 < parts.length; i++) {
      expect(parts[i].continues).toBe(true);
      expect(parts[i + 1].continued).toBe(true);
      // A paragraph split across the break keeps ≥ 2 lines behind and carries ≥ 3 over.
      if (!/^Paragraph \d+\./.test(parts[i + 1].firstText)) {
        expect(parts[i].lastLines).toBeGreaterThanOrEqual(2);
        expect(parts[i + 1].firstLines).toBeGreaterThanOrEqual(3);
      }
    }
    // Without the setting the text moves whole, as before.
    const whole = await compose(run(p, layout('long-text', { splitText: false })));
    expect(whole.metrics.diagnostics.map((d: any) => d.code)).toContain('BLOCK_OVERFLOW');
  });
});

describe('downstream', () => {
  it('the AFP simulation follows the page design', async () => {
    const p = run(card, design({ paper: 'A4', orientation: 'landscape', pageTemplates: { following: { columns: 2 }, last: {} } }));
    const { res, metrics } = await compose(p);
    const sim = afpSimulation(res, p, metrics);
    expect(sim.media).toMatchObject({ paper: 'A4', orientation: 'landscape', widthPt: 841.89, heightPt: 595.28 });
    expect(sim.pagedef).toBe('P1A4L01 (conceptual)');
    expect(sim.continuationRegions.map((c: any) => [c.name, c.columns])).toEqual([['First page', 1], ['Following pages', 2], ['Last page', 1]]);
    expect(sim.pageSequence.at(-1)).toMatchObject({ template: expect.stringMatching(/last/) });
    // A document without page design keeps the simulation it had.
    const legacy = afpSimulation(resolve({ project: card, record: rec('CARD-0001') }), card, null);
    expect(legacy.media).toEqual({ paper: 'US-Letter', widthPt: 612, heightPt: 792, duplex: false, marginsMm: [14, 14, 14, 14] });
    expect(legacy.pagedef).toBe('P1LTR01 (conceptual)');
    expect(legacy.continuationRegions).toEqual([{ name: 'flow-region', firstPageTopPt: 184, otherPagesTopPt: 84, bottomPt: 738 }]);
  });

  it('static page checks: fixed items outside the page', () => {
    expect(pageDesignFindings(card)).toEqual([]);
    const p = structuredClone(run(card, design({ orientation: 'landscape' })));
    // A locked item does not move with the page edges.
    const q = structuredClone(card);
    q.nodes.find((n) => n.id === 'page-footer')!.locked = true;
    const r = run(q, design({ orientation: 'landscape' }));
    expect(pageDesignFindings(p)).toEqual([]);
    expect(pageDesignFindings(r)).toEqual([expect.objectContaining({ code: 'FIXED_OFF_PAGE', nodeId: 'page-footer', severity: 'warning' })]);
    const fixes = proposeFixes(r, pageDesignFindings(r)[0], { records: RECORDS });
    expect(fixes.map((f) => f.kind)).toEqual(['link']);
    expect(blockerKindOf(pageDesignFindings(r)[0])).toBe('layout');
  });
});
