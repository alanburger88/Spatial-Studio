import { describe, expect, it } from 'vitest';
import { seedProjects } from '../src/fixtures';
import {
  applyCommand, diffProjects, effectivePageDesign, fixedItemTemplates, fixedItemsOffPage, isLegacyPageDesign, pagedProfileOf, pageDesignProblems,
  pageSizePt, projectFileProblems, projectFromSavedTemplate, templateContentOf, type Command, type PresentationProfile, type Project,
} from '../src/index';

/** Page design (roadmap wave 2): model, defaults, validation, the SET_PAGE_DESIGN command, diff, templates, project files. */

const aster = () => structuredClone(seedProjects().find((p) => p.projectId === 'aster-card-demo')!) as Project;
const run = (p: Project, ...cmds: Command[]) => cmds.reduce((acc, c) => { const r = applyCommand(acc, c); if (!r.ok) throw new Error(r.message); return r.project; }, p);
const paged = (p: Project) => pagedProfileOf(p)!;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('page design defaults: existing documents mean exactly what they meant', () => {
  it('a profile without the new fields is US Letter portrait with the old margins and flow region', () => {
    for (const p of seedProjects()) {
      const prof = paged(p);
      expect(isLegacyPageDesign(prof)).toBe(true);
      const d = effectivePageDesign(prof);
      expect([d.widthPt, d.heightPt, d.css, d.paper, d.orientation]).toEqual([612, 792, '8.5in 11in', 'US-Letter', 'portrait']);
      expect(d.margins).toEqual({ top: 40, right: 40, bottom: 40, left: 40 });
      expect(d.first.flow).toEqual({ xPt: 40, yPt: 184, wPt: 532, hPt: 554 });
      expect(d.following.flow).toEqual({ xPt: 40, yPt: 84, wPt: 532, hPt: 654 });
      expect(d.last).toBeNull();
      expect([d.first.columns, d.following.columns, d.first.background]).toEqual([1, 1, null]);
      expect(pageDesignProblems(prof)).toEqual([]);
    }
    expect(effectivePageDesign(undefined).first.flow).toEqual({ xPt: 40, yPt: 184, wPt: 532, hPt: 554 });
  });

  it('fixed items keep their pages; last is new', () => {
    expect(fixedItemTemplates(undefined)).toEqual(['first']);
    expect(fixedItemTemplates('first')).toEqual(['first']);
    expect(fixedItemTemplates('following')).toEqual(['following', 'last']);
    expect(fixedItemTemplates('all')).toEqual(['first', 'following', 'last']);
    expect(fixedItemTemplates('last')).toEqual(['last']);
  });

  it('paper sizes and orientation', () => {
    expect(pageSizePt({ paper: 'A4' })).toMatchObject({ widthPt: 595.28, heightPt: 841.89, css: '210mm 297mm' });
    expect(pageSizePt({ paper: 'US-Legal', orientation: 'landscape' })).toMatchObject({ widthPt: 1008, heightPt: 612, css: '14in 8.5in' });
  });
});

