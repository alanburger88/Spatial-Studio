import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project, SyntheticRecord } from '@iss/model';
import type { Finding } from '@iss/resolver';
import { documentBlockers, fixImpact, type Blocker, type DocumentBlockers, type ExtraFinding, type FixImpact, type FixProposal } from '@iss/scenarios';
import { bindingAnalysis, staticRuleAnalysis } from '@iss/validation';
import { useStudio } from '../../state/store';
import { fullCheckOf, useFullCheck, type FullCheckResult } from './fullCheck';

/**
 * Every blocker of the open (possibly unsaved) model, for every customer, worked out in the browser. It is recomputed,
 * after a short pause, whenever the model, the customers, the full check or the top-bar output / journey step change.
 * The work is a few hundred milliseconds at most for the sample projects, so it runs on the main thread, after paint.
 */

export interface BlockerData {
  result: DocumentBlockers;
  project: Project;
  records: SyntheticRecord[];
  full: FullCheckResult;
  /** How long the engine took, for Technical view. */
  ms: number;
}

export function useDocumentBlockers(): { data: BlockerData | null; current: boolean; full: FullCheckResult } {
  const project = useStudio((s) => s.project);
  const records = useStudio((s) => s.records);
  const profileId = useStudio((s) => s.ctx.profileId);
  const journeyCursor = useStudio((s) => s.ctx.journeyCursor);
  const full = useFullCheck((s) => (project ? fullCheckOf(s, project.projectId) : fullCheckOf(s, '')));
  const [data, setData] = useState<BlockerData | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (!project) return;
    const h = setTimeout(() => {
      const t0 = performance.now();
      // Static rule and binding checks are cheap and current, so they count as fast; the full check's findings do not.
      const fast: ExtraFinding[] = [...staticRuleAnalysis(project, records), ...bindingAnalysis(project)].map((finding: Finding) => ({ finding, recordId: null, speed: 'fast' as const }));
      const slow: ExtraFinding[] = full.findings.map((x) => ({ finding: x.finding, recordId: x.recordId, speed: 'full-check' as const }));
      const result = documentBlockers(project, records, { profileId, journeyCursor, extraFindings: [...fast, ...slow] });
      setData({ result, project, records, full, ms: Math.round(performance.now() - t0) });
      first.current = false;
    }, first.current ? 0 : 150);
    return () => clearTimeout(h);
  }, [project, records, full.findings, profileId, journeyCursor]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = !!data && data.project === project && data.records === records && data.full.findings === full.findings;
  return { data, current, full };
}

/* ------------------------------------------------------------------ the effect of each fix, worked out one at a time after paint */

const cache = new WeakMap<Project, WeakMap<SyntheticRecord[], Map<string, FixImpact>>>();
const slot = (project: Project, records: SyntheticRecord[]): Map<string, FixImpact> => {
  let byRecords = cache.get(project);
  if (!byRecords) { byRecords = new WeakMap(); cache.set(project, byRecords); }
  let m = byRecords.get(records);
  if (!m) { m = new Map(); byRecords.set(records, m); }
  return m;
};
const keyOf = (blockerId: string, fixId: string, profileId: string, cursor: number | null): string => `${blockerId}|${fixId}|${profileId}|${cursor ?? ''}`;

export interface WantedImpact { blocker: Blocker; fix: FixProposal }

/** The effect of the wanted fixes on every customer, in the order asked; a result appears as soon as it is worked out. */
export function useFixImpacts(project: Project, records: SyntheticRecord[], wanted: WantedImpact[], enabled: boolean): (blockerId: string, fixId: string) => FixImpact | null {
  const profileId = useStudio((s) => s.ctx.profileId);
  const cursor = useStudio((s) => s.ctx.journeyCursor);
  const [, setTick] = useState(0);
  const sig = useMemo(() => wanted.map((w) => `${w.blocker.id}|${w.fix.id}`).join(','), [wanted]);
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const m = slot(project, records);
    const todo = wantedRef.current.filter((w) => w.fix.kind === 'change' && !m.has(keyOf(w.blocker.id, w.fix.id, profileId, cursor)));
    const step = (k: number) => {
      if (cancelled || k >= todo.length) return;
      setTimeout(() => {
        if (cancelled) return;
        const w = todo[k];
        try { m.set(keyOf(w.blocker.id, w.fix.id, profileId, cursor), fixImpact(project, w.fix, records, { finding: w.blocker.finding, profileId, journeyCursor: cursor })); } catch { /* a fix whose effect cannot be worked out shows none */ }
        setTick((t) => t + 1);
        step(k + 1);
      }, 15);
    };
    step(0);
    return () => { cancelled = true; };
  }, [project, records, sig, profileId, cursor, enabled]);
  return (blockerId, fixId) => slot(project, records).get(keyOf(blockerId, fixId, profileId, cursor)) ?? null;
}
