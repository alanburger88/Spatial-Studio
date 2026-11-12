import type { Project } from '@iss/model';
import type { Resolution } from '@iss/resolver';

export const AFP_SIMULATION_LABEL = 'AFP simulation only — no MO:DCA / AFP print stream generated';

export interface PageMetrics {
  pageCount: number;
  pages: Array<{ index: number; nodeIds: string[]; tables: Record<string, { rows: number; continued: boolean; headerRepeated: boolean }>; flowTopPt: number; flowBottomPt: number }>;
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
  return {
    simulationOnly: true as const,
    label: AFP_SIMULATION_LABEL,
    runId: res.runId,
    contentDigest: res.contentDigest,
    afpBytesGenerated: 0,
    media: { paper: profile?.paper ?? 'US-Letter', widthPt: 612, heightPt: 792, duplex: profile?.duplex ?? false, marginsMm: profile?.pageMarginsMm ?? [14, 14, 14, 14] },
    formdef: profile?.afp?.formdef ?? 'n/a',
    pagedef: profile?.afp?.pagedef ?? 'n/a',
    fontMap: profile?.afp?.fontMap ?? {},
    overlays: profile?.afp?.overlays ?? [],
    resources,
    continuationRegions: [{ name: 'flow-region', firstPageTopPt: profile?.flowRegion?.firstPageTopPt, otherPagesTopPt: profile?.flowRegion?.otherPagesTopPt, bottomPt: profile?.flowRegion?.bottomPt }],
    pageSequence: (metrics?.pages ?? []).map((p) => ({ sheet: profile?.duplex ? Math.ceil(p.index / 2) : p.index, side: profile?.duplex ? (p.index % 2 ? 'front' : 'back') : 'front', page: p.index, nodeIds: p.nodeIds, continuedTables: Object.entries(p.tables).filter(([, t]) => t.continued).map(([id]) => id) })),
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
