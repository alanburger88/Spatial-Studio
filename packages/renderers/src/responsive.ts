import type { Project } from '@iss/model';
import type { RNode, Resolution } from '@iss/resolver';
import { SCREEN_FONT as DOC_FONT, esc, modeText, nodeDataAttrs, nodeInnerHtml, type RenderMode } from './html-common';
import { fmtString, resolveHtmlStrings, type HtmlStringKey } from './html-strings';
import { documentCss } from './paged';

export const HTML_RENDERER_VERSION = 'iss-html-renderer/1.0.0';

export interface InteractiveHtmlOptions {
  /** Translated fixed strings; anything missing falls back to the English text in `HTML_STRINGS`. */
  strings?: Partial<Record<HtmlStringKey, string>>;
}

/** Progressive enhancement only: every fact is in the markup; the script adds sorting, filtering, paging, chart filtering and the section menu state. All text comes from the JSON strings block. */
const INTERACTION_JS = String.raw`
(function () {
  var doc = document, root = doc.documentElement;
  var S = {};
  try { S = JSON.parse(doc.getElementById('iss-strings').textContent) || {}; } catch (e) {}
  function t(k, v) { var s = S[k] == null ? '' : String(S[k]); return s.replace(/\{(\w+)\}/g, function (m, n) { return v && n in v ? v[n] : m; }); }
  root.setAttribute('data-js', '1');
  var all = function (sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var PAGE = 10, BIG = 1000000;
  var tables = {};

  function setupTable(table) {
    var id = table.getAttribute('data-table-id'), tbody = table.tBodies[0];
    var q = function (a) { return doc.querySelector('[' + a + '="' + id + '"]'); };
    var tools = q('data-table-tools'), status = q('data-table-status'), filter = q('data-table-filter'), quick = q('data-table-quick');
    var chip = q('data-table-chip'), moreBar = q('data-table-more-bar'), moreBtn = q('data-table-more'), allBtn = q('data-table-all');
    var scroller = table.closest('.iss-table-scroll');
    var heads = all('thead th', table);
    var catKey = tools && tools.getAttribute('data-cat-key'), catLabel = tools && tools.getAttribute('data-cat-label') || '';
    var catIdx = -1;
    heads.forEach(function (h, i) { if (catKey && h.getAttribute('data-key') === catKey) catIdx = i; });
    var st = { limit: PAGE, query: '', cat: '' };
    function rows() { return all('tr[data-row-id]', tbody); }
    function txt(r, i) { return (r.children[i] ? r.children[i].textContent : '').trim(); }
    function update(prefix) {
      var list = rows(), matches = 0, shown = 0;
      list.forEach(function (r) {
        var ok = true;
        if (st.query && r.textContent.toLowerCase().indexOf(st.query) < 0) ok = false;
        if (ok && st.cat && catIdx >= 0 && txt(r, catIdx) !== st.cat) ok = false;
        if (ok) { matches++; if (shown < st.limit) { shown++; r.hidden = false; } else r.hidden = true; } else r.hidden = true;
      });
      var filtered = !!(st.query || st.cat);
      if (status) status.textContent = (prefix ? prefix + ' ' : '') + (filtered ? t('tableStatusFiltered', { shown: shown, total: list.length, matches: matches }) : t('tableStatus', { shown: shown, total: list.length }));
      if (moreBar) {
        var hadFocus = moreBar.contains(doc.activeElement);
        moreBar.hidden = shown >= matches;
        if (moreBar.hidden && hadFocus && scroller) scroller.focus();
      }
      if (chip) {
        chip.hidden = !st.cat;
        var tx = chip.querySelector('[data-chip-text]');
        if (tx) tx.textContent = st.cat ? t('tableFilterChip', { column: catLabel, value: st.cat }) : '';
      }
      if (quick && quick.value !== st.cat) quick.value = st.cat;
      all('.iss-chart [data-label]').forEach(function (m) { if (m._tbl === id) m.setAttribute('aria-pressed', st.cat && m.getAttribute('data-label') === st.cat ? 'true' : 'false'); });
    }
    heads.forEach(function (th, idx) {
      var btn = th.querySelector('button.iss-sort');
      if (!btn) return;
      btn.addEventListener('click', function () {
        var dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
        heads.forEach(function (h) { h.removeAttribute('aria-sort'); });
        th.setAttribute('aria-sort', dir);
        var list = rows();
        list.sort(function (a, b) {
          var x = a.children[idx].getAttribute('data-sort'), y = b.children[idx].getAttribute('data-sort');
          var nx = parseFloat(x), ny = parseFloat(y);
          var c = (!isNaN(nx) && !isNaN(ny) && String(nx) === x && String(ny) === y) ? nx - ny : String(x).localeCompare(String(y));
          return dir === 'ascending' ? c : -c;
        });
        var anchor = tbody.querySelector('tr:not([data-row-id])');
        list.forEach(function (r) { tbody.insertBefore(r, anchor); });
        update(t('tableSortedBy', { column: btn.firstChild ? btn.firstChild.textContent : '', direction: t(dir === 'ascending' ? 'tableSortAscending' : 'tableSortDescending') }));
      });
    });
    if (filter) filter.addEventListener('input', function () { st.query = filter.value.trim().toLowerCase(); st.limit = PAGE; update(); });
    if (quick) quick.addEventListener('change', function () { st.cat = quick.value; st.limit = PAGE; update(st.cat ? t('tableFilteredTo', { value: st.cat, matches: rows().filter(function (r) { return txt(r, catIdx) === st.cat; }).length }) : t('tableFilterCleared')); });
    if (moreBtn) moreBtn.addEventListener('click', function () { st.limit += PAGE; update(); });
    if (allBtn) allBtn.addEventListener('click', function () { st.limit = BIG; update(); });
    if (chip) chip.querySelector('button').addEventListener('click', function () { api.setCat('', true); });
    var api = {
      id: id, table: table, catIdx: catIdx,
      has: function (v) { return catIdx >= 0 && rows().some(function (r) { return txt(r, catIdx) === v; }); },
      current: function () { return st.cat; },
      setCat: function (v, announce) {
        st.cat = v; st.limit = PAGE;
        var n = rows().filter(function (r) { return !v || txt(r, catIdx) === v; }).length;
        update(announce ? (v ? t('tableFilteredTo', { value: v, matches: n }) : t('tableFilterCleared')) : '');
      }
    };
    tables[id] = api;
    update();
  }
  all('table[data-table-id]').forEach(function (tb) { try { setupTable(tb); } catch (e) {} });

  /* chart bars drive the table filter */
  all('.iss-chart [data-label]').forEach(function (m) {
    var label = m.getAttribute('data-label'), target = null;
    Object.keys(tables).forEach(function (k) { if (!target && tables[k].has(label)) target = tables[k]; });
    if (!target) return;
    m._tbl = target.id;
    m.setAttribute('role', 'button'); m.setAttribute('tabindex', '0'); m.setAttribute('aria-pressed', 'false');
    m.setAttribute('aria-label', t('chartBarAction', { label: label, value: m.getAttribute('data-display') }));
    function act() {
      target.setCat(target.current() === label ? '' : label, true);
      var d = target.table.closest('details.iss-secd'); if (d) d.open = true;
      var box = target.table.closest('.iss-table-wrap') || target.table;
      var r = box.getBoundingClientRect(), bar = doc.querySelector('[data-iss-bar]'), top = bar ? bar.offsetHeight : 0;
      if (r.top < top || r.top > window.innerHeight - 80) box.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    }
    m.addEventListener('click', act);
    m.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); act(); } });
  });

  var expandAll = doc.querySelector('[data-action="expand-all"]');
  if (expandAll) expandAll.addEventListener('click', function () {
    var ds = all('details.iss-expl');
    var open = ds.some(function (d) { return !d.open; });
    ds.forEach(function (d) { d.open = open; });
    expandAll.textContent = open ? t('collapseAll') : t('expandAll');
    expandAll.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  all('[data-chart-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var tb = doc.getElementById(btn.getAttribute('data-chart-toggle'));
      tb.hidden = !tb.hidden; btn.setAttribute('aria-expanded', tb.hidden ? 'false' : 'true');
    });
  });
  var tip = doc.createElement('div'); tip.className = 'iss-tip'; tip.setAttribute('aria-hidden', 'true'); doc.body.appendChild(tip);
  all('.iss-chart [data-label]').forEach(function (m) {
    function show() { tip.textContent = m.getAttribute('data-label') + ': ' + m.getAttribute('data-display'); var r = m.getBoundingClientRect(); tip.style.left = (r.left + window.scrollX) + 'px'; tip.style.top = (r.top + window.scrollY - 30) + 'px'; tip.style.opacity = 1; }
    function hide() { tip.style.opacity = 0; }
    m.addEventListener('mouseenter', show); m.addEventListener('focus', show); m.addEventListener('mouseleave', hide); m.addEventListener('blur', hide);
  });

  /* collapsible sections: phones only; always open on wider screens */
  var mq = window.matchMedia ? window.matchMedia('(max-width: 600px)') : { matches: false };
  var secs = all('details.iss-secd');
  function applyMode() {
    secs.forEach(function (d) {
      var s = d.querySelector('summary');
      if (mq.matches) { s.removeAttribute('tabindex'); if (!d._init) { d._init = 1; d.open = d.getAttribute('data-default-open') === '1'; } }
      else { d._init = 0; d.open = true; s.setAttribute('tabindex', '-1'); }
    });
  }
  secs.forEach(function (d) { d.querySelector('summary').addEventListener('click', function (e) { if (!mq.matches) e.preventDefault(); }); });
  applyMode();
  if (mq.addEventListener) mq.addEventListener('change', applyMode);

  /* sticky bar: height for anchor offsets, current-section state */
  var bar = doc.querySelector('[data-iss-bar]'), menu = doc.querySelector('[data-iss-menu]');
  var links = menu ? all('a[href^="#"]', menu) : [];
  var targets = links.map(function (a) { return doc.getElementById(a.getAttribute('href').slice(1)); });
  function measure() { if (bar) root.style.setProperty('--iss-bar-h', bar.offsetHeight + 'px'); }
  var queued = false;
  function spy() {
    queued = false; measure();
    if (!links.length) return;
    var y = (bar ? bar.offsetHeight : 0) + 24, cur = 0;
    targets.forEach(function (el, i) { if (el && el.getBoundingClientRect().top <= y) cur = i; });
    if (window.innerHeight + window.scrollY >= doc.body.scrollHeight - 4) cur = targets.length - 1;
    links.forEach(function (a, i) {
      if (i === cur) {
        if (a.getAttribute('aria-current') !== 'location') {
          a.setAttribute('aria-current', 'location');
          var l = a.offsetLeft - 16, r = a.offsetLeft + a.offsetWidth + 16;
          if (l < menu.scrollLeft) menu.scrollLeft = l; else if (r > menu.scrollLeft + menu.clientWidth) menu.scrollLeft = r - menu.clientWidth;
        }
      } else a.removeAttribute('aria-current');
    });
  }
  function queue() { if (!queued) { queued = true; window.requestAnimationFrame(spy); } }
  links.forEach(function (a, i) {
    a.addEventListener('click', function () {
      var d = targets[i] && targets[i].querySelector('details.iss-secd');
      if (d) d.open = true;
      links.forEach(function (x) { x.removeAttribute('aria-current'); }); a.setAttribute('aria-current', 'location');
    });
  });
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue);
  spy();
  root.setAttribute('data-interactive-ready', '1');
})();
`;

