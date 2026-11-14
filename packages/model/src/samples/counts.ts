import { projectLanguages } from '../languages';
import { translatableStrings } from '../strings';
import type { Project } from '../types';

/**
 * How many customer-visible texts of a document are approved, only drafted or missing in each target language:
 * every translatable string (labels, text, email and SMS, fixed wording) and every message or notice a component shows.
 * Pure; the accuracy check compares these with what a sample's notes declare.
 */
export function translationCounts(project: Project): Record<string, { approved: number; draft: number; missing: number }> {
  const out: Record<string, { approved: number; draft: number; missing: number }> = {};
  const used = new Set<string>();
  for (const n of project.nodes) { for (const v of n.variantIds ?? []) used.add(v); if (n.contentPartId) used.add(n.contentPartId); }
  const strings = translatableStrings(project);
  for (const locale of projectLanguages(project)) {
    const c = { approved: 0, draft: 0, missing: 0 };
    for (const s of strings) {
      const t = project.strings?.[s.id];
      if (t?.approved?.[locale]?.trim()) c.approved += 1; else if (t?.draft?.[locale]?.trim()) c.draft += 1; else c.missing += 1;
    }
    for (const p of project.contentParts) {
      if (!used.has(p.id)) continue;
      if (p.approvedLocales[locale]?.trim()) c.approved += 1; else if (p.draftLocales?.[locale]?.trim()) c.draft += 1; else c.missing += 1;
    }
    out[locale] = c;
  }
  return out;
}

/** The ids of the texts in each state for one language (for reports and for writing the translations). */
export function translationIds(project: Project, locale: string): { approved: string[]; draft: string[]; missing: Array<{ id: string; source: string }> } {
  const used = new Set<string>();
  for (const n of project.nodes) { for (const v of n.variantIds ?? []) used.add(v); if (n.contentPartId) used.add(n.contentPartId); }
  const out = { approved: [] as string[], draft: [] as string[], missing: [] as Array<{ id: string; source: string }> };
  for (const s of translatableStrings(project)) {
    const t = project.strings?.[s.id];
    if (t?.approved?.[locale]?.trim()) out.approved.push(s.id); else if (t?.draft?.[locale]?.trim()) out.draft.push(s.id); else out.missing.push({ id: s.id, source: s.source });
  }
  for (const p of project.contentParts) {
    if (!used.has(p.id)) continue;
    if (p.approvedLocales[locale]?.trim()) out.approved.push(p.id); else if (p.draftLocales?.[locale]?.trim()) out.draft.push(p.id); else out.missing.push({ id: p.id, source: p.approvedLocales['en-US'] ?? '' });
  }
  return out;
}
