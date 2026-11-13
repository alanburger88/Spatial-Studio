/**
 * PAGINATOR_JS_V2: the page-design composer (roadmap wave 2), embedded as a plain JavaScript string like PAGINATOR_JS
 * so the same code runs in headless Chromium (PDF, the runnable package) and in any preview.
 *
 * It is used only for a document whose page design or components use something PAGINATOR_JS does not know: another
 * paper or orientation, page templates (own flow areas, columns, backgrounds, a Last page template), keep together,
 * a break before a component, spanning all columns, text that splits by lines, fixed items on the last page.
 * Every other document keeps composing with PAGINATOR_JS, byte for byte, so its pages, PDF and fingerprints do not move.
 *
 * What it adds, all switched on by the document:
 * - every page takes its flow area, columns, gap and background from its page template (First page, Following pages,
 *   Last page). A one-page document with a Last page template uses the First page flow area, kept clear of the Last
 *   page area's top and bottom, and carries the fixed items of both;
 * - the Last page template: the document is composed, then composed again with its final page on the Last page
 *   template, until the page count holds (deterministic; in practice two passes). When the content fits the Following
 *   pages area but not the Last page area, the last page carries only its fixed items;
 * - columns are filled one after another, then the next page. Columns are not balanced. A component that spans the
 *   columns starts below the longest column above it, and the next columns start below it;
 * - keep together, start on a new page or column, and text that splits line by line with a minimum number of lines
 *   left behind (orphans) and carried over (widows).
 */
