/**
 * Browser-side composition scripts, embedded as plain JavaScript strings so the exact same code
 * runs in headless Chromium (PDF composition) and in any preview iframe.
 *
 * PAGINATOR_JS: measures every flow block in real browser layout and distributes it into
 * physical US-Letter pages (pt geometry), splitting repeating tables row by row, repeating
 * headings where configured, honouring keep-with-next, fixed anchors and continuation policy.
 * The resulting page tree is the single source of truth for page counts and overflow findings.
 *
 * EXTRACTOR_JS: reads the semantic manifest back out of a rendered DOM (paged or interactive),
 * so parity is checked against what each output actually contains.
 */

export const PAGINATOR_JS = String.raw`
(function () {
  var PX = 4 / 3; // CSS px per pt
  function pt(px) { return Math.round((px / PX) * 10) / 10; }
  function compose() {
    var t0 = (window.performance && performance.now()) || 0;
    var cfg = JSON.parse(document.getElementById('iss-layout').textContent);
    var source = document.getElementById('iss-source');
    var pagesEl = document.getElementById('iss-pages');
    var fixed = Array.prototype.slice.call(source.querySelectorAll(':scope > .iss-fixed'));
    var blocks = Array.prototype.slice.call(source.querySelectorAll(':scope > .iss-block'));
    var pages = [];
    var diagnostics = [];
    var page = null;

    function addDiag(d) { diagnostics.push(d); }

    function newPage() {
      var index = pages.length + 1;
      var el = document.createElement('div');
      el.className = 'page';
      el.setAttribute('data-page', String(index));
      var top = index === 1 ? cfg.firstPageTopPt : cfg.otherPagesTopPt;
      var bottom = cfg.bottomPt;
      var fixedIds = [];
      fixed.forEach(function (f) {
        var where = f.getAttribute('data-pages') || 'first';
        if (where === 'first' && index !== 1) return;
        if (where === 'following' && index === 1) return;
        var c = f.cloneNode(true);
        el.appendChild(c);
        fixedIds.push(f.getAttribute('data-node-id'));
        var fx = parseFloat(f.getAttribute('data-x')), fy = parseFloat(f.getAttribute('data-y'));
        var fw = parseFloat(f.getAttribute('data-w')), fh = parseFloat(f.getAttribute('data-h'));
        var horiz = fx < cfg.leftPt + cfg.widthPt && fx + fw > cfg.leftPt;
        var vert = fy < bottom && fy + fh > top;
        if (horiz && vert && f.getAttribute('data-chrome') !== '1') {
          if (fy + fh / 2 < (top + bottom) / 2) top = Math.max(top, fy + fh + 6); else bottom = Math.min(bottom, fy - 6);
          addDiag({ code: 'FIXED_FLOW_ADJUSTED', severity: 'warning', nodeId: f.getAttribute('data-node-id'), page: index,
            message: 'Fixed element ' + f.getAttribute('data-node-id') + ' overlaps the flow region on page ' + index + '; flowing content was kept clear of it (no silent overlap).' });
        }
      });
      var flow = document.createElement('div');
      flow.className = 'iss-flow';
      flow.style.left = cfg.leftPt + 'pt';
      flow.style.top = top + 'pt';
      flow.style.width = cfg.widthPt + 'pt';
      flow.style.height = (bottom - top) + 'pt';
      el.appendChild(flow);
      if (cfg.watermark) { var wm = document.createElement('div'); wm.className = 'iss-watermark'; wm.textContent = cfg.watermark; el.appendChild(wm); }
      pagesEl.appendChild(el);
      page = { index: index, el: el, flow: flow, limitPx: (bottom - top) * PX, topPt: top, bottomPt: bottom, nodeIds: [], tables: {}, fixedNodeIds: fixedIds };
      pages.push(page);
      return page;
    }

    function bottomOf(el) { return el.offsetTop + el.offsetHeight; }
    function fits(el) { return bottomOf(el) <= page.limitPx + 0.5; }
    function isEmpty() { return page.flow.children.length === 0; }
    function setSpace(el) {
      var sb = parseFloat(el.getAttribute('data-space-before') || '0');
      el.style.marginTop = (isEmpty() ? 0 : sb) + 'pt';
    }
    function note(id) { if (page.nodeIds.indexOf(id) < 0) page.nodeIds.push(id); }

    function placeTable(block) {
      var id = block.getAttribute('data-node-id');
      var continuation = block.getAttribute('data-continuation') === '1';
      var repeatHeader = block.getAttribute('data-repeat-header') === '1';
      var wrap = block.querySelector('.iss-table-wrap');
      var caption = wrap.querySelector('.iss-table-caption');
      var table = wrap.querySelector('table');
      var thead = table.querySelector('thead');
      var tfoot = table.querySelector('tfoot');
      var rows = Array.prototype.slice.call(table.querySelector('tbody').children);
      var chunkNo = 0;
      var placedTotal = 0;
      function makeChunk() {
        var b = block.cloneNode(false);
        var w = wrap.cloneNode(false);
        var cap = caption.cloneNode(true);
        if (chunkNo > 0) { cap.textContent = caption.textContent + ' ' + ((cfg.strings && cfg.strings.tableContinued) || '(continued)'); b.setAttribute('data-continued', '1'); }
        w.appendChild(cap);
        var tb = table.cloneNode(false);
        var headerShown = chunkNo === 0 || repeatHeader;
        if (headerShown) tb.appendChild(thead.cloneNode(true));
        var body = document.createElement('tbody');
        tb.appendChild(body);
        w.appendChild(tb);
        b.appendChild(w);
        return { el: b, body: body, table: tb, headerShown: headerShown };
      }
      while (true) {
        var chunk = makeChunk();
        setSpace(chunk.el);
        page.flow.appendChild(chunk.el);
        if (!fits(chunk.el) && !isEmpty() && page.flow.children.length > 1) {
          page.flow.removeChild(chunk.el); newPage(); continue;
        }
        var placedHere = 0;
        while (rows.length) {
          chunk.body.appendChild(rows[0]);
          if (!fits(chunk.el) && !(placedHere === 0 && page.flow.children.length === 1)) { chunk.body.removeChild(rows[0]); break; }
          rows.shift(); placedHere++;
          if (!fits(chunk.el)) { addDiag({ code: 'ROW_TALLER_THAN_REGION', severity: 'error', nodeId: id, page: page.index, message: 'A single row of ' + id + ' is taller than the flow region on page ' + page.index + '.' }); break; }
        }
        if (placedHere === 0 && rows.length && page.flow.children.length > 1) { page.flow.removeChild(chunk.el); newPage(); continue; }
        placedTotal += placedHere;
        var rowEls = chunk.body.querySelectorAll('tr[data-row-id]');
        page.tables[id] = { rows: placedHere, firstRowId: rowEls.length ? rowEls[0].getAttribute('data-row-id') : null, lastRowId: rowEls.length ? rowEls[rowEls.length - 1].getAttribute('data-row-id') : null, continued: chunkNo > 0, headerRepeated: chunkNo > 0 && chunk.headerShown };
        note(id);
        if (!rows.length) {
          if (tfoot) {
            var tf = tfoot.cloneNode(true);
            chunk.table.appendChild(tf);
            if (!fits(chunk.el)) {
              chunk.table.removeChild(tf);
              if (continuation && placedHere > 1) {
                var last = chunk.body.lastElementChild; chunk.body.removeChild(last); rows.push(last); placedTotal--; page.tables[id].rows--;
                newPage(); chunkNo++; continue;
              }
              addDiag({ code: 'TABLE_TOTAL_CLIPPED', severity: 'error', nodeId: id, page: page.index, message: 'The total row of ' + id + ' does not fit on page ' + page.index + '.' });
            }
          }
          return;
        }
        if (!continuation) {
          chunk.el.classList.add('iss-overflow');
          var marker = document.createElement('div');
          marker.className = 'iss-overflow-marker';
          marker.textContent = 'Overflow: ' + rows.length + ' row(s) of ' + id + ' cannot be placed — continuation is disabled for this flow region.';
          page.el.appendChild(marker);
          addDiag({ code: 'FLOW_OVERFLOW_NO_CONTINUATION', severity: 'blocking', nodeId: id, page: page.index, rowsPlaced: placedTotal, rowsClipped: rows.length,
            message: 'Repeating table ' + id + ' overflows the flow region on page ' + page.index + ': ' + rows.length + ' of ' + (placedTotal + rows.length) + ' rows cannot be placed because continuation is disabled.' });
          return;
        }
        newPage();
        chunkNo++;
      }
    }

    newPage();
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var id = b.getAttribute('data-node-id');
      if (b.getAttribute('data-splittable') === '1') { placeTable(b); continue; }
      setSpace(b);
      page.flow.appendChild(b);
      var keep = b.getAttribute('data-keep-with-next') === '1' && i + 1 < blocks.length;
      if (keep && fits(b)) {
        var probe = blocks[i + 1].cloneNode(true);
        probe.style.marginTop = (blocks[i + 1].getAttribute('data-space-before') || 0) + 'pt';
        if (blocks[i + 1].getAttribute('data-splittable') === '1') { var pb = probe.querySelectorAll('tbody tr'); for (var k = 2; k < pb.length; k++) pb[k].parentNode.removeChild(pb[k]); }
        page.flow.appendChild(probe);
        var together = fits(probe);
        page.flow.removeChild(probe);
        if (!together && page.flow.children.length > 1) { page.flow.removeChild(b); newPage(); setSpace(b); page.flow.appendChild(b); }
      }
      if (!fits(b) && page.flow.children.length > 1) { page.flow.removeChild(b); newPage(); setSpace(b); page.flow.appendChild(b); }
      if (!fits(b)) {
        b.classList.add('iss-overflow');
        addDiag({ code: 'BLOCK_OVERFLOW', severity: 'error', nodeId: id, page: page.index, message: id + ' is taller than the flow region on page ' + page.index + ' and is clipped.' });
      }
      note(id);
    }

    // Orphaned heading post-check (bounded): heading-only block last on a page, content continues next page.
    pages.forEach(function (p, idx) {
      var kids = p.flow.children;
      if (!kids.length || idx === pages.length - 1) return;
      var lastEl = kids[kids.length - 1];
      if (lastEl.getAttribute('data-heading-only') === '1') addDiag({ code: 'ORPHANED_HEADING', severity: 'warning', nodeId: lastEl.getAttribute('data-node-id'), page: p.index, message: 'Heading ' + lastEl.getAttribute('data-node-id') + ' ends page ' + p.index + ' while its content continues on page ' + (p.index + 1) + '. Enable keep-with-next.' });
    });

    var total = pages.length;
    pagesEl.querySelectorAll('.iss-page-number').forEach(function (s) {
      var pg = s.closest('.page'); s.textContent = ((cfg.strings && cfg.strings.pageOf) || 'Page {page} of {total}').replace('{page}', pg.getAttribute('data-page')).replace('{total}', total);
    });
    source.parentNode.removeChild(source);
    var result = {
      engine: 'iss-paged-composer/1', pageCount: total, diagnostics: diagnostics, durationMs: Math.round(((window.performance && performance.now()) || 0) - t0),
      pages: pages.map(function (p) { return { index: p.index, nodeIds: p.nodeIds, fixedNodeIds: p.fixedNodeIds, tables: p.tables, flowTopPt: p.topPt, flowBottomPt: p.bottomPt, usedPt: p.flow.lastElementChild ? pt(bottomOf(p.flow.lastElementChild)) : 0 }; })
    };
    window.__ISS_COMPOSITION__ = result;
    document.documentElement.setAttribute('data-composed', '1');
  }
  function start() {
    try { compose(); } catch (e) { window.__ISS_COMPOSITION__ = { error: String(e && e.stack || e) }; document.documentElement.setAttribute('data-composed', 'error'); }
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start); else window.addEventListener('load', start);
})();
`;

