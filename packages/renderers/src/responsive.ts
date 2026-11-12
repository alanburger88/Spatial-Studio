import type { Project } from '@iss/model';
import type { RNode, Resolution } from '@iss/resolver';
import { SCREEN_FONT as DOC_FONT, esc, nodeDataAttrs, nodeInnerHtml, type RenderMode } from './html-common';
import { documentCss } from './paged';

export const HTML_RENDERER_VERSION = 'iss-html-renderer/1.0.0';

const INTERACTION_JS = String.raw`
(function () {
  function onReady(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  onReady(function () {
    document.querySelectorAll('table[data-table-id]').forEach(function (table) {
      var tbody = table.querySelector('tbody');
      var id = table.getAttribute('data-table-id');
      var status = document.querySelector('[data-table-status="' + id + '"]');
      var filter = document.querySelector('[data-table-filter="' + id + '"]');
      function rows() { return Array.prototype.slice.call(tbody.querySelectorAll('tr[data-row-id]')); }
      function update() {
        var all = rows(), shown = all.filter(function (r) { return !r.hidden; }).length;
        if (status) status.textContent = 'Showing ' + shown + ' of ' + all.length + ' items. Totals always reflect all ' + all.length + ' items.';
      }
      table.querySelectorAll('button.iss-sort').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var th = btn.closest('th');
          var idx = Array.prototype.indexOf.call(th.parentNode.children, th);
          var dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
          table.querySelectorAll('th').forEach(function (h) { h.removeAttribute('aria-sort'); });
          th.setAttribute('aria-sort', dir);
          var list = rows();
          list.sort(function (a, b) {
            var x = a.children[idx].getAttribute('data-sort'), y = b.children[idx].getAttribute('data-sort');
            var nx = parseFloat(x), ny = parseFloat(y);
            var c = (!isNaN(nx) && !isNaN(ny) && String(nx) === x && String(ny) === y) ? nx - ny : String(x).localeCompare(String(y));
            return dir === 'ascending' ? c : -c;
          });
          list.forEach(function (r) { tbody.appendChild(r); });
          update();
        });
      });
      if (filter) filter.addEventListener('input', function () {
        var q = filter.value.trim().toLowerCase();
        rows().forEach(function (r) { r.hidden = q ? r.textContent.toLowerCase().indexOf(q) < 0 : false; });
        update();
      });
      update();
    });
    var expandAll = document.querySelector('[data-action="expand-all"]');
    if (expandAll) expandAll.addEventListener('click', function () {
      var ds = document.querySelectorAll('details.iss-expl');
      var open = Array.prototype.some.call(ds, function (d) { return !d.open; });
      ds.forEach(function (d) { d.open = open; });
      expandAll.textContent = open ? 'Collapse all explanations' : 'Expand all explanations';
      expandAll.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.querySelectorAll('[data-chart-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var t = document.getElementById(btn.getAttribute('data-chart-toggle'));
        t.hidden = !t.hidden; btn.setAttribute('aria-expanded', t.hidden ? 'false' : 'true');
      });
    });
    var tip = document.createElement('div'); tip.className = 'iss-tip'; tip.setAttribute('role', 'status'); document.body.appendChild(tip);
    document.querySelectorAll('.iss-chart [data-label]').forEach(function (m) {
      function show() { tip.textContent = m.getAttribute('data-label') + ': ' + m.getAttribute('data-display'); var r = m.getBoundingClientRect(); tip.style.left = (r.left + window.scrollX) + 'px'; tip.style.top = (r.top + window.scrollY - 30) + 'px'; tip.style.opacity = 1; }
      function hide() { tip.style.opacity = 0; }
      m.addEventListener('mouseenter', show); m.addEventListener('focus', show); m.addEventListener('mouseleave', hide); m.addEventListener('blur', hide);
    });
    document.documentElement.setAttribute('data-interactive-ready', '1');
  });
})();
`;

