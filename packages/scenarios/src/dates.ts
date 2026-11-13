import {
  addDaysToIso, dateBoundaries, dayWords, isIsoDay, periodInWords,
  type DateBoundaryItem, type EffectivePeriod, type ProfileId, type Project, type Rule, type SyntheticRecord,
} from '@iss/model';
import { resolve } from '@iss/resolver';
import { visibleChanges, type VisibleChange } from './compareVersions';
import { nodeWords, ruleWords } from './assist/writing';

/**
 * Checks of a document's effective dates, pure and deterministic (no clock: every date is a day the document names).
 *
 * - `dateChecks`: gaps (a message with no alternative in effect between two days, where one is needed) and overlaps
 *   (two rules that would tie only during a period), each with the days.
 * - `documentDateBoundaries`: every day on which something changes, in plain words.
 * - `documentTimeline`: for each of those days, what changes and which test customers it reaches.
 */

export interface DateCheck {
  kind: 'gap' | 'overlap';
  severity: 'blocking' | 'warning';
  /** The message (variant set) or section it is about. */
  nodeId?: string;
  ruleIds?: string[];
  /** The days it applies: from (included) and until (not included); null = open. */
  from: string | null;
  until: string | null;
  message: string;
}

const q = (s: string) => `“${s}”`;
const span = (from: string | null, until: string | null): string =>
  from && until ? `from ${dayWords(from)} until ${dayWords(until)} (not included)` : from ? `from ${dayWords(from)} on` : until ? `before ${dayWords(until)}` : 'on every day';

/** Where two periods meet (null when they do not). Open ends stay open. */
function intersect(a: EffectivePeriod | undefined, b: EffectivePeriod | undefined): { from: string | null; until: string | null } | null {
  const from = [a?.from, b?.from].filter((x): x is string => !!x).sort().pop() ?? null;
  const until = [a?.until, b?.until].filter((x): x is string => !!x).sort()[0] ?? null;
  if (from && until && !(from < until)) return null;
  return { from, until };
}

/** The days outside a period, as at most two open-ended spans. */
const outside = (p: EffectivePeriod): Array<{ from: string | null; until: string | null }> => [
  ...(p.from ? [{ from: null, until: p.from }] : []),
  ...(p.until ? [{ from: p.until, until: null }] : []),
];

/** Gaps and overlaps in time, with the days. Nothing for a document without periods. */
export function dateChecks(project: Project): DateCheck[] {
  if (!project.documentDate) return [];
  const out: DateCheck[] = [];
  for (const n of project.nodes) {
    if (n.type !== 'variant-set' && n.type !== 'conditional-region') continue;
    const periods = n.variantPeriods ?? {};
    const name = nodeWords(project, n.id);
    const fb = n.fallbackVariantId;
    // A message that has a fallback relies on it whenever no rule chooses; outside the fallback's period nothing is left.
    if (n.type === 'variant-set' && fb && periods[fb]) {
      for (const s of outside(periods[fb])) {
        const others = (n.variantIds ?? []).filter((v) => v !== fb);
        const covered = others.some((v) => !periods[v] || intersect(periods[v], { ...(s.from ? { from: s.from } : {}), ...(s.until ? { until: s.until } : {}) }));
        out.push({
          kind: 'gap', severity: 'blocking', nodeId: n.id, from: s.from, until: s.until,
          message: `${q(name)} has no fallback message in effect ${span(s.from, s.until)}: its fallback ${q(nodeWords({ nodes: [], contentParts: project.contentParts }, fb))} applies only ${periodInWords(periods[fb])}. A customer no rule chooses a message for then gets none${covered ? ', unless a rule chooses another message' : ''}.`,
        });
      }
    }
    // Every alternative of the message has a period: on the days none is in effect, nothing can be shown.
    const ids = n.variantIds ?? [];
    if (ids.length && ids.every((v) => periods[v])) {
      const days = [...new Set(ids.flatMap((v) => [periods[v].from, periods[v].until]).filter((x): x is string => !!x))].sort();
      const inEffectOn = (d: string | null) => ids.some((v) => (!periods[v].from || (d !== null && d >= periods[v].from!)) && (!periods[v].until || (d === null || d < periods[v].until!)));
      // Before the first day, between each pair, and from the last day on.
      const spans: Array<{ from: string | null; until: string | null }> = [{ from: null, until: days[0] ?? null }, ...days.map((d, i) => ({ from: d, until: days[i + 1] ?? null }))];
      for (const s of spans) {
        const probe = s.from ?? (s.until ? addDaysToIso(s.until, -1) : null);
        if (probe && !inEffectOn(probe)) out.push({ kind: 'gap', severity: n.type === 'variant-set' ? 'blocking' : 'warning', nodeId: n.id, from: s.from, until: s.until, message: `None of the messages of ${q(name)} is in effect ${span(s.from, s.until)}.` });
      }
    }
  }
  // Two exclusive rules for the same part at the same priority, whose periods meet: they can tie on those days only.
  const groups = new Map<string, Rule[]>();
  for (const r of project.rules) {
    if (r.mode !== 'exclusive' || r.enabled === false || r.then.op !== 'selectVariant') continue;
    const g = r.exclusiveGroup ?? r.then.targetNodeId;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  for (const [g, rules] of groups) {
    for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i], b = rules[j];
      if (a.priority !== b.priority || (!a.effective && !b.effective)) continue;
      const meet = intersect(a.effective, b.effective);
      if (!meet) continue;
      out.push({ kind: 'overlap', severity: 'warning', nodeId: g, ruleIds: [a.id, b.id], from: meet.from, until: meet.until, message: `${q(ruleWords(project, a))} and ${q(ruleWords(project, b))} have the same priority and are both in effect ${span(meet.from, meet.until)}: a customer both apply to then gets no message, because the studio never picks a winner silently.` });
    }
  }
  return out;
}

