import { SOURCE_LANGUAGE, addDaysToIso, dateBoundaries, type Project, type SyntheticRecord } from '@iss/model';
import type { Finding } from '@iss/resolver';
import { blockerIdOf, blockerKindOfId, blockerTitleOf, customerBlockers } from './assist/blockers';
import { readersOf } from './assist/fixes';
import { wordingFindings } from './assist/wordingRules';
import type { BlockerKind } from './assist/types';

/**
 * Blockers phase 6 (docs/design/BLOCKERS.md, "Warn before saving"): which root causes a save would ADD.
 *
 * Pure and deterministic. It reuses the blocker engine (`customerBlockers`, `wordingFindings`, `blockerIdOf`) and works
 * out only the FAST causes: what the resolver finds for every customer, broken "must" wording rules, and the static rule
 * and data-link checks the caller passes in (they live in @iss/validation). Page layout, PDF/web and PDF accessibility need
 * composed pages and are not part of it. It is the same set of causes the server works out for the saved document
 * (`savedCauses` in apps/api/src/blockerWork.ts), over every customer and every day the approval check uses, so a cause
 * the warning names is one the server will hold against the saved version.
 */

export interface FastCause {
  id: string;
  kind: BlockerKind;
  /** Plain words, the same title the Blockers screen gives the cause. */
  title: string;
  /** The customers it stops on at least one of the days checked (empty for a cause of the document as a whole). */
  recordIds: string[];
  /** The days (null: a document without dates) on which it was found. */
  days: Array<string | null>;
  /** The finding, for a cause found on the model itself (wording rules, static checks); per-customer causes carry none. */
  finding?: Finding;
  /** For a wording-rule cause: the parts whose readers it stops (empty = every customer); the count is worked out on demand. */
  readBy?: string[];
}

export interface FastCauses {
  /** How many customers were checked (of the document's kind). */
  checked: number;
  /** The days checked: each date boundary and the day before the first for a document dated by the run; otherwise [null]. */
  days: Array<string | null>;
  causes: Map<string, FastCause>;
}

/** The days approval checks a document on: for a document whose date is given for each run, each boundary and the day before the first (a fixed day when it has none); otherwise one undated check. Mirrors `approvalDays` in apps/api/src/issueDate.ts. */
export function saveCheckDays(project: Project): Array<string | null> {
  if (project.documentDate?.source !== 'run') return [null];
  const days = dateBoundaries(project).map((b) => b.date);
  return days.length ? [addDaysToIso(days[0], -1), ...days] : ['2026-01-01'];
}

/**
 * Every fast cause of one version of the document, across `records` (those of its kind) and every day approval checks.
 * `staticFindings`: the static rule and data-link findings of this version (`staticRuleAnalysis` + `bindingAnalysis`).
 */
export function fastCauses(project: Project, records: SyntheticRecord[], staticFindings: Finding[] = []): FastCauses {
  const ofType = records.filter((r) => r.documentType === project.documentType);
  const days = saveCheckDays(project);
  const causes = new Map<string, FastCause>();
  const add = (id: string, kind: BlockerKind, title: string, recordId: string | null, day: string | null): FastCause => {
    let c = causes.get(id);
    if (!c) { c = { id, kind, title, recordIds: [], days: [] }; causes.set(id, c); }
    if (recordId && !c.recordIds.includes(recordId)) c.recordIds.push(recordId);
    if (!c.days.includes(day)) c.days.push(day);
    return c;
  };
  for (const day of days) {
    for (const record of ofType) {
      for (const b of customerBlockers(project, record, day ? { issueDate: day } : undefined)) add(b.id, b.kind, b.title, record.recordId, day);
    }
  }
  for (const f of wordingFindings(project)) {
    if (f.severity !== 'blocking') continue;
    const id = blockerIdOf(f);
    const c = add(id, blockerKindOfId(id) ?? 'wording', blockerTitleOf(project, f), null, null);
    c.finding = f;
    c.readBy = Array.isArray(f.details?.readBy) ? (f.details!.readBy as string[]) : [];
  }
  for (const f of staticFindings) {
    if (f.severity !== 'blocking') continue;
    const id = blockerIdOf(f);
    const c = add(id, blockerKindOfId(id) ?? 'rules', blockerTitleOf(project, f), null, null);
    c.finding = f;
  }
  for (const c of causes.values()) c.recordIds.sort();
  return { checked: ofType.length, days, causes };
}

/**
 * The causes `after` has that `before` does not, compared by root-cause id (`blockerIdOf`), most customers first.
 * A cause both versions have is never new, even when it now stops more customers: the warning is about new causes, and
 * the Blockers screen already lists every customer a known cause stops. A cause only `before` has (fixed by the save) is
 * ignored.
 */
export function newCausesOnSave(before: FastCauses, after: FastCauses): FastCause[] {
  const out: FastCause[] = [];
  for (const [id, c] of after.causes) if (!before.causes.has(id)) out.push(c);
  return out.sort((a, b) => b.recordIds.length - a.recordIds.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The customers a new cause stops: its own list, or for a wording-rule cause the readers of the text in its language (on the first day it was found). */
export function newCauseCustomers(project: Project, records: SyntheticRecord[], cause: FastCause): string[] {
  if (cause.readBy === undefined) return cause.recordIds;
  const day = cause.days.find((d) => d !== null) ?? saveCheckDays(project)[0];
  return readersOf(project, records, cause.readBy, { locale: cause.finding?.locale ?? SOURCE_LANGUAGE, ...(day ? { issueDate: day } : {}) });
}