function htmlCss(accent: string): string {
  return `*{box-sizing:border-box}
html{font-size:16px}
body{margin:0;font-family:${DOC_FONT};color:#334155;background:#F1F5F9;line-height:1.5}
a{color:#1D5941}
:focus-visible{outline:3px solid #4EAF60;outline-offset:2px}
.iss-skip{position:absolute;left:-9999px}.iss-skip:focus{left:12px;top:12px;background:#fff;padding:8px;z-index:10}
.iss-demo-ribbon{background:#0F172A;color:#DBE64C;font-size:12px;font-weight:700;letter-spacing:.06em;text-align:center;padding:6px 12px}
.iss-shell{max-width:1120px;margin:0 auto;padding:24px 20px 48px}
.iss-head{background:#fff;border-radius:16px;padding:20px 24px;display:grid;grid-template-columns:repeat(12,1fr);gap:12px 20px;align-items:center;box-shadow:0 1px 3px rgba(15,23,42,.08);border-top:5px solid #4EAF60}
.iss-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px;margin-top:16px;align-items:start}
.iss-main{grid-column:span 8;display:grid;grid-template-columns:repeat(12,1fr);gap:16px}
.iss-aside{grid-column:span 4;display:grid;gap:16px}
.iss-foot{margin-top:16px;display:grid;gap:12px}
.iss-card{background:#fff;border-radius:14px;padding:16px 18px;box-shadow:0 1px 3px rgba(15,23,42,.08);min-width:0}
.iss-card.iss-plain{background:transparent;box-shadow:none;padding:0}
.iss-node{min-width:0}
.iss-head .iss-img{height:44px;width:auto;max-width:220px}
.iss-head .iss-rich h1,.iss-head .iss-rich h2{font-size:24px;margin:0 0 4px}
.iss-hf--document-header{color:#92400e;font-weight:700;font-size:12px;letter-spacing:.08em;text-align:right}
.iss-hf--page-footer{font-size:13px;color:#475569;border-top:2px solid #4EAF60;padding-top:10px}
.iss-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.iss-metric{padding:12px 14px;border-radius:12px}.iss-metric-label{font-size:11px}.iss-metric-value{font-size:22px}.iss-metric--secondary .iss-metric-value{font-size:16px}
.iss-table-tools{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin:4px 0 8px}
.iss-table-tools input{padding:8px 10px;border:1px solid #CBD5E1;border-radius:8px;min-width:220px;font:inherit}
.iss-table-status{font-size:13px;color:#64748B}
.iss-table-scroll{overflow-x:auto}
.iss-table{font-size:14px}.iss-table th{padding:8px}.iss-table td{padding:7px 8px}
.iss-sort{all:unset;cursor:pointer;font-weight:700}.iss-sort:focus-visible{outline:3px solid #4EAF60}
th[aria-sort=ascending] .iss-sort-ind::after{content:" ▲"}th[aria-sort=descending] .iss-sort-ind::after{content:" ▼"}
details.iss-expl{font-size:15px;border-radius:12px;padding:12px 14px}
details.iss-expl summary{cursor:pointer;display:flex;flex-direction:column;gap:2px}
.iss-expl-title{font-weight:700;color:#0F172A}.iss-expl-summary{font-size:13px;color:#64748B}
.iss-tools{display:flex;gap:8px;margin:16px 0 0;flex-wrap:wrap}
.iss-btn{border:1px solid #CBD5E1;background:#fff;border-radius:999px;padding:8px 14px;font:inherit;font-size:14px;cursor:pointer;color:#0F172A}
.iss-chart--bar svg{max-width:100%}
.iss-tip{position:absolute;pointer-events:none;background:#0F172A;color:#fff;font-size:12px;padding:4px 8px;border-radius:6px;opacity:0;transition:opacity .15s}
.iss-chart-data{font-size:13px;margin-top:8px}
.iss-banner{font-size:22px}
.iss-meta{font-size:12px;color:#475569;margin-top:24px;word-break:break-all}
@media (max-width:960px){.iss-main,.iss-aside{grid-column:1/-1}}
@media (max-width:600px){.iss-shell{padding:12px}.iss-head{grid-template-columns:1fr}.iss-head>*{grid-column:1/-1 !important}.iss-main{grid-template-columns:1fr}.iss-main>*{grid-column:1/-1 !important}.iss-banner{font-size:18px}.iss-table{font-size:13px}}
@media (prefers-reduced-motion:reduce){*{transition:none !important}}
${documentCss(accent)}`;
}