export interface BoundaryChange extends DateBoundaryItem {
  /** Plain words: "Rule “New year offer” starts". */
  words: string;
}
export interface DocumentBoundary { date: string; changes: BoundaryChange[] }

/** Every day on which something about the document changes, with what changes, in plain words. */
export function documentDateBoundaries(project: Project): DocumentBoundary[] {
  const part = (id: string) => nodeWords({ nodes: [], contentParts: project.contentParts }, id);
  return dateBoundaries(project).map((b) => ({
    date: b.date,
    changes: b.items.map((it) => {
      const verb = it.change === 'starts' ? 'starts' : 'stops';
      const words = it.kind === 'rule' ? `Rule ${q(ruleWords(project, project.rules.find((r) => r.id === it.id) ?? { id: it.id, then: { op: 'setPresentationHint', hint: it.id } }))} ${it.change === 'starts' ? 'starts to apply' : 'stops applying'}`
        : it.kind === 'variant' ? `The message ${q(part(it.id))} in ${q(nodeWords(project, it.nodeId!))} ${it.change === 'starts' ? 'can be chosen from this day' : 'can no longer be chosen'}`
        : it.kind === 'section' ? `The section ${q(nodeWords(project, it.id))} ${it.change === 'starts' ? 'is shown from this day (where its condition holds)' : 'is no longer shown'}`
        : `Row ${it.id.split('#')[1]} of the table ${q(project.lookupTables?.find((t) => t.id === it.nodeId)?.title ?? it.nodeId ?? '')} ${verb}`;
      return { ...it, words };
    }),
  }));
}

export interface TimelineEntry extends DocumentBoundary {
  /** The day before, compared with the day itself. */
  dayBefore: string;
  /** Test customers whose document differs between the two days. */
  reached: string[];
  /** Customers of the document's kind that were compared. */
  evaluated: number;
  /** A few of the differences, for showing to a person. */
  examples: Array<{ recordId: string; changes: VisibleChange[] }>;
}

/**
 * What changes on which day, and which test customers it reaches: each boundary day is compared with the day before,
 * for every customer of the document's kind. Pure; a document without dates has an empty timeline.
 */
export function documentTimeline(project: Project, records: SyntheticRecord[], opts: { profileId?: ProfileId; examples?: number } = {}): TimelineEntry[] {
  if (!project.documentDate) return [];
  const mine = records.filter((r) => r.documentType === project.documentType);
  const max = opts.examples ?? 3;
  return documentDateBoundaries(project).filter((b) => isIsoDay(b.date)).map((b) => {
    const dayBefore = addDaysToIso(b.date, -1);
    const reached: string[] = [];
    const examples: TimelineEntry['examples'] = [];
    for (const record of mine) {
      const before = resolve({ project, record, issueDate: dayBefore, profileId: opts.profileId });
      const after = resolve({ project, record, issueDate: b.date, profileId: opts.profileId });
      if (before.contentDigest === after.contentDigest && before.findings.length === after.findings.length) continue;
      const changes = visibleChanges(before, after);
      if (!changes.length) continue;
      reached.push(record.recordId);
      if (examples.length < max) examples.push({ recordId: record.recordId, changes });
    }
    return { ...b, dayBefore, reached, evaluated: mine.length, examples };
  });
}