function htmlCss(accent: string, project?: Project): string {
  return `*{box-sizing:border-box}
html{font-size:16px;scroll-padding-top:calc(var(--iss-bar-h,120px) + 8px);-webkit-text-size-adjust:100%}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
body{margin:0;font-family:${DOC_FONT};color:#334155;background:#F1F5F9;line-height:1.5;overflow-wrap:break-word}
a{color:#1D5941}
:focus-visible{outline:3px solid #4EAF60;outline-offset:2px}
.iss-skip{position:absolute;left:-9999px}.iss-skip:focus{left:12px;top:12px;background:#fff;padding:8px;z-index:50}
.iss-demo-ribbon{background:#0F172A;color:#DBE64C;font-size:12px;font-weight:700;letter-spacing:.06em;text-align:center;padding:6px 12px}
.iss-shell{max-width:1120px;margin:0 auto;padding:16px 20px 48px}
.iss-head{background:#fff;border-radius:16px;padding:20px 24px;display:grid;grid-template-columns:repeat(12,1fr);gap:12px 20px;align-items:center;box-shadow:0 1px 3px rgba(15,23,42,.08);border-top:5px solid #4EAF60}
.iss-head>*{min-width:0}
.iss-card{background:#fff;border-radius:14px;padding:16px 18px;box-shadow:0 1px 3px rgba(15,23,42,.08);min-width:0}
.iss-card.iss-plain{background:transparent;box-shadow:none;padding:0}
.iss-node{min-width:0}
.iss-head .iss-img{height:44px;width:auto;max-width:min(220px,100%)}
.iss-head .iss-rich h1,.iss-head .iss-rich h2{font-size:24px;margin:0 0 4px}
.iss-hf--document-header{color:#92400e;font-weight:700;font-size:12px;letter-spacing:.08em;text-align:right}
.iss-hf--page-footer{font-size:13px;color:#475569;border-top:2px solid #4EAF60;padding-top:10px;display:block}
/* sticky bar */
.iss-bar{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.97);border-bottom:1px solid #CBD5E1;box-shadow:0 2px 8px rgba(15,23,42,.08)}
.iss-bar-main{max-width:1120px;margin:0 auto;padding:8px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.iss-bar-id{min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 16px;color:#0F172A}
.iss-bar-issuer{font-weight:800;font-size:15px}
.iss-bar-fact{font-size:14px;color:#334155}
.iss-bar-fact strong{font-size:18px;color:#0F172A}
.iss-bar-label{font-weight:600}
.iss-bar-action{flex:none;display:inline-flex;align-items:center;min-height:44px;font-size:14px;text-align:center}
.iss-menu{max-width:1120px;margin:0 auto;padding:0 20px;overflow-x:auto;scrollbar-width:thin}
.iss-menu ul{list-style:none;margin:0;padding:0 0 6px;display:flex;gap:8px;white-space:nowrap}
.iss-menu a{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:999px;border:1px solid #CBD5E1;background:#fff;color:#0F172A;text-decoration:none;font-size:14px;font-weight:600}
.iss-menu a:hover{background:#F1F5F9}
.iss-menu a[aria-current]{background:#0F172A;color:#fff;border-color:#0F172A;box-shadow:inset 0 -3px 0 #4EAF60}
.iss-menu a[aria-current]::before{content:"\\25CF";font-size:9px;margin-right:6px;color:#DBE64C}
/* sections */
.iss-sec{margin-top:16px}
.iss-sec-title{font-size:18px;margin:0;color:#0F172A}
.iss-sec>.iss-sec-title{margin:0 0 10px}
.iss-secd>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px;cursor:default;list-style:none;margin:0 0 10px}
.iss-secd>summary::-webkit-details-marker{display:none}
.iss-chev{display:none}
.iss-sec-body{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px;align-items:start}
.iss-pre{margin-top:16px}
.iss-foot{margin-top:16px;display:grid;gap:12px}
.iss-shell .iss-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(160px,100%),1fr));gap:12px}
.iss-shell .iss-row>*{min-width:0}
.iss-shell .iss-metric{padding:12px 14px;border-radius:12px;border:1px solid #E2E8F0;background:#fff;height:100%}
.iss-shell .iss-metric--primary{border-color:var(--accent);background:linear-gradient(180deg,#fff,#f6fbf7)}
.iss-shell .iss-metric-label{font-size:12px;overflow-wrap:break-word}
.iss-shell .iss-metric-value{font-size:22px;overflow-wrap:anywhere;line-height:1.2}
.iss-shell .iss-metric--secondary .iss-metric-value{font-size:18px}
.iss-shell .iss-metric--guarded .iss-metric-value{font-size:15px;color:#92400E}
.iss-shell .iss-field{font-size:15px}
.iss-shell .iss-row .iss-field{border:1px solid #E2E8F0;border-radius:12px;padding:12px 14px;background:#fff;height:100%;display:flex;flex-direction:column;gap:2px}
.iss-shell .iss-row .iss-field-label{font-size:12px}
.iss-shell .iss-row .iss-field-value{font-size:18px}
.iss-shell .iss-rich{font-size:16px}
.iss-shell .iss-rich h1,.iss-shell .iss-rich h2{font-size:22px}
.iss-shell .iss-rich h3{font-size:17px}
.iss-shell .iss-variant{font-size:16px;padding:12px 16px}
.iss-shell h2.iss-variant-title{font-size:17px}
.iss-shell .iss-disclosure{font-size:14px;color:#334155;position:static}
.iss-shell .iss-disclosure h3{font-size:14px}
.iss-shell .iss-version{position:static;display:block;margin-top:6px;font-size:12px;color:#475569}
.iss-shell .iss-banner{font-size:22px;padding:12px 16px}
.iss-shell .iss-banner .iss-version{color:#334155}
.iss-shell .iss-action{font-size:15px}
.iss-shell .iss-button{display:inline-flex;align-items:center;min-height:44px;padding:8px 18px}
.iss-shell .iss-fallback{font-size:14px}
.iss-shell .iss-url{overflow-wrap:anywhere}
/* tables */
.iss-table-wrap{min-width:0}
.iss-shell .iss-table-caption{font-size:17px;margin:0 0 8px}
.iss-table-tools{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin:4px 0 10px}
.iss-table-tools label{display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:14px}
.iss-table-tools input,.iss-table-tools select{padding:8px 10px;min-height:44px;border:1px solid #64748B;border-radius:8px;font:inherit;font-weight:400;background:#fff;color:#0F172A;max-width:100%}
.iss-table-tools input{min-width:200px}
.iss-table-status{font-size:14px;color:#475569;flex:1 1 220px}
.iss-chip{display:inline-flex;align-items:center;gap:8px;font-size:14px}
.iss-chip [data-chip-text]{font-weight:600;color:#0F172A}
.iss-btn{border:1px solid #64748B;background:#fff;border-radius:999px;padding:8px 16px;min-height:44px;font:inherit;font-size:14px;cursor:pointer;color:#0F172A}
.iss-btn:hover{background:#F1F5F9}
.iss-table-scroll{overflow-x:auto;max-width:100%;border-radius:8px}
.iss-shell .iss-table{font-size:14px;min-width:100%}
.iss-shell .iss-table th{padding:8px;font-size:13px}
.iss-shell .iss-table td{padding:8px;overflow-wrap:break-word;word-break:normal}
.iss-shell .iss-table td.num,.iss-shell .iss-table th.num{white-space:nowrap}
.iss-table-more{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.iss-sort{all:unset;cursor:pointer;font-weight:700;display:inline-flex;align-items:center;min-height:44px;box-sizing:border-box}
.iss-sort:focus-visible{outline:3px solid #4EAF60;outline-offset:2px}
th[aria-sort=ascending] .iss-sort-ind::after{content:" \\25B2"}th[aria-sort=descending] .iss-sort-ind::after{content:" \\25BC"}
details.iss-expl{font-size:15px;border-radius:12px;padding:0 14px;background:#fff;border:1px solid #E2E8F0}
details.iss-expl summary{cursor:pointer;display:flex;flex-direction:column;justify-content:center;gap:2px;min-height:44px;padding:8px 0}
details.iss-expl[open] summary{padding-bottom:4px}
.iss-expl-title{font-weight:700;color:#0F172A}.iss-expl-summary{font-size:14px;color:#475569}
.iss-tools{display:flex;gap:8px;margin:0 0 12px;flex-wrap:wrap}
.iss-shell .iss-chart--bar svg{max-width:min(100%,460px);width:100%;height:auto;display:block}
.iss-shell .iss-chart--donut{flex-wrap:wrap}
.iss-shell .iss-chart--donut svg{width:140px;height:140px}
.iss-shell .iss-legend{font-size:14px}
.iss-chart [role=button]{cursor:pointer}
.iss-chart [role=button]:focus-visible{outline:3px solid #0F172A;outline-offset:2px}
.iss-chart [aria-pressed=true]{stroke:#0F172A;stroke-width:2.5;stroke-dasharray:none}
.iss-chart-data{font-size:14px;margin-top:8px}
.iss-tip{position:absolute;pointer-events:none;background:#0F172A;color:#fff;font-size:12px;padding:4px 8px;border-radius:6px;opacity:0;transition:opacity .15s;z-index:30}
.iss-meta{font-size:12px;color:#475569;margin-top:24px;overflow-wrap:anywhere}
html:not([data-js]) .iss-js-only{display:none !important}
html:not([data-js]) .iss-chart-data[hidden]{display:table}
.iss-js-only[hidden]{display:none !important}
@media (max-width:960px){.iss-shell{padding:12px 16px 40px}}
@media (max-width:600px){
.iss-shell{padding:8px 12px 32px}
.iss-head{grid-template-columns:1fr;padding:16px;gap:10px}.iss-head>*{grid-column:1/-1 !important}
.iss-hf--document-header{text-align:left}
.iss-sec-body{grid-template-columns:1fr}.iss-sec-body>*{grid-column:1/-1 !important}
.iss-card{padding:14px}
.iss-shell .iss-row{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.iss-shell .iss-metric{padding:10px 12px}
.iss-shell .iss-metric-value{font-size:19px}.iss-shell .iss-metric--secondary .iss-metric-value{font-size:17px}
.iss-shell .iss-banner{font-size:18px}
.iss-bar-main{padding:6px 12px;gap:8px}
.iss-bar-id{flex-direction:column;gap:0}
.iss-bar-issuer{font-size:12px;color:#475569;font-weight:700}
.iss-bar-fact{font-size:12px}.iss-bar-fact strong{font-size:16px}
.iss-bar-action{padding:6px 12px;font-size:13px;max-width:44%}
.iss-menu{padding:0 12px}
.iss-secd>summary{cursor:pointer;padding:0 4px;border-bottom:1px solid #CBD5E1}
.iss-chev{display:inline-block;width:10px;height:10px;border-right:2px solid #0F172A;border-bottom:2px solid #0F172A;transform:rotate(45deg);margin-right:6px;transition:transform .15s}
.iss-secd[open]>summary .iss-chev{transform:rotate(-135deg)}
.iss-table-tools{flex-direction:column;align-items:stretch}.iss-table-tools label{flex-direction:column;align-items:stretch;gap:4px}.iss-table-tools input{min-width:0;width:100%}
.iss-shell .iss-table th{padding:6px}.iss-shell .iss-table td{padding:8px 6px}
.iss-btn{flex:1 1 auto}
}
@media (max-width:340px){.iss-shell .iss-row{grid-template-columns:minmax(0,1fr)}.iss-bar-action{max-width:none}.iss-bar-main{flex-wrap:wrap}}
@media (pointer:coarse){.iss-menu a,.iss-btn,.iss-sort{min-height:44px}}
@media (prefers-reduced-motion:reduce){*{transition:none !important;scroll-behavior:auto !important}}
@media (forced-colors:active){.iss-menu a[aria-current]{outline:2px solid CanvasText}.iss-chart [aria-pressed=true]{stroke:CanvasText}}`;
}

