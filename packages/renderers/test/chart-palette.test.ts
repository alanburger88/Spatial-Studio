import { describe, expect, it } from 'vitest';
import { defaultNode, type Project } from '@iss/model';
import { resolve } from '@iss/resolver';
import { renderInteractiveHtml, renderPagedDocument } from '@iss/renderers';
import { gymMember, gymProject, run } from '../../model/test/helpers/customProject';

/** A chart whose palette is `mono` is drawn in the document's own colour only; `brand` (and no palette) keep the studio's colours. */
describe('chart palette', () => {
  const chart = (palette?: 'brand' | 'mono'): Project => {
    const p = gymProject();
    return run(p, { type: 'INSERT_NODE', parentId: 'doc-root', node: { ...defaultNode('chart', 'by-class', 'custom', p), binding: 'custom.sessions', chart: { kind: 'bar', title: 'By class', groupBy: 'className', valueKey: 'priceCents', limit: 5, ...(palette ? { palette } : {}) } } });
  };
  const fills = (html: string) => [...new Set([...html.matchAll(/<rect x="110"[^>]*fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase()))];
  const out = (p: Project) => { const res = resolve({ project: p, record: gymMember() }); return [renderPagedDocument(res, p), renderInteractiveHtml(res, p)]; };

  it('draws every bar in the issuer’s colour with mono', () => {
    const p = chart('mono');
    for (const html of out(p)) expect(fills(html)).toEqual([p.issuer.accent.toUpperCase()]);
  });
  it('keeps the studio’s colours otherwise', () => {
    for (const p of [chart('brand'), chart()]) for (const html of out(p)) expect(fills(html)).toEqual(['#277656', '#4EAF60']);
  });
});