export const EXTRACTOR_JS = String.raw`
(function () {
  var out = { visibleNodeIds: [], money: {}, guardedLiabilityNodeIds: [], disclosures: [], selectedVariants: {}, tableRows: {}, tableTotalsCents: {}, actions: [], identity: {} };
  var seen = {}, guarded = {}, disc = {}, acts = {};
  var all = document.querySelectorAll('[data-node-id]');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.closest('#iss-source')) continue;
    var id = el.getAttribute('data-node-id');
    if (el.getAttribute('data-decorative') !== '1' && el.getAttribute('data-node-type') !== 'container') seen[id] = 1;
    if (el.hasAttribute('data-cents') && !(id in out.money)) out.money[id] = parseInt(el.getAttribute('data-cents'), 10);
    if (el.getAttribute('data-guarded') === '1') guarded[id] = 1;
    if (el.hasAttribute('data-disclosure-hash') && !disc[id]) { disc[id] = 1; out.disclosures.push({ nodeId: id, contentPartId: el.getAttribute('data-content-part'), version: parseInt(el.getAttribute('data-version'), 10), contentHash: el.getAttribute('data-disclosure-hash') }); }
    if (el.hasAttribute('data-variant-set')) { var sv = el.getAttribute('data-selected-variant'); out.selectedVariants[id] = sv ? sv : null; }
    if (el.hasAttribute('data-action-url') && !acts[id]) { acts[id] = 1; out.actions.push({ nodeId: id, url: el.getAttribute('data-action-url') }); }
  }
  var tables = {};
  document.querySelectorAll('table[data-table-id]').forEach(function (t) {
    if (t.closest('#iss-source')) return;
    var id = t.getAttribute('data-table-id');
    tables[id] = tables[id] || {};
    t.querySelectorAll('tbody tr[data-row-id]').forEach(function (r) { tables[id][r.getAttribute('data-row-id')] = 1; });
    var tot = t.querySelector('[data-table-total-cents]');
    if (tot) out.tableTotalsCents[id] = parseInt(tot.getAttribute('data-table-total-cents'), 10);
  });
  Object.keys(tables).forEach(function (k) { out.tableRows[k] = Object.keys(tables[k]).length; });
  function tok(path) { var e = document.querySelector('[data-path="' + path + '"]'); return e ? e.textContent.trim() : null; }
  var g = tok('customer.givenName'), f = tok('customer.familyName');
  if (g || f) out.identity.name = ((g || '') + ' ' + (f || '')).trim();
  var acct = tok('card.maskedAccount'); if (acct) out.identity.account = acct;
  var mem = tok('member.memberId'); if (mem) out.identity.memberId = mem;
  out.visibleNodeIds = Object.keys(seen).sort();
  out.guardedLiabilityNodeIds = Object.keys(guarded).sort();
  out.disclosures.sort(function (a, b) { return a.nodeId < b.nodeId ? -1 : 1; });
  out.text = (document.body.innerText || '').slice(0, 200000);
  return out;
})()
`;
