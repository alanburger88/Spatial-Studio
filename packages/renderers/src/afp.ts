import type { Project } from '@iss/model';
import { effectivePageDesign, isLegacyPageDesign, PAPER_SIZES } from '@iss/model';
import type { Resolution } from '@iss/resolver';

export const AFP_SIMULATION_LABEL = 'AFP simulation only — no MO:DCA / AFP print stream generated';

export interface PageMetrics {
  pageCount: number;
  pages: Array<{ index: number; nodeIds: string[]; tables: Record<string, { rows: number; continued: boolean; headerRepeated: boolean }>; flowTopPt: number; flowBottomPt: number; /** Page-design composer only: the page template and its columns. */ template?: 'first' | 'following' | 'last' | 'first+last'; columns?: number }>;
  /** Page-design composer only: the page size. */
  page?: { widthPt: number; heightPt: number };
  diagnostics: Array<{ code: string; severity: string; nodeId?: string; page?: number; message: string }>;
}

/**
 * AFP feasibility simulation. Produces a JSON profile report only; it never emits AFP/MO:DCA bytes
 * and never renames a PDF as .afp. Page sequence comes from the real paged composer metrics.
 */
export function afpSimulation(res: Resolution, project: Project, metrics: PageMetrics | null) {
  const profile = project.presentationProfiles.find((p) => p.id === 'paged-afp-sim');
  const warnings: string[] = [
    AFP_SIMULATION_LABEL + '.',
    'Font and overlay mappings are conceptual placeholders for a future native AFP adapter.',
    'Page appearance is illustrated using the paged (PDF) composition; this is not AFP data.',
  ];
  if (!profile) warnings.push('Project has no paged-afp-sim profile; using paged-pdf geometry.');
  if (metrics?.diagnostics.some((d) => d.severity === 'blocking' || d.severity === 'error')) warnings.push('Composer reported layout errors that a production AFP job would reject.');
  const resources = (profile?.afp?.resources ?? []).map((r) => ({ name: r, status: 'concept-only' as const }));
  // A page design beyond US Letter portrait follows the paged composition: paper, page definition name and the flow area of each page template.
  const designed = !!profile && !isLegacyPageDesign(profile);
  const d = designed ? effectivePageDesign(profile) : null;
  const pageCode = d ? `${d.paper === 'A4' ? 'A4' : d.paper === 'US-Legal' ? 'LGL' : 'LTR'}${d.orientation === 'landscape' ? 'L' : ''}` : 'LTR';
  const pagedef = d && profile?.afp?.pagedef === 'P1LTR01 (conceptual)' ? `P1${pageCode}01 (conceptual)` : profile?.afp?.pagedef ?? 'n/a';
  const region = (name: string, t: NonNullable<typeof d>['first']) => ({ name, template: t.id, xPt: t.flow.xPt, yPt: t.flow.yPt, wPt: t.flow.wPt, hPt: t.flow.hPt, columns: t.columns, columnGapPt: t.columnGapPt, firstPageTopPt: t.flow.yPt, otherPagesTopPt: t.flow.yPt, bottomPt: Math.round((t.flow.yPt + t.flow.hPt) * 10) / 10 });
  return {
    simulationOnly: true as const,
    label: AFP_SIMULATION_LABEL,
    runId: res.runId,
    contentDigest: res.contentDigest,
    afpBytesGenerated: 0,
    media: d
      ? { paper: PAPER_SIZES[d.paper].label, orientation: d.orientation, widthPt: d.widthPt, heightPt: d.heightPt, duplex: profile?.duplex ?? false, marginsMm: profile?.pageMarginsMm ?? [14, 14, 14, 14] }
      : { paper: profile?.paper ?? 'US-Letter', widthPt: 612, heightPt: 792, duplex: profile?.duplex ?? false, marginsMm: profile?.pageMarginsMm ?? [14, 14, 14, 14] },
    formdef: profile?.afp?.formdef ?? 'n/a',
    pagedef,
    fontMap: profile?.afp?.fontMap ?? {},
    overlays: profile?.afp?.overlays ?? [],
    resources,
    continuationRegions: d
      ? [region('First page', d.first), region('Following pages', d.following), ...(d.last ? [region('Last page', d.last)] : [])]
      : [{ name: 'flow-region', firstPageTopPt: profile?.flowRegion?.firstPageTopPt, otherPagesTopPt: profile?.flowRegion?.otherPagesTopPt, bottomPt: profile?.flowRegion?.bottomPt }],
    pageSequence: (metrics?.pages ?? []).map((p) => ({ sheet: profile?.duplex ? Math.ceil(p.index / 2) : p.index, side: profile?.duplex ? (p.index % 2 ? 'front' : 'back') : 'front', page: p.index, nodeIds: p.nodeIds, continuedTables: Object.entries(p.tables).filter(([, t]) => t.continued).map(([id]) => id), ...(p.template ? { template: p.template, columns: p.columns ?? 1 } : {}) })),
    pageCount: metrics?.pageCount ?? null,
    checklist: [
      { item: 'Page size and margins defined in paged profile', ok: true },
      { item: 'Flow region and continuation policy defined', ok: true },
      { item: 'Coded font mapping', ok: false, note: 'Concept only' },
      { item: 'Overlay / page segment resources packaged', ok: false, note: 'Concept only' },
      { item: 'MO:DCA structured fields emitted', ok: false, note: 'Out of POC scope — never generated' },
    ],
    warnings,
  };
}
