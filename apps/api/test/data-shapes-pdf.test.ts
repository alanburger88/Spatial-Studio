/**
 * Richer data shapes (wave 5, section 2) as real pages: the household statement repeats one section per account, each
 * with its own transactions table. Composed in Chromium: nothing is clipped, a long inner table continues over pages
 * with its headings repeated, the PDF and the web page carry the same facts, and the PDF passes the studio's
 * accessibility checks. `SHAPES_PDF_DIR` saves the PDFs for a person to look at.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildHousehold, householdCustomers } from '@iss/model/samples/index';
import { resolve } from '@iss/resolver';
import { compareManifests, renderInteractiveHtml, renderPagedDocument } from '@iss/renderers';
import { Composer } from '../src/composer';
import { checkDocumentPdf } from '../src/pdfAccessibility';

const composer = new Composer();
afterAll(() => composer.close());
const project = buildHousehold();
const customers = householdCustomers();
const byAccounts = (n: number, long = false) => customers.find((c) => (c.custom.accounts as unknown[]).length === n && (!long || (c.custom.accounts as Array<{ transactions: unknown[] }>).every((a) => a.transactions.length >= 30)))!;

describe('a repeating section on real pages', () => {
  it('a customer with four accounts of 36 to 40 transactions: every table continues with its headings, nothing is clipped, the PDF and the web page agree', async () => {
    const record = byAccounts(4, true);
    const res = resolve({ project, record });
    expect(res.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
    const out = await composer.composePaged(renderPagedDocument(res, project), { pdf: true });
    if (process.env.SHAPES_PDF_DIR) { mkdirSync(process.env.SHAPES_PDF_DIR, { recursive: true }); writeFileSync(`${process.env.SHAPES_PDF_DIR}/household-4-accounts.pdf`, out.pdf!); }
    expect(out.metrics.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(out.metrics.diagnostics.map((d) => d.code)).not.toContain('BLOCK_OVERFLOW');
    expect(out.metrics.pageCount).toBeGreaterThanOrEqual(4);
    expect(out.metrics.pdfPageCount).toBe(out.metrics.pageCount);
    // Each account's table: all of its rows placed, continued on a later page with the header repeated there.
    const ids = ['account-transactions', 'account-transactions~2', 'account-transactions~3', 'account-transactions~4'];
    const accounts = record.custom.accounts as Array<{ transactions: unknown[] }>;
    ids.forEach((id, i) => {
      const parts = out.metrics.pages.filter((p) => p.tables[id]).map((p) => p.tables[id]);
      expect(parts.reduce((s, t) => s + t.rows, 0), id).toBe(accounts[i].transactions.length);
      for (const t of parts.slice(1)) expect([t.continued, t.headerRepeated], id).toEqual([true, true]);
    });
    expect(ids.some((id) => out.metrics.pages.filter((p) => p.tables[id]).length > 1)).toBe(true);
    // The PDF and the web page carry the resolver's facts: every account's table, its rows, its subtotal.
    const html = await composer.inspectHtml(renderInteractiveHtml(res, project));
    const parity = compareManifests(res.semanticManifest, out.extracted, html.extracted);
    expect(parity.checks.filter((c) => c.status === 'mismatch').map((c) => c.id)).toEqual([]);
    expect(parity.ok).toBe(true);
    expect(Object.keys(res.semanticManifest.tableRows).sort()).toEqual([...ids].sort());
  }, 300_000);

  it('the PDF passes the studio’s accessibility checks for one, two and four accounts (headings, table headers on continued parts)', async () => {
    for (const record of [byAccounts(1), byAccounts(2), byAccounts(4, true)]) {
      const res = resolve({ project, record });
      const pdf = await checkDocumentPdf(composer, res, project);
      expect(pdf.studio.checks.filter((c) => c.status === 'failed').map((c) => `${c.id}: ${c.detail}`), record.recordId).toEqual([]);
      if (process.env.SHAPES_PDF_DIR) {
        const out = await composer.composePaged(renderPagedDocument(res, project), { pdf: true });
        writeFileSync(`${process.env.SHAPES_PDF_DIR}/household-${(record.custom.accounts as unknown[]).length}-accounts-${record.recordId}.pdf`, out.pdf!);
      }
    }
  }, 300_000);

  it('“start each item on a new page” puts each account after the first at the top of a page', async () => {
    const p = { ...project, nodes: project.nodes.map((n) => (n.id === 'accounts-section' ? { ...n, repeat: { ...n.repeat!, newPage: true } } : n)) };
    const record = byAccounts(3);
    const res = resolve({ project: p, record });
    const out = await composer.composePaged(renderPagedDocument(res, p), { pdf: true });
    for (const id of ['account-heading~2', 'account-heading~3']) {
      const page = out.metrics.pages.find((pg) => pg.nodeIds.includes(id))!;
      expect(page.nodeIds[0], id).toBe(id);
    }
    expect(out.metrics.diagnostics.map((d) => d.code)).not.toContain('BLOCK_OVERFLOW');
  }, 300_000);
});
