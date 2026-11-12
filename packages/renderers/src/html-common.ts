import qrcode from 'qrcode-generator';
import type { Project } from '@iss/model';
import type { RBlock, RInline, RNode } from '@iss/resolver';
import { formatCents } from '@iss/resolver';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function inlinesHtml(inlines: RInline[] | undefined): string {
  return (inlines ?? []).map((i) => {
    if (i.kind === 'break') return '<br/>';
    let t = esc(i.text);
    if (i.kind === 'token') {
      const attrs = [`class="iss-token${i.missing ? ' iss-token--missing' : ''}"`, `data-path="${esc(i.path)}"`];
      if (i.cents !== undefined) attrs.push(`data-cents="${i.cents}"`);
      t = `<span ${attrs.join(' ')}>${t}</span>`;
    }
    if (i.bold) t = `<strong>${t}</strong>`;
    if (i.italic) t = `<em>${t}</em>`;
    if (i.href) t = `<a href="${esc(i.href)}" rel="noopener noreferrer">${t}</a>`;
    return t;
  }).join('');
}

export function blocksHtml(blocks: RBlock[] | undefined): string {
  return (blocks ?? []).map((b) => {
    if (b.kind === 'ul' || b.kind === 'ol') return `<${b.kind}>${(b.items ?? []).map((it) => `<li>${inlinesHtml(it)}</li>`).join('')}</${b.kind}>`;
    return `<${b.kind}>${inlinesHtml(b.inlines)}</${b.kind}>`;
  }).join('');
}

/* ------------------------------------------------- fictional issuer marks */