describe('page design validation (also for untrusted project files)', () => {
  const base = () => structuredClone(paged(aster()));
  const problems = (patch: Partial<PresentationProfile>) => pageDesignProblems({ ...base(), ...patch } as PresentationProfile);
  it('rejects unknown paper, bad margins, columns and flow areas off the page', () => {
    expect(problems({ paper: 'B5' as never })[0]).toMatch(/US Letter, A4 or US Legal/);
    expect(problems({ orientation: 'diagonal' as never })[0]).toMatch(/portrait or landscape/);
    expect(problems({ pageMarginsMm: [14, 14, 14] as never })[0]).toMatch(/four numbers/);
    expect(problems({ pageMarginsMm: [14, 200, 14, 14] })[0]).toMatch(/0 to 60 mm/);
    expect(problems({ pageTemplates: { following: { columns: 4 } } })[0]).toMatch(/1, 2 or 3/);
    expect(problems({ pageTemplates: { following: { columns: 3, columnGapPt: 72, flowArea: { xPt: 40, yPt: 84, wPt: 300, hPt: 600 } } } })[0]).toMatch(/at least 72 pt is needed/);
    expect(problems({ pageTemplates: { first: { flowArea: { xPt: 40, yPt: 700, wPt: 532, hPt: 200 } } } })[0]).toMatch(/stay on the US Letter page/);
    expect(problems({ pageTemplates: { first: { flowArea: { xPt: 40, yPt: 100, wPt: 20, hPt: 200 } } } })[0]).toMatch(/at least 72/);
    expect(problems({ pageTemplates: { middle: {} } as never })[0]).toMatch(/Unknown page template/);
    // The old flow region does not fit a landscape page: the person must set the areas (the command refits them).
    expect(problems({ orientation: 'landscape' }).join(' ')).toMatch(/does not fit the landscape US Letter page/);
  });
  it('backgrounds: an image from the library or a hex tint, with an opacity', () => {
    expect(problems({ pageTemplates: { first: { background: { kind: 'tint', color: '#F1F5F9', opacityPct: 40 } } } })).toEqual([]);
    expect(problems({ pageTemplates: { first: { background: { kind: 'image', image: PNG, opacityPct: 10 } } } })).toEqual([]);
    expect(problems({ pageTemplates: { first: { background: { kind: 'image', image: 'asset:aster-mark', fit: 'contain', opacityPct: 10 } } } })).toEqual([]);
    expect(problems({ pageTemplates: { first: { background: { kind: 'image', image: 'https://example.com/x.png', opacityPct: 10 } } } })[0]).toMatch(/image library/);
    expect(problems({ pageTemplates: { first: { background: { kind: 'image', image: 'data:image/svg+xml;base64,PHN2Zz4=', opacityPct: 10 } } } })[0]).toMatch(/PNG, JPEG or WebP/);
    expect(problems({ pageTemplates: { first: { background: { kind: 'tint', color: 'red', opacityPct: 10 } } } })[0]).toMatch(/hex colour/);
    expect(problems({ pageTemplates: { first: { background: { kind: 'tint', color: '#FFFFFF', opacityPct: 140 } } } })[0]).toMatch(/0–100%/);
  });
});

