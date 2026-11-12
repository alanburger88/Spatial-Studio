import { describe, expect, it } from 'vitest';
import { seedProjects, RECORDS } from '../../model/src/fixtures';
import { resolve } from '@iss/resolver';
import { renderInteractiveHtml, renderPagedDocument } from '@iss/renderers';

const [card] = seedProjects();
const rec = RECORDS.find((r) => r.recordId === 'CARD-0001')!;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function styled() {
  return {
    ...card,
    styles: [{ id: 'lead', name: 'Lead', kind: 'paragraph' as const, fontSizePt: 14, fontWeight: 700 as const, italic: true, color: '#112233', lineHeight: 1.6, spaceBeforePt: 4, spaceAfterPt: 6, uppercase: true }],
    brand: { primary: '#123456', accent: '#654321', text: '#111111', fontFamily: 'Georgia' as const, logoDataUri: PNG, logoAlt: 'Test brand logo' },
    nodes: card.nodes.map((n) => (n.id === 'greeting' ? { ...n, styleId: 'lead' } : n)),
  };
}

describe('text styles and brand kit', () => {
  it('projects without styles or brand are unchanged', () => {
    const res = resolve({ project: card, record: rec });
    const html = renderInteractiveHtml(res, card);
    expect(html).not.toContain('iss-st-');
    expect(html).not.toContain('--iss-brand');
  });

  it('applies style classes and CSS in paged and interactive output', () => {
    const p = styled();
    const res = resolve({ project: p, record: rec });
    for (const out of [renderPagedDocument(res, p), renderInteractiveHtml(res, p)]) {
      expect(out).toContain('.iss-st-lead.iss-st-lead');
      expect(out).toContain('font-size:14pt');
      expect(out).toContain('text-transform:uppercase');
      expect(out).toMatch(/class="iss-st-lead iss-rich"/);
    }
  });

  it('applies brand variables, font and logo; stays self-contained', () => {
    const p = styled();
    const res = resolve({ project: p, record: rec });
    for (const out of [renderPagedDocument(res, p), renderInteractiveHtml(res, p)]) {
      expect(out).toContain('--iss-brand-primary:#123456');
      expect(out).toContain('--iss-brand-accent:#654321');
      expect(out).toContain('--iss-brand-font:Georgia');
      expect(out).toContain('--accent:#123456');
    }
    const html = renderInteractiveHtml(res, p);
    expect(html).toContain(`src="${PNG}"`);
    expect(html).toContain('alt="Test brand logo"');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain("default-src 'none'; img-src data:");
  });

  it('ignores unsafe style ids and colours', () => {
    const p = { ...styled(), styles: [{ id: 'x}{evil', name: 'x', kind: 'paragraph' as const }], brand: { primary: 'red;}', accent: '#000000' } };
    const res = resolve({ project: p, record: rec });
    const html = renderInteractiveHtml(res, p);
    expect(html).not.toContain('evil');
    expect(html).not.toContain('red;}');
  });
});
