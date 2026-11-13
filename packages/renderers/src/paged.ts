import type { Project, ProfileId } from '@iss/model';
import { sysText } from '@iss/model';
import type { RNode, Resolution } from '@iss/resolver';
import { DOC_FONT, esc, projectStyleCss, nodeDataAttrs, nodeInnerHtml, type RenderMode } from './html-common';
import { PAGINATOR_JS } from './paginator-source';

export const PAGED_RENDERER_VERSION = 'iss-paged-renderer/1.0.0';

export function documentCss(accent: string, project?: Project): string {
  return `
:root{--ink:#0F172A;--body:#334155;--muted:#4B5A6E;--rule:#E2E8F0;--tint:#F1F5F9;--accent:${accent};--brand:#4EAF60;--lime:#DBE64C}
.iss-rich h1,.iss-rich h2{font-size:15pt;font-weight:800;color:var(--ink);margin:0 0 3pt;letter-spacing:-.01em}
.iss-rich h3{font-size:11.5pt;font-weight:700;color:var(--ink);margin:0 0 3pt}
.iss-rich h4{font-size:10pt;font-weight:700;margin:0 0 2pt}
.iss-rich p{margin:0 0 3pt}
.iss-rich ul,.iss-rich ol{margin:0 0 3pt 14pt;padding:0}
.iss-token--missing{background:#fde8e8;color:#9b1c1c;border-radius:2pt;padding:0 2pt}
.iss-container{display:block}
.iss-row{display:flex;gap:8pt;align-items:stretch}
.iss-row>*{flex:1 1 0;min-width:0}
.iss-metric{border:0.75pt solid var(--rule);border-radius:5pt;padding:6pt 8pt;background:#fff;height:100%;box-sizing:border-box}
.iss-metric--primary{border-color:var(--accent);background:linear-gradient(180deg,#fff, #f6fbf7)}
.iss-metric-label{font-size:7.5pt;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
.iss-metric-value{font-size:13pt;font-weight:800;color:var(--ink);margin-top:2pt;}
.iss-metric--secondary .iss-metric-value{font-size:10.5pt;font-weight:700}
.iss-metric--guarded .iss-metric-value{font-size:9pt;color:#92400e}
.iss-field{font-size:9.5pt}
.iss-row .iss-field{border:0.75pt solid var(--rule);border-radius:5pt;padding:6pt 8pt;height:100%;display:flex;flex-direction:column;gap:2pt}
.iss-row .iss-field-label{font-size:7.5pt;text-transform:uppercase;letter-spacing:.06em}
.iss-row .iss-field-value{font-size:10.5pt}.iss-field-label{color:var(--muted);font-weight:600}.iss-field-value{font-weight:700;color:var(--ink)}
.iss-variant{border-left:3pt solid var(--accent);background:var(--tint);padding:7pt 10pt;border-radius:0 5pt 5pt 0}
h2.iss-variant-title,.iss-variant-title{font-size:10.5pt;font-weight:700;color:var(--ink);margin:0 0 2pt;letter-spacing:0}
.iss-variant p{margin:0}
.iss-unresolved{border:1.5pt dashed #dc2626;color:#991b1b;padding:6pt 8pt;font-weight:700;border-radius:4pt}
.iss-locale-missing{color:#92400e;font-size:8pt;margin-top:3pt}
.iss-disclosure{border-top:0.75pt solid var(--rule);padding-top:5pt;font-size:7.5pt;color:var(--muted);position:relative}
.iss-disclosure h3,.iss-disclosure h4{font-size:8pt;margin:0 0 2pt;color:var(--body);text-transform:uppercase;letter-spacing:.05em}
.iss-disclosure p{margin:0}
.iss-version{font-size:6.5pt;color:#5B6B80;position:absolute;right:0;top:5pt}
.iss-banner{border:2pt solid var(--ink);background:var(--lime);color:var(--ink);padding:8pt 12pt;border-radius:5pt;font-size:16pt;font-weight:900;text-align:center;letter-spacing:.04em}
.iss-banner .iss-version{color:#334155;top:2pt;right:6pt}
.iss-action{font-size:9pt}
.iss-action--print{border:0.75pt solid var(--rule);border-radius:5pt;padding:6pt 8pt;background:#fff}
.iss-button{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;font-weight:700;padding:8px 14px;border-radius:8px}
.iss-fallback{font-size:12px;color:var(--muted);margin:6px 0 0}
.iss-qrblock{margin:0;display:flex;gap:6pt;align-items:center;font-size:7.5pt;color:var(--muted)}
.iss-url{color:var(--ink);font-weight:600}
.iss-expl{font-size:8.5pt;border:0.75pt solid var(--rule);border-radius:5pt;padding:6pt 8pt}
.iss-expl h3,.iss-expl h4{margin:0 0 2pt;font-size:9pt;color:var(--ink)}.iss-expl p{margin:0 0 2pt}
.iss-figure{margin:0}.iss-chart-title{font-size:8.5pt;font-weight:700;color:var(--ink);margin-bottom:3pt}
.iss-chart--donut{display:flex;gap:10pt;align-items:center}.iss-chart--donut svg{width:84pt;height:84pt}
.iss-legend{list-style:none;margin:0;padding:0;font-size:8pt}.iss-legend li{margin:1pt 0}
.sw{display:inline-block;width:7pt;height:7pt;border-radius:2pt;margin-right:4pt;vertical-align:middle}
.iss-chart--bar svg{width:100%;max-width:330pt;height:auto}
.iss-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.iss-img{width:100%;height:100%;display:block}
.iss-hf{font-size:7.5pt;color:var(--muted)}
.iss-hf--document-header{text-align:right;font-weight:700;letter-spacing:.08em;color:#92400e;font-size:7pt;padding-top:4pt}
.iss-hf--page-header{border-bottom:0.75pt solid var(--rule);padding-bottom:4pt;font-weight:600;color:var(--body)}
.iss-hf--page-footer{border-top:1pt solid var(--brand);padding-top:4pt;display:flex;justify-content:space-between}
.iss-table-caption{font-size:10.5pt;font-weight:700;color:var(--ink);margin:0 0 3pt}
.iss-table{width:100%;border-collapse:collapse;font-size:8pt;}
.iss-table th{background:var(--tint);color:var(--ink);text-align:left;font-weight:700;padding:3pt 4pt;border-bottom:1pt solid var(--accent)}
.iss-table td{padding:2.4pt 4pt;border-bottom:0.5pt solid var(--rule);color:var(--body);word-break:break-word}
.iss-table .num{text-align:right}
.iss-table tfoot th,.iss-table tfoot td{font-weight:800;color:var(--ink);border-top:1pt solid var(--ink);background:#fff}
.iss-table td.guarded{color:#92400e;font-style:italic}
.iss-empty td{text-align:center;color:var(--muted);padding:8pt}
${projectStyleCss(project)}`;
}

