import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Project, ReleaseInfo } from '@iss/model';
import { compareVersions, type VersionComparison } from '@iss/scenarios';
import { ApiFailure, api, type ProjectReleasesDto } from '../api/client';
import { useIsDirty, useStudio } from '../state/store';
import { IssuedOnPicks } from './dates/IssuedOnPicks';
import { useWorkflow } from '../shell/workflow';
import { Empty, ErrorState, Loading, ScreenHeader, Tech } from '../ui/common';
import { DocChanges } from './compare/DocChanges';
import { SideBySide, type SideData } from './compare/SideBySide';
import { WhoChanges } from './compare/WhoChanges';
import { UPDATE, WORKING, defaultCustomer, defaultPair, isOutput, otherSideFor, releaseNumberOf, releaseSide, savedNumberOf, sideLabel, sideShort, validSide, type Output, type SideId } from './compare/model';
import { ShareForReview } from './releases/ReviewLinks'; // review links (wave 4)
import { useVariant } from './variants/useVariant'; // variants (wave 5): the update side
import './BeforeAfter.css';

/**
 * Before & after (S20): if this version replaces that one, what will customers actually see differently, and who?
 * Two sides, each a release of this document or the working version. The comparison itself is the pure engine in
 * `@iss/scenarios` (`compareVersions`), so it agrees with the server; the pages are real compositions of each side.
 * A release side is always the frozen release (`GET /api/v1/releases/:id/template`), never the current project.
 */

/** A frozen release never changes, so what was fetched is kept for the whole browser session. */
const frozen = new Map<string, Project>();

function useFrozen(release: ReleaseInfo | null): { project: Project | null; error: string | null; loading: boolean } {
  const id = release?.id ?? null;
  const [state, setState] = useState<{ id: string | null; project: Project | null; error: string | null }>({ id: null, project: null, error: null });
  useEffect(() => {
    if (!id) return;
    const hit = frozen.get(id);
    if (hit) { setState({ id, project: hit, error: null }); return; }
    let live = true;
    setState({ id, project: null, error: null });
    api.releaseProject(id).then(
      (p) => { frozen.set(id, p); if (live) setState({ id, project: p, error: null }); },
      (e) => { if (live) setState({ id, project: null, error: e instanceof ApiFailure ? e.message : 'The release could not be loaded.' }); },
    );
    return () => { live = false; };
  }, [id]);
  if (!id) return { project: null, error: null, loading: false };
  const mine = state.id === id ? state : { project: frozen.get(id) ?? null, error: null };
  return { project: mine.project, error: mine.error, loading: !mine.project && !mine.error };
}

/** Wave 4: a saved version from the version history, as one side (Before & after from "a newer version was saved first"). */
const savedVersions = new Map<string, Project>();
function useSavedVersion(projectId: string, version: number | null): { project: Project | null; error: string | null; loading: boolean } {
  const key = version ? `${projectId}@${version}` : null;
  const [state, setState] = useState<{ key: string | null; project: Project | null; error: string | null }>({ key: null, project: null, error: null });
  useEffect(() => {
    if (!key || !version) return;
    const hit = savedVersions.get(key);
    if (hit) { setState({ key, project: hit, error: null }); return; }
    let live = true;
    setState({ key, project: null, error: null });
    api.version(projectId, version).then(
      (r) => { savedVersions.set(key, r.project); if (live) setState({ key, project: r.project, error: null }); },
      (e) => { if (live) setState({ key, project: null, error: e instanceof ApiFailure ? e.message : 'The saved version could not be loaded.' }); },
    );
    return () => { live = false; };
  }, [key, projectId, version]);
  if (!key) return { project: null, error: null, loading: false };
  const mine = state.key === key ? state : { project: savedVersions.get(key) ?? null, error: null };
  return { project: mine.project, error: mine.error, loading: !mine.project && !mine.error };
}