describe('SET_PAGE_DESIGN', () => {
  it('changes the PDF and AFP simulation profiles together in one undoable step; the web profile is untouched', () => {
    const p = aster();
    const r = applyCommand(p, { type: 'SET_PAGE_DESIGN', patch: { pageTemplates: { following: { columns: 2, columnGapPt: 18 }, last: {} } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.modelVersion).toBe(p.modelVersion + 1);
    expect(r.label).toBe('Page design: page templates');
    for (const id of ['paged-pdf', 'paged-afp-sim']) expect(r.project.presentationProfiles.find((x) => x.id === id)!.pageTemplates).toEqual({ following: { columns: 2, columnGapPt: 18 }, last: {} });
    expect(r.project.presentationProfiles.find((x) => x.id === 'html-responsive')).toEqual(p.presentationProfiles.find((x) => x.id === 'html-responsive'));
    const d = effectivePageDesign(paged(r.project));
    expect(d.last?.flow).toEqual(d.following.flow);
    expect(d.following.columns).toBe(2);
  });

  it('rejects an unusable design and leaves the model as it was', () => {
    const p = aster();
    const r = applyCommand(p, { type: 'SET_PAGE_DESIGN', patch: { pageTemplates: { following: { columns: 3, flowArea: { xPt: 40, yPt: 84, wPt: 200, hPt: 600 } } } } });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_PAGE_DESIGN' });
    expect(applyCommand(p, { type: 'UPDATE_PROFILE', profileId: 'paged-pdf', patch: { paper: 'B5' as never } })).toMatchObject({ ok: false, code: 'INVALID_PAGE_DESIGN' });
  });

  it('another paper or orientation refits the flow areas and moves fixed items with their page edges', () => {
    const p = run(aster(), { type: 'SET_PAGE_DESIGN', patch: { paper: 'A4', orientation: 'landscape' } });
    const prof = paged(p);
    expect(pageDesignProblems(prof)).toEqual([]);
    const d = effectivePageDesign(prof);
    expect(d.widthPt).toBeCloseTo(841.89);
    // Same distance from the top and from the bottom as before, margin to margin.
    expect(d.first.flow).toMatchObject({ xPt: 40, yPt: 184, wPt: 761.9 });
    expect(d.first.flow.yPt + d.first.flow.hPt).toBeCloseTo(595.28 - 54, 0);
    expect(fixedItemsOffPage(p)).toEqual([]);
    const footer = p.nodes.find((n) => n.id === 'page-footer')!.layout!.paged!;
    const was = aster().nodes.find((n) => n.id === 'page-footer')!.layout!.paged!;
    expect(595.28 - (footer.yPt! + footer.hPt!)).toBeCloseTo(792 - (was.yPt! + was.hPt!), 0);
    expect(footer.wPt).toBeCloseTo(841.89 - 80, 0);
    // Back to Letter portrait gives today's flow area again (as explicit areas).
    const back = run(p, { type: 'SET_PAGE_DESIGN', patch: { paper: 'US-Letter', orientation: 'portrait' } });
    expect(effectivePageDesign(paged(back)).first.flow).toEqual({ xPt: 40, yPt: 184, wPt: 532, hPt: 554 });
  });

  it('templates emptied again leave the document with its original page design', () => {
    const p = run(aster(), { type: 'SET_PAGE_DESIGN', patch: { pageTemplates: { last: {} } } }, { type: 'SET_PAGE_DESIGN', patch: { pageTemplates: {} } });
    expect(paged(p).pageTemplates).toBeUndefined();
    expect(isLegacyPageDesign(paged(p))).toBe(true);
    const q = run(aster(), { type: 'SET_PAGE_DESIGN', patch: { pageTemplates: { last: {} } } }, { type: 'SET_PAGE_DESIGN', patch: { pageTemplates: null } });
    expect(isLegacyPageDesign(paged(q))).toBe(true);
  });
});

describe('SET_LAYOUT: keeping things together and the page size', () => {
  it('accepts the new component settings and validates them', () => {
    const p = run(aster(), { type: 'SET_LAYOUT', nodeId: 'spend-chart', profile: 'paged', layout: { keepTogether: true, breakBefore: 'column', spanColumns: true } });
    expect(p.nodes.find((n) => n.id === 'spend-chart')!.layout!.paged).toMatchObject({ mode: 'flow', keepTogether: true, breakBefore: 'column', spanColumns: true });
    const q = run(aster(), { type: 'SET_LAYOUT', nodeId: 'greeting', profile: 'paged', layout: { splitText: true, minLinesLeft: 2, minLinesCarried: 3 } });
    expect(q.nodes.find((n) => n.id === 'greeting')!.layout!.paged).toMatchObject({ splitText: true, minLinesLeft: 2, minLinesCarried: 3 });
    expect(applyCommand(aster(), { type: 'SET_LAYOUT', nodeId: 'greeting', profile: 'paged', layout: { breakBefore: 'section' as never } })).toMatchObject({ ok: false, code: 'INVALID_LAYOUT' });
    expect(applyCommand(aster(), { type: 'SET_LAYOUT', nodeId: 'greeting', profile: 'paged', layout: { minLinesLeft: 0 } })).toMatchObject({ ok: false, code: 'INVALID_LAYOUT' });
    expect(applyCommand(aster(), { type: 'SET_LAYOUT', nodeId: 'greeting', profile: 'paged', layout: { keepTogether: 'yes' as never } })).toMatchObject({ ok: false, code: 'INVALID_LAYOUT' });
  });

  it('a fixed item may be on the last page, and must stay on the page of the chosen paper', () => {
    const p = run(aster(), { type: 'SET_LAYOUT', nodeId: 'page-footer', profile: 'paged', layout: { pages: 'last' } });
    expect(p.nodes.find((n) => n.id === 'page-footer')!.layout!.paged!.pages).toBe('last');
    // Letter: the old message and limit.
    expect(applyCommand(aster(), { type: 'SET_LAYOUT', nodeId: 'issuer-logo', profile: 'paged', layout: { yPt: 900 } })).toMatchObject({ ok: false, message: 'Fixed element must stay within the US-Letter page (612×792 pt).' });
    // Legal: 900 pt down is on the page.
    const legal = run(aster(), { type: 'SET_PAGE_DESIGN', patch: { paper: 'US-Legal' } });
    expect(applyCommand(legal, { type: 'SET_LAYOUT', nodeId: 'issuer-logo', profile: 'paged', layout: { yPt: 900 } }).ok).toBe(true);
    expect(applyCommand(legal, { type: 'SET_LAYOUT', nodeId: 'issuer-logo', profile: 'paged', layout: { yPt: 990 } })).toMatchObject({ ok: false, message: expect.stringContaining('US Legal page (612×1008 pt)') });
  });
});

describe('diff, templates and project files carry the page design', () => {
  it('the diff names each page design change in plain words', () => {
    const a = aster();
    const b = run(a, { type: 'SET_PAGE_DESIGN', patch: { pageTemplates: { following: { columns: 2, background: { kind: 'tint', color: '#F1F5F9', opacityPct: 30 } }, last: {} } } });
    const d = diffProjects(a, b);
    expect(d.profiles.design).toEqual(expect.arrayContaining([
      { field: 'Following pages: columns', from: '1', to: '2, gap 18 pt' },
      { field: 'Following pages: background', from: 'none', to: 'tint #F1F5F9 at 30%' },
      { field: 'Last page', from: 'off', to: 'on' },
    ]));
    expect(d.profiles.changed.map((c) => c.id).sort()).toEqual(['paged-afp-sim', 'paged-pdf']);
    expect(d.profiles.changed[0].fields).toEqual(['pageTemplates']);
    expect(diffProjects(a, aster()).profiles.design).toBeUndefined();
    const img = run(b, { type: 'SET_PAGE_DESIGN', patch: { pageTemplates: { following: { background: { kind: 'image', image: PNG, opacityPct: 30 } } } } });
    const img2 = structuredClone(img);
    paged(img2).pageTemplates!.following!.background!.image = PNG.replace('ggg', 'ggh');
    expect(diffProjects(img, img2).profiles.design).toEqual([{ field: 'Following pages: background', from: 'an image', to: 'a different image' }]);
  });

  it('a saved template and a document started from it keep the page design', () => {
    const p = run(aster(), { type: 'SET_PAGE_DESIGN', patch: { paper: 'A4', pageTemplates: { first: { columns: 2 }, last: { background: { kind: 'image', image: PNG, opacityPct: 12 } } } } },
      { type: 'SET_LAYOUT', nodeId: 'spend-chart', profile: 'paged', layout: { keepTogether: true } });
    const t = templateContentOf(p);
    const fresh = projectFromSavedTemplate(t, { projectId: 'from-tpl', title: 'From template', templateId: 't1', version: 1, templateTitle: 'T' });
    expect(paged(fresh)).toEqual(paged(p));
    expect(fresh.nodes.find((n) => n.id === 'spend-chart')!.layout!.paged!.keepTogether).toBe(true);
    expect(projectFileProblems(fresh)).toEqual([]);
  });

  it('a project file with a background from outside the file or an unusable page design is refused', () => {
    const p = aster();
    const outside = structuredClone(p);
    paged(outside).pageTemplates = { first: { background: { kind: 'image', image: 'https://tracker.example/pixel.png', opacityPct: 10 } } };
    expect(projectFileProblems(outside).map((x) => x.code)).toEqual(expect.arrayContaining(['IMAGE', 'PAGE_DESIGN']));
    const bad = structuredClone(p);
    (paged(bad) as any).pageTemplates = { following: { columns: 9 } };
    expect(projectFileProblems(bad)).toEqual([{ code: 'PAGE_DESIGN', message: 'The page design in the file cannot be used: Following pages: columns must be 1, 2 or 3.' }]);
    const notObject = structuredClone(p);
    (notObject as any).presentationProfiles.push(null);
    expect(projectFileProblems(notObject).map((x) => x.code)).toContain('PAGE_DESIGN');
    expect(projectFileProblems(p)).toEqual([]);
  });
});