/** Renders the interactive, standalone responsive HTML communication (no external assets or scripts). */
export function renderInteractiveHtml(res: Resolution, project: Project): string {
  const mode: RenderMode = { target: 'html', project };
  const accent = project.issuer?.accent ?? '#277656';
  const visibleHtml = (n: RNode) => n.visible && !n.layout?.html?.hidden;
  const renderNested = (n: RNode): string => (visibleHtml(n) ? `<div class="iss-node" ${nodeDataAttrs(n)}>${inner(n)}</div>` : '');
  const inner = (n: RNode): string => {
    if (n.type === 'repeating-table') {
      const id = esc(n.id);
      const tools = `<div class="iss-table-tools">${n.table!.filterable ? `<label>Filter <input type="search" data-table-filter="${id}" aria-label="Filter ${esc(n.table!.caption)}" placeholder="Type to filter rows"/></label>` : ''}<span class="iss-table-status" data-table-status="${id}" aria-live="polite"></span></div>`;
      return nodeInnerHtml(n, mode, renderNested).replace('<table', `${tools}<div class="iss-table-scroll"><table`).replace('</table>', '</table></div>');
    }
    if (n.type === 'chart') {
      const tid = `chart-data-${esc(n.id)}`;
      const rows = n.chart!.data.map((d) => `<tr><th scope="row">${esc(d.label)}</th><td class="num">${esc(d.display)}</td></tr>`).join('');
      return nodeInnerHtml(n, mode, renderNested) + (n.chart!.data.length ? `<button class="iss-btn" type="button" data-chart-toggle="${tid}" aria-expanded="false" aria-controls="${tid}">Show chart data</button><table class="iss-table iss-chart-data" id="${tid}" hidden><caption class="iss-sr">${esc(n.chart!.title)}</caption><tbody>${rows}</tbody></table>` : '');
    }
    return nodeInnerHtml(n, mode, renderNested);
  };
  const card = (n: RNode) => {
    const span = Math.max(1, Math.min(12, n.layout?.html?.span ?? 12));
    const plain = n.type === 'container' || n.type === 'shape' || n.type === 'header-footer' || n.type === 'image' || (n.type === 'disclosure' && n.disclosure?.contentPartId === 'not-a-bill-banner');
    return `<div class="iss-node iss-card${plain ? ' iss-plain' : ''}" ${nodeDataAttrs(n)} style="grid-column:span ${span}">${inner(n)}</div>`;
  };
  const areas: Record<string, RNode[]> = { header: [], main: [], aside: [], footer: [] };
  for (const n of res.root.children) {
    if (!visibleHtml(n)) continue;
    areas[n.layout?.html?.area ?? 'main'].push(n);
  }
  for (const k of Object.keys(areas)) areas[k].sort((a, b) => (a.layout?.html?.order ?? 0) - (b.layout?.html?.order ?? 0));
  const title = `${project.issuer?.name ?? project.title} — ${project.documentType === 'eob' ? 'Explanation of Benefits' : 'Statement'} (synthetic)`;
  const manifestJson = JSON.stringify({ runId: res.runId, contentDigest: res.contentDigest, renderer: HTML_RENDERER_VERSION, resolverManifest: res.semanticManifest }).replace(/</g, '\\u003c');
  const hasExpl = areas.main.concat(areas.aside, areas.footer).some((n) => n.type === 'expandable-explanation');
  return `<!doctype html>
<html lang="${esc(res.locale)}" data-run-id="${esc(res.runId)}" data-profile="html-responsive" data-renderer="${HTML_RENDERER_VERSION}">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<meta name="description" content="Synthetic demonstration communication generated by InfoSlips Spatial Studio. Not a real ${project.documentType === 'eob' ? 'bill or medical record' : 'financial statement'}."/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"/>
<style>${htmlCss(accent)}</style></head>
<body>
<a class="iss-skip" href="#iss-main">Skip to content</a>
<aside class="iss-demo-ribbon" aria-label="Synthetic data notice">SYNTHETIC DEMO DATA — fictional ${esc(project.issuer?.name ?? '')}; not a legal document${project.documentType === 'eob' ? ' · THIS IS NOT A BILL' : ''}</aside>
<div class="iss-shell">
<header class="iss-head" aria-label="Document header">${areas.header.map(card).join('').replace(/<h2>([\s\S]*?)<\/h2>/, '<h1>$1</h1>')}</header>
<main id="iss-main" class="iss-grid">
<div class="iss-main">${areas.main.map(card).join('')}</div>
<aside class="iss-aside" aria-label="Related information">${areas.aside.map((n) => card({ ...n, layout: { ...n.layout, html: { ...n.layout?.html, span: 12 } } })).join('')}</aside>
</main>
${hasExpl ? '<div class="iss-tools"><button class="iss-btn" type="button" data-action="expand-all" aria-expanded="false">Expand all explanations</button></div>' : ''}
<footer class="iss-foot">${areas.footer.map(card).join('')}
<p class="iss-meta">Composed by InfoSlips Spatial Studio · run ${esc(res.runId)} · content digest ${esc(res.contentDigest.slice(0, 16))} · rules ${esc(res.rulesDigest.slice(0, 12))} · model v${res.modelVersion}</p>
</footer>
</div>
<script type="application/json" id="iss-semantic-manifest">${manifestJson}</script>
<script>${INTERACTION_JS}</script>
</body></html>`;
}
