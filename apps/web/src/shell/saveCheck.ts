import type { Project, SyntheticRecord } from '@iss/model';
import { documentBlockers, fastCauses, newCauseCustomers, newCausesOnSave, type BlockerKind, type BlockerLink, type ExtraFinding, type FastCauses } from '@iss/scenarios';
import { bindingAnalysis, staticRuleAnalysis } from '@iss/validation';
import { api } from '../api/client';

/**
 * Blockers phase 6: the comparison behind "warn before saving" (a separate download; see state/saveFlow.ts). The fast
 * causes of a version are worked out once per version and set of customers and remembered, so the saved version's are
 * usually ready before Save is pressed. Only when a new cause is found is anything more worked out (its words, how many
 * customers it stops, and where it is fixed), with the same engine the Blockers screen uses.
 */

export interface SaveWarningCause {
  id: string;
  kind: BlockerKind;
  title: string;
  explanation: string | null;
  /** Customers it stops (of `checked`). */
  customers: number;
  link: BlockerLink | null;
}
export interface SaveWarning {
  causes: SaveWarningCause[];
  /** Customers checked, of the document's kind. */
  checked: number;
  /** Days checked (more than one for a document dated by the run). */
  days: number;
  /** Time to compare (ms), without describing the new causes. */
  ms: number;
}

const memo = new WeakMap<Project, WeakMap<SyntheticRecord[], FastCauses>>();
const staticOf = (project: Project, records: SyntheticRecord[]) => [...staticRuleAnalysis(project, records), ...bindingAnalysis(project)];
function causesOf(project: Project, records: SyntheticRecord[]): FastCauses {
  let byRecords = memo.get(project);
  if (!byRecords) { byRecords = new WeakMap(); memo.set(project, byRecords); }
  let c = byRecords.get(records);
  if (!c) { c = fastCauses(project, records, staticOf(project, records)); byRecords.set(records, c); }
  return c;
}

/** Work out a version's causes ahead of time (the saved version, while the person edits). */
export function warm(project: Project, records: SyntheticRecord[]): void {
  if (records.length) causesOf(project, records);
}

/**
 * The causes saving `project` would add to the last saved version. `saved` is that version when the store still holds it;
 * otherwise it is read from the version history (`savedVersion`).
 */
export async function saveWarning(project: Project, records: SyntheticRecord[], saved: Project | null, savedVersion: number): Promise<SaveWarning> {
  const base = saved ?? (await api.version(project.projectId, savedVersion)).project;
  const t0 = performance.now();
  const before = causesOf(base, records);
  const after = causesOf(project, records);
  const added = newCausesOnSave(before, after);
  const ms = Math.round(performance.now() - t0);
  return { causes: added.length ? describe(project, records, added) : [], checked: after.checked, days: after.days.length, ms };
}

/** Words, counts and where each new cause is fixed, from the Blockers screen's own engine, on just the customers concerned. */
function describe(project: Project, records: SyntheticRecord[], added: ReturnType<typeof newCausesOnSave>): SaveWarningCause[] {
  const wanted = new Set(added.flatMap((c) => c.recordIds.slice(0, 10)));
  const some = records.filter((r) => wanted.has(r.recordId));
  const extra: ExtraFinding[] = staticOf(project, records).map((finding) => ({ finding, recordId: null, speed: 'fast' as const }));
  const byDay = new Map<string | null, ReturnType<typeof documentBlockers>>();
  const blockersOn = (day: string | null) => {
    let b = byDay.get(day);
    if (!b) { b = documentBlockers(project, some, { extraFindings: extra, ...(day ? { issueDate: day } : {}) }); byDay.set(day, b); }
    return b;
  };
  return added.map((c) => {
    const day = c.days.find((d) => d !== null) ?? null;
    const b = blockersOn(day).blockers.find((x) => x.id === c.id);
    return { id: c.id, kind: c.kind, title: b?.title ?? c.title, explanation: b?.explanation ?? null, customers: newCauseCustomers(project, records, c).length, link: b?.link ?? null };
  });
}
