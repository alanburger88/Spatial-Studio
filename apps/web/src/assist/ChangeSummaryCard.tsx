import { useEffect, useState } from 'react';
import type { Project } from '@iss/model';
import { summarizeChanges, type ChangeSummary } from '@iss/scenarios';
import { api, type VersionDto } from '../api/client';
import { usePreviewDate, useStudio } from '../state/store';
import { Loading } from '../ui/common';
import { SourceChip } from './common';
import './panel.css';

/**
 * Plain-language summary of what changed between two versions of a document, computed in the browser from the
 * model and the synthetic customers (`summarizeChanges`). No AI key is needed and nothing is written anywhere.
 * Shared by version history, the review panel and the assistant side panel.
 */

const versionCache = new Map<string, Project>();
async function loadVersion(pid: string, v: number): Promise<Project> {
  const key = `${pid}:${v}`;
  const hit = versionCache.get(key);
  if (hit) return hit;
  const r = await api.version(pid, v);
  versionCache.set(key, r.project);
  return r.project;
}

/** The newest saved version that was approved or published (strictly older than `before` when given). */
export function lastApprovedVersion(versions: VersionDto[], before?: number): VersionDto | null {
  return versions
    .filter((v) => (before === undefined || v.modelVersion < before) && v.workflow.some((w) => w.to === 'approved' || w.to === 'published'))
    .sort((a, b) => b.modelVersion - a.modelVersion)[0] ?? null;
}

export function ChangeSummaryCard({ pid, from, to, fromLabel, toLabel, note, testId = 'change-summary' }: {
  pid: string;
  /** Saved version to compare against; null when there is nothing earlier. */
  from: number | null;
  /** A saved version, or the working copy open in the studio. */
  to: number | 'working';
  fromLabel?: string; toLabel?: string; note?: string; testId?: string;
}) {
  const records = useStudio((s) => s.records);
  const working = useStudio((s) => s.project);
  // The customer impact is worked out on the day the studio previews ("As issued on"), like every other screen.
  const issueDate = usePreviewDate();
  const [state, setState] = useState<{ summary: ChangeSummary } | { error: string } | null>(null);

  useEffect(() => {
    setState(null);
    if (from === null) return;
    let live = true;
    (async () => {
      try {
        const [before, after] = await Promise.all([loadVersion(pid, from), to === 'working' ? Promise.resolve(working as Project) : loadVersion(pid, to)]);
        // Let the "Working" state paint before the heavy part (it resolves every synthetic customer twice).
        await new Promise((r) => window.setTimeout(r, 30));
        if (!live) return;
        setState({ summary: summarizeChanges(before, after, records, { issueDate }) });
      } catch (e) { if (live) setState({ error: e instanceof Error ? e.message : String(e) }); }
    })();
    return () => { live = false; };
    // The working copy is only read when `to` is 'working'; its identity changes on every edit, which is what we want.
  }, [pid, from, to, to === 'working' ? working : null, records, issueDate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (from === null) return <div className="cs-card" data-testid={testId}><p className="cs-none">This is the first saved version, so there is nothing earlier to compare with.</p></div>;
  if (!state) return <div className="cs-card" data-testid={testId} aria-busy="true"><Loading label="Working out what changed…" /></div>;
  if ('error' in state) return <div className="cs-card" data-testid={testId}><div className="callout error" role="alert">The summary could not be worked out: {state.error}</div></div>;
  return <SummaryBody s={state.summary} fromLabel={fromLabel} toLabel={toLabel} note={note} testId={testId} />;
}

function SummaryBody({ s, fromLabel, toLabel, note, testId }: { s: ChangeSummary; fromLabel?: string; toLabel?: string; note?: string; testId: string }) {
  const none = s.headline === 'No changes' && s.sections.length === 0;
  const i = s.impact;
  const bits: string[] = [];
  if (i.newlyBlocked) bits.push(`${i.newlyBlocked} can no longer get a document`);
  if (i.unblocked) bits.push(`${i.unblocked} no longer ${i.unblocked === 1 ? 'is' : 'are'} blocked`);
  return (
    <div className="cs-card" data-testid={testId} data-source={s.source} data-changes={none ? 'none' : 'some'}>
      <div className="cs-head">
        <strong className="cs-headline" data-testid="summary-headline">{s.headline}</strong>
        <SourceChip source={s.source} />
      </div>
      {(fromLabel || toLabel || note) && <p className="cs-note muted">{fromLabel && toLabel ? <>Comparing <strong>{fromLabel}</strong> with <strong>{toLabel}</strong>. </> : null}{note}</p>}
      {!none && (
        <>
          {s.attention.length > 0 && (
            <div className="cs-attention" data-testid="summary-attention">
              <div className="cs-sub">Look at first</div>
              <ol>{s.attention.map((a, k) => <li key={k}>{a}</li>)}</ol>
            </div>
          )}
          <div className="cs-impact" data-testid="summary-impact" data-changed={i.changedCustomers} data-total={i.totalCustomers}>
            <p>
              <strong>{i.changedCustomers} of {i.totalCustomers} synthetic customers</strong> get different messages or sections
              {bits.length ? `; ${bits.join('; ')}` : ''}.
            </p>
            {i.examples.length > 0 && (
              <ul className="cs-examples" aria-label="Examples">
                {i.examples.slice(0, 5).map((e) => (
                  <li key={e.recordId}>
                    <button type="button" className="linkbtn" data-testid="summary-example" data-record-id={e.recordId} title={`Preview the document as ${e.name}`} onClick={() => useStudio.getState().setRecord(e.recordId)}>{e.name}</button>
                    <span className="muted"> — {e.what}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="cs-sections">
            {s.sections.map((sec, k) => (
              <details key={sec.area} className="cs-section" data-area={sec.area} open>
                <summary><span>{sec.title}</span> <span className="chip count">{sec.items.length}</span></summary>
                <ul>{sec.items.map((it, n) => <li key={n}>{it}</li>)}</ul>
              </details>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
