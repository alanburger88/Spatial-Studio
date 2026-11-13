import { fixedItemsOffPage, pageDesignProblems, type Project } from '@iss/model';
import type { Finding } from '@iss/resolver';

/**
 * Page design checks that need no composition (wave 2): a page design that cannot be used (a project file can hold
 * anything) and fixed items that reach outside the page. They use the composer's codes and source, so they flow
 * through the same finding, blocker and fix paths. Composition adds what only real pages show
 * (KEEP_TOGETHER_CANNOT_FIT, FIXED_OFF_PAGE per page; see paginator-design-source.ts).
 */
export function pageDesignFindings(project: Project): Finding[] {
  const out: Finding[] = [];
  for (const p of project.presentationProfiles) {
    if (p.kind === 'responsive') continue;
    for (const message of pageDesignProblems(p).slice(0, 3)) out.push({ code: 'PAGE_DESIGN_INVALID', severity: 'blocking', source: 'composer', message });
  }
  for (const f of fixedItemsOffPage(project)) out.push({ code: 'FIXED_OFF_PAGE', severity: 'warning', nodeId: f.nodeId, source: 'composer', message: `${f.name} reaches outside the page and is cut off.` });
  return out;
}
