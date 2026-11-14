import { addDaysToIso, dateBoundaries, isIsoDay, type Project, type SyntheticRecord } from '@iss/model';
import { ScenarioEngine } from '@iss/scenarios';
import type { ApiError } from './app';

/**
 * "As issued on": the document's date given for a request (a preview, a run, a batch, a check). Every route that
 * resolves accepts it as `issueDate`, checks it with the engine's own day check, and passes it to the engine. A
 * request without it behaves exactly as before; the engine ignores it for a document that does not use dates.
 */

/** The plain refusal for a date that is not a calendar day. */
export function issueDateRefusal(v: unknown): string {
  return `The document’s date ${typeof v === 'string' ? `“${v.slice(0, 40)}” ` : ''}is not a calendar day. Write it as YYYY-MM-DD, for example 2027-01-01.`;
}

/** The day given (`issueDate`), or null when none was given. A value that is not a day is refused in plain words (400 INVALID_ISSUE_DATE). */
export function issueDateFrom(v: unknown, Err: typeof ApiError): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (!isIsoDay(v)) throw new Err(400, 'INVALID_ISSUE_DATE', issueDateRefusal(v));
  return v;
}

/** `{ issueDate }` to spread into a resolve input, or nothing. */
export const dated = (issueDate: string | null | undefined): { issueDate?: string } => (issueDate ? { issueDate } : {});

/** The scenario engine "as issued on" a day (the Cube and the Landscape follow it); the plain engine without a day. */
export function scenarioEngineFor(project: Project, records: SyntheticRecord[], issueDate: string | null): ScenarioEngine {
  return new ScenarioEngine(project, records, issueDate);
}

/** The days a document whose date is given for each run is checked on before approval: each boundary and the day before the first (a fixed day when it has none). */
export function approvalDays(project: Project): string[] {
  const days = dateBoundaries(project).map((b) => b.date);
  return days.length ? [addDaysToIso(days[0], -1), ...days] : ['2026-01-01'];
}