const MARKS: Record<string, (accent: string) => string> = {
  'aster-mark': (accent) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 80"><g transform="translate(40 40)" fill="${accent}">${[0, 45, 90, 135].map((a) => `<rect x="-4" y="-30" width="8" height="60" rx="4" transform="rotate(${a})"/>`).join('')}</g><text x="84" y="50" font-family="Arial, Liberation Sans, sans-serif" font-size="34" font-weight="800" fill="#0F172A">aster</text><text x="186" y="50" font-family="Arial, Liberation Sans, sans-serif" font-size="34" font-weight="400" fill="${accent}">card</text></svg>`,
  'harborcare-mark': (accent) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 80"><circle cx="40" cy="40" r="30" fill="${accent}"/><path d="M18 46c8-8 14-8 22 0s14 8 22 0" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round"/><path d="M40 16v18M31 25h18" stroke="#DBE64C" stroke-width="6" stroke-linecap="round"/><text x="84" y="50" font-family="Arial, Liberation Sans, sans-serif" font-size="32" font-weight="800" fill="#0F172A">Harbor</text><text x="200" y="50" font-family="Arial, Liberation Sans, sans-serif" font-size="32" font-weight="400" fill="${accent}">Care</text></svg>`,
};

export function imageSrc(src: string, accent: string): string | null {
  if (src.startsWith('asset:')) {
    const m = MARKS[src.slice(6)];
    return m ? 'data:image/svg+xml;base64,' + toBase64(m(accent)) : null;
  }
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(src) && src.length < 400_000) return src;
  return null;
}

function toBase64(s: string): string {
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
  // eslint-disable-next-line no-undef
  return (globalThis as any).Buffer.from(s, 'utf8').toString('base64');
}

export function qrSvg(url: string, sizePt = 72): string {
  if (!url) return '';
  const q = qrcode(0, 'M');
  q.addData(url);
  q.make();
  const n = q.getModuleCount();
  const quiet = 2;
  const cells: string[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) cells.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
  const dim = n + quiet * 2;
  return `<svg class="iss-qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${sizePt}pt" height="${sizePt}pt" role="img" aria-label="QR code for ${esc(url)}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${cells.join('')}" fill="#0F172A"/></svg>`;
}

const CHART_COLORS = ['#277656', '#4EAF60', '#80D100', '#1D5941', '#94A3B8', '#DBE64C'];

export function chartSvg(node: RNode, interactive: boolean): string {
  const ch = node.chart!;
  if (!ch.data.length) return `<p class="iss-chart-empty">${esc(ch.summary)}</p>`;
  if (ch.kind === 'donut') {
    const total = ch.data.reduce((s, d) => s + d.value, 0) || 1;
    let acc = 0;
    const R = 40, C = 2 * Math.PI * R;
    const arcs = ch.data.map((d, i) => {
      const frac = d.value / total;
      const seg = `<circle r="${R}" cx="60" cy="60" fill="none" stroke="${CHART_COLORS[i % CHART_COLORS.length]}" stroke-width="22" stroke-dasharray="${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}" stroke-dashoffset="${(-acc * C).toFixed(2)}" transform="rotate(-90 60 60)" data-label="${esc(d.label)}" data-display="${esc(d.display)}" tabindex="${interactive ? 0 : -1}"><title>${esc(d.label)}: ${esc(d.display)}</title></circle>`;
      acc += frac;
      return seg;
    }).join('');
    const legend = ch.data.map((d, i) => `<li><span class="sw" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>${esc(d.label)} <strong>${esc(d.display)}</strong></li>`).join('');
    return `<div class="iss-chart iss-chart--donut"><svg viewBox="0 0 120 120" role="img" aria-label="${esc(ch.summary)}">${arcs}</svg><ul class="iss-legend">${legend}</ul></div>`;
  }
  const max = Math.max(...ch.data.map((d) => d.value), 1);
  const rowH = 18;
  const bars = ch.data.map((d, i) => {
    const w = Math.max(2, Math.round((d.value / max) * 150));
    return `<g transform="translate(0 ${i * rowH})"><text x="0" y="12" font-size="9" fill="#334155">${esc(d.label.length > 22 ? d.label.slice(0, 21) + '…' : d.label)}</text><rect x="110" y="3" width="${w}" height="11" rx="2" fill="${CHART_COLORS[i % CHART_COLORS.length]}" data-label="${esc(d.label)}" data-display="${esc(d.display)}" tabindex="${interactive ? 0 : -1}"><title>${esc(d.label)}: ${esc(d.display)}</title></rect><text x="${116 + w}" y="12" font-size="9" fill="#0F172A" font-weight="600">${esc(d.display)}</text></g>`;
  }).join('');
  return `<div class="iss-chart iss-chart--bar"><svg viewBox="0 0 330 ${ch.data.length * rowH + 4}" role="img" aria-label="${esc(ch.summary)}">${bars}</svg></div>`;
}

export interface RenderMode {
  target: 'paged' | 'html';
  project: Project;
}

/** Common semantic markup for one node (without the outer flow/fixed positioning wrapper). */
export function nodeInnerHtml(n: RNode, mode: RenderMode, renderChild: (c: RNode) => string): string {
  const accent = mode.project.issuer?.accent ?? '#277656';
  switch (n.type) {
    case 'container': {
      const dir = mode.target === 'paged' ? n.layout?.paged?.direction : n.layout?.html?.direction;
      return `<div class="iss-container${dir === 'row' ? ' iss-row' : ''}">${n.children.filter((c) => c.visible).map(renderChild).join('')}</div>`;
    }
    case 'rich-text':
      return `<div class="iss-rich">${blocksHtml(n.text)}</div>`;
    case 'summary-metric': {
      const f = n.field!;
      return `<div class="iss-metric iss-metric--${f.importance ?? 'secondary'}${f.guarded ? ' iss-metric--guarded' : ''}"><div class="iss-metric-label">${esc(f.label)}</div><div class="iss-metric-value"${f.cents !== undefined ? ` data-cents="${f.cents}"` : ''}>${esc(f.display)}</div></div>`;
    }
    case 'bound-field': {
      const f = n.field!;
      return `<div class="iss-field${f.missing ? ' iss-field--missing' : ''}"><span class="iss-field-label">${esc(f.label)}</span> <span class="iss-field-value" data-path="${esc(f.path)}"${f.cents !== undefined ? ` data-cents="${f.cents}"` : ''}>${esc(f.display)}</span></div>`;
    }
    case 'variant-set':
    case 'conditional-region': {
      const v = n.variants;
      if (v?.unresolved) return `<div class="iss-unresolved" role="alert">Unresolved variant: blocking rule conflict — no outcome is shown.</div>`;
      const sel = v?.items.filter((x) => x.selected) ?? [];
      const banner = n.type === 'variant-set' ? ' iss-variant--guidance' : '';
      const title = sel.map((x) => esc(x.title)).join(' · ');
      const body = n.text?.length ? blocksHtml(n.text) : '';
      const missingLoc = sel.some((x) => x.missingLocale) ? `<p class="iss-locale-missing">[Approved translation missing — English approved text shown]</p>` : '';
      return `<section class="iss-variant${banner}" aria-label="${title}"><h2 class="iss-variant-title">${title}</h2>${body}${missingLoc}</section>`;
    }
    case 'disclosure': {
      const d = n.disclosure!;
      const isBanner = d.contentPartId === 'not-a-bill-banner';
      return `<aside class="iss-disclosure${isBanner ? ' iss-banner' : ''}" role="note" aria-label="${esc(d.title)}">${isBanner ? '' : `<h3>${esc(d.title)}</h3>`}${blocksHtml(n.text)}<span class="iss-version">${esc(d.contentPartId)} v${d.version}</span></aside>`;
    }
    case 'action-link': {
      const a = n.action!;
      if (mode.target === 'paged') return `<div class="iss-action iss-action--print"><strong>${esc(a.label)}:</strong> ${esc(a.fallbackText)}</div>`;
      return `<div class="iss-action">${a.url ? `<a class="iss-button" href="${esc(a.url)}" rel="noopener noreferrer" target="_blank">${esc(a.label)}</a>` : ''}${!a.interactive ? `<p class="iss-fallback">${esc(a.fallbackText)}</p>` : ''}</div>`;
    }
    case 'qr-code': {
      const q = n.qr!;
      return `<figure class="iss-qrblock">${qrSvg(q.url, mode.target === 'paged' ? 64 : 96)}<figcaption>${esc(q.caption)}<br/><span class="iss-url">${esc(q.url.replace(/^https:\/\//, ''))}</span></figcaption></figure>`;
    }
    case 'expandable-explanation': {
      const e = n.explanation!;
      if (mode.target === 'paged') return `<div class="iss-expl"><h3>${esc(e.title)}</h3><p>${esc(e.summary)}</p><p class="iss-expl-details">${esc(e.details)}</p></div>`;
      return `<details class="iss-expl"><summary><span class="iss-expl-title">${esc(e.title)}</span><span class="iss-expl-summary">${esc(e.summary)}</span></summary><p>${esc(e.details)}</p></details>`;
    }
    case 'chart':
      return `<figure class="iss-figure"><figcaption class="iss-chart-title">${esc(n.chart!.title)}</figcaption>${chartSvg(n, mode.target === 'html')}<p class="iss-sr">${esc(n.chart!.summary)}</p></figure>`;
    case 'image': {
      const src = imageSrc(n.image!.src, accent);
      return src ? `<img class="iss-img" src="${src}" alt="${esc(n.image!.alt)}" style="object-fit:${esc(n.image!.fit)}"/>` : `<div class="iss-img-missing">Image unavailable</div>`;
    }
    case 'shape': {
      const s = n.shape!;
      if (s.kind === 'line') return `<div class="iss-shape" aria-hidden="true" style="border-top:${s.strokeWidthPt ?? 1}pt solid ${esc(s.stroke ?? accent)};"></div>`;
      return `<div class="iss-shape iss-shape--rect" aria-hidden="true" style="height:100%;min-height:12pt;border:${s.strokeWidthPt ?? 1}pt solid ${esc(s.stroke ?? accent)};background:${esc(s.fill ?? 'transparent')};border-radius:${s.radiusPt ?? 0}pt"></div>`;
    }
    case 'header-footer': {
      const h = n.headerFooter!;
      return `<div class="iss-hf iss-hf--${esc(h.role)}">${inlinesHtml(h.inlines)}${h.role === 'page-footer' && mode.target === 'paged' ? '<span class="iss-page-number"></span>' : ''}</div>`;
    }
    case 'repeating-table':
      return tableHtml(n, mode);
  }
}

export function tableHtml(n: RNode, mode: RenderMode): string {
  const t = n.table!;
  const head = `<thead><tr>${t.columns.map((c) => `<th scope="col" class="${c.align === 'right' ? 'num' : ''}" data-key="${esc(c.key)}">${mode.target === 'html' && t.sortable ? `<button type="button" class="iss-sort" data-sort-key="${esc(c.key)}" aria-label="Sort by ${esc(c.label)}">${esc(c.label)}<span aria-hidden="true" class="iss-sort-ind"></span></button>` : esc(c.label)}</th>`).join('')}</tr></thead>`;
  const body = t.rows.map((r) => `<tr data-row-id="${esc(r.id)}">${t.columns.map((c) => {
    const cell = r.cells[c.key];
    const sortVal = cell?.cents ?? (typeof cell?.raw === 'number' ? cell.raw : cell?.raw ?? '');
    return `<td class="${c.align === 'right' ? 'num' : ''}${cell?.guarded ? ' guarded' : ''}" data-sort="${esc(sortVal)}"${cell?.cents !== undefined ? ` data-cents="${cell.cents}"` : ''}>${esc(cell?.display ?? '')}</td>`;
  }).join('')}</tr>`).join('');
  const empty = t.rows.length ? '' : `<tr class="iss-empty"><td colspan="${t.columns.length}">No items in this period.</td></tr>`;
  const amountCol = t.columns.findIndex((c) => c.key === 'amountCents' || c.key === 'billedCents');
  const foot = t.totalCents !== undefined && amountCol >= 0
    ? `<tfoot><tr><th scope="row" colspan="${amountCol}">Total ${esc(t.columns[amountCol].label.toLowerCase())} · ${t.rows.length} listed item${t.rows.length === 1 ? '' : 's'}</th><td class="num" data-table-total-cents="${t.totalCents}">${esc(formatCents(t.totalCents))}</td>${t.columns.length - amountCol - 1 > 0 ? `<td colspan="${t.columns.length - amountCol - 1}"></td>` : ''}</tr></tfoot>`
    : '';
  return `<div class="iss-table-wrap"><div class="iss-table-caption">${esc(t.caption)}</div><table class="iss-table" data-table-id="${esc(n.id)}">${head}<tbody>${body}${empty}</tbody>${foot}</table></div>`;
}

/** Data attributes carried by the outer wrapper of every rendered semantic node (lineage + parity facts). */
export function nodeDataAttrs(n: RNode): string {
  const a: string[] = [`data-node-id="${esc(n.id)}"`, `data-node-type="${esc(n.type)}"`];
  if (n.decorative) a.push('data-decorative="1"');
  if (n.required) a.push('data-required="1"');
  if (n.ruleIds.length) a.push(`data-rule-ids="${esc(n.ruleIds.join(' '))}"`);
  if (n.field?.cents !== undefined) a.push(`data-cents="${n.field.cents}"`);
  if (n.field?.guarded) a.push('data-guarded="1"');
  if (n.disclosure) a.push(`data-disclosure-hash="${esc(n.disclosure.contentHash)}" data-content-part="${esc(n.disclosure.contentPartId)}" data-version="${n.disclosure.version}"`);
  if (n.type === 'variant-set' && n.variants) a.push(`data-variant-set="${esc(n.id)}" data-selected-variant="${esc(n.variants.unresolved ? '' : n.variants.selected[0] ?? '')}"`);
  if (n.action?.url) a.push(`data-action-url="${esc(n.action.url)}"`);
  if (n.table) a.push(`data-table-rows="${n.table.rows.length}"${n.table.totalCents !== undefined ? ` data-table-total="${n.table.totalCents}"` : ''}`);
  return a.join(' ');
}

export const DOC_FONT = `Arial, "Liberation Sans", Helvetica, sans-serif`;
export const SCREEN_FONT = `Inter, Arial, "Liberation Sans", Helvetica, sans-serif`;