type SectionKey = 'summary' | 'message' | 'data' | 'notices';

/** Renders the interactive, standalone responsive HTML communication (no external assets or scripts). */
export function renderInteractiveHtml(res: Resolution, project: Project, opts?: InteractiveHtmlOptions): string {
  const strings = resolveHtmlStrings(opts?.strings);
  const T = (k: HtmlStringKey, v?: Record<string, string | number>) => esc(fmtString(strings[k], v));
  const mode: RenderMode = { target: 'html', project, strings };
  const isEob = project.documentType === 'eob';
  const accent = project.issuer?.accent ?? '#277656';
  const issuer = project.issuer?.name ?? project.title;
  const visibleHtml = (n: RNode) => n.visible && !n.layout?.html?.hidden;
  const renderNested = (n: RNode): string => (visibleHtml(n) ? `<div class="iss-node" ${nodeDataAttrs(n)}>${inner(n)}</div>` : '');
  const CAT_KEYS = ['merchant', 'category'];
  const inner = (n: RNode): string => {
    if (n.type === 'repeating-table') {
      const id = esc(n.id);
      const t = n.table!;
      const cat = t.columns.find((c) => CAT_KEYS.includes(c.key));
      const values = cat ? [...new Set(t.rows.map((r) => r.cells[cat.key]?.display ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b)) : [];
      const quick = cat && values.length > 1
        ? `<label class="iss-js-only">${esc(cat.label)} <select data-table-quick="${id}"><option value="">${T('tableQuickAll')}</option>${values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select></label>`
        : '';
      const chip = cat ? `<span class="iss-chip iss-js-only" data-table-chip="${id}" hidden><span data-chip-text></span><button type="button" class="iss-btn">${T('tableClearFilter')}</button></span>` : '';
      const tools = `<div class="iss-table-tools" data-table-tools="${id}"${cat ? ` data-cat-key="${esc(cat.key)}" data-cat-label="${esc(cat.label)}"` : ''}>${t.filterable ? `<label class="iss-js-only">${T('tableFilterLabel')} <input type="search" data-table-filter="${id}" aria-label="${T('tableFilterAria', { caption: t.caption })}" placeholder="${T('tableFilterPlaceholder')}"/></label>` : ''}${quick}${chip}<span class="iss-table-status" data-table-status="${id}" aria-live="polite"></span></div>`;
      const more = `<div class="iss-table-more iss-js-only" data-table-more-bar="${id}" hidden><button type="button" class="iss-btn" data-table-more="${id}">${T('tableShowMore')}</button><button type="button" class="iss-btn" data-table-all="${id}">${T('tableShowAll')}</button></div>`;
      const scroll = `<div class="iss-table-scroll" tabindex="0" role="region" aria-label="${esc(t.caption)}">`;
      return nodeInnerHtml(n, mode, renderNested).replace('<table', () => `${tools}${scroll}<table`).replace('</table>', () => `</table></div>${more}`);
    }
    if (n.type === 'chart') {
      const tid = `chart-data-${esc(n.id)}`;
      const rows = n.chart!.data.map((d) => `<tr><th scope="row">${esc(d.label)}</th><td class="num">${esc(d.display)}</td></tr>`).join('');
      // bars are focusable/activatable, so the svg is a labelled group rather than a presentational image
      const figure = nodeInnerHtml(n, mode, renderNested).replace('<svg viewBox', '<svg data-iss-chart viewBox').replace(/(<svg data-iss-chart[^>]*?) role="img"/, '$1 role="group"');
      return figure + (n.chart!.data.length ? `<button class="iss-btn iss-js-only" type="button" data-chart-toggle="${tid}" aria-expanded="false" aria-controls="${tid}">${T('chartShowData')}</button><table class="iss-table iss-chart-data" id="${tid}" hidden><caption class="iss-sr">${esc(n.chart!.title)}</caption><tbody>${rows}</tbody></table>` : '');
    }
    return nodeInnerHtml(n, mode, renderNested);
  };
  const card = (n: RNode, span?: number) => {
    const sp = Math.max(1, Math.min(12, span ?? n.layout?.html?.span ?? 12));
    const plain = n.type === 'container' || n.type === 'shape' || n.type === 'header-footer' || n.type === 'image' || (n.type === 'disclosure' && n.disclosure?.contentPartId === 'not-a-bill-banner');
    return `<div class="iss-node iss-card${plain ? ' iss-plain' : ''}" ${nodeDataAttrs(n)} style="grid-column:span ${sp}">${inner(n)}</div>`;
  };
  const walk = (n: RNode, f: (x: RNode) => void) => { f(n); n.children.forEach((c) => walk(c, f)); };
  const has = (n: RNode, pred: (x: RNode) => boolean) => { let hit = false; walk(n, (x) => { if (pred(x)) hit = true; }); return hit; };

  const areas: Record<string, RNode[]> = { header: [], main: [], aside: [], footer: [] };
  for (const n of res.root.children) {
    if (!visibleHtml(n)) continue;
    areas[n.layout?.html?.area ?? 'main'].push(n);
  }
  for (const k of Object.keys(areas)) areas[k].sort((a, b) => (a.layout?.html?.order ?? 0) - (b.layout?.html?.order ?? 0));

  /* group the body content into the sections of the in-page menu */
  const isBanner = (n: RNode) => n.type === 'disclosure' && n.disclosure?.contentPartId === 'not-a-bill-banner';
  const sectionOf = (n: RNode): SectionKey | 'foot' | 'pre' => {
    switch (n.type) {
      case 'header-footer': return 'foot';
      case 'disclosure': return isBanner(n) ? 'pre' : 'notices';
      case 'expandable-explanation': return 'notices';
      case 'repeating-table': case 'chart': return 'data';
      case 'variant-set': case 'conditional-region': case 'rich-text': case 'action-link': case 'qr-code': return 'message';
      case 'container':
        if (has(n, (x) => x.type === 'summary-metric' || x.type === 'bound-field')) return 'summary';
        if (has(n, (x) => x.type === 'action-link' || x.type === 'qr-code')) return 'message';
        if (has(n, (x) => x.type === 'disclosure')) return 'notices';
        return 'summary';
      default: return 'summary';
    }
  };
  const groups: Record<SectionKey | 'foot' | 'pre', string[]> = { summary: [], message: [], data: [], notices: [], foot: [], pre: [] };
  const nodes: Record<SectionKey, RNode[]> = { summary: [], message: [], data: [], notices: [] };
  const bodyNodes = [...areas.main.map((n) => ({ n, span: undefined as number | undefined })), ...areas.aside.map((n) => ({ n, span: 12 })), ...areas.footer.map((n) => ({ n, span: undefined as number | undefined }))];
  const sorted = [...bodyNodes.filter((x) => x.n.type === 'chart'), ...bodyNodes.filter((x) => x.n.type !== 'chart')];
  for (const { n, span } of sorted) {
    const k = sectionOf(n);
    groups[k].push(card(n, span));
    if (k in nodes) nodes[k as SectionKey].push(n);
  }
  // charts first inside the data section, so a bar filters the table right below it
  const dataLabel = isEob ? 'sectionClaims' : 'sectionTransactions';
  const defs: Array<{ key: SectionKey; label: HtmlStringKey; open: boolean }> = [
    { key: 'summary', label: 'sectionSummary', open: true },
    { key: 'message', label: 'sectionMessage', open: true },
    { key: 'data', label: dataLabel, open: false },
    { key: 'notices', label: 'sectionNotices', open: false },
  ];
  const present = defs.filter((d) => groups[d.key].length);
  const hasExpl = nodes.notices.some((n) => n.type === 'expandable-explanation');
  const sectionHtml = (d: (typeof defs)[number]): string => {
    const sid = `sec-${d.key}`;
    const protectedSection = nodes[d.key].some((n) => has(n, (x) => x.type === 'disclosure'));
    const expand = d.key === 'notices' && hasExpl ? `<div class="iss-tools iss-js-only"><button class="iss-btn" type="button" data-action="expand-all" aria-expanded="false">${T('expandAll')}</button></div>` : '';
    const body = `<div class="iss-sec-body">${groups[d.key].join('')}</div>`;
    if (protectedSection) return `<section class="iss-sec" id="${sid}" data-section="${d.key}" aria-labelledby="${sid}-h"><h2 class="iss-sec-title" id="${sid}-h">${T(d.label)}</h2>${expand}${body}</section>`;
    return `<section class="iss-sec" id="${sid}" data-section="${d.key}" aria-labelledby="${sid}-h"><details class="iss-secd" open data-default-open="${d.open ? 1 : 0}"><summary><h2 class="iss-sec-title" id="${sid}-h">${T(d.label)}</h2><span class="iss-chev" aria-hidden="true"></span></summary>${body}</details></section>`;
  };

  /* sticky bar: repeated facts are presentation only (aria-hidden, no data-node-id / data-cents) */
  const all: RNode[] = [];
  walk(res.root, (n) => { if (visibleHtml(n)) all.push(n); });
  const metric = (pred: (n: RNode) => boolean) => all.find((n) => n.field && pred(n));
  let fact = '';
  if (isEob) {
    const resp = metric((n) => n.field!.path === 'claim.patientResponsibilityCents' && n.type === 'summary-metric') ?? metric((n) => n.id === 'member-responsibility');
    fact = `<span class="iss-bar-fact"><strong>${T('barNotBill')}</strong></span>${resp ? `<span class="iss-bar-fact"><span class="iss-bar-label">${esc(resp.field!.label)}</span> <strong>${esc(resp.field!.display)}</strong></span>` : ''}`;
  } else {
    const due = metric((n) => n.id === 'payment-due') ?? metric((n) => n.type === 'summary-metric' && n.field!.importance === 'primary' && /minimum|due/i.test(n.field!.label));
    const date = metric((n) => n.id === 'payment-due-date') ?? metric((n) => n.type === 'bound-field' && /due date/i.test(n.field!.label));
    if (due) fact = `<span class="iss-bar-fact"><span class="iss-bar-label">${esc(due.field!.label)}</span> <strong>${esc(due.field!.display)}</strong>${date && !date.field!.missing ? ` <span class="iss-bar-date">${T('barDueOn', { date: date.field!.display })}</span>` : ''}</span>`;
  }
  const actionNode = all.find((n) => n.type === 'action-link' && n.action?.url && /^https:\/\//i.test(n.action.url));
  const barAction = actionNode ? `<a class="iss-button iss-bar-action" href="${esc(actionNode.action!.url)}" rel="noopener noreferrer" target="_blank">${esc(actionNode.action!.label)}</a>` : '';
  const menu = present.length > 1 ? `<nav class="iss-menu" aria-label="${T('menuLabel')}" data-iss-menu><ul>${present.map((d) => `<li><a href="#sec-${d.key}">${T(d.label)}</a></li>`).join('')}</ul></nav>` : '';
  const bar = `<div class="iss-bar" role="region" aria-label="${T('barLabel')}" data-iss-bar><div class="iss-bar-main"><div class="iss-bar-id" aria-hidden="true"><span class="iss-bar-issuer">${esc(issuer)}</span>${fact}</div>${barAction}</div>${menu}</div>`;

  const title = fmtString(strings[isEob ? 'docTitleEob' : 'docTitleStatement'], { issuer });
  const manifestJson = JSON.stringify({ runId: res.runId, contentDigest: res.contentDigest, renderer: HTML_RENDERER_VERSION, resolverManifest: res.semanticManifest }).replace(/</g, '\\u003c');
  const stringsJson = JSON.stringify(strings).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="${esc(res.locale)}" data-run-id="${esc(res.runId)}" data-profile="html-responsive" data-renderer="${HTML_RENDERER_VERSION}">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<meta name="description" content="${T(isEob ? 'metaDescriptionEob' : 'metaDescriptionStatement')}"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"/>
<style>${htmlCss(accent, project)}
${documentCss(accent, project)}
${screenOverrides()}</style></head>
<body>
<a class="iss-skip" href="#iss-main">${T('skipToContent')}</a>
<aside class="iss-demo-ribbon" aria-label="${T('syntheticNoticeLabel')}">${T('syntheticNotice', { issuer: project.issuer?.name ?? '' })}${isEob ? T('syntheticNoticeNotBill') : ''}</aside>
${bar}
<div class="iss-shell">
<header class="iss-head" aria-label="${T('documentHeaderLabel')}">${areas.header.map((n) => card(n)).join('').replace(/<h2>([\s\S]*?)<\/h2>/, '<h1>$1</h1>')}</header>
<main id="iss-main" aria-label="${T('mainLabel')}">
${groups.pre.length ? `<div class="iss-pre iss-sec-body">${groups.pre.join('')}</div>` : ''}
${present.map(sectionHtml).join('\n')}
</main>
<footer class="iss-foot">${groups.foot.join('')}
<p class="iss-meta">${T('composedBy', { run: res.runId, digest: res.contentDigest.slice(0, 16), rules: res.rulesDigest.slice(0, 12), model: res.modelVersion })}</p>
</footer>
</div>
<script type="application/json" id="iss-semantic-manifest">${manifestJson}</script>
<script type="application/json" id="iss-strings">${stringsJson}</script>
<script>${INTERACTION_JS}</script>
</body></html>`;
}

/** Placeholder for rules that must win over the shared document stylesheet (kept after it). */
function screenOverrides(): string {
  return `.iss-shell .iss-row{display:grid}.iss-shell .iss-metric,.iss-shell .iss-metric-label,.iss-shell .iss-metric-value{box-sizing:border-box}.iss-shell .iss-disclosure .iss-version{position:static}`;
}