function pagedCss(accent: string, project?: Project): string {
  return `@page{size:8.5in 11in;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#e5e7eb}
body{font-family:${DOC_FONT};font-feature-settings:'calt' 0,'tnum' 0,'liga' 0,'case' 0;font-variant-ligatures:none;font-size:9.5pt;line-height:1.35;color:#334155;-webkit-print-color-adjust:exact;print-color-adjust:exact}
#iss-pages{display:flex;flex-direction:column;align-items:center;gap:16px;padding:16px 0}
.page{width:612pt;height:792pt;position:relative;overflow:hidden;background:#fff;box-shadow:0 2px 10px rgba(15,23,42,.18);page-break-after:always;break-after:page}
.page:last-child{page-break-after:auto;break-after:auto}
@media print{html,body{background:#fff}#iss-pages{display:block;padding:0}.page{box-shadow:none;margin:0}}
.iss-fixed{position:absolute;overflow:hidden}
.iss-flow{position:absolute}
.iss-block{position:relative}
.iss-overflow{outline:1.5pt solid #dc2626;outline-offset:2pt}
.iss-overflow-marker{position:absolute;left:40pt;right:40pt;bottom:50pt;background:#fee2e2;border:1pt solid #dc2626;color:#991b1b;font-weight:700;font-size:8.5pt;padding:4pt 6pt;border-radius:3pt}
.iss-watermark{position:absolute;left:0;right:0;top:46%;text-align:center;transform:rotate(-24deg);font-size:34pt;font-weight:900;color:rgba(220,38,38,.13);letter-spacing:.06em;pointer-events:none}
#iss-source{position:absolute;left:-20000px;top:0}
${documentCss(accent, project)}`;
}

function isHeadingOnly(n: RNode): boolean {
  return n.type === 'rich-text' && !!n.text?.length && n.text.every((b) => b.kind === 'h2' || b.kind === 'h3' || b.kind === 'h4');
}

export interface PagedRenderOptions {
  profileId?: ProfileId;
  watermark?: string;
  title?: string;
}

