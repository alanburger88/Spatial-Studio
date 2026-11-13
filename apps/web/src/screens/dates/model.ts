import { addDaysToIso, dateBoundaries, projectFields, type FieldDef, type Project } from '@iss/model';

/** Pure helpers for the Dates screen and the lines other screens show about the document's date. */

/** The date fields of the customer's data that can be the document's date (never a calculated or derived one). */
export function dateFieldsOf(project: Project): FieldDef[] {
  return projectFields(project).filter((f) => f.type === 'date' && !f.derived && !f.calculated && !f.documentDate);
}

/** Every day on which something about the document changes, in date order. */
export function boundaryDays(project: Project): string[] {
  return project.documentDate ? dateBoundaries(project).map((b) => b.date) : [];
}

/** The first boundary after `day` (or the first one when there is no day). Null when nothing changes later. */
export function nextBoundary(project: Project, day: string | null): string | null {
  const days = boundaryDays(project);
  return (day ? days.find((d) => d > day) : days[0]) ?? null;
}

/** Quick picks for "As issued on": the day before each boundary and the boundary itself. */
export function quickPicks(project: Project): Array<{ day: string; boundary: string; side: 'before' | 'on' }> {
  return boundaryDays(project).flatMap((d) => [{ day: addDaysToIso(d, -1), boundary: d, side: 'before' as const }, { day: d, boundary: d, side: 'on' as const }]);
}

/** Where the document's date comes from, in plain words. */
export function sourceWords(project: Project): string {
  const s = project.documentDate;
  if (!s) return 'The document does not use dates.';
  if (s.source === 'run') return 'The document’s date is given for each run.';
  const f = projectFields(project).find((x) => x.path === s.path);
  return `The document’s date is each customer’s “${f?.label ?? s.path}”.`;
}