export const PAGINATOR_JS_V2 = String.raw`
(function () {
  var PX = 4 / 3; // CSS px per pt
  function pt(px) { return Math.round((px / PX) * 10) / 10; }
  function compose() {
    var t0 = (window.performance && performance.now()) || 0;
    var cfg = JSON.parse(document.getElementById('iss-layout').textContent);
    var pagesEl = document.getElementById('iss-pages');
    var source = document.getElementById('iss-source');
    var pristine = cfg.templates.last ? source.cloneNode(true) : null;
    var pages, diagnostics, page, fixed, blocks, lastIndex = null;

    function addDiag(d) { diagnostics.push(d); }

    function templateFor(index) {
      var T = cfg.templates;
      if (lastIndex !== null && index === lastIndex && T.last) {
        if (index !== 1) return { name: 'last', t: T.last };
        var f = T.first, l = T.last;
        var top = Math.max(f.y, l.y), bottom = Math.min(f.y + f.h, l.y + l.h);
        if (bottom - top < 36) { top = f.y; bottom = f.y + f.h; }
        return { name: 'first+last', t: { x: f.x, y: top, w: f.w, h: bottom - top, columns: f.columns, gap: f.gap, bg: f.bg } };
      }
      return index === 1 ? { name: 'first', t: T.first } : { name: 'following', t: T.following };
    }
    function fixedShown(where, index, tplName) {
      if (where === 'all') return true;
      if (where === 'first') return index === 1;
      if (where === 'following') return index !== 1;
      if (where === 'last') return tplName === 'last' || tplName === 'first+last';
      return false;
    }

    function newPage() {
      var index = pages.length + 1;
      var tp = templateFor(index), t = tp.t;
      var el = document.createElement('div');
      el.className = 'page';
      el.setAttribute('data-page', String(index));
      el.setAttribute('data-template', tp.name);
      if (t.bg) {
        // Decoration: no node id (not in the semantic manifest or parity), hidden from assistive technology.
        var bg = document.createElement('div');
        bg.className = 'iss-bg iss-bg--' + t.bg;
        bg.setAttribute('aria-hidden', 'true');
        el.appendChild(bg);
      }
      var top = t.y, bottom = t.y + t.h;
      var fixedIds = [];
      fixed.forEach(function (f) {
        if (!fixedShown(f.getAttribute('data-pages') || 'first', index, tp.name)) return;
        var c = f.cloneNode(true);
        el.appendChild(c);
        fixedIds.push(f.getAttribute('data-node-id'));
        var fx = parseFloat(f.getAttribute('data-x')), fy = parseFloat(f.getAttribute('data-y'));
        var fw = parseFloat(f.getAttribute('data-w')), fh = parseFloat(f.getAttribute('data-h'));
        if (fx + fw > cfg.pageWidthPt + 0.01 || fy + fh > cfg.pageHeightPt + 0.01) addDiag({ code: 'FIXED_OFF_PAGE', severity: 'warning', nodeId: f.getAttribute('data-node-id'), page: index,
          message: 'Fixed element ' + f.getAttribute('data-node-id') + ' reaches outside the page on page ' + index + ' and is cut off.' });
        var horiz = fx < t.x + t.w && fx + fw > t.x;
        var vert = fy < bottom && fy + fh > top;
        if (horiz && vert && f.getAttribute('data-chrome') !== '1') {
          if (fy + fh / 2 < (top + bottom) / 2) top = Math.max(top, fy + fh + 6); else bottom = Math.min(bottom, fy - 6);
          addDiag({ code: 'FIXED_FLOW_ADJUSTED', severity: 'warning', nodeId: f.getAttribute('data-node-id'), page: index,
            message: 'Fixed element ' + f.getAttribute('data-node-id') + ' overlaps the flow region on page ' + index + '; flowing content was kept clear of it (no silent overlap).' });
        }
      });
      var flow = document.createElement('div');
      flow.className = 'iss-flow';
      flow.style.left = t.x + 'pt';
      flow.style.top = top + 'pt';
      flow.style.width = t.w + 'pt';
      flow.style.height = (bottom - top) + 'pt';
      el.appendChild(flow);
      if (cfg.watermark) { var wm = document.createElement('div'); wm.className = 'iss-watermark'; wm.textContent = cfg.watermark; el.appendChild(wm); }
      pagesEl.appendChild(el);
      var cols = Math.max(1, t.columns || 1);
      page = { index: index, el: el, flow: flow, template: tp.name, columns: cols, gapPt: t.gap || 0, widthPt: t.w, limitPx: (bottom - top) * PX, topPt: top, bottomPt: bottom, nodeIds: [], tables: {}, fixedNodeIds: fixedIds, band: null, cur: null, lastBlock: null, placed: 0 };
      if (cols === 1) page.cur = { el: flow, topPx: 0, kind: 'flow', spaced: false };
      pages.push(page);
      return page;
    }

    /* ---- containers: the flow area itself (one column), or columns and spanning strips stacked inside it */
    function makeBox(cls, leftPt, topPx, widthPt) {
      var d = document.createElement('div');
      d.className = cls;
      d.style.left = leftPt + 'pt';
      d.style.top = (topPx / PX) + 'pt';
      d.style.width = widthPt + 'pt';
      page.flow.appendChild(d);
      return d;
    }
    function colWidth() { return (page.widthPt - (page.columns - 1) * page.gapPt) / page.columns; }
    function openColumn(i, topPx) {
      var w = colWidth();
      var box = { el: makeBox('iss-col', i * (w + page.gapPt), topPx, w), topPx: topPx, kind: 'col', col: i, spaced: topPx > 0 };
      box.el.setAttribute('data-column', String(i + 1));
      page.band.cols.push(box);
      page.cur = box;
      return box;
    }
    function contentBottomPx(box) { var l = box.el.lastElementChild; return box.topPx + (l ? l.offsetTop + l.offsetHeight : 0); }
    function closeBand() {
      if (!page.band) return page.cur ? contentBottomPx(page.cur) : 0;
      var b = 0, used = false;
      page.band.cols.forEach(function (c) { if (c.el.children.length) used = true; b = Math.max(b, contentBottomPx(c)); });
      if (!used) { page.band.cols.forEach(function (c) { page.flow.removeChild(c.el); }); b = page.band.top; }
      page.band = null;
      return b;
    }
    function ensure(span) {
      if (page.columns === 1) return;
      var cur = page.cur;
      if (span) {
        if (cur && cur.kind === 'span') return;
        var top = cur ? closeBand() : 0;
        page.cur = { el: makeBox('iss-span', 0, top, page.widthPt), topPx: top, kind: 'span', spaced: top > 0 };
      } else {
        if (cur && cur.kind === 'col') return;
        var t2 = cur ? contentBottomPx(cur) : 0;
        if (cur && !cur.el.children.length) { page.flow.removeChild(cur.el); t2 = cur.topPx; }
        page.band = { top: t2, cols: [] };
        openColumn(0, t2);
      }
    }
    function isSpan(el) { return page.columns > 1 && el.getAttribute('data-span') === '1'; }
    /** Moves on: to the next column of this page when there is one, otherwise to a new page. */
    function advance(el) {
      var span = el.getAttribute('data-span') === '1';
      if (!span && page.cur && page.cur.kind === 'col' && page.cur.col + 1 < page.columns) openColumn(page.cur.col + 1, page.band.top);
      else newPage();
      ensure(isSpan(el));
    }
    function append(el) { page.cur.el.appendChild(el); }
    function remove(el) { if (el.parentNode) el.parentNode.removeChild(el); }

    function bottomOf(el) { return el.offsetTop + el.offsetHeight; }
    function fits(el) { return page.cur.topPx + bottomOf(el) <= page.limitPx + 0.5; }
    /** Something else is in this container, or above it on the page: moving on gives more room. */
    function others(el) { var n = page.cur.el.children.length - (el && el.parentNode === page.cur.el ? 1 : 0); return n > 0 || page.cur.topPx > 0; }
    function atTop() { return page.cur.el.children.length === 0 && !page.cur.spaced; }
    function setSpace(el) {
      var sb = parseFloat(el.getAttribute('data-space-before') || '0');
      el.style.marginTop = (atTop() ? 0 : sb) + 'pt';
    }
    function note(id, el) { if (page.nodeIds.indexOf(id) < 0) page.nodeIds.push(id); if (el) page.lastBlock = el; page.placed++; }
    function noteTable(id, info) {
      var prev = page.tables[id];
      if (!prev) { page.tables[id] = info; return; }
      prev.rows += info.rows; prev.lastRowId = info.lastRowId || prev.lastRowId; prev.headerRepeated = prev.headerRepeated || info.headerRepeated;
    }
    function nextPageRoomPx() { var t = templateFor(pages.length + 1).t; return t.h * PX; }

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
        if (headerShown && thead) tb.appendChild(thead.cloneNode(true));
        var body = document.createElement('tbody');
        tb.appendChild(body);
        w.appendChild(tb);
        b.appendChild(w);
        return { el: b, body: body, table: tb, headerShown: headerShown };
      }
      while (true) {
        var chunk = makeChunk();
        setSpace(chunk.el);
        append(chunk.el);
        if (!fits(chunk.el) && others(chunk.el)) { remove(chunk.el); advance(block); continue; }
        var placedHere = 0;
        while (rows.length) {
          chunk.body.appendChild(rows[0]);
          if (!fits(chunk.el) && !(placedHere === 0 && !others(chunk.el))) { chunk.body.removeChild(rows[0]); break; }
          rows.shift(); placedHere++;
          if (!fits(chunk.el)) { addDiag({ code: 'ROW_TALLER_THAN_REGION', severity: 'error', nodeId: id, page: page.index, message: 'A single row of ' + id + ' is taller than the flow region on page ' + page.index + '.' }); break; }
        }
        if (placedHere === 0 && rows.length && others(chunk.el)) { remove(chunk.el); advance(block); continue; }
        placedTotal += placedHere;
        var rowEls = chunk.body.querySelectorAll('tr[data-row-id]');
        noteTable(id, { rows: placedHere, firstRowId: rowEls.length ? rowEls[0].getAttribute('data-row-id') : null, lastRowId: rowEls.length ? rowEls[rowEls.length - 1].getAttribute('data-row-id') : null, continued: chunkNo > 0, headerRepeated: chunkNo > 0 && chunk.headerShown });
        note(id, chunk.el);
        if (!rows.length) {
          if (tfoot) {
            var tf = tfoot.cloneNode(true);
            chunk.table.appendChild(tf);
            if (!fits(chunk.el)) {
              chunk.table.removeChild(tf);
              if (continuation && placedHere > 1) {
                var last = chunk.body.lastElementChild; chunk.body.removeChild(last); rows.push(last); placedTotal--; page.tables[id].rows--;
                advance(block); chunkNo++; continue;
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
        advance(block);
        chunkNo++;
      }
    }

    /** Keep together: the whole component in one column or page, or a blocking finding that names it. */
    function placeWhole(b) {
      var id = b.getAttribute('data-node-id');
      for (var attempt = 0; attempt < 4; attempt++) {
        setSpace(b); append(b);
        if (fits(b)) {
          if (b.getAttribute('data-splittable') === '1') {
            var trs = b.querySelectorAll('tbody tr[data-row-id]');
            noteTable(id, { rows: trs.length, firstRowId: trs.length ? trs[0].getAttribute('data-row-id') : null, lastRowId: trs.length ? trs[trs.length - 1].getAttribute('data-row-id') : null, continued: false, headerRepeated: false });
          }
          note(id, b);
          return true;
        }
        remove(b);
        if (others(null)) { advance(b); continue; }
        if (nextPageRoomPx() > page.limitPx - page.cur.topPx + 1) { newPage(); ensure(isSpan(b)); continue; }
        break;
      }
      addDiag({ code: 'KEEP_TOGETHER_CANNOT_FIT', severity: 'blocking', nodeId: id, page: page.index,
        message: id + ' is set to keep together but is taller than an empty ' + (page.columns > 1 && !isSpan(b) ? 'column' : 'flow area') + ' on page ' + page.index + ', so it cannot be placed in one piece.' });
      return false;
    }

    /* ---- text that splits by lines */
    function blockAncestor(node, root) {
      var e = node.parentNode;
      while (e && e !== root) { var d = getComputedStyle(e).display; if (d === 'block' || d === 'list-item' || d === 'flex' || d === 'table-cell') return e; e = e.parentNode; }
      return root;
    }
    function textLines(root) {
      var lines = [];
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var r = document.createRange();
      var tn;
      while ((tn = walker.nextNode())) {
        var s = tn.nodeValue;
        if (!s || !/\S/.test(s)) continue;
        var para = blockAncestor(tn, root);
        for (var i = 0; i < s.length; i++) {
          if (/\s/.test(s.charAt(i))) continue;
          r.setStart(tn, i); r.setEnd(tn, i + 1);
          var rect = r.getBoundingClientRect();
          if (!rect.height) continue;
          var ln = lines[lines.length - 1];
          if (!ln || ln.para !== para || rect.top >= ln.bottom - 1) lines.push({ para: para, node: tn, offset: i, top: rect.top, bottom: rect.bottom });
          else ln.bottom = Math.max(ln.bottom, rect.bottom);
        }
      }
      return lines;
    }
    /** Splits text block b so that its first part ends above the bottom of the container; returns the rest (a new block) or null. */
    function splitText(b) {
      var minLeft = parseInt(b.getAttribute('data-min-left') || '2', 10), minCarried = parseInt(b.getAttribute('data-min-carried') || '2', 10);
      var cs = getComputedStyle(b);
      var limitY = page.cur.el.getBoundingClientRect().top + (page.limitPx - page.cur.topPx) - (parseFloat(cs.paddingBottom) || 0) - (parseFloat(cs.borderBottomWidth) || 0) - 1;
      var lines = textLines(b);
      var k = -1;
      for (var i = 0; i < lines.length; i++) if (lines[i].bottom > limitY) { k = i; break; }
      if (k <= 0) return null;
      var para = lines[k].para, ps = k, pe = k;
      while (ps > 0 && lines[ps - 1].para === para) ps--;
      while (pe < lines.length && lines[pe].para === para) pe++;
      if (k > ps && k - ps < minLeft) k = ps;
      if (k > ps && pe - k < minCarried) { k = pe - minCarried; if (k - ps < minLeft) k = ps; }
      if (k <= 0) return null;
      if (k === ps && para === b) return null;
      var li = para.closest ? para.closest('li') : null;
      if (li && !b.contains(li)) li = null;
      var list = li ? li.parentNode : null, startNo = 1;
      if (li) { var n = 0, sib = li; while ((sib = sib.previousElementSibling)) n++; startNo = parseInt(list.getAttribute('start') || '1', 10) + n; }
      var r = document.createRange();
      if (k === ps) r.setStartBefore(para); else r.setStart(lines[k].node, lines[k].offset);
      r.setEnd(b, b.childNodes.length);
      var frag = r.extractContents();
      var rest = b.cloneNode(false);
      rest.appendChild(frag);
      rest.setAttribute('data-continued', '1');
      rest.setAttribute('data-space-before', '0');
      rest.style.marginTop = '0pt';
      b.setAttribute('data-continues', '1');
      b.setAttribute('data-keep-with-next', '0');
      if (li) {
        var restList = rest.querySelector(list.tagName.toLowerCase());
        if (restList && list.tagName === 'OL') restList.setAttribute('start', String(startNo));
        if (restList && k !== ps && restList.firstElementChild) restList.firstElementChild.style.listStyleType = 'none';
      }
      return rest;
    }

    function pass(lastIdx, minPages) {
      lastIndex = lastIdx;
      pages = []; diagnostics = []; page = null;
      pagesEl.innerHTML = '';
      fixed = Array.prototype.slice.call(source.querySelectorAll(':scope > .iss-fixed'));
      blocks = Array.prototype.slice.call(source.querySelectorAll(':scope > .iss-block'));
      newPage();
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        var id = b.getAttribute('data-node-id');
        ensure(isSpan(b));
        var brk = b.getAttribute('data-break-before');
        if (brk === 'page' && page.placed > 0) { newPage(); ensure(isSpan(b)); }
        else if (brk === 'column' && others(null)) advance(b);
        if (b.getAttribute('data-keep-together') === '1') {
          if (placeWhole(b)) continue;
          if (b.getAttribute('data-splittable') === '1') { placeTable(b); continue; }
          setSpace(b); append(b); b.classList.add('iss-overflow'); note(id, b); continue;
        }
        if (b.getAttribute('data-splittable') === '1') { placeTable(b); continue; }
        setSpace(b);
        append(b);
        var keep = b.getAttribute('data-keep-with-next') === '1' && i + 1 < blocks.length;
        if (keep && fits(b)) {
          var nb = blocks[i + 1];
          var probe = nb.cloneNode(true);
          probe.style.marginTop = (nb.getAttribute('data-space-before') || 0) + 'pt';
          if (nb.getAttribute('data-splittable') === '1') { var pb = probe.querySelectorAll('tbody tr'); for (var k = 2; k < pb.length; k++) pb[k].parentNode.removeChild(pb[k]); }
          var together = true;
          if (isSpan(nb) === isSpan(b)) { append(probe); together = fits(probe); remove(probe); }
          if (!together && others(b)) { remove(b); advance(b); setSpace(b); append(b); }
        }
        var split = b.getAttribute('data-split-text') === '1';
        if (!fits(b) && split) {
          var rest = splitText(b);
          if (rest) { blocks.splice(i + 1, 0, rest); note(id, b); advance(rest); continue; }
        }
        if (!fits(b) && others(b)) { remove(b); advance(b); setSpace(b); append(b); }
        if (!fits(b) && split) {
          var rest2 = splitText(b);
          if (rest2) { blocks.splice(i + 1, 0, rest2); note(id, b); advance(rest2); continue; }
        }
        if (!fits(b)) {
          b.classList.add('iss-overflow');
          addDiag({ code: 'BLOCK_OVERFLOW', severity: 'error', nodeId: id, page: page.index, message: id + ' is taller than the flow region on page ' + page.index + ' and is clipped.' });
        }
        note(id, b);
      }
      while (pages.length < minPages) newPage();
      return pages.length;
    }

    var count = pass(null, 0);
    if (cfg.templates.last) {
      var N = count;
      for (var it = 0; it < 6; it++) {
        var fresh = pristine.cloneNode(true);
        source.parentNode.replaceChild(fresh, source);
        source = fresh;
        count = pass(N, N);
        if (count === N) break;
        N = count;
      }
    }

    // Orphaned heading post-check (bounded): heading-only block last on a page, content continues next page.
    pages.forEach(function (p, idx) {
      var lastEl = p.lastBlock;
      if (!lastEl || idx === pages.length - 1) return;
      if (lastEl.getAttribute('data-heading-only') === '1') addDiag({ code: 'ORPHANED_HEADING', severity: 'warning', nodeId: lastEl.getAttribute('data-node-id'), page: p.index, message: 'Heading ' + lastEl.getAttribute('data-node-id') + ' ends page ' + p.index + ' while its content continues on page ' + (p.index + 1) + '. Enable keep-with-next.' });
    });

    var total = pages.length;
    pagesEl.querySelectorAll('.iss-page-number').forEach(function (s) {
      var pg = s.closest('.page'); s.textContent = ((cfg.strings && cfg.strings.pageOf) || 'Page {page} of {total}').replace('{page}', pg.getAttribute('data-page')).replace('{total}', total);
    });
    function usedPt(p) {
      // One column: measured exactly as PAGINATOR_JS does. Columns: the lowest content of any column or strip.
      if (p.columns === 1) return p.flow.lastElementChild ? pt(bottomOf(p.flow.lastElementChild)) : 0;
      var top = p.flow.getBoundingClientRect().top, max = 0;
      p.flow.querySelectorAll('.iss-block').forEach(function (e) { max = Math.max(max, e.getBoundingClientRect().bottom - top); });
      return pt(max);
    }
    var result = {
      engine: 'iss-paged-composer/2', pageCount: total, diagnostics: diagnostics, durationMs: Math.round(((window.performance && performance.now()) || 0) - t0),
      page: { widthPt: cfg.pageWidthPt, heightPt: cfg.pageHeightPt },
      pages: pages.map(function (p) { return { index: p.index, nodeIds: p.nodeIds, fixedNodeIds: p.fixedNodeIds, tables: p.tables, flowTopPt: p.topPt, flowBottomPt: p.bottomPt, usedPt: usedPt(p), template: p.template, columns: p.columns }; })
    };
    source.parentNode.removeChild(source);
    window.__ISS_COMPOSITION__ = result;
    document.documentElement.setAttribute('data-composed', '1');
  }
  function start() {
    try { compose(); } catch (e) { window.__ISS_COMPOSITION__ = { error: String(e && e.stack || e) }; document.documentElement.setAttribute('data-composed', 'error'); }
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start); else window.addEventListener('load', start);
})();
`;