/** Composes the RCT into a self-paginating paged HTML document (the PDF composition request). */
export function renderPagedDocument(res: Resolution, project: Project, opts: PagedRenderOptions = {}): string {
  const profileId = opts.profileId ?? 'paged-pdf';
  const profile = project.presentationProfiles.find((p) => p.id === profileId) ?? project.presentationProfiles.find((p) => p.kind === 'paged')!;
  const flow = profile.flowRegion ?? { firstPageTopPt: 184, otherPagesTopPt: 84, bottomPt: 738 };
  const marginMm = profile.pageMarginsMm ?? [14, 14, 14, 14];
  const leftPt = Math.round((marginMm[3] * 72) / 25.4);
  const rightPt = Math.round((marginMm[1] * 72) / 25.4);
  const widthPt = 612 - leftPt - rightPt;
  const mode: RenderMode = { target: 'paged', project, strings: res.systemStrings };
  const accent = project.issuer?.accent ?? '#277656';

  const renderNested = (n: RNode): string => {
    const w = n.layout?.paged?.widthPct;
    const style = w && w < 100 ? ` style="flex:0 0 calc(${w}% - 6pt)"` : '';
    return `<div class="iss-node" ${nodeDataAttrs(n)}${style}>${nodeInnerHtml(n, mode, renderNested)}</div>`;
  };

  const fixedParts: string[] = [];
  const flowParts: string[] = [];
  for (const n of res.root.children) {
    if (!n.visible) continue;
    const pl = n.layout?.paged ?? { mode: 'flow' as const };
    const inner = nodeInnerHtml(n, mode, renderNested);
    if (pl.mode === 'fixed') {
      const chrome = n.type === 'header-footer' && n.headerFooter?.role !== 'document-header' ? ' data-chrome="1"' : '';
      fixedParts.push(`<div class="iss-fixed" ${nodeDataAttrs(n)} data-pages="${pl.pages ?? 'first'}"${chrome} data-x="${pl.xPt ?? 0}" data-y="${pl.yPt ?? 0}" data-w="${pl.wPt ?? 100}" data-h="${pl.hPt ?? 20}" style="left:${pl.xPt ?? 0}pt;top:${pl.yPt ?? 0}pt;width:${pl.wPt ?? 100}pt;height:${pl.hPt ?? 20}pt">${inner}</div>`);
    } else {
      const w = pl.widthPct ?? 100;
      const ml = pl.align === 'center' ? (100 - w) / 2 : pl.align === 'right' ? 100 - w : 0;
      const attrs = [
        `data-space-before="${pl.spaceBeforePt ?? 8}"`,
        `data-keep-with-next="${pl.keepWithNext ? 1 : 0}"`,
        isHeadingOnly(n) ? 'data-heading-only="1"' : '',
        n.table ? `data-splittable="1" data-continuation="${n.table.continuation ? 1 : 0}" data-repeat-header="${n.table.repeatHeader ? 1 : 0}"` : '',
      ].filter(Boolean).join(' ');
      flowParts.push(`<div class="iss-block" ${nodeDataAttrs(n)} ${attrs} style="width:${w}%;margin-left:${ml}%">${inner}</div>`);
    }
  }
  const layout = { firstPageTopPt: flow.firstPageTopPt, otherPagesTopPt: flow.otherPagesTopPt, bottomPt: flow.bottomPt, leftPt, widthPt, watermark: opts.watermark ?? '', strings: { pageOf: sysText(res.systemStrings, 'pageOf'), tableContinued: sysText(res.systemStrings, 'tableContinued') } };
  const title = opts.title ?? `${project.issuer?.name ?? project.title} — ${res.recordId} (synthetic)`;
  return `<!doctype html>
<html lang="${esc(res.locale)}" data-run-id="${esc(res.runId)}" data-profile="${esc(profileId)}" data-renderer="${PAGED_RENDERER_VERSION}">
<head><meta charset="utf-8"/><title>${esc(title)}</title>
<meta name="generator" content="InfoSlips Spatial Studio ${PAGED_RENDERER_VERSION}"/>
<meta name="description" content="Synthetic demonstration document. Run ${esc(res.runId)}; content digest ${esc(res.contentDigest)}."/>
<style>${pagedCss(accent, project)}</style></head>
<body>
<div id="iss-pages" role="document" aria-label="${esc(title)}"></div>
<div id="iss-source" style="width:${widthPt}pt">${fixedParts.join('\n')}${flowParts.join('\n')}</div>
<script id="iss-layout" type="application/json">${JSON.stringify(layout).replace(/</g, '\\u003c')}</script>
<script>${PAGINATOR_JS}</script>
</body></html>`;
}
