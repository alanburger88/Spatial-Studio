import { describe, expect, it } from 'vitest';
import { seedProjects, RECORDS } from '../../model/src/fixtures';
import { resolve } from '@iss/resolver';
import { HTML_STRINGS, renderInteractiveHtml, renderPagedDocument, type HtmlStringKey } from '@iss/renderers';

const [card, eob] = seedProjects();
const rec = (id: string) => RECORDS.find((r) => r.recordId === id)!;
const html = (p: typeof card, id: string, strings?: Partial<Record<HtmlStringKey, string>>) => renderInteractiveHtml(resolve({ project: p, record: rec(id) }), p, strings ? { strings } : undefined);
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const bar = (h: string) => h.slice(h.indexOf('data-iss-bar'), h.indexOf('<div class="iss-shell">'));
const eobGuarded = RECORDS.filter((r) => r.documentType === 'eob').map((r) => ({ r, res: resolve({ project: eob, record: r }) })).find((x) => x.res.semanticManifest.guardedLiabilityNodeIds.length > 0);

describe('interactive HTML as a web experience', () => {
  it('credit statement: sticky bar with minimum payment, due date and https action; menu; collapsible sections', () => {
    const h = html(card, 'CARD-0001');
    expect(h).toContain('class="iss-bar"');
    const b = bar(h);
    expect(b).toContain('Minimum payment due');
    expect(b).toContain('$45.00');
    expect(b).toContain('due Nov 25, 2026');
    expect(b).toMatch(/<a class="iss-button iss-bar-action" href="https:\/\/example\.com\/aster\/payments"/);
    expect(b).toContain('aria-hidden="true"');
    expect(h).toContain('position:sticky');
    for (const id of ['summary', 'message', 'data', 'notices']) {
      expect(h).toContain(`href="#sec-${id}"`);
      expect(h).toContain(`id="sec-${id}"`);
    }
    expect(h).toContain('Transactions');
    expect(count(h, /<h1[ >]/g)).toBe(1);
    // collapsible sections use native details; summary and message start open
    expect(h).toMatch(/<details class="iss-secd" open data-default-open="1"><summary><h2 class="iss-sec-title" id="sec-summary-h">/);
    expect(h).toMatch(/id="sec-message-h"/);
    expect(h).toMatch(/<details class="iss-secd" open data-default-open="0"><summary><h2 class="iss-sec-title" id="sec-data-h">/);
  });

  it('required disclosures are never inside a collapsible section', () => {
    for (const [p, id] of [[card, 'CARD-0001'], [eob, 'EOB-0001']] as const) {
      const h = html(p, id);
      const notices = h.slice(h.indexOf('id="sec-notices"'));
      expect(notices.slice(0, 400)).not.toContain('<details class="iss-secd"');
      expect(h).toContain('<h2 class="iss-sec-title" id="sec-notices-h">');
      // every disclosure node sits outside any iss-secd block
      const secd = [...h.matchAll(/<details class="iss-secd"[\s\S]*?<\/details>/g)].map((m) => m[0]);
      for (const block of secd) expect(block).not.toContain('data-disclosure-hash');
    }
  });

  it('EOB: not a bill, member responsibility as the document shows it; guarded never a number', () => {
    const h = html(eob, 'EOB-0001');
    expect(bar(h)).toContain('This is not a bill');
    expect(bar(h)).toContain('$50.00');
    expect(h).toContain('href="#sec-data">Claims<');
    expect(h).toContain('THIS IS NOT A BILL.');
    expect(eobGuarded).toBeTruthy();
    const g = renderInteractiveHtml(eobGuarded!.res, eob);
    expect(bar(g)).toContain('under review');
    expect(bar(g)).not.toMatch(/\$\d/);
  });

  it('parity attributes are unchanged and the sticky bar adds none', () => {
    // counts taken from the renderer before this change (CARD-0001 and EOB-0001)
    const before = { card: { ids: 23, cents: 26, rows: 12 }, eob: { ids: 19, cents: 13, rows: 1 } };
    for (const [key, p, id] of [['card', card, 'CARD-0001'], ['eob', eob, 'EOB-0001']] as const) {
      const h = html(p, id);
      expect(count(h, /data-node-id="/g)).toBe(before[key].ids);
      expect(count(h, /data-cents="/g)).toBe(before[key].cents);
      expect(count(h, /data-row-id="/g)).toBe(before[key].rows);
      expect(count(h, /data-table-total-cents="/g)).toBe(1);
      const b = bar(h);
      expect(b).not.toContain('data-node-id');
      expect(b).not.toContain('data-cents');
      expect(b).not.toContain('data-action-url');
      const paged = renderPagedDocument(resolve({ project: p, record: rec(id) }), p);
      const ids = (s: string) => new Set([...s.matchAll(/data-node-id="([^"]+)"/g)].map((m) => m[1]));
      const hi = ids(h), pi = ids(paged);
      for (const x of hi) expect(pi.has(x)).toBe(true);
      expect(count(h, /data-disclosure-hash="/g)).toBe(count(paged.slice(0, paged.indexOf('<script')), /data-disclosure-hash="/g) || count(h, /data-disclosure-hash="/g));
    }
  });

  it('all rows stay in the DOM, interactive extras are script-only, charts have a data table', () => {
    const h = html(card, 'CARD-0002');
    expect(count(h, /<tr data-row-id=/g)).toBe(45);
    expect(h).not.toMatch(/<tr data-row-id="[^"]*" hidden/);
    expect(h).toContain('data-table-more="transaction-table"');
    expect(h).toContain('data-table-all="transaction-table"');
    expect(h).toContain('data-table-quick="transaction-table"');
    expect(h).toContain('data-cat-key="merchant"');
    expect(h).toContain('data-table-chip="transaction-table"');
    expect(h).toContain('aria-live="polite"');
    expect(h).toContain('html:not([data-js]) .iss-js-only{display:none !important}');
    expect(h).toContain('html:not([data-js]) .iss-chart-data[hidden]{display:table}');
    expect(h).toContain('id="chart-data-spend-chart"');
  });

  it('every fixed string can be overridden, including those used by the script', () => {
    const over: Partial<Record<HtmlStringKey, string>> = { tableShowMore: 'Mostrar más', tableFilterLabel: 'Filtrar', sectionSummary: 'Resumen', barDueOn: 'vence {date}', tableStatus: 'Mostrando {shown} de {total}', skipToContent: 'Ir al contenido', tableTotalMany: 'Total {label} · {count} partidas', chartShowData: 'Mostrar datos' };
    const h = html(card, 'CARD-0001', over);
    for (const t of ['Mostrar más', 'Filtrar', 'Resumen', 'vence Nov 25, 2026', 'Ir al contenido', 'partidas', 'Mostrar datos']) expect(h).toContain(t);
    expect(h).not.toContain('>Show more<');
    expect(h).not.toContain('>Skip to content<');
    const json = JSON.parse(h.match(/<script type="application\/json" id="iss-strings">([\s\S]*?)<\/script>/)![1]);
    expect(json.tableStatus).toBe('Mostrando {shown} de {total}');
    expect(json.tableShowAll).toBe(HTML_STRINGS.tableShowAll);
    // no English string literals from HTML_STRINGS hard-coded in the script
    const script = h.slice(h.lastIndexOf('<script>'));
    for (const k of ['tableShowMore', 'tableClearFilter', 'expandAll', 'tableStatus'] as HtmlStringKey[]) expect(script).not.toContain(HTML_STRINGS[k]);
  });

  it('defaults to English and keeps the document self-contained', () => {
    for (const [p, id] of [[card, 'CARD-0001'], [eob, 'EOB-0001']] as const) {
      const h = html(p, id);
      expect(h).toContain('Show more');
      expect(h).not.toMatch(/<script[^>]+src=/);
      expect(h).not.toMatch(/<link[^>]+href=/);
      expect(h).not.toMatch(/\beval\s*\(|new Function/);
      const urls = [...h.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]).filter((u) => !/^http:\/\/www\.w3\.org\/2000\/svg/.test(u));
      const own = new Set([...h.matchAll(/data-action-url="([^"]+)"/g)].map((m) => m[1]));
      for (const u of urls) expect(own.has(u) || /^https:\/\/example\.com\//.test(u)).toBe(true);
    }
  });

  it('brand kit still reaches the HTML', () => {
    const branded = { ...card, brand: { primary: '#123456', accent: '#abcdef', fontFamily: 'Georgia' } } as typeof card;
    expect(renderInteractiveHtml(resolve({ project: branded, record: rec('CARD-0001') }), branded)).toContain('--iss-brand-primary:#123456');
  });
});