export function BeforeAfter() {
  const project = useStudio((s) => s.project)!;
  const records = useStudio((s) => s.records);
  const studioRecord = useStudio((s) => s.ctx.recordId);
  const savedVersion = useStudio((s) => s.serverVersion);
  const dirty = useIsDirty();
  // "As issued on": both sides are worked out on the same day when either version uses dates (a version without dates ignores it).
  const chosenDay = useStudio((s) => s.ctx.issueDate ?? null);
  const wf = useWorkflow((s) => (s.wf && s.wf.projectId === project.projectId ? s.wf : null));
  const [params, setParams] = useSearchParams();

  /* ---------------------------------------------------- the releases of this document */
  const [data, setData] = useState<ProjectReleasesDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let live = true;
    api.projectReleases(project.projectId)
      .then((d) => { if (live) { setData(d); setError(null); } })
      .catch((e) => { if (live) setError(e instanceof ApiFailure ? e.message : 'The releases could not be loaded.'); });
    return () => { live = false; };
  }, [project.projectId, rev, savedVersion, wf?.state, wf?.updatedAt]);
  const releases = useMemo(() => [...(data?.releases ?? [])].sort((a, b) => b.number - a.number), [data]);

  /* ---------------------------------------------------- which two sides (the URL is the source of truth) */
  const asked = { before: params.get('before'), after: params.get('after') };
  // Wave 4: a saved version can be a side even before the first release.
  const askedSaved = savedNumberOf(asked.before) !== null || savedNumberOf(asked.after) !== null || asked.before === UPDATE || asked.after === UPDATE;
  // Variants (wave 5): "with the update from the base" is the working variant with the update applied, worked out here.
  const variant = useVariant(project.variantOf ? project : null);
  const updated = variant.update?.project ?? null;
  const sides = useMemo<{ before: SideId; after: SideId; unknown: string[] } | null>(() => {
    if (!releases.length && !askedSaved) return null;
    const def = defaultPair(releases, project) ?? { before: WORKING, after: WORKING };
    let before = validSide(asked.before, releases), after = validSide(asked.after, releases);
    const unknown = [asked.before, asked.after].filter((x): x is string => !!x && !validSide(x, releases));
    if (!before && !after) { before = def.before; after = def.after; }
    else if (!before) before = otherSideFor(after!, releases, project);
    else if (!after) after = otherSideFor(before, releases, project);
    return { before: before!, after: after!, unknown };
  }, [releases, project, asked.before, asked.after, askedSaved]);

  const patchParams = useCallback((patch: Record<string, string | null>) => {
    setParams((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(patch)) { if (v === null) n.delete(k); else n.set(k, v); } return n; }, { replace: true });
  }, [setParams]);

  // Write the resolved pair into the address, so the link that is copied reopens this very comparison.
  useEffect(() => {
    if (sides && (asked.before !== sides.before || asked.after !== sides.after)) patchParams({ before: sides.before, after: sides.after });
  }, [sides, asked.before, asked.after, patchParams]);

  const releaseOf = (side: SideId) => releases.find((r) => r.number === releaseNumberOf(side)) ?? null;
  const releaseBefore = useFrozen(sides && sides.before !== WORKING ? releaseOf(sides.before) : null);
  const releaseAfter = useFrozen(sides && sides.after !== WORKING ? releaseOf(sides.after) : null);
  const savedBefore = useSavedVersion(project.projectId, sides ? savedNumberOf(sides.before) : null);
  const savedAfter = useSavedVersion(project.projectId, sides ? savedNumberOf(sides.after) : null);
  const frozenBefore = sides && savedNumberOf(sides.before) !== null ? savedBefore : releaseBefore;
  const frozenAfter = sides && savedNumberOf(sides.after) !== null ? savedAfter : releaseAfter;

  const build = (id: SideId, f: { project: Project | null }): SideData | null => {
    const p = id === WORKING ? project : id === UPDATE ? updated : f.project;
    return p ? { id, label: sideLabel(id, releases, dirty), short: sideShort(id), project: p, working: id === WORKING || id === UPDATE, issueDate: chosenDay } : null;
  };
  const noUpdate = !!sides && (sides.before === UPDATE || sides.after === UPDATE) && (!project.variantOf || (variant.status !== 'loading' && !updated));
  const before = sides ? build(sides.before, frozenBefore) : null;
  const after = sides ? build(sides.after, frozenAfter) : null;
  const sideError = frozenBefore.error ?? frozenAfter.error;

  /* ---------------------------------------------------- the comparison (the engine, off the paint) */
  const [cmp, setCmp] = useState<{ value: VersionComparison } | { error: string } | null>(null);
  const bProject = before?.project, aProject = after?.project, bWorking = before?.working, aWorking = after?.working;
  const compareDay = chosenDay && (bProject?.documentDate || aProject?.documentDate) ? chosenDay : null;
  useEffect(() => {
    setCmp(null);
    if (!bProject || !aProject) return;
    const t = window.setTimeout(() => {
      try { setCmp({ value: compareVersions(bProject, aProject, records, { includeDraftsBefore: bWorking, includeDraftsAfter: aWorking, ...(compareDay ? { issueDate: compareDay } : {}) }) }); }
      catch (e) { setCmp({ error: e instanceof Error ? e.message : String(e) }); }
    }, 30);
    return () => window.clearTimeout(t);
  }, [bProject, aProject, bWorking, aWorking, records, compareDay]);
  const comparison = cmp && 'value' in cmp ? cmp.value : null;

  /* ---------------------------------------------------- the customer and the output */
  const askedCustomer = params.get('customer');
  const customerId = comparison
    ? (comparison.customers.some((c) => c.recordId === askedCustomer) ? askedCustomer : defaultCustomer(comparison.customers, studioRecord))
    : null;
  const customer = comparison?.customers.find((c) => c.recordId === customerId) ?? null;
  const record = records.find((r) => r.recordId === customerId) ?? null;
  const rawOutput = params.get('output');
  const output: Output = isOutput(rawOutput) ? rawOutput : 'pdf';

  const setSide = (which: 'before' | 'after', value: SideId) => patchParams({ before: sides!.before, after: sides!.after, [which]: value });
  const swap = () => patchParams({ before: sides!.after, after: sides!.before });

  /* ---------------------------------------------------- render */
  const header = (
    <ScreenHeader id="S20" title="Before & after"
      subtitle="If one version replaces another, what will customers see differently, and who? Compare two releases of this document, or the working version with a release. Every synthetic test customer is worked out under both versions, and you can look at the real pages side by side." />
  );

  if (error && !data) return <section className="screen" data-testid="before-after">{header}<div className="screen-body"><ErrorState title="The releases could not be loaded" message={error} onRetry={() => setRev((r) => r + 1)} /></div></section>;
  if (!data) return <section className="screen" data-testid="before-after">{header}<div className="screen-body"><Loading label="Loading releases…" /></div></section>;

  if (!releases.length && !askedSaved) {
    return (
      <section className="screen" data-testid="before-after">
        {header}
        <div className="screen-body cmp-single">
          <div className="cmp-main">
            <div data-testid="cmp-no-release">
              <Empty title="There is no release of this document yet"
                message="Before & after compares two releases, or a release with the working version. A release is made when the document is approved, so there is nothing to compare yet. Once the first release exists, you can see here what customers would see differently when the next version replaces it.">
                <Link className="btn" to={`/studio/${project.projectId}/releases`} data-testid="cmp-to-releases">Go to Releases</Link>
              </Empty>
            </div>
            <Limits count={records.length} />
          </div>
        </div>
      </section>
    );
  }

  const options = [
    { id: WORKING as SideId, label: dirty ? 'Working version (not released, with unsaved changes)' : 'Working version (not released)' },
    ...releases.map((r) => ({ id: releaseSide(r.number), label: sideLabel(releaseSide(r.number), releases) })),
    // Wave 4: a saved version named in the address stays choosable.
    ...[...new Set([sides!.before, sides!.after])].filter((s) => savedNumberOf(s) !== null).map((s) => ({ id: s, label: sideLabel(s, releases) })),
    ...(updated || sides!.before === UPDATE || sides!.after === UPDATE ? [{ id: UPDATE, label: sideLabel(UPDATE, releases) }] : []),
  ];
  const picker = (which: 'before' | 'after', title: string) => (
    <label className="field cmp-picker"><span className="label">{title}</span>
      <select className="select" data-testid={`cmp-${which}`} data-value={sides![which]} value={sides![which]} onChange={(e) => setSide(which, e.target.value)}>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  );
  const rel = (side: SideId) => releaseOf(side);

  return (
    <section className="screen" data-testid="before-after">
      {header}
      <div className="screen-body cmp-body">
        <aside className="panel cmp-left" data-side="left" data-side-title="Who changes" aria-label="Who changes">
          <div className="panel-head"><h2 className="section-title">Who changes</h2></div>
          <div className="panel-body">
            {sideError ? null : !comparison ? (cmp && 'error' in cmp ? <div className="callout error" role="alert">{cmp.error}</div> : <Loading label="Working out who changes…" />)
              : comparison.evaluated === 0 ? <p className="muted" data-testid="cmp-no-customers">This document has no test customers, so there is nobody to compare. Add some in the Data Explorer, or generate test customers.</p>
              : <WhoChanges comparison={comparison} selected={customerId} onSelect={(id) => patchParams({ customer: id })} />}
          </div>
        </aside>

        <div className="cmp-main">
          <div className="cmp-pickers" data-testid="cmp-pickers">
            {picker('before', 'Before')}
            <button type="button" className="btn cmp-swap" data-testid="cmp-swap" onClick={swap} title="Swap Before and After"><span aria-hidden="true">⇄</span> Swap sides</button>
            {picker('after', 'After')}
            {/* Review links (wave 4): share the After side, frozen: a release, or the saved version (never unsaved changes). */}
            {sides!.after === WORKING
              ? <ShareForReview projectId={project.projectId} target={{ version: savedVersion }} testId="cmp-share-review" className="btn cmp-share"
                  note={dirty ? `You have unsaved changes. The link shows saved version ${savedVersion}, without them.` : undefined} />
              : rel(sides!.after) && <ShareForReview projectId={project.projectId} target={{ releaseId: rel(sides!.after)!.id }} testId="cmp-share-review" className="btn cmp-share" />}
          </div>
          <Tech>
            <p className="muted cmp-tech" data-testid="cmp-tech">
              {([['Before', sides!.before], ['After', sides!.after]] as const).map(([t, s]) => (
                <span key={t}>{t}: {s === WORKING ? 'the working project as open in the studio' : s === UPDATE ? 'the working project with the update from the base applied (mergeVariantUpdate), not saved' : savedNumberOf(s) !== null ? `saved version ${savedNumberOf(s)} from the version history` : <>frozen release <span className="chip code" title={rel(s)?.contentDigest}>{rel(s)?.id}</span> · content {rel(s)?.contentDigest.slice(0, 12)}…</>}{' '}</span>
              ))}
            </p>
          </Tech>
          {(bProject?.documentDate || aProject?.documentDate) && <IssuedOnPicks project={(aProject?.documentDate ? aProject : bProject)!} what="Both versions are compared" testId="cmp-issue-date" />}
          {sides!.unknown.length > 0 && <div className="callout warning" role="note" data-testid="cmp-unknown-side">{sides!.unknown.join(', ')} is not a release of this document, so the usual pair is shown instead.</div>}
          {sides!.before === sides!.after && <div className="callout accent" role="note" data-testid="cmp-same-side">Both sides are the same version, so nothing can differ. Choose a different Before or After.</div>}

          {noUpdate && <div className="callout accent" role="note" data-testid="cmp-no-update">{project.variantOf ? `This variant follows the latest saved version of “${project.variantOf.baseTitle}”, so there is no update to compare.` : 'This document is not a variant, so there is no update from a base to compare.'}</div>}
          {noUpdate ? null : sideError ? <ErrorState title="A release could not be loaded" message={sideError} onRetry={() => setRev((r) => r + 1)} />
            : !before || !after ? <Loading label="Loading the release…" />
            : !comparison ? (cmp && 'error' in cmp ? <ErrorState title="The comparison could not be worked out" message={cmp.error} /> : <Loading label="Working out who changes…" />)
            : comparison.evaluated === 0 ? <Empty title="No test customers" message="This document has no test customers, so there is nothing to compare. Add some in the Data Explorer, or generate test customers." />
            : (
              <>
                {customer && record ? <SideBySide before={before} after={after} record={record} comparison={customer} output={output} onOutput={(o) => patchParams({ output: o })} styleChanged={comparison.styleChanged} />
                  : <Empty title="Choose a customer" message="Choose a customer on the left to see what they get under each version." />}
                <DocChanges before={before} after={after} records={records} />
              </>
            )}
          <Limits count={comparison?.evaluated ?? records.length} />
        </div>
      </div>
    </section>
  );
}

function Limits({ count }: { count: number }) {
  return (
    <section className="cmp-limits" data-testid="cmp-limits" aria-labelledby="cmp-limits-h">
      <h3 className="section-title" id="cmp-limits-h">What this screen does and does not compare</h3>
      <ul>
        <li>It compares what the engine decides and writes for each customer, and shows the real pages side by side. It does not compare pixels, so a change that only moves content or restyles it (for example a different font size in the brand settings) is reported as a look change for every customer, with the pages to look at, not as an outline of one part.</li>
        <li>It covers the {count} synthetic test {count === 1 ? 'customer' : 'customers'} this document has. “Generate test customers” widens the net.</li>
        <li>Output for the print-stream simulation (AFP) is not compared here.</li>
        <li>Comparing whole production runs between releases, as a check before Production, is not part of this screen yet.</li>
      </ul>
    </section>
  );
}

export default BeforeAfter;
